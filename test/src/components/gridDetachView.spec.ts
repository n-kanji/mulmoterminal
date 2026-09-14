// The two windows' handshake, wired through the view (operator request 2026-09-14): tearing the
// page off writes a workspace and opens a window, the ghost tab brings it back, and a window
// that went home stops being a window on those sessions. The transforms have their own spec —
// this is the part that only exists in a browser.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { PAGE_SIZE } from "../../../src/components/gridTabs";

vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({ subscribe: () => () => {}, onReconnect: () => () => {} }),
}));
vi.mock("../../../src/composables/useGridActivity", () => ({ useGridActivity: () => ({ activity: new Map() }) }));

const GridStub = { name: "TerminalGrid", props: ["cells", "expandedUid"], template: '<div class="grid-stub" />' };
const ToolbarStub = { name: "AppToolbar", template: "<div><slot name='tabs' /></div>" };
const SettingsStub = { name: "SettingsModal", template: "<div />" };

const setSearch = (search: string) => window.history.replaceState({}, "", `/terminals${search}`);
const id = (n: number) => `${String(n).padStart(8, "0")}-cccc-cccc-cccc-cccccccccccc`;
const sessions = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ uid: from + i, session: id(from + i), cwd: "/w" }));

let opened: Array<{ url: string; name: string }>;
let closed: number;

beforeEach(() => {
  localStorage.clear();
  setSearch("");
  opened = [];
  closed = 0;
  vi.stubGlobal(
    "open",
    vi.fn((url: string, name: string) => {
      opened.push({ url, name });
      return { focus: () => {} } as unknown as Window;
    }),
  );
  vi.stubGlobal(
    "close",
    vi.fn(() => closed++),
  );
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/config")) {
      return {
        ok: true,
        json: async () => ({ cwd: "/w", home: "/w", cwdPresets: [], soundFile: null, pushEnabled: false, prRepos: [], launchers: [], userMcpServers: [] }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
});
afterEach(() => vi.unstubAllGlobals());

const mountGrid = async () => {
  const w = mount((await import("../../../src/components/GridView.vue")).default, {
    global: { stubs: { TerminalGrid: GridStub, AppToolbar: ToolbarStub, SettingsModal: SettingsStub } },
  });
  await flushPromises();
  return w;
};

const saved = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");
const detachButton = (w: ReturnType<typeof mount>) => w.find("[data-testid='grid-detach-page']");
const ghostTabs = (w: ReturnType<typeof mount>) => w.findAll("[data-testid='grid-detached-tab']");

// A grid of two pages: a full first page and one column on the second.
const twoPages = () => localStorage.setItem("grid_v2", JSON.stringify({ cells: sessions(PAGE_SIZE + 1), page: 1, sortMode: "manual" }));

describe("tearing a page off into its own window", () => {
  it("moves the page into a workspace of its own and opens a window on it", async () => {
    twoPages();
    const w = await mountGrid();
    await detachButton(w).trigger("click");
    await flushPromises();

    // The page is gone from HERE — two windows on one session is a pane that dies in one of them.
    expect(saved("grid_v2").cells).toHaveLength(PAGE_SIZE);
    // …and is waiting in its own workspace, pointed back at the window it came from.
    const child = saved("grid_v2:page2");
    expect(child.cells.map((c: { session: string }) => c.session)).toEqual([id(PAGE_SIZE)]);
    expect(child.origin).toBe("grid_v2");
    expect(saved("grid_v2::detached")).toEqual([{ ws: "page2", label: "2", at: expect.any(Number) }]);
    expect(opened).toEqual([{ url: "/terminals?ws=page2", name: "page2" }]);
    w.unmount();
  });

  it("puts everything back when the browser blocks the window", async () => {
    twoPages();
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const w = await mountGrid();
    await detachButton(w).trigger("click");
    await flushPromises();

    expect(saved("grid_v2").cells).toHaveLength(PAGE_SIZE + 1); // the page never left
    expect(localStorage.getItem("grid_v2:page2")).toBeNull();
    expect(localStorage.getItem("grid_v2::detached")).toBeNull();
    expect(w.text()).toContain("ポップアップ");
    w.unmount();
  });

  it("does not move the page when the register cannot be written", async () => {
    twoPages();
    // The register is the only record that a `grid_v2:<ws>` belongs to this window: without it
    // the page would have no ghost tab and would not be recognised when it asked to come home.
    const realSet = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.endsWith("::detached")) throw new Error("quota exceeded");
      realSet.call(this, key, value);
    });
    const w = await mountGrid();
    await detachButton(w).trigger("click");
    await flushPromises();

    expect(saved("grid_v2").cells).toHaveLength(PAGE_SIZE + 1); // still here
    expect(localStorage.getItem("grid_v2:page2")).toBeNull(); // and nothing left behind
    expect(opened).toEqual([]);
    spy.mockRestore();
    w.unmount();
  });

  it("cannot be asked for when there is only one page", async () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: sessions(2), page: 0, sortMode: "manual" }));
    const w = await mountGrid();
    expect(detachButton(w).attributes("disabled")).toBeDefined();
    expect(detachButton(w).attributes("title")).toContain("1枚");
    w.unmount();
  });

  it("takes the page's name, account and columns with it", async () => {
    localStorage.setItem(
      "grid_v2",
      JSON.stringify({
        cells: [...sessions(PAGE_SIZE), { uid: 99, session: id(9), cwd: "/w", name: "決済", account: "b@orosy.co.jp" }],
        page: 1,
        sortMode: "manual",
        pages: [{}, { label: "work", account: "b@orosy.co.jp" }],
      }),
    );
    const w = await mountGrid();
    await detachButton(w).trigger("click");
    await flushPromises();
    const child = saved("grid_v2:work");
    expect(child.pages[0]).toMatchObject({ label: "work", account: "b@orosy.co.jp" });
    expect(child.cells[0]).toMatchObject({ name: "決済", account: "b@orosy.co.jp" });
    w.unmount();
  });
});

describe("bringing a page back", () => {
  // A page already out on loan, as the register and its workspace would be found on startup.
  const outOnLoan = () => {
    localStorage.setItem("grid_v2", JSON.stringify({ cells: sessions(2), page: 0, sortMode: "manual" }));
    localStorage.setItem("grid_v2::detached", JSON.stringify([{ ws: "page2", label: "work", at: 1 }]));
    localStorage.setItem(
      "grid_v2:page2",
      JSON.stringify({ cells: [{ uid: 0, session: id(50), cwd: "/w" }], page: 0, sortMode: "manual", origin: "grid_v2", pages: [{ label: "work" }] }),
    );
  };

  it("shows the page as a ghost tab, and one click takes it back", async () => {
    outOnLoan();
    const w = await mountGrid();
    expect(ghostTabs(w)).toHaveLength(1);
    expect(ghostTabs(w)[0].text()).toContain("work");

    await ghostTabs(w)[0].trigger("click");
    await flushPromises();
    const back = saved("grid_v2");
    expect(back.cells.map((c: { session: string }) => c.session)).toContain(id(50));
    expect(back.pages.at(-1).label).toBe("work");
    // The other window watches this key: removing it is how it learns to stand down.
    expect(localStorage.getItem("grid_v2:page2")).toBeNull();
    expect(localStorage.getItem("grid_v2::detached")).toBeNull();
    expect(ghostTabs(w)).toHaveLength(0);
    w.unmount();
  });

  it("takes the page from a window that went home while this one was closed", async () => {
    outOnLoan();
    localStorage.setItem(
      "grid_v2::home:page2",
      JSON.stringify({ ws: "page2", pages: [{ meta: { label: "work" }, cells: [{ uid: 0, session: id(50), cwd: "/w" }] }], at: 2 }),
    );
    const w = await mountGrid();
    await flushPromises();
    expect(saved("grid_v2").cells.map((c: { session: string }) => c.session)).toContain(id(50));
    expect(localStorage.getItem("grid_v2::home:page2")).toBeNull();
    expect(localStorage.getItem("grid_v2:page2")).toBeNull();
    w.unmount();
  });

  it("takes it the moment the other window says so", async () => {
    outOnLoan();
    const w = await mountGrid();
    // What the other window does: write the note, which reaches us as a storage event.
    const note = JSON.stringify({ ws: "page2", pages: [{ meta: {}, cells: [{ uid: 0, session: id(50), cwd: "/w" }] }], at: 3 });
    localStorage.setItem("grid_v2::home:page2", note);
    window.dispatchEvent(new StorageEvent("storage", { key: "grid_v2::home:page2", newValue: note }));
    await flushPromises();
    expect(saved("grid_v2").cells.map((c: { session: string }) => c.session)).toContain(id(50));
    expect(ghostTabs(w)).toHaveLength(0);
    w.unmount();
  });

  it("ignores a note about a page this window never lent out", async () => {
    outOnLoan();
    const w = await mountGrid();
    const strangerNote = JSON.stringify({ ws: "stranger", pages: [{ meta: {}, cells: [{ uid: 0, session: id(77), cwd: "/w" }] }], at: 3 });
    localStorage.setItem("grid_v2::home:stranger", strangerNote);
    window.dispatchEvent(new StorageEvent("storage", { key: "grid_v2::home:stranger", newValue: strangerNote }));
    await flushPromises();
    expect(saved("grid_v2").cells.map((c: { session: string }) => c.session)).not.toContain(id(77));
    expect(localStorage.getItem("grid_v2::home:stranger")).toBeNull(); // and the note is not left lying around
    w.unmount();
  });

  it("forgets a page whose window was cleared by hand", async () => {
    outOnLoan();
    localStorage.removeItem("grid_v2:page2");
    const w = await mountGrid();
    expect(ghostTabs(w)).toHaveLength(0);
    expect(localStorage.getItem("grid_v2::detached")).toBeNull();
    w.unmount();
  });
});

describe("the window that holds a torn-off page", () => {
  const asDetachedWindow = () => {
    setSearch("?ws=page2");
    localStorage.setItem(
      "grid_v2:page2",
      JSON.stringify({ cells: [{ uid: 0, session: id(50), cwd: "/w" }], page: 0, sortMode: "manual", origin: "grid_v2", pages: [{ label: "work" }] }),
    );
  };

  it("offers to go home instead of tearing off another page", async () => {
    asDetachedWindow();
    const w = await mountGrid();
    expect(detachButton(w).exists()).toBe(false);
    expect(w.find("[data-testid='grid-go-home']").exists()).toBe(true);
    w.unmount();
  });

  it("leaves the page for the other window, closes, and writes nothing more", async () => {
    asDetachedWindow();
    const w = await mountGrid();
    await w.find("[data-testid='grid-go-home']").trigger("click");
    await flushPromises();

    const note = saved("grid_v2::home:page2");
    expect(note.ws).toBe("page2");
    expect(note.pages[0].cells[0].session).toBe(id(50));
    expect(note.pages[0].meta.label).toBe("work");
    expect(closed).toBe(1);
    // Its own grid is left in place: a note the other window never takes must still be findable.
    expect(localStorage.getItem("grid_v2:page2")).not.toBeNull();
    // The terminals are gone from this window — it is not on those sessions any more.
    expect(w.findComponent(GridStub).exists()).toBe(false);
    expect(w.text()).toContain("元のウィンドウに戻しました");

    // …and nothing this window does now can write that grid back.
    localStorage.setItem("grid_v2:page2", "{}");
    w.findComponent(ToolbarStub); // a render pass
    await flushPromises();
    expect(localStorage.getItem("grid_v2:page2")).toBe("{}");
    w.unmount();
  });

  it("stands down when the other window calls the page back", async () => {
    asDetachedWindow();
    const w = await mountGrid();
    window.dispatchEvent(new StorageEvent("storage", { key: "grid_v2:page2", newValue: null }));
    await flushPromises();
    expect(closed).toBe(1);
    expect(w.findComponent(GridStub).exists()).toBe(false);
    w.unmount();
  });

  it("leaves no page controls behind once it has gone home", async () => {
    asDetachedWindow();
    const w = await mountGrid();
    await w.find("[data-testid='grid-go-home']").trigger("click");
    await flushPromises();
    // Nothing to click twice: a second hand-over, or a page opened in a window that is done.
    expect(w.find("nav[aria-label='Grid tabs']").exists()).toBe(false);
    w.unmount();
  });
});
