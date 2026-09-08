import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { PRESET_UNDO_MS } from "../../../src/components/presetUndo";
import { TYPING_HOLD_MS, XTERM_TEXTAREA_CLASS } from "../../../src/composables/useTypingHold";
import { openAgentColumn } from "../../../src/composables/useAgentColumn";
import type { Cell } from "../../../src/components/gridTabs";

// R10, the three parts that live in GridView: the preset-removal undo, the auto sort held under
// a cursor mid-sentence, and the agent API's `label` landing on the column it opened.

vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({ subscribe: () => () => {}, onReconnect: () => () => {} }),
}));
// Empty: this suite drives status through the cells' own reports (the grid's `statusByUid`),
// which is what an un-sessioned or just-launched cell uses anyway.
vi.mock("../../../src/composables/useGridActivity", () => ({ useGridActivity: () => ({ activity: new Map() }) }));

const IDS = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];

// A stand-in server for /api/config: a GET hydrates from it, a POST replaces the preset list —
// so the undo's re-registration is observed the way the real one is (the list comes back).
let serverPresets: Array<{ label: string; path: string }> = [];
const posts: unknown[] = [];

beforeEach(() => {
  localStorage.clear();
  posts.length = 0;
  serverPresets = [
    { label: "orosy", path: "/w/orosy" },
    { label: "mulmo", path: "/w/mulmo" },
    { label: "docs", path: "/w/docs" },
  ];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/config")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (Array.isArray(body.cwdPresets)) serverPresets = body.cwdPresets;
      }
      return { ok: true, json: async () => ({ cwd: "/w", home: "/w", cwdPresets: serverPresets, launchers: [] }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

// The toolbar, reduced to the two chip events and the prop the undo draws from.
const ToolbarStub = {
  name: "AppToolbar",
  props: ["presets", "undoChip"],
  emits: ["remove-preset", "undo-remove-preset"],
  template: '<div class="toolbar-stub" />',
};
// The grid, reduced to the cells it is asked to render (their order is what this suite reads).
const GridStub = { name: "TerminalGrid", props: ["cells", "listRows", "expandedUid", "groups"], emits: ["status", "session"], template: '<div class="grid-stub" />' };

// Wrapped in <KeepAlive>, as the router mounts it: the grid registers the agent-column opener
// in `onActivated`, which never fires for a component mounted bare — and an unregistered opener
// queues the request instead of opening the column.
const mountGrid = async () => {
  const GridView = (await import("../../../src/components/GridView.vue")).default;
  const w = mount(
    { components: { GridView }, template: "<KeepAlive><GridView /></KeepAlive>" },
    { global: { stubs: { AppToolbar: ToolbarStub, TerminalGrid: GridStub, AppSettingsModal: true, GuideLinks: true } } },
  );
  await flushPromises();
  return w;
};

const toolbar = (w: Awaited<ReturnType<typeof mountGrid>>) => w.findComponent(ToolbarStub);
const grid = (w: Awaited<ReturnType<typeof mountGrid>>) => w.findComponent(GridStub);
const renderedUids = (w: Awaited<ReturnType<typeof mountGrid>>) => (grid(w).props("cells") as Cell[]).map((c) => c.uid);

const threeCells = () =>
  localStorage.setItem(
    "grid_v2",
    JSON.stringify({
      cells: IDS.map((session, i) => ({ uid: i, session, cwd: "/w" })),
      expanded: null,
      page: 0,
      sortMode: "auto",
    }),
  );

describe("undoing a preset removal", () => {
  it("offers the undo in the removed chip's slot, then takes it back", async () => {
    const w = await mountGrid();
    toolbar(w).vm.$emit("remove-preset", "/w/mulmo");
    await flushPromises();
    expect(serverPresets.map((p) => p.path)).toEqual(["/w/orosy", "/w/docs"]);
    expect(toolbar(w).props("undoChip")).toEqual({ label: "mulmo", index: 1 });

    toolbar(w).vm.$emit("undo-remove-preset");
    await flushPromises();
    // Back where it was, not at the front: the strip is hand-ordered.
    expect(serverPresets.map((p) => p.path)).toEqual(["/w/orosy", "/w/mulmo", "/w/docs"]);
    expect(toolbar(w).props("undoChip")).toBeNull();
  });

  it("expires on its own after the undo window", async () => {
    vi.useFakeTimers();
    const w = await mountGrid();
    toolbar(w).vm.$emit("remove-preset", "/w/orosy");
    await flushPromises();
    expect(toolbar(w).props("undoChip")).not.toBeNull();
    vi.advanceTimersByTime(PRESET_UNDO_MS + 10);
    await flushPromises();
    expect(toolbar(w).props("undoChip")).toBeNull();
    // And an expired undo restores nothing — the only writes are the removal itself.
    expect(posts.filter((p) => (p as { cwdPresets?: unknown }).cwdPresets)).toHaveLength(1);
  });

  it("offers nothing for a path the list never had", async () => {
    const w = await mountGrid();
    toolbar(w).vm.$emit("remove-preset", "/w/never");
    await flushPromises();
    expect(toolbar(w).props("undoChip")).toBeNull();
  });

  // A second removal replaces the offer rather than stacking one: only the most recent
  // mis-click is still on screen to take back.
  it("keeps only the newest removal undoable", async () => {
    const w = await mountGrid();
    toolbar(w).vm.$emit("remove-preset", "/w/orosy");
    await flushPromises();
    toolbar(w).vm.$emit("remove-preset", "/w/docs");
    await flushPromises();
    expect(toolbar(w).props("undoChip")).toEqual({ label: "docs", index: 1 }); // docs, after orosy left
    toolbar(w).vm.$emit("undo-remove-preset");
    await flushPromises();
    expect(serverPresets.map((p) => p.path)).toEqual(["/w/mulmo", "/w/docs"]);
  });
});

describe("holding the auto sort while a terminal is being typed into", () => {
  const typeInATerminal = () => {
    const el = document.createElement("textarea");
    el.className = XTERM_TEXTAREA_CLASS;
    document.body.appendChild(el);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    return el;
  };

  it("re-sorts normally when nobody is typing", async () => {
    threeCells();
    const w = await mountGrid();
    expect(renderedUids(w)).toEqual([0, 1, 2]);
    grid(w).vm.$emit("status", 2, "approval");
    await flushPromises();
    expect(renderedUids(w)).toEqual([2, 0, 1]); // attention-first, the point of auto mode
  });

  // The failure this prevents: the columns slide under the cursor mid-sentence and the rest of
  // the keystrokes land in whatever took the slot. They are gone by then — nothing to undo.
  it("does not move the columns while the operator is typing", async () => {
    vi.useFakeTimers();
    threeCells();
    const w = await mountGrid();
    typeInATerminal();
    await flushPromises();
    grid(w).vm.$emit("status", 2, "approval");
    await flushPromises();
    expect(renderedUids(w)).toEqual([0, 1, 2]);
  });

  it("applies the pending order two seconds after the typing stops", async () => {
    vi.useFakeTimers();
    threeCells();
    const w = await mountGrid();
    typeInATerminal();
    await flushPromises();
    grid(w).vm.$emit("status", 2, "approval");
    await flushPromises();
    expect(renderedUids(w)).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(TYPING_HOLD_MS + 10);
    await flushPromises();
    expect(renderedUids(w)).toEqual([2, 0, 1]);
  });

  it("applies it immediately when the terminal loses focus instead", async () => {
    vi.useFakeTimers();
    threeCells();
    const w = await mountGrid();
    const el = typeInATerminal();
    await flushPromises();
    grid(w).vm.$emit("status", 2, "approval");
    await flushPromises();
    expect(renderedUids(w)).toEqual([0, 1, 2]);
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flushPromises();
    expect(renderedUids(w)).toEqual([2, 0, 1]);
  });
});

describe("a column opened by the agent self-drive API", () => {
  it("wears the request's label as its name", async () => {
    const w = await mountGrid();
    openAgentColumn({ cwd: "/w/worker", label: "worker-3" });
    await flushPromises();
    const opened = (grid(w).props("cells") as Cell[]).find((c) => c.cwd === "/w/worker");
    expect(opened?.name).toBe("worker-3");
  });

  it("seats a column beside the pane that asked for it, and marks it as that pane's child", async () => {
    const w = await mountGrid();
    const parentId = "11111111-2222-4333-8444-555555555555";
    const parentUid = (grid(w).props("cells") as Cell[])[0].uid;
    grid(w).vm.$emit("session", parentUid, parentId);
    await flushPromises();
    openAgentColumn({ cwd: "/w/worker", label: "worker-3", parent: parentId });
    await flushPromises();
    const after = grid(w).props("cells") as Cell[];
    const at = after.findIndex((c) => c.cwd === "/w/worker");
    expect(after[at]?.parent).toBe(parentUid);
    expect(after[at - 1]?.uid).toBe(parentUid);
    const groups = grid(w).props("groups") as Record<number, { parent: string | null }>;
    expect(groups[after[at]?.uid ?? -1]?.parent).toBeTruthy();
  });

  it("leaves a column unnamed when the request carried no label", async () => {
    const w = await mountGrid();
    openAgentColumn({ cwd: "/w/plain", label: null });
    await flushPromises();
    const opened = (grid(w).props("cells") as Cell[]).find((c) => c.cwd === "/w/plain");
    expect(opened?.name).toBeUndefined();
  });
});
