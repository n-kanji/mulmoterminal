import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// The grid subscribes to the pub/sub socket on mount — stub it so no real socket opens.
vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({ subscribe: () => () => {}, onReconnect: () => () => {} }),
}));

// Session ids for the roster-ordering test (must be valid UUIDs or parseGridState drops them).
const IDS = vi.hoisted(() => ({
  blocked: "11111111-1111-1111-1111-111111111111",
  idleA: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  idleB: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
}));
// Feed one blocked session so the auto sort has something to float to the front.
vi.mock("../../../src/composables/useGridActivity", () => ({
  useGridActivity: () => ({ activity: new Map([[IDS.blocked, { working: false, waiting: true, event: "Notification" }]]) }),
}));

// Config GET hydrates pushEnabled=true; capture POSTs so we can assert the toggle saves.
const posts: Array<{ url: string; body: unknown }> = [];
beforeEach(() => {
  posts.length = 0;
  localStorage.clear();
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/config")) {
      if (init?.method === "POST") posts.push({ url: u, body: init.body });
      return {
        ok: true,
        json: async () => ({
          cwd: "/w",
          home: "/w",
          cwdPresets: [],
          soundFile: null,
          pushEnabled: true,
          prRepos: [],
          launchers: [],
          userMcpServers: [],
          buttons: null,
          chips: null,
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

// A SettingsModal stub whose props we can inspect + whose emits we can drive.
const SettingsStub = {
  name: "SettingsModal",
  props: ["soundFile", "pushEnabled", "prRepos", "launchers", "userMcpServers", "cwd", "sessionId"],
  emits: ["update-push-enabled", "close"],
  template: '<div class="settings-stub" />',
};
// A toolbar stub that lets us open the settings modal (GridView: @settings="showSettings = true").
// Renders the tabs slot: the page tabs live inside the real toolbar's row now.
const ToolbarStub = {
  name: "AppToolbar",
  emits: ["settings"],
  template: '<div><button class="open-settings" @click="$emit(\'settings\')" /><slot name="tabs" /></div>',
};

const mountGrid = async () => {
  const w = mount((await import("../../../src/components/GridView.vue")).default, {
    global: { stubs: { TerminalGrid: true, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
  });
  await flushPromises(); // onMounted loadConfig
  return w;
};

// A TerminalGrid stub that exposes the ordering props the roster/grid receive.
const OrderStub = {
  name: "TerminalGrid",
  props: ["cells", "listRows", "expandedUid", "reorderable"],
  template: '<div class="order-stub" />',
};

describe("GridView roster ordering (#720)", () => {
  it("orders the cockpit roster (listRows) attention-first in auto mode, matching the grid", async () => {
    // Auto sort, one cell zoomed (roster visible); the middle cell (uid→1) is the blocked one.
    localStorage.setItem(
      "grid_v2",
      JSON.stringify({
        cells: [
          { uid: 10, session: IDS.idleA, cwd: "/w" },
          { uid: 11, session: IDS.blocked, cwd: "/w" },
          { uid: 12, session: IDS.idleB, cwd: "/w" },
        ],
        expanded: 10,
        page: 0,
        sortMode: "auto",
      }),
    );
    const w = mount((await import("../../../src/components/GridView.vue")).default, {
      global: { stubs: { TerminalGrid: OrderStub, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
    });
    await flushPromises();
    const grid = w.findComponent(OrderStub);
    // The blocked cell (renumbered uid 1) floats to the top; the two idle cells keep manual order.
    const rosterOrder = grid.props("listRows").map((r: { uid: number }) => r.uid);
    expect(rosterOrder).toEqual([1, 0, 2]);
    // The grid reads the SAME ordering — roster and grid can't drift.
    expect(grid.props("cells").map((c: { uid: number }) => c.uid)).toEqual([1, 0, 2]);
    w.unmount();
  });
});

// A toolbar stub that surfaces the view-toggle props and can fire the toggle-view event, plus a
// TerminalGrid stub exposing the listMode prop — together they trace the header → GridView → grid
// wiring for the roster ⇄ strip toggle.
const ViewToggleToolbarStub = {
  name: "AppToolbar",
  props: ["showViewToggle", "listMode"],
  emits: ["toggle-view"],
  template: '<button class="toggle-view" @click="$emit(\'toggle-view\')" />',
};
const ListModeGridStub = { name: "TerminalGrid", props: ["listMode", "expandedUid"], template: '<div class="lm-stub" />' };

describe("GridView view toggle wiring", () => {
  it("shows the toggle only while zoomed and flips the grid's listMode when the header fires toggle-view", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: [{ uid: 10, session: IDS.idleA, cwd: "/w" }], expanded: 10, page: 0, sortMode: "manual" }));
    const w = mount((await import("../../../src/components/GridView.vue")).default, {
      global: { stubs: { TerminalGrid: ListModeGridStub, AppToolbar: ViewToggleToolbarStub, SettingsModal: SettingsStub } },
    });
    await flushPromises();
    const toolbar = w.findComponent(ViewToggleToolbarStub);
    const grid = w.findComponent(ListModeGridStub);
    // A cell is expanded → the toggle is offered, and both surfaces start in roster (list) mode.
    expect(toolbar.props("showViewToggle")).toBe(true);
    expect(toolbar.props("listMode")).toBe(true);
    expect(grid.props("listMode")).toBe(true);
    // The header toggle flips roster → strip for the grid too.
    await toolbar.trigger("click");
    expect(grid.props("listMode")).toBe(false);
    expect(toolbar.props("listMode")).toBe(false);
    w.unmount();
  });

  it("hides the toggle when nothing is expanded", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: [{ uid: 10, session: IDS.idleA, cwd: "/w" }], expanded: null, page: 0, sortMode: "manual" }));
    const w = mount((await import("../../../src/components/GridView.vue")).default, {
      global: { stubs: { TerminalGrid: ListModeGridStub, AppToolbar: ViewToggleToolbarStub, SettingsModal: SettingsStub } },
    });
    await flushPromises();
    expect(w.findComponent(ViewToggleToolbarStub).props("showViewToggle")).toBe(false);
    w.unmount();
  });
});

describe("GridView guide help (empty state)", () => {
  it("shows the guide footer (ja/en links) when no terminal is running, and hides it once one is", async () => {
    // Empty grid: ensureEntry leaves only the entry launch cell, so runningCount === 0.
    const empty = await mountGrid();
    const footer = empty.find("footer");
    expect(footer.exists()).toBe(true);
    const hrefs = footer.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("https://receptron.github.io/mulmoterminal/guide/ja/");
    expect(hrefs).toContain("https://receptron.github.io/mulmoterminal/guide/en/");
    empty.unmount();

    // A running session cell (occupied) — the newcomer hint must step out of the way.
    localStorage.setItem("grid_v2", JSON.stringify({ cells: [{ uid: 1, session: IDS.idleA, cwd: "/w" }], expanded: null, page: 0, sortMode: "manual" }));
    const running = mount((await import("../../../src/components/GridView.vue")).default, {
      global: { stubs: { TerminalGrid: true, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
    });
    await flushPromises();
    expect(running.find("footer").exists()).toBe(false);
    running.unmount();
  });
});

describe("GridView settings wiring", () => {
  it("passes pushEnabled to SettingsModal and saves it on update-push-enabled (regression #347)", async () => {
    const w = await mountGrid();
    await w.find(".open-settings").trigger("click"); // open the settings modal
    const modal = w.findComponent(SettingsStub);
    expect(modal.exists()).toBe(true);
    // The grid view must reflect the saved config, not a default false.
    expect(modal.props("pushEnabled")).toBe(true);

    // Toggling in the grid view must persist via POST /api/config.
    modal.vm.$emit("update-push-enabled", false);
    await flushPromises();
    const pushPost = posts.find((p) => String(p.body).includes("pushEnabled"));
    expect(pushPost, "toggling push should POST /api/config").toBeTruthy();
    expect(String(pushPost?.body)).toContain('"pushEnabled":false');
  });
});

// --- Keyboard shortcut wiring (#829) -------------------------------------------------
//
// The pure transforms are covered in gridTabs.spec.ts. What is covered HERE is the wiring
// GridView owns, which is where every bug in this feature actually lived: which ordered list
// the shortcuts are given, which cell the cursor is moved to, and whether a key that should
// only move ends up changing the layout.

// Focus calls land here instead of a real xterm.
const focused = vi.hoisted(() => [] as string[]);
vi.mock("../../../src/composables/useTerminalConnections", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  focus: (key: string) => focused.push(key),
}));

import { setActiveKeymap } from "../../../src/composables/activeKeymap";
import { PAGE_SIZE } from "../../../src/components/gridTabs";

const uuid = (n: number) => `${String(n % 10).repeat(8)}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;

// A TerminalGrid stub that reports the props the shortcuts drive, and can raise focus-cell the
// way the real grid does when a terminal takes the cursor.
const ShortcutGridStub = {
  name: "TerminalGrid",
  props: ["cells", "listRows", "expandedUid", "reorderable"],
  emits: ["focus-cell"],
  template: '<div class="shortcut-stub" />',
};

const press = async (key: string) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await flushPromises();
};

// An Option chord as macOS really delivers it: the CHARACTER Option produced on `key`, the
// physical key on `code`. Every default this fork ships is one of these, so a matcher that
// only looked at `key` would leave all of them dead on the operator's actual machine (R3).
const pressAlt = async (code: string, char: string) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: char, code, altKey: true, bubbles: true }));
  await flushPromises();
};

const DEFAULT_KEYMAP = { "zoom-toggle": "F8", "next-attention": "F9", "zoom-next": "PageDown", "zoom-prev": "PageUp" };

/** Mount a grid of `count` running cells, all on the first page unless `page` says otherwise.
 *  The keymap is applied AFTER mounting because GridView's onMounted loadConfig hydrates it
 *  from /api/config — setting it earlier would be overwritten by the stubbed response. */
const mountShortcutGrid = async (count: number, extra: Record<string, unknown> = {}, keymap: unknown = DEFAULT_KEYMAP) => {
  localStorage.setItem(
    "grid_v2",
    JSON.stringify({
      cells: Array.from({ length: count }, (_, i) => ({ uid: i, session: uuid(i), cwd: "/w" })),
      expanded: null,
      page: 0,
      sortMode: "manual",
      ...extra,
    }),
  );
  const w = mount((await import("../../../src/components/GridView.vue")).default, {
    global: { stubs: { TerminalGrid: ShortcutGridStub, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
  });
  await flushPromises();
  setActiveKeymap(keymap);
  return w;
};

const gridOf = (w: ReturnType<typeof mount>) => w.findComponent(ShortcutGridStub);

describe("GridView keyboard shortcuts (#829)", () => {
  beforeEach(() => {
    focused.length = 0;
  });

  // Fork-local (R3): a config with no `keymap` no longer means "no shortcuts" — it means this
  // fork's Alt defaults. What stays true is that an unbound key is still the terminal's.
  it("falls back to this fork's defaults when no keymap is configured", async () => {
    // `null`, not `undefined` — passing undefined to a defaulted parameter selects the default.
    const w = await mountShortcutGrid(4, {}, null);
    await press("F8"); // not part of the defaults
    expect(gridOf(w).props("expandedUid")).toBeNull();
    expect(focused).toEqual([]);
    await pressAlt("KeyZ", "Ω"); // the default zoom-toggle
    expect(gridOf(w).props("expandedUid")).not.toBeNull();
    w.unmount();
  });

  it("F8 enlarges, and F8 again collapses", async () => {
    const w = await mountShortcutGrid(4);
    await press("F8");
    expect(gridOf(w).props("expandedUid")).not.toBeNull();
    await press("F8");
    expect(gridOf(w).props("expandedUid")).toBeNull();
    w.unmount();
  });

  it("F8 enlarges the FOCUSED terminal, not the first of the page", async () => {
    const w = await mountShortcutGrid(4);
    gridOf(w).vm.$emit("focus-cell", 2); // the cursor is in cell 2
    await flushPromises();
    await press("F8");
    expect(gridOf(w).props("expandedUid")).toBe(2);
    w.unmount();
  });

  it("keeps the cursor on the same terminal across enlarge and collapse", async () => {
    const w = await mountShortcutGrid(4);
    gridOf(w).vm.$emit("focus-cell", 2);
    await flushPromises();
    await press("F8");
    expect(focused.at(-1)).toBe("cell-2");
    await press("F8"); // collapse — the selection must stay on 2, not jump elsewhere
    expect(focused.at(-1)).toBe("cell-2");
    w.unmount();
  });

  // The bug that made F9 look dead: with no origin the rotation restarted every press.
  it("F9 advances through terminals instead of picking the same one every time", async () => {
    const w = await mountShortcutGrid(4);
    await press("F9");
    const first = focused.at(-1);
    // Report the focus back the way the real grid does, so the next press has an origin.
    gridOf(w).vm.$emit("focus-cell", Number(first?.replace("cell-", "")));
    await flushPromises();
    await press("F9");
    expect(focused.at(-1)).not.toBe(first);
    w.unmount();
  });

  it("F9 NEVER enlarges or collapses — only F8 changes that", async () => {
    const w = await mountShortcutGrid(4);
    await press("F9");
    expect(gridOf(w).props("expandedUid")).toBeNull(); // still a grid

    await press("F8"); // now zoomed
    const zoomed = gridOf(w).props("expandedUid");
    expect(zoomed).not.toBeNull();
    await press("F9");
    expect(gridOf(w).props("expandedUid")).not.toBeNull(); // still zoomed, just a different cell
    w.unmount();
  });

  // Regression: shortcuts used to be handed the visible page slice, so a cell calling from
  // another page was unreachable and the page maths were computed against the wrong origin.
  it("reaches a terminal on another page, and shows that page", async () => {
    const w = await mountShortcutGrid(PAGE_SIZE + 3, { page: 0 });
    gridOf(w).vm.$emit("focus-cell", PAGE_SIZE - 1); // last cell of page 0
    await flushPromises();
    await press("F9");
    // It moved onto a cell the first page does not contain...
    expect(focused.at(-1)).toBe(`cell-${PAGE_SIZE}`);
    // ...and that cell is now among the rendered ones.
    expect(
      gridOf(w)
        .props("cells")
        .map((c: { uid: number }) => c.uid),
    ).toContain(PAGE_SIZE);
    w.unmount();
  });

  it("PageDown/PageUp walk the enlarged terminal and stop at the ends", async () => {
    const w = await mountShortcutGrid(4);
    gridOf(w).vm.$emit("focus-cell", 0);
    await flushPromises();
    await press("F8");
    expect(gridOf(w).props("expandedUid")).toBe(0);
    await press("PageDown");
    expect(gridOf(w).props("expandedUid")).toBe(1);
    await press("PageUp");
    expect(gridOf(w).props("expandedUid")).toBe(0);
    await press("PageUp"); // already at the front — stays put
    expect(gridOf(w).props("expandedUid")).toBe(0);
    w.unmount();
  });

  it("leaves Shift+PageDown to the terminal when only the bare key is bound", async () => {
    const w = await mountShortcutGrid(4);
    await press("F8");
    const before = gridOf(w).props("expandedUid");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", shiftKey: true, bubbles: true }));
    await flushPromises();
    expect(gridOf(w).props("expandedUid")).toBe(before);
    w.unmount();
  });

  it("ignores an unbound key", async () => {
    const w = await mountShortcutGrid(4);
    await press("F7");
    expect(gridOf(w).props("expandedUid")).toBeNull();
    expect(focused).toEqual([]);
    w.unmount();
  });
});

// --- Column and page keys (R3) --------------------------------------------------------
//
// The half of the keyboard the plain grid needed: upstream's actions all act on the ZOOMED
// cell, so an un-zoomed 9-column grid could only be driven with the mouse. The pure transforms
// are in gridTabs.spec.ts; what is wired HERE is which list each key is given, that a column
// key moves the CURSOR rather than the layout, and that a page key cannot collapse the zoom.
const R3_KEYMAP = {
  "zoom-toggle": "F8",
  "focus-next-column": "F5",
  "focus-prev-column": "F4",
  "page-next": "F6",
  "page-prev": "F7",
};

// The real grid reports focus back up on `focusin`; the stub cannot, so echo it by hand.
const echoFocus = async (w: ReturnType<typeof mount>) => {
  const uid = Number(focused.at(-1)?.replace("cell-", ""));
  gridOf(w).vm.$emit("focus-cell", uid);
  await flushPromises();
};

describe("GridView column and page keys (R3)", () => {
  beforeEach(() => {
    focused.length = 0;
  });

  it("moves the cursor one column at a time, and stops at the last one", async () => {
    const w = await mountShortcutGrid(3, {}, R3_KEYMAP);
    gridOf(w).vm.$emit("focus-cell", 0);
    await flushPromises();

    await press("F5");
    expect(focused.at(-1)).toBe("cell-1");
    await echoFocus(w);
    await press("F5");
    expect(focused.at(-1)).toBe("cell-2");
    await echoFocus(w);

    focused.length = 0;
    await press("F5"); // last column — nothing to move to
    expect(focused).toEqual([]);
    w.unmount();
  });

  it("moves the cursor back, and stops at the first column", async () => {
    const w = await mountShortcutGrid(3, {}, R3_KEYMAP);
    gridOf(w).vm.$emit("focus-cell", 1);
    await flushPromises();
    await press("F4");
    expect(focused.at(-1)).toBe("cell-0");
    await echoFocus(w);

    focused.length = 0;
    await press("F4");
    expect(focused).toEqual([]);
    w.unmount();
  });

  // Zoom invariant 1: a key that only claims to move the cursor must not rearrange the layout.
  it("NEVER enlarges or collapses — it only moves the cursor", async () => {
    const w = await mountShortcutGrid(3, {}, R3_KEYMAP);
    gridOf(w).vm.$emit("focus-cell", 0);
    await flushPromises();
    await press("F5");
    expect(gridOf(w).props("expandedUid")).toBeNull();
    w.unmount();
  });

  // Zoomed there are no columns on screen to walk — one terminal fills the stage — so the key
  // does the same gesture one level up and moves the enlargement.
  it("moves the ENLARGEMENT while zoomed, without leaving the zoom", async () => {
    const w = await mountShortcutGrid(3, {}, R3_KEYMAP);
    gridOf(w).vm.$emit("focus-cell", 0);
    await flushPromises();
    await press("F8");
    expect(gridOf(w).props("expandedUid")).toBe(0);
    await press("F5");
    expect(gridOf(w).props("expandedUid")).toBe(1);
    await press("F4");
    expect(gridOf(w).props("expandedUid")).toBe(0);
    await press("F4"); // at the front — stays, and stays zoomed
    expect(gridOf(w).props("expandedUid")).toBe(0);
    w.unmount();
  });

  it("pages forward and back, stopping at both ends", async () => {
    const w = await mountShortcutGrid(PAGE_SIZE + 3, { page: 0 }, R3_KEYMAP);
    const uids = () =>
      gridOf(w)
        .props("cells")
        .map((c: { uid: number }) => c.uid);
    expect(uids()).toContain(0);

    await press("F6");
    expect(uids()).toContain(PAGE_SIZE); // page 2
    expect(uids()).not.toContain(0);

    await press("F6"); // last page — stays
    expect(uids()).toContain(PAGE_SIZE);

    await press("F7");
    expect(uids()).toContain(0);
    await press("F7"); // first page — stays
    expect(uids()).toContain(0);
    w.unmount();
  });

  // switchPage clears the zoom, so a page key that acted while zoomed would collapse the whole
  // layout — the exact unpredictability zoom invariant 1 exists to prevent.
  it("does nothing while zoomed, so it can never collapse the zoom", async () => {
    const w = await mountShortcutGrid(PAGE_SIZE + 3, { page: 0 }, R3_KEYMAP);
    gridOf(w).vm.$emit("focus-cell", 0);
    await flushPromises();
    await press("F8");
    expect(gridOf(w).props("expandedUid")).toBe(0);
    await press("F6");
    expect(gridOf(w).props("expandedUid")).toBe(0);
    w.unmount();
  });

  // The end-to-end reason `code` matching exists: on the operator's Mac, Option+l arrives as
  // "¬". Matched on `key` alone, every default this fork ships would be dead on arrival.
  it("runs the shipped defaults from the characters macOS actually sends", async () => {
    const w = await mountShortcutGrid(3, {}, null); // no config keymap -> DEFAULT_KEYMAP
    gridOf(w).vm.$emit("focus-cell", 0);
    await flushPromises();

    await pressAlt("KeyL", "¬"); // focus-next-column
    expect(focused.at(-1)).toBe("cell-1");
    await echoFocus(w);
    await pressAlt("KeyJ", "∆"); // focus-prev-column
    expect(focused.at(-1)).toBe("cell-0");
    await echoFocus(w);

    await pressAlt("KeyZ", "Ω"); // zoom-toggle
    expect(gridOf(w).props("expandedUid")).toBe(0);
    w.unmount();
  });
});

// R1 (workspaces). Two things GridView owns rather than gridTabs: WHICH saved grid this browser
// window reads, and the fact that naming and pinning a page happen on the tab row that already
// existed — no second toolbar row, because every row costs each column readable lines.
const TabsGridStub = { name: "TerminalGrid", props: ["cells", "expandedUid", "pageTargets"], template: '<div class="tabs-stub" />' };

// One page's worth of sessions plus one, so the grid always shows two tabs.
const overOnePage = PAGE_SIZE + 1;
const overOnePageSessions = (from: number) =>
  Array.from({ length: overOnePage }, (_, i) => ({ uid: from + i, session: `${String((from + i) % 10).repeat(8)}-cccc-cccc-cccc-cccccccccccc`, cwd: "/w" }));

const mountTabs = async () => {
  const w = mount((await import("../../../src/components/GridView.vue")).default, {
    global: { stubs: { TerminalGrid: TabsGridStub, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
  });
  await flushPromises();
  return w;
};

describe("GridView workspaces (R1)", () => {
  const setSearch = (search: string) => window.history.replaceState({}, "", `/terminals${search}`);
  beforeEach(() => setSearch(""));

  it("gives a ?ws= window its own saved grid, leaving the default window's untouched", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: overOnePageSessions(0), page: 0, sortMode: "manual" }));
    setSearch("?ws=right");
    const w = await mountTabs();
    // The named workspace starts empty rather than inheriting the other window's columns.
    const grid = w.findComponent(TabsGridStub);
    expect(grid.props("cells")).toHaveLength(1);
    grid.vm.$emit("cwd", 0, "/elsewhere");
    await flushPromises();
    // …and what it saves lands on its own key, leaving the default window's grid alone.
    expect(JSON.parse(localStorage.getItem("grid_v2:right") ?? "{}").cells).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("grid_v2") ?? "{}").cells).toHaveLength(overOnePage); // untouched
    w.unmount();
  });

  it("names a page from the tab row itself: double-click, type, Enter", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: overOnePageSessions(0), page: 0, sortMode: "manual" }));
    const w = await mountTabs();
    const tabs = () => w.findAll("nav[aria-label='Grid tabs'] .grid-tab");
    expect(tabs().map((t) => t.text())).toEqual(["1", "2"]);
    await tabs()[0].trigger("dblclick");
    const input = w.find("nav[aria-label='Grid tabs'] input");
    await input.setValue("orosy");
    await input.trigger("keydown.enter");
    expect(tabs()[0].text()).toBe("orosy");
    expect(JSON.parse(localStorage.getItem("grid_v2") ?? "{}").pages[0].label).toBe("orosy");
    w.unmount();
  });

  it("abandons a rename on Escape", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: overOnePageSessions(0), page: 0, sortMode: "manual" }));
    const w = await mountTabs();
    await w.findAll("nav[aria-label='Grid tabs'] .grid-tab")[0].trigger("dblclick");
    const input = w.find("nav[aria-label='Grid tabs'] input");
    await input.setValue("nope");
    await input.trigger("keydown.esc");
    expect(w.findAll("nav[aria-label='Grid tabs'] .grid-tab")[0].text()).toBe("1");
    w.unmount();
  });

  // Page-move: the pane toolbar's page menu, wired end to end — GridView decides the targets and
  // applies the move; the cell only asks.
  it("sends a column to another page from the pane menu (move-to-page)", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: overOnePageSessions(0), page: 0, sortMode: "manual" }));
    const w = await mountTabs();
    const grid = w.findComponent(TabsGridStub);
    // Every column is offered the OTHER page and a fresh one, under the operator's own words.
    expect(grid.props("pageTargets")[0]).toEqual([
      { page: 1, label: "2枚目" },
      { page: 2, label: "3枚目（新規）" },
    ]);
    expect(grid.props("pageTargets")[overOnePage - 1]).toEqual([
      { page: 0, label: "1枚目" },
      { page: 2, label: "3枚目（新規）" },
    ]);
    grid.vm.$emit("move-to-page", 0, 1);
    await flushPromises();
    const saved = JSON.parse(localStorage.getItem("grid_v2") ?? "{}");
    expect(saved.cells).toHaveLength(overOnePage); // nothing forked or dropped
    expect(saved.cells.at(-1).uid).toBe(0); // the column now lives on page 2
    w.unmount();
  });

  it("pins a page from the same tab, and a pinned page stops closing a column pulling the next page's terminal in", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: [...overOnePageSessions(0), ...overOnePageSessions(20)], page: 0, sortMode: "manual" }));
    const w = await mountTabs();
    const grid = w.findComponent(TabsGridStub);
    const onPage0 = () => grid.props("cells").map((c: { uid: number }) => c.uid);
    expect(onPage0()).toEqual(Array.from({ length: PAGE_SIZE }, (_, i) => i));
    await w.findAll("nav[aria-label='Grid tabs'] .grid-tab")[0].trigger("contextmenu");
    grid.vm.$emit("close", 0);
    await flushPromises();
    // One column short on the pinned page — nothing flowed back from page 2.
    expect(onPage0()).toEqual(Array.from({ length: PAGE_SIZE - 1 }, (_, i) => i + 1));
    expect(JSON.parse(localStorage.getItem("grid_v2") ?? "{}").pages[0].pinned).toBe(true);
    w.unmount();
  });
});

// R12 (fork-local, iTerm2 mode): the Fork button's end-to-end wiring inside the view — a cell
// asks, and the grid opens the branch in the column next to it, already launching.
const ForkGridStub = { name: "TerminalGrid", props: ["cells", "expandedUid", "autoLaunchUid"], template: '<div class="fork-stub" />' };

describe("GridView fork (R12)", () => {
  const A = "aaaaaaaa-1111-1111-1111-111111111111";
  const B = "bbbbbbbb-2222-2222-2222-222222222222";

  it("opens the branch beside its source, carrying the fork request and auto-launching it", async () => {
    localStorage.setItem(
      "grid_v2",
      JSON.stringify({
        cells: [
          { uid: 0, session: A, cwd: "/w/proj" },
          { uid: 1, session: B, cwd: "/w/other" },
        ],
        page: 0,
        sortMode: "manual",
      }),
    );
    const w = mount((await import("../../../src/components/GridView.vue")).default, {
      global: { stubs: { TerminalGrid: ForkGridStub, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
    });
    await flushPromises();
    const grid = w.findComponent(ForkGridStub);
    grid.vm.$emit("fork", 0);
    await flushPromises();

    const cells = grid.props("cells") as { uid: number; session: string | null; cwd: string | null; fork?: string | null }[];
    expect(cells.map((c) => c.uid)).toEqual([0, 2, 1]); // the branch sits next to the cell it came from
    expect(cells[1]).toMatchObject({ session: null, cwd: "/w/proj", fork: A });
    // No launch form to stop at: the directory and the conversation both come from the source.
    expect(grid.props("autoLaunchUid")).toBe(2);
    w.unmount();
  });
});
