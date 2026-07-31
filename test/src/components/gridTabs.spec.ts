import { describe, it, expect } from "vitest";
import type { RunCommand } from "../../../src/components/runCommand.js";
import {
  pageCount,
  pageSlice,
  resolveCellStatus,
  runningCount,
  addCell,
  addCellWithCwd,
  setSession,
  setCwd,
  closeCell,
  toggleExpand,
  switchPage,
  runCommand,
  runScriptInNewCell,
  insertCellAfter,
  shellCell,
  launchInCell,
  canMoveCell,
  setSortMode,
  moveCell,
  moveCellTo,
  moveZoom,
  toggleZoom,
  nextAttention,
  nextAttentionUid,
  orderCells,
  visibleOrdered,
  activityStatus,
  countByStatus,
  cancelableLaunchUid,
  zoomedUid,
  visibleCells,
  parseGridState,
  migrateLegacy,
  initialState,
  type CellStatus,
  type GridState,
  type Cell,
  type PageMeta,
  type StatusCounts,
  gridStatusSummary,
  isHole,
  realCells,
  reserveSlots,
  pageLabel,
  isPagePinned,
  setPageLabel,
  togglePagePin,
  orderGrid,
  isSealed,
  workspaceFromSearch,
  stateKeyFor,
  focusStepUid,
  stepPage,
  PAGE_SIZE,
  MAX_PAGE_LABEL,
  MAX_TERMINALS,
  STATE_KEY,
  forkCell,
} from "../../../src/components/gridTabs.js";

// A full seven-state tally with only the interesting entries named. Shared by countByStatus
// and gridStatusSummary so adding a state means editing one literal, not two.
const counts = (over: Partial<StatusCounts> = {}): StatusCounts => ({
  approval: 0,
  question: 0,
  disconnected: 0,
  unread: 0,
  working: 0,
  idle: 0,
  shell: 0,
  ...over,
});

const U = (n: number) => `${String(n % 10).repeat(8)}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
const cell = (uid: number, session: string | null = null, cwd: string | null = null): Cell => ({ uid, session, cwd });
const running = (count: number): Cell[] => Array.from({ length: count }, (_, i) => cell(i, U(i)));
const make = (cells: Cell[], extra: Partial<GridState> = {}): GridState => ({
  cells,
  expanded: null,
  page: 0,
  nextUid: cells.length,
  sortMode: "manual",
  ...extra,
});

describe("pagination helpers", () => {
  it("pageCount is 1..n in chunks of PAGE_SIZE (10 columns)", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(10)).toBe(1);
    expect(pageCount(11)).toBe(2);
    expect(pageCount(20)).toBe(2);
    expect(pageCount(21)).toBe(3);
  });
  it("pageSlice returns the page's window", () => {
    const xs = Array.from({ length: 13 }, (_, i) => i);
    expect(pageSlice(xs, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pageSlice(xs, 1)).toEqual([10, 11, 12]);
  });
  it("runningCount counts non-null sessions", () => {
    expect(runningCount([cell(0, U(0)), cell(1), cell(2, U(2))])).toBe(2);
  });
});

describe("addCell", () => {
  it("appends a launch cell and jumps to its (last) page", () => {
    const s = addCell(make(running(10)));
    expect(s.cells).toHaveLength(11);
    expect(s.cells[10].session).toBeNull();
    expect(s.page).toBe(1); // overflowed to page 2
  });
  it("cancels an open launch cell (but never the sole entry cell)", () => {
    const open = make([...running(2), cell(2)]);
    expect(addCell(open).cells).toHaveLength(2);
    const entryOnly = make([cell(0)]);
    expect(addCell(entryOnly).cells).toHaveLength(1);
  });
  it("does not exceed MAX_TERMINALS", () => {
    const s = addCell(make(running(81)));
    expect(runningCount(s.cells)).toBe(81);
    expect(s.cells).toHaveLength(81);
  });
  it("un-zooms when a cell was zoomed (iTerm2 mode: columns grow sideways, never behind a zoom)", () => {
    const s = addCell(make(running(3), { expanded: 1 }));
    expect(s.cells).toHaveLength(4);
    expect(s.expanded).toBeNull(); // back to the columns so the new pane is visible
  });
  it("leaves the grid un-zoomed when nothing was zoomed", () => {
    expect(addCell(make(running(3))).expanded).toBeNull();
  });
  it("does not zoom the new cell when `expanded` is stale (points at no cell)", () => {
    // zoomedUid treats a dangling `expanded` as not-zoomed, so a new cell must not inherit it.
    const s = addCell(make(running(2), { expanded: 99 }));
    expect(s.expanded).toBe(99); // unchanged; zoomedUid() still resolves it to null
  });
});

describe("moveCellTo (iTerm2 mode drag & drop)", () => {
  it("splices the dragged cell into the target's position, shifting the ones between", () => {
    const s = moveCellTo(make(running(5)), 0, 3);
    expect(s.cells.map((c) => c.uid)).toEqual([1, 2, 3, 0, 4]);
    const back = moveCellTo(make(running(5)), 4, 1);
    expect(back.cells.map((c) => c.uid)).toEqual([0, 4, 1, 2, 3]);
  });
  it("is a no-op onto itself or an unknown uid", () => {
    const s = make(running(3));
    expect(moveCellTo(s, 1, 1)).toBe(s);
    expect(moveCellTo(s, 1, 99)).toBe(s);
    expect(moveCellTo(s, 99, 1)).toBe(s);
  });
});

describe("addCellWithCwd (iTerm2 mode quick launch)", () => {
  it("appends a launch cell already pointed at the directory and returns its uid", () => {
    const { state: s, uid } = addCellWithCwd(make(running(2)), "/proj/a");
    expect(s.cells).toHaveLength(3);
    expect(uid).toBe(s.cells[2].uid);
    expect(s.cells[2].session).toBeNull();
    expect(s.cells[2].cwd).toBe("/proj/a");
  });
  it("reuses an already-open trailing launch cell instead of stacking a second", () => {
    const open = make([...running(2), cell(7)]);
    const { state: s, uid } = addCellWithCwd(open, "/proj/b");
    expect(s.cells).toHaveLength(3);
    expect(uid).toBe(7);
    expect(s.cells[2].cwd).toBe("/proj/b");
  });
  it("un-zooms so the new column is visible, and refuses when full", () => {
    const zoomed = addCellWithCwd(make(running(3), { expanded: 1 }), "/proj/c");
    expect(zoomed.state.expanded).toBeNull();
    const full = addCellWithCwd(make(running(80)), "/proj/d");
    expect(full.uid).toBe(-1);
    expect(full.state.cells).toHaveLength(80);
  });
});

describe("cancelableLaunchUid", () => {
  const CMD: RunCommand = { source: "script", index: 0, label: "Build", cwd: "/x" };
  it("is the trailing launch cell's uid when one is open beyond the entry cell", () => {
    expect(cancelableLaunchUid(make([...running(2), cell(7)]))).toBe(7);
  });
  it("is null for the sole entry cell (nothing to cancel)", () => {
    expect(cancelableLaunchUid(make([cell(0)]))).toBeNull();
  });
  it("is null when the last cell is occupied (running session or command)", () => {
    expect(cancelableLaunchUid(make(running(2)))).toBeNull();
    expect(cancelableLaunchUid(make([...running(1), { uid: 1, session: null, cwd: null, command: CMD }]))).toBeNull();
  });
});

describe("closeCell reflows across pages", () => {
  it("removes a cell and packs later cells forward (page 2 -> page 1)", () => {
    const s = make(running(11), { page: 0 }); // 11 terminals -> 2 pages
    expect(pageCount(s.cells.length)).toBe(2);
    const after = closeCell(s, 0); // close the first terminal
    expect(after.cells).toHaveLength(10); // the 11th flowed back onto page 1
    expect(pageCount(after.cells.length)).toBe(1);
    expect(after.cells.map((c) => c.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("clamps the active page when a page disappears", () => {
    const s = make(running(11), { page: 1 });
    const after = closeCell(s, 0);
    expect(after.page).toBe(0);
  });
  it("keeps an entry cell after the last terminal closes", () => {
    const after = closeCell(make([cell(0, U(0))]), 0);
    expect(after.cells).toHaveLength(1);
    expect(after.cells[0].session).toBeNull();
  });
  it("un-zooms when the zoomed cell is closed with no on-screen order (fallback)", () => {
    const after = closeCell(make(running(2), { expanded: 0 }), 0);
    expect(after.expanded).toBeNull();
  });
  it("stays zoomed on the PREVIOUS cell when the zoomed cell is closed", () => {
    const after = closeCell(make(running(3), { expanded: 1 }), 1, [0, 1, 2]);
    expect(after.expanded).toBe(0);
  });
  it("stays zoomed on the NEXT cell when the FIRST (front) cell is closed", () => {
    const after = closeCell(make(running(3), { expanded: 0 }), 0, [0, 1, 2]);
    expect(after.expanded).toBe(1);
  });
  it("un-zooms when the last remaining cell is closed (no neighbour)", () => {
    const after = closeCell(make(running(1), { expanded: 0 }), 0, [0]);
    expect(after.expanded).toBeNull();
  });
  it("leaves the zoom untouched when a NON-zoomed cell is closed", () => {
    const after = closeCell(make(running(3), { expanded: 2 }), 0, [0, 1, 2]);
    expect(after.expanded).toBe(2);
  });
});

describe("moveZoom (Page Up / Page Down walk the zoom along the filmstrip)", () => {
  const order3 = [0, 1, 2];

  it("moves the zoom forward and back along the on-screen order", () => {
    expect(moveZoom(make(running(3), { expanded: 1 }), order3, 1).expanded).toBe(2);
    expect(moveZoom(make(running(3), { expanded: 1 }), order3, -1).expanded).toBe(0);
  });

  it("stops at either end instead of wrapping", () => {
    expect(moveZoom(make(running(3), { expanded: 2 }), order3, 1).expanded).toBe(2);
    expect(moveZoom(make(running(3), { expanded: 0 }), order3, -1).expanded).toBe(0);
  });

  it("does nothing when nothing is zoomed", () => {
    const s = make(running(3));
    expect(moveZoom(s, order3, 1)).toBe(s);
  });

  it("does nothing when `expanded` is stale (points at a cell that's gone)", () => {
    const s = make(running(3), { expanded: 99 });
    expect(moveZoom(s, order3, 1)).toBe(s);
  });

  it("does nothing when the zoomed cell isn't in the given order", () => {
    const s = make(running(3), { expanded: 2 });
    expect(moveZoom(s, [0, 1], 1)).toBe(s);
  });

  it("does nothing with an empty order", () => {
    const s = make(running(3), { expanded: 1 });
    expect(moveZoom(s, [], 1)).toBe(s);
  });

  it("refuses to zoom a uid the order mentions but the grid no longer has", () => {
    const s = make(running(2), { expanded: 1 });
    expect(moveZoom(s, [0, 1, 42], 1)).toBe(s);
  });

  it("collapsing after walking forward lands on the page holding the cell just viewed", () => {
    // 12 terminals = 2 pages. Zoomed on the last cell of page 0, stepping forward
    // crosses onto page 1.
    const s = make(running(12), { expanded: 9, page: 0 });
    const order = s.cells.map((c) => c.uid);
    const moved = moveZoom(s, order, 1);
    expect(moved.expanded).toBe(10);
    expect(toggleZoom(moved, order).page).toBe(1);
  });

  it("collapsing after walking backwards lands on the earlier page", () => {
    const s = make(running(12), { expanded: 10, page: 1 });
    const order = s.cells.map((c) => c.uid);
    const moved = moveZoom(s, order, -1);
    expect(moved.expanded).toBe(9);
    expect(toggleZoom(moved, order).page).toBe(0);
  });

  it("uses the ORDER's index for the page, not the cell's position in state.cells", () => {
    // "auto" sort can float a later cell to the front; the page must follow what the user
    // is actually looking at on screen.
    const s = make(running(12), { expanded: 11, page: 0 });
    const reversed = [...s.cells.map((c) => c.uid)].reverse(); // 11 is now index 0
    const after = moveZoom(s, reversed, 1);
    expect(after.expanded).toBe(10); // the next one in the ON-SCREEN order
    expect(after.page).toBe(0);
  });
});

describe("toggleZoom (the keyboard's way in and out of the zoom)", () => {
  it("collapses when something is zoomed", () => {
    expect(toggleZoom(make(running(3), { expanded: 1 }), [0, 1, 2]).expanded).toBeNull();
  });

  it("enlarges the FIRST cell in the on-screen order when nothing is zoomed", () => {
    // Page 0, so the page offset is 0 and the order's own first entry wins — this is what makes
    // the "auto" sort put the most-wanting-attention cell under the key.
    expect(toggleZoom(make(running(3)), [2, 0, 1]).expanded).toBe(2);
  });

  it("refuses to zoom with fewer than two running cells (same rule as toggleExpand)", () => {
    const s = make([cell(0, U(0)), cell(1)]); // one running + one empty launcher
    expect(toggleZoom(s, [0, 1])).toBe(s);
  });

  it("still collapses even with one running cell — ⤡ must always get you out", () => {
    expect(toggleZoom(make([cell(0, U(0))], { expanded: 0 }), [0]).expanded).toBeNull();
  });

  it("does nothing with an empty order", () => {
    const s = make(running(3));
    expect(toggleZoom(s, [])).toBe(s);
  });

  // The selection is the focused cell — one notion, not a second "last enlarged" memory that
  // could disagree with it. Collapse then re-expand keeps you on the same terminal because the
  // caller keeps the cursor there.
  it("enlarges the SELECTED cell, not the first of the page", () => {
    const s = make(running(12), { page: 0 });
    const order = s.cells.map((c) => c.uid);
    expect(toggleZoom(s, order, 5).expanded).toBe(5);
  });

  it("round-trips: collapsing then re-expanding the same selection returns to it", () => {
    const s = make(running(12), { page: 0, expanded: 5 });
    const order = s.cells.map((c) => c.uid);
    const collapsed = toggleZoom(s, order, 5);
    expect(collapsed.expanded).toBeNull();
    expect(toggleZoom(collapsed, order, 5).expanded).toBe(5);
  });

  it("falls back to the page's first cell when the selection is gone", () => {
    const s = make(running(12), { page: 1 });
    const order = s.cells.map((c) => c.uid);
    expect(toggleZoom(s, order, 99).expanded).toBe(10);
  });

  // Regression (caught on a real grid, not by the unit tests or the bots): entering the zoom
  // from page 2 enlarged a cell from page 1 and dragged the page back to 0 with it, so ⤡ then
  // dropped the user on the wrong tab. `order` is the whole un-paged list, so the entry index
  // has to be derived from the page being looked at.
  it("enlarges a cell ON THE CURRENT PAGE, not the first of the whole list", () => {
    const s = make(running(12), { page: 1 });
    const order = s.cells.map((c) => c.uid);
    const after = toggleZoom(s, order);
    expect(after.expanded).toBe(10); // first cell of page 1, not uid 0
    expect(toggleZoom(after, order).page).toBe(1); // and releasing stays on that tab
  });

  it("enlarges the first cell of the list when on the first page", () => {
    const s = make(running(12), { page: 0 });
    const order = s.cells.map((c) => c.uid);
    const after = toggleZoom(s, order);
    expect(after.expanded).toBe(0);
    expect(toggleZoom(after, order).page).toBe(0);
  });

  // The rule as the user stated it: the tab shown on release is decided by WHERE THE ENLARGED
  // CELL IS, not by remembering the page they zoomed in from. Reaching a page-1 cell (via the
  // filmstrip, a roster row, or a jump) and releasing must show page 1.
  it("decides the page from the enlarged cell, whatever page the zoom started on", () => {
    const s = make(running(12), { expanded: 10, page: 0 });
    expect(
      toggleZoom(
        s,
        s.cells.map((c) => c.uid),
      ).page,
    ).toBe(1);
  });

  it("keeps the current page when the enlarged cell is no longer in the order", () => {
    const s = make(running(12), { expanded: 10, page: 1 });
    expect(toggleZoom(s, [0, 1, 2]).page).toBe(1);
  });
});

describe("nextAttention (jump to a terminal that needs you)", () => {
  const status = (m: Record<number, CellStatus>): Record<number, CellStatus> => m;

  // F8 alone enlarges and collapses. This key only moves, so pressing it on a plain grid must
  // leave a plain grid — it brings the candidate's page on screen instead.
  it("NEVER enters the zoom from an un-zoomed grid", () => {
    const s = make(running(12), { page: 0 });
    const after = nextAttention(
      s,
      s.cells.map((c) => c.uid),
      status({ 10: "approval" }),
    );
    expect(after.expanded).toBeNull();
    expect(after.page).toBe(1); // but the calling cell is now on screen
  });

  it("NEVER collapses the zoom either — it only moves which cell is enlarged", () => {
    const after = nextAttention(make(running(3), { expanded: 0 }), [0, 1, 2], status({ 2: "approval" }));
    expect(after.expanded).toBe(2);
  });

  it("prefers blocked over done, even when done is nearer", () => {
    const after = nextAttention(make(running(3), { expanded: 0 }), [0, 1, 2], status({ 0: "idle", 1: "unread", 2: "approval" }));
    expect(after.expanded).toBe(2);
  });

  it("starts from the cell AFTER the zoomed one", () => {
    const st = status({ 0: "unread", 1: "unread", 2: "unread" });
    expect(nextAttention(make(running(3), { expanded: 0 }), [0, 1, 2], st).expanded).toBe(1);
    expect(nextAttention(make(running(3), { expanded: 1 }), [0, 1, 2], st).expanded).toBe(2);
  });

  it("wraps around, so repeated presses cycle instead of stopping at the end", () => {
    const st = status({ 0: "unread", 1: "idle", 2: "unread" });
    expect(nextAttention(make(running(3), { expanded: 2 }), [0, 1, 2], st).expanded).toBe(0);
  });

  it("stays put when the zoomed cell is the ONLY one wanting attention", () => {
    const st = status({ 0: "idle", 1: "approval", 2: "idle" });
    expect(nextAttention(make(running(3), { expanded: 1 }), [0, 1, 2], st).expanded).toBe(1);
  });

  it("falls back to an idle cell when nothing is calling, so the key still moves", () => {
    const after = nextAttention(make(running(3), { expanded: 0 }), [0, 1, 2], status({ 0: "idle", 1: "working", 2: "idle" }));
    expect(after.expanded).toBe(2); // skips the working cell at index 1
  });

  it("still prefers a calling cell over a nearer idle one", () => {
    const after = nextAttention(make(running(3), { expanded: 0 }), [0, 1, 2], status({ 0: "idle", 1: "idle", 2: "unread" }));
    expect(after.expanded).toBe(2);
  });

  it("does nothing when every other cell is mid-turn — working is the one place not to go", () => {
    const s = make(running(2));
    expect(nextAttention(s, [0, 1], status({ 0: "working", 1: "working" }))).toBe(s);
  });

  it("treats a cell with no reported status as idle, so a fresh grid still moves", () => {
    const after = nextAttention(make(running(3), { expanded: 0 }), [0, 1, 2], status({}));
    expect(after.expanded).toBe(1);
  });

  it("does nothing with an empty order", () => {
    const s = make(running(3));
    expect(nextAttention(s, [], {})).toBe(s);
  });

  // The trailing launch cell is not a terminal. It also never reports a status, so without an
  // explicit skip it reads as `idle` and gets picked constantly — including as the cell to
  // ENLARGE while zoomed. `ensureEntry`/`addCell` mean one is almost always present.
  it("never picks the empty launch cell, even when it is the only idle thing left", () => {
    const s = make([cell(0, U(0)), cell(1)]); // one running terminal + the trailing launcher
    expect(nextAttentionUid(s, [0, 1], { 0: "working" }, null)).toBeNull();
  });

  it("picks the idle TERMINAL and skips the launcher beside it", () => {
    const s = make([cell(0, U(0)), cell(1, U(1)), cell(2)]); // two terminals + a launcher
    expect(nextAttentionUid(s, [0, 1, 2], { 0: "working" }, null)).toBe(1);
  });

  it("does not enlarge a launcher when zoomed and nothing else is idle", () => {
    const s = make([cell(0, U(0)), cell(1, U(1)), cell(2)], { expanded: 1 });
    const after = nextAttention(s, [0, 1, 2], { 0: "working", 1: "working" }, null);
    expect(after.expanded).toBe(1); // unchanged — never the launcher at uid 2
  });

  it("still counts a command or launcher-backed cell as a real terminal", () => {
    // Occupied means session OR command OR launcher — a shell cell is somewhere worth going.
    const s = make([cell(0, U(0)), { uid: 1, session: null, cwd: "/w", launcher: { shell: true, label: "shell" } }]);
    expect(nextAttentionUid(s, [0, 1], { 0: "working" }, null)).toBe(1);
  });

  it("reports the uid it would move to, so the caller can focus that terminal", () => {
    const st = status({ 0: "idle", 1: "working", 2: "approval" });
    expect(nextAttentionUid(make(running(3)), [0, 1, 2], st)).toBe(2);
    // Same rotation as nextAttention: starts after the zoomed cell. Here every remaining cell
    // is idle or working, so it settles on the idle one rather than the mid-turn cell.
    expect(nextAttentionUid(make(running(3), { expanded: 2 }), [0, 1, 2], status({ 0: "idle", 1: "working", 2: "idle" }))).toBe(0);
  });

  // The bug this parameter exists for: without an origin the rotation always restarts at index
  // 0, so a second press picks the same cell and the key looks dead on a plain grid.
  it("rotates from the FOCUSED cell when nothing is zoomed", () => {
    const s = make(running(4));
    const st = status({ 0: "idle", 1: "idle", 2: "idle", 3: "idle" });
    expect(nextAttentionUid(s, [0, 1, 2, 3], st, null)).toBe(0);
    expect(nextAttentionUid(s, [0, 1, 2, 3], st, 0)).toBe(1);
    expect(nextAttentionUid(s, [0, 1, 2, 3], st, 1)).toBe(2);
    expect(nextAttentionUid(s, [0, 1, 2, 3], st, 3)).toBe(0); // wraps
  });

  it("prefers the zoomed cell over the focused one as the origin", () => {
    const s = make(running(4), { expanded: 2 });
    const st = status({ 0: "idle", 1: "idle", 2: "idle", 3: "idle" });
    expect(nextAttentionUid(s, [0, 1, 2, 3], st, 0)).toBe(3); // after the ZOOMED cell, not 1
  });

  it("reports null when there is nowhere to move", () => {
    expect(nextAttentionUid(make(running(2)), [0, 1], status({ 0: "working", 1: "working" }))).toBeNull();
    expect(nextAttentionUid(make(running(2)), [], {})).toBeNull();
  });

  it("leaves an un-zoomed grid alone when the candidate is already on screen", () => {
    const s = make(running(3), { page: 0 });
    const after = nextAttention(s, [0, 1, 2], status({ 1: "approval" }));
    expect(after.expanded).toBeNull();
    expect(after.page).toBe(0);
  });

  it("collapsing after a jump made WHILE ZOOMED lands on that cell's page", () => {
    const s = make(running(12), { expanded: 0 });
    const order = s.cells.map((c) => c.uid);
    const after = nextAttention(s, order, status({ 10: "approval" }));
    expect(after.expanded).toBe(10);
    expect(toggleZoom(after, order).page).toBe(1);
  });

  // Regression: the caller must hand over the WHOLE ordered list, not the visible page. Given a
  // page slice, a cell calling from another page is invisible here and the page math below is
  // computed against the wrong origin.
  it("reaches a calling cell on ANOTHER page while un-zoomed", () => {
    const s = make(running(12), { page: 0 });
    const order = s.cells.map((c) => c.uid);
    const after = nextAttention(s, order, status({ 11: "approval" }));
    expect(after.expanded).toBeNull(); // still a grid
    expect(after.page).toBe(1); // showing the page that was calling
  });
});

describe("setSession / setCwd / toggleExpand", () => {
  it("promotes a launch cell to running", () => {
    const s = setSession(make([cell(0)]), 0, U(5));
    expect(s.cells[0].session).toBe(U(5));
  });
  it("setCwd updates the matching cell", () => {
    expect(setCwd(make([cell(0)]), 0, "/x").cells[0].cwd).toBe("/x");
  });
  it("toggleExpand flips the zoom uid", () => {
    expect(toggleExpand(make(running(2)), 1).expanded).toBe(1);
    expect(toggleExpand(make(running(2), { expanded: 1 }), 1).expanded).toBeNull();
  });

  // #374: zooming shows one cell big with the others as a filmstrip, so with nothing to
  // switch to it swaps a working layout for an empty filmstrip and squeezes the terminal's
  // status bar and input off the bottom of the viewport, for no gain.
  it("refuses to zoom when there is only one occupied cell", () => {
    const single = make([cell(0, U(0)), cell(1)]);
    expect(toggleExpand(single, 0)).toBe(single);
  });

  it("refuses to zoom a grid of nothing but launch cells", () => {
    const empty = make([cell(0), cell(1)]);
    expect(toggleExpand(empty, 0)).toBe(empty);
  });

  it("zooms as soon as a second cell is occupied", () => {
    expect(toggleExpand(make([cell(0, U(0)), cell(1, U(1)), cell(2)]), 0).expanded).toBe(0);
  });

  // Whatever a state got into, the collapse button has to get out of it — including a state
  // that was zoomed when its sibling closed.
  it("always allows collapsing, even down to one cell", () => {
    const stranded = make([cell(0, U(0)), cell(1)], { expanded: 0 });
    expect(toggleExpand(stranded, 0).expanded).toBeNull();
  });
});

describe("switchPage", () => {
  it("is a no-op when selecting the already-active page (keeps zoom + launch cell)", () => {
    const s = make([...running(9), cell(9)], { page: 1, expanded: 3 });
    expect(switchPage(s, 1)).toBe(s);
  });
  it("drops an abandoned trailing launch cell and clears zoom", () => {
    const s = make([...running(9), cell(9)], { page: 1, expanded: 0 });
    const after = switchPage(s, 0);
    expect(after.cells).toHaveLength(9); // launch cell trimmed
    expect(after.expanded).toBeNull();
    expect(after.page).toBe(0);
  });
});

describe("runCommand (script command cells)", () => {
  const CMD: RunCommand = { source: "script", index: 0, label: "Build", cwd: "/x" };
  const cmdCell = (uid: number): Cell => ({ uid, session: null, cwd: null, command: CMD });

  it("attaches a command to a launch cell, turning it into a command cell", () => {
    const s = runCommand(make([cell(0)]), 0, CMD);
    expect(s.cells[0].command).toEqual(CMD);
    expect(s.cells[0].session).toBeNull();
  });
  it("counts a command cell as running (toward the cap)", () => {
    expect(runningCount([cell(0, U(0)), cmdCell(1), cell(2)])).toBe(2);
  });
  it("a trailing command cell is not a cancellable launch cell — '+' appends", () => {
    const s = addCell(make([...running(2), cmdCell(2)]));
    expect(s.cells).toHaveLength(4); // appended a launch cell, kept the command cell
    expect(s.cells[3].session).toBeNull();
    expect(s.cells[3].command).toBeUndefined();
  });
  it("switchPage keeps a trailing command cell (only abandons an empty launcher)", () => {
    const after = switchPage(make([...running(9), cmdCell(9)], { page: 1 }), 0);
    expect(after.cells).toHaveLength(10);
  });
});

describe("launchInCell (persistent launcher cells)", () => {
  const L = { index: 1, label: "Shell" };

  it("attaches a launcher + cwd to a launch cell", () => {
    const s = launchInCell(make([cell(0)]), 0, L, "/proj");
    expect(s.cells[0].launcher).toEqual(L);
    expect(s.cells[0].cwd).toBe("/proj");
    expect(s.cells[0].session).toBeNull(); // id arrives later via setSession
  });
  it("counts a launcher cell as running, and it's not a cancellable launch cell", () => {
    const withLauncher = launchInCell(make([cell(0), cell(1)]), 0, L, "/p");
    expect(runningCount(withLauncher.cells)).toBe(1);
    // A trailing launcher cell must not read as an empty (cancellable) launch cell.
    const s = addCell(make([launchInCell(make([cell(0)]), 0, L, "/p").cells[0]]));
    expect(s.cells).toHaveLength(2);
  });
  it("persists a launcher cell (session + launcher) across parseGridState", () => {
    const withId = setSession(launchInCell(make([cell(0)]), 0, L, "/p"), 0, U(3));
    const restored = parseGridState(JSON.stringify(withId));
    expect(restored?.cells[0]).toMatchObject({ session: U(3), cwd: "/p", launcher: L });
  });
  it("drops a malformed persisted launcher to null", () => {
    const raw = JSON.stringify({ cells: [{ session: U(4), cwd: "/p", launcher: { label: "x" } }], page: 0, sortMode: "manual" });
    expect(parseGridState(raw)?.cells[0].launcher).toBeNull();
  });
});

describe("insertCellAfter", () => {
  it("inserts a new cell right after the given uid, minting the next uid", () => {
    const s = insertCellAfter(make(running(3)), 1, { session: null, cwd: "/x" });
    expect(s.cells).toHaveLength(4);
    expect(s.cells.map((c) => c.uid)).toEqual([0, 1, 3, 2]); // NEW (uid 3) lands after uid 1
    expect(s.cells[2]).toMatchObject({ session: null, cwd: "/x", uid: 3 });
  });
  it("appends when the uid is not found (e.g. no triggering cell)", () => {
    const s = insertCellAfter(make(running(2)), -1, { session: null, cwd: null });
    expect(s.cells).toHaveLength(3);
    expect(s.cells[2].uid).toBe(2);
  });
  it("jumps to the new cell's page when it lands on a later page", () => {
    const s = insertCellAfter(make(running(11)), 10, { session: null, cwd: null }); // after index 10 -> index 11 -> page 1
    expect(s.cells).toHaveLength(12);
    expect(s.page).toBe(1);
  });
  it("is a no-op at the terminal cap", () => {
    expect(insertCellAfter(make(running(81)), 0, { session: null, cwd: null }).cells).toHaveLength(81);
  });
});

// R12. The Fork button branches a conversation into the column beside it. The cell it makes is
// the request itself: no session of its own, the source's id in `fork`, and the source's dir.
describe("forkCell (Fork button → adjacent branch of this conversation)", () => {
  it("opens the branch immediately after the source, carrying its session and dir", () => {
    const s = make([cell(0, U(0), "/proj"), cell(1, U(1), "/other")]);
    const { state, uid } = forkCell(s, 0);
    expect(uid).toBe(2);
    expect(state.cells.map((c) => c.uid)).toEqual([0, 2, 1]); // the branch lands NEXT to its source
    expect(state.cells[1]).toMatchObject({ uid: 2, session: null, cwd: "/proj", fork: U(0) });
  });

  it("refuses a cell with nothing to fork — an empty launcher has no conversation", () => {
    const s = make([cell(0)]);
    expect(forkCell(s, 0)).toEqual({ state: s, uid: -1 });
    expect(forkCell(s, 99)).toEqual({ state: s, uid: -1 }); // and a uid that is gone
  });

  it("refuses at the terminal cap rather than half-opening a column", () => {
    const full = make(running(MAX_TERMINALS));
    expect(forkCell(full, 0)).toEqual({ state: full, uid: -1 });
  });

  // A fork that has been asked for but not yet answered has no session id, which would otherwise
  // read as "an empty launch form at the end of the grid" — the one cell the grid feels free to
  // drop, reuse or cancel. It is a column the operator opened and is waiting on, and it stays one
  // even when the fork is REFUSED (that pane is holding the error message meant to be read).
  it("is a real column while it waits for its id, not a spare launch cell", () => {
    const { state } = forkCell(make([cell(0, U(0), "/proj")]), 0);
    expect(runningCount(state.cells)).toBe(2);
    expect(cancelableLaunchUid(state)).toBeNull(); // "+ Terminal" cancels a form, not this
    expect(switchPage(state, 0).cells).toHaveLength(2); // a tab click does not sweep it away
  });

  // The one-shot rule. `fork` is a REQUEST, and the server serves it once: the moment the branch
  // has an id, a reconnect must resume THAT id — a still-set `fork` would branch the source again
  // and leave the operator with columns they never asked for.
  it("is spent by setSession, so a reconnect resumes the branch instead of forking twice", () => {
    const { state, uid } = forkCell(make([cell(0, U(0), "/proj")]), 0);
    const after = setSession(state, uid, U(7));
    expect(after.cells.find((c) => c.uid === uid)).toMatchObject({ session: U(7), fork: null });
  });
});

describe("runScriptInNewCell (Run button → adjacent spare cell)", () => {
  const CMD: RunCommand = { source: "script", index: 1, label: "Dev server", cwd: "/x" };

  it("opens the command in a new cell right after the triggering cell", () => {
    const s = runScriptInNewCell(make(running(3)), 0, CMD);
    expect(s.cells).toHaveLength(4);
    expect(s.cells[1]).toMatchObject({ session: null, command: CMD }); // after uid 0 (index 0)
  });
  it("appends when there is no triggering cell (afterUid -1)", () => {
    const s = runScriptInNewCell(make(running(2)), -1, CMD);
    expect(s.cells).toHaveLength(3);
    expect(s.cells[2].command).toEqual(CMD);
  });
  it("is a no-op at the terminal cap", () => {
    expect(runScriptInNewCell(make(running(81)), 0, CMD).cells).toHaveLength(81);
  });
});

describe("shellCell", () => {
  it("is a launcher cell for the OS default shell ($SHELL)", () => {
    expect(shellCell("/proj")).toEqual({ session: null, cwd: "/proj", launcher: { shell: true, label: "shell" } });
  });
});

describe("setSortMode / moveCell (manual reorder)", () => {
  it("setSortMode flips between manual and auto", () => {
    expect(setSortMode(make(running(2)), "auto").sortMode).toBe("auto");
    expect(setSortMode(make(running(2), { sortMode: "auto" }), "manual").sortMode).toBe("manual");
  });
  it("moveCell swaps a cell with its right/left neighbour", () => {
    const s = make(running(3));
    expect(moveCell(s, 0, 1).cells.map((c) => c.uid)).toEqual([1, 0, 2]); // 0 right
    expect(moveCell(s, 2, -1).cells.map((c) => c.uid)).toEqual([0, 2, 1]); // 2 left
  });
  it("moveCell is a no-op past either end", () => {
    const s = make(running(3));
    expect(moveCell(s, 0, -1)).toBe(s); // already leftmost
    expect(moveCell(s, 2, 1)).toBe(s); // already rightmost
    expect(moveCell(s, 99, 1)).toBe(s); // unknown uid
  });
  it("moveCell won't push a cell past the trailing launch cell (it stays last)", () => {
    const s = make([...running(2), cell(2)]); // cell 2 is the trailing launcher
    expect(moveCell(s, 1, 1)).toBe(s);
  });

  // canMoveCell drives the enabled/disabled state of the roster's up/down menu items, so it must
  // report exactly the moves moveCell would perform (used to gate them in TerminalGrid).
  it("canMoveCell allows a swap in the middle", () => {
    const cells = running(3);
    expect(canMoveCell(cells, 1, -1)).toBe(true);
    expect(canMoveCell(cells, 1, 1)).toBe(true);
  });
  it("canMoveCell forbids moving off either end or an unknown uid", () => {
    const cells = running(3);
    expect(canMoveCell(cells, 0, -1)).toBe(false); // already first
    expect(canMoveCell(cells, 2, 1)).toBe(false); // already last
    expect(canMoveCell(cells, 99, 1)).toBe(false); // unknown uid
  });
  it("canMoveCell forbids swapping past the trailing launch cell", () => {
    const cells = [...running(2), cell(2)]; // cell 2 is the trailing launcher
    expect(canMoveCell(cells, 1, 1)).toBe(false); // would push cell 1 into the launcher's last slot
    expect(canMoveCell(cells, 0, 1)).toBe(true); // cell 0 down into cell 1 is fine
  });
});

describe("activityStatus", () => {
  it("splits a Notification wait by the kind the server classified, and Stop into unread", () => {
    expect(activityStatus(false, true, "Notification", "approval")).toBe("approval");
    expect(activityStatus(false, true, "Notification", "question")).toBe("question");
    expect(activityStatus(false, true, "Stop")).toBe("unread");
    expect(activityStatus(false, true, null)).toBe("unread"); // any non-Notification waiting -> unread
  });
  // The safe direction to be wrong: "question" asks the operator to look, while "approval"
  // would promise a yes/no button that is not there.
  it("falls back to question for an unclassified Notification", () => {
    expect(activityStatus(false, true, "Notification")).toBe("question");
    expect(activityStatus(false, true, "Notification", null)).toBe("question");
  });
  it("is working when only working, idle when neither", () => {
    expect(activityStatus(true, false, "UserPromptSubmit")).toBe("working");
    expect(activityStatus(false, false, null)).toBe("idle");
  });
  it("waiting wins over working (a permission pause mid-turn is blocked)", () => {
    expect(activityStatus(true, true, "Notification", "approval")).toBe("approval");
  });
  // The cell's own two facts outrank everything the session table says: a pane whose socket
  // died cannot be answered, and a shell pane runs no agent at all.
  it("reports a dead pane as disconnected whatever it was last doing", () => {
    expect(activityStatus(true, false, "PreToolUse", null, { connected: false })).toBe("disconnected");
    expect(activityStatus(false, true, "Notification", "approval", { connected: false })).toBe("disconnected");
  });
  it("reports a launcher pane as shell", () => {
    expect(activityStatus(false, false, null, null, { shell: true })).toBe("shell");
  });
});

describe("countByStatus", () => {
  it("tallies occupied cells by status, skipping empty launchers", () => {
    const cells = [...running(4), cell(4)]; // uid 4 = empty launcher
    expect(countByStatus(cells, { 0: "approval", 1: "question", 2: "unread", 3: "working" })).toEqual(
      counts({ approval: 1, question: 1, unread: 1, working: 1 }),
    );
  });
  it("treats an unreported occupied cell as idle", () => {
    expect(countByStatus(running(2), { 0: "working" })).toEqual(counts({ working: 1, idle: 1 }));
  });
  it("counts a command cell (occupied, no session)", () => {
    const cmd: Cell = { uid: 0, session: null, cwd: null, command: { source: "script", index: 0, label: "Build", cwd: "/x" } };
    expect(countByStatus([cmd], { 0: "working" })).toEqual(counts({ working: 1 }));
  });
});

describe("orderCells (auto attention sort)", () => {
  const status = (m: Record<number, CellStatus>) => m;
  it("manual mode returns the list unchanged", () => {
    const cells = running(3);
    expect(orderCells(cells, status({ 0: "working", 1: "approval", 2: "idle" }), "manual")).toBe(cells);
  });
  it("auto sorts blocked -> disconnected -> unread -> idle -> working -> shell, launch cells last", () => {
    const cells = [...running(7), cell(7)]; // uid 7 is an empty launch cell
    const ordered = orderCells(cells, status({ 0: "working", 1: "approval", 2: "unread", 3: "idle", 4: "shell", 5: "disconnected", 6: "question" }), "auto");
    expect(ordered.map((c) => c.uid)).toEqual([1, 6, 5, 2, 3, 0, 4, 7]);
  });
  // Which of the two is more urgent depends on the pane, not on the kind, so they share a
  // bucket and the stable sort leaves them in the operator's own column order.
  it("ranks approval and question equally, newest-first order preserved", () => {
    const cells = running(2);
    expect(orderCells(cells, status({ 0: "question", 1: "approval" }), "auto").map((c) => c.uid)).toEqual([0, 1]);
  });
  it("is stable within a bucket (equal status keeps manual order)", () => {
    const cells = running(4);
    const ordered = orderCells(cells, status({ 0: "working", 1: "working", 2: "working", 3: "working" }), "auto");
    expect(ordered.map((c) => c.uid)).toEqual([0, 1, 2, 3]);
  });
  it("treats an unreported uid as idle", () => {
    const cells = running(2);
    const ordered = orderCells(cells, status({ 0: "working" }), "auto");
    expect(ordered.map((c) => c.uid)).toEqual([1, 0]); // uid 1 (idle) before uid 0 (working)
  });
});

describe("visibleOrdered (attention-sort the whole list, then page)", () => {
  it("floats a blocked cell from any page onto the first page", () => {
    // 12 cells over 2 pages. uid 10 starts on page 2; once blocked it sorts to the
    // front and lands on page 1, while the working uid 0 sinks off page 1.
    const s = make(running(12), { page: 0, sortMode: "auto" });
    const statusByUid: Record<number, CellStatus> = { 0: "working", 1: "approval", 10: "approval" };
    const page1 = visibleOrdered(s, statusByUid).map((c) => c.uid);
    expect(page1.slice(0, 2)).toEqual([1, 10]); // both blocked cells, base order, up front
    expect(page1).not.toContain(0); // working uid 0 sank to page 2
    expect(page1).toHaveLength(10);
  });
  it("manual mode leaves the on-screen order untouched", () => {
    const s = make(running(4), { sortMode: "manual" });
    expect(visibleOrdered(s, { 0: "working", 3: "approval" }).map((c) => c.uid)).toEqual([0, 1, 2, 3]);
  });
  it("orders the whole list (the filmstrip) while zoomed", () => {
    const s = make(running(12), { page: 0, expanded: 11, sortMode: "auto" });
    expect(visibleOrdered(s, { 11: "approval" }).map((c) => c.uid)[0]).toBe(11);
  });
});

describe("zoomedUid / visibleCells", () => {
  it("zoomedUid returns the expanded uid, or null when nothing is zoomed", () => {
    expect(zoomedUid(make(running(3)))).toBeNull();
    expect(zoomedUid(make(running(3), { expanded: 1 }))).toBe(1);
  });
  it("zoomedUid is null when expanded points at a missing cell", () => {
    expect(zoomedUid(make(running(2), { expanded: 99 }))).toBeNull();
  });
  it("visibleCells is the active page's slice when nothing is zoomed", () => {
    const s = make(running(12)); // 2 pages
    expect(visibleCells(s).map((c) => c.uid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(visibleCells({ ...s, page: 1 }).map((c) => c.uid)).toEqual([10, 11]);
  });
  it("visibleCells is the WHOLE list while a cell is zoomed (all tabs in the strip)", () => {
    const s = make(running(12), { page: 1, expanded: 10 });
    expect(visibleCells(s)).toHaveLength(12);
  });
  it("visibleCells falls back to the page slice when expanded is stale", () => {
    const s = make(running(12), { page: 1, expanded: 99 });
    expect(visibleCells(s).map((c) => c.uid)).toEqual([10, 11]);
  });
});

describe("parseGridState / migrateLegacy / initialState", () => {
  it("keeps running cells, renumbers uids, and drops malformed entries", () => {
    const raw = JSON.stringify({ cells: [cell(0, U(0)), { uid: 1, session: "bad", cwd: null }, cell(2, U(2))], expanded: 2, page: 0, nextUid: 3 });
    const s = parseGridState(raw);
    if (!s) throw new Error("expected parsed state");
    expect(s.cells.map((c) => c.session)).toEqual([U(0), U(2)]); // "bad" session dropped
    expect(s.cells.map((c) => c.uid)).toEqual([0, 1]); // renumbered from position
    expect(s.expanded).toBe(1); // old uid 2 -> new index 1
  });
  it("returns null for missing/corrupt input", () => {
    expect(parseGridState(null)).toBeNull();
    expect(parseGridState("not json{")).toBeNull();
  });
  it("round-trips a persisted sortMode and defaults to manual", () => {
    const cells = [cell(0, U(0))];
    expect(parseGridState(JSON.stringify({ cells, sortMode: "auto" }))?.sortMode).toBe("auto");
    expect(parseGridState(JSON.stringify({ cells }))?.sortMode).toBe("manual"); // absent -> manual
    expect(parseGridState(JSON.stringify({ cells, sortMode: "bogus" }))?.sortMode).toBe("manual"); // invalid -> manual
  });
  it("constrains a malformed persisted page to a valid integer", () => {
    const cells = Array.from({ length: 18 }, (_, i) => cell(i, U(i))); // 2 pages
    const s = parseGridState(JSON.stringify({ cells, expanded: null, page: 1.5, nextUid: 18 }));
    if (!s) throw new Error("expected parsed state");
    expect(Number.isInteger(s.page)).toBe(true);
    expect(s.page).toBe(0);
  });
  it("renumbers duplicate/oversized persisted uids and keeps nextUid safe", () => {
    const raw = JSON.stringify({
      cells: [
        cell(0, U(0)),
        cell(0, U(1)), // duplicate uid 0
        { uid: 5, session: null, cwd: null }, // empty launch cell — dropped
        { uid: Number.MAX_SAFE_INTEGER, session: U(2), cwd: null }, // oversized uid
      ],
      expanded: null,
      page: 0,
      nextUid: 1,
    });
    const s = parseGridState(raw);
    if (!s) throw new Error("expected parsed state");
    expect(s.cells.map((c) => c.session)).toEqual([U(0), U(1), U(2)]); // empty dropped, all running kept
    expect(s.cells.map((c) => c.uid)).toEqual([0, 1, 2]); // renumbered — no collision
    expect(s.nextUid).toBe(3);
    expect(Number.isSafeInteger(s.nextUid)).toBe(true);
  });
  it("migrates the legacy single-grid shape into the flat list", () => {
    const legacy = JSON.stringify({ sessions: [U(0), null, U(2), null], cwds: ["/a", null, "/c", null], expanded: 1 });
    const s = migrateLegacy(legacy);
    if (!s) throw new Error("expected migration");
    expect(s.cells.map((c) => c.session)).toEqual([U(0), U(2)]);
    expect(s.cells[1].cwd).toBe("/c");
    expect(s.expanded).toBe(s.cells[1].uid); // old position 1 -> the 2nd running cell
  });
  it("initialState prefers current, then legacy, then a fresh entry", () => {
    expect(initialState(JSON.stringify({ cells: [cell(0, U(0))] }), null).migrated).toBe(false);
    const fromLegacy = initialState(null, JSON.stringify({ sessions: [U(0)] }));
    expect(fromLegacy.migrated).toBe(true);
    const fresh = initialState(null, null);
    expect(fresh.state.cells).toHaveLength(1);
    expect(fresh.state.cells[0].session).toBeNull();
  });
});

describe("resolveCellStatus", () => {
  const cell = (uid: number, session: string | null) => ({ uid, session });

  // The server's activity for the cell's session wins: it is the only source that knows a
  // turn is blocked, which is what auto mode sorts on.
  it("prefers the session's live status over the cell's own", () => {
    const out = resolveCellStatus([cell(1, "s1")], new Map<string, CellStatus>([["s1", "approval"]]), { 1: "working" });
    expect(out[1]).toBe("approval");
  });

  // Command cells have no session id, and a just-launched cell has none yet — without the
  // fallback they would read idle and sort past cells that need nothing.
  it("falls back to the cell's own status when it has no session", () => {
    expect(resolveCellStatus([cell(2, null)], new Map<string, CellStatus>(), { 2: "working" })[2]).toBe("working");
  });

  it("falls back when the session has no activity yet", () => {
    expect(resolveCellStatus([cell(3, "unknown")], new Map<string, CellStatus>(), { 3: "working" })[3]).toBe("working");
  });

  it("lands on idle when nothing knows anything", () => {
    expect(resolveCellStatus([cell(4, null)], new Map<string, CellStatus>(), {})[4]).toBe("idle");
  });

  it("answers for every cell, not just the ones with activity", () => {
    const out = resolveCellStatus([cell(1, "s1"), cell(2, null), cell(3, "s3")], new Map<string, CellStatus>([["s1", "approval"]]), {});
    expect(Object.keys(out).sort()).toEqual(["1", "2", "3"]);
  });

  it("keys by uid, so two cells on the same session can still differ elsewhere", () => {
    const out = resolveCellStatus([cell(1, "s1"), cell(2, "s1")], new Map<string, CellStatus>([["s1", "working"]]), {});
    expect([out[1], out[2]]).toEqual(["working", "working"]);
  });

  it("returns an empty map for no cells", () => {
    expect(resolveCellStatus([], new Map<string, CellStatus>(), {})).toEqual({});
  });

  // The two exceptions to "the session wins". Only the CELL can see that this browser's
  // socket dropped or that the pane runs a plain shell — the server's row describes an
  // agent's turn and knows neither. A pane whose socket died while its last row said
  // "working" must not keep claiming to work, or the auto sort buries it under idle cells.
  it("lets the cell's disconnected win over the session's last known state", () => {
    const out = resolveCellStatus([cell(1, "s1")], new Map<string, CellStatus>([["s1", "working"]]), { 1: "disconnected" });
    expect(out[1]).toBe("disconnected");
  });

  it("lets the cell's shell win over the session's state", () => {
    const out = resolveCellStatus([cell(1, "s1")], new Map<string, CellStatus>([["s1", "idle"]]), { 1: "shell" });
    expect(out[1]).toBe("shell");
  });
});

describe("gridStatusSummary", () => {
  it("shows nothing when there are no counts", () => {
    expect(gridStatusSummary(null)).toEqual({ show: false, title: "" });
    expect(gridStatusSummary(undefined)).toEqual({ show: false, title: "" });
  });

  // The asymmetry this exists for: the quiet states alone do not raise the badge — a grid of
  // nothing but idle and shell panes has nothing to triage, and the strip would be noise.
  it("does not show for a grid that is only idle or shell", () => {
    expect(gridStatusSummary(counts({ idle: 9 })).show).toBe(false);
    expect(gridStatusSummary(counts({ idle: 4, shell: 5 })).show).toBe(false);
  });

  it.each(["approval", "question", "disconnected", "unread", "working"] as const)("shows as soon as one cell is %s", (key) => {
    expect(gridStatusSummary(counts({ [key]: 1 })).show).toBe(true);
  });

  // …but the quiet ones ARE in the tooltip text once the strip is up.
  it("includes idle in the title even though it does not raise the badge", () => {
    const s = gridStatusSummary(counts({ working: 1, idle: 3 }));
    expect(s.show).toBe(true);
    expect(s.title).toBe("1 working · 3 idle");
  });

  // Reading order: the ones holding the operator up first.
  it("orders the parts approval, question, disconnected, unread, working, idle, shell", () => {
    expect(gridStatusSummary(counts({ approval: 1, question: 2, disconnected: 3, unread: 4, working: 5, idle: 6, shell: 7 })).title).toBe(
      "1 awaiting approval · 2 asking · 3 disconnected · 4 done (review) · 5 working · 6 idle · 7 shell",
    );
  });

  it("omits a zero count from the title", () => {
    expect(gridStatusSummary(counts({ approval: 2, working: 1 })).title).toBe("2 awaiting approval · 1 working");
  });
});

// The rules written at the top of the zoom section in gridTabs.ts. Each was broken at least
// once while building #829, so they are pinned as rules rather than as one-off cases: a future
// action that quietly violates one fails here instead of in someone's grid.
describe("zoom invariants (#829)", () => {
  const order12 = Array.from({ length: 12 }, (_, i) => i);
  const allIdle: Record<number, CellStatus> = {};

  // Invariant 1 — only toggleZoom changes WHETHER the grid is zoomed.
  const movements: Array<[string, (s: GridState) => GridState]> = [
    ["moveZoom(+1)", (s) => moveZoom(s, order12, 1)],
    ["moveZoom(-1)", (s) => moveZoom(s, order12, -1)],
    ["nextAttention", (s) => nextAttention(s, order12, allIdle, 3)],
  ];

  it.each(movements)("%s leaves an un-zoomed grid un-zoomed", (_label, apply) => {
    expect(apply(make(running(12), { page: 0 })).expanded).toBeNull();
  });

  it.each(movements)("%s leaves a zoomed grid zoomed", (_label, apply) => {
    expect(apply(make(running(12), { expanded: 5 })).expanded).not.toBeNull();
  });

  it.each(movements)("%s never adds or removes a terminal", (_label, apply) => {
    const s = make(running(12), { expanded: 5 });
    expect(apply(s).cells).toHaveLength(s.cells.length);
  });

  it("toggleZoom is the one action that flips it, in both directions", () => {
    const s = make(running(12), { page: 0 });
    const zoomed = toggleZoom(s, order12, 4);
    expect(zoomed.expanded).toBe(4);
    expect(toggleZoom(zoomed, order12, 4).expanded).toBeNull();
  });

  // Invariant 3 — page is decided only on release, and only from the enlarged cell.
  it.each(movements)("%s does not touch the page", (_label, apply) => {
    const s = make(running(12), { expanded: 5, page: 1 });
    expect(apply(s).page).toBe(1);
  });

  it("releasing the zoom sets the page from the enlarged cell, ignoring where it started", () => {
    for (const [uid, expected] of [
      [0, 0],
      [9, 0],
      [10, 1],
      [11, 1],
    ]) {
      const s = make(running(12), { expanded: uid, page: 0 });
      expect(toggleZoom(s, order12, uid).page).toBe(expected);
    }
  });

  // Invariant 5 — entry needs a second running cell; leaving never refuses.
  it("refuses to ENTER the zoom with one running cell", () => {
    const lonely = make([cell(0, U(0)), cell(1)]); // one running + an empty launcher
    expect(toggleZoom(lonely, [0, 1], 0)).toBe(lonely);
  });

  // nextAttention needs no such guard: by invariant 1 it never enters the zoom in the first
  // place, so on a one-cell grid there is nothing for it to refuse.
  it("nextAttention still does not zoom a lone cell", () => {
    const lonely = make([cell(0, U(0)), cell(1)]);
    expect(nextAttention(lonely, [0, 1], { 0: "approval" }, null).expanded).toBeNull();
  });

  it("always allows LEAVING the zoom, even in a state that could not be entered", () => {
    const lonely = make([cell(0, U(0))], { expanded: 0 });
    expect(toggleZoom(lonely, [0], 0).expanded).toBeNull();
    expect(toggleExpand(lonely, 0, [0]).expanded).toBeNull();
  });
});

// R1 (workspaces). The operator runs two named workspaces of columns, not eight anonymous
// pages of one list, so a page can be NAMED and PINNED. Pinned means sealed: closing a column
// must not pull a terminal in from the next page, and the page's own columns must not drain
// into an earlier one. Everything below also pins the other half of the promise — with nothing
// pinned, the grid is the flat, reflowing list it always was.
describe("named pages", () => {
  const withPages = (cells: Cell[], pages: PageMeta[], extra: Partial<GridState> = {}) => make(cells, { pages, ...extra });

  it("shows the page number until the page is named", () => {
    const s = make(running(12));
    expect(pageLabel(s, 0)).toBe("1");
    expect(pageLabel(s, 1)).toBe("2");
    expect(pageLabel(setPageLabel(s, 1, "orosy"), 1)).toBe("orosy");
  });

  it("clears a name back to the number when it is blanked", () => {
    const named = setPageLabel(make(running(12)), 0, "tools");
    expect(pageLabel(setPageLabel(named, 0, "   "), 0)).toBe("1");
  });

  it("caps a name at MAX_PAGE_LABEL so eight tabs still fit one row", () => {
    const s = setPageLabel(make(running(2)), 0, "x".repeat(MAX_PAGE_LABEL + 10));
    expect(pageLabel(s, 0)).toHaveLength(MAX_PAGE_LABEL);
  });

  it("names a page that does not exist yet without disturbing the ones that do", () => {
    const s = setPageLabel(withPages(running(2), [{ label: "a" }]), 3, "later");
    expect(pageLabel(s, 0)).toBe("a");
    expect(pageLabel(s, 3)).toBe("later");
  });
});

describe("pinned pages (sealed workspaces)", () => {
  const pin = (cells: Cell[], page: number, extra: Partial<GridState> = {}) => togglePagePin(make(cells, extra), page);
  const uidsOnPage = (s: GridState, p: number) => realCells(pageSlice(s.cells, p)).map((c) => c.uid);

  it("pinning holds the page's width open with reserved slots, adding no terminals", () => {
    const s = pin(running(5), 0);
    expect(isPagePinned(s, 0)).toBe(true);
    expect(s.cells).toHaveLength(10); // one page's worth of slots
    expect(realCells(s.cells).map((c) => c.uid)).toEqual([0, 1, 2, 3, 4]);
    expect(s.cells.filter(isHole)).toHaveLength(5);
    expect(runningCount(s.cells)).toBe(5); // a reserved slot is not a terminal
  });

  it("closing a column on a pinned page does NOT pull the next page's terminal in", () => {
    const s = pin(running(12), 0); // page 0 pinned and already full, page 1 holds 10..11
    const after = closeCell(s, 0);
    expect(uidsOnPage(after, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // uid 10 stayed put
    expect(uidsOnPage(after, 1)).toEqual([10, 11]);
    expect(pageSlice(after.cells, 0)).toHaveLength(10); // the slot stayed with the page
  });

  it("closes the middle of a pinned page without leaving a gap between the columns", () => {
    const after = closeCell(pin(running(12), 0), 3);
    expect(uidsOnPage(after, 0)).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);
    expect(pageSlice(after.cells, 0).map(isHole)).toEqual([false, false, false, false, false, false, false, false, false, true]);
  });

  it("keeps a pinned page's terminals off an EARLIER page when that one loses a column", () => {
    // Page 0 is the elastic one, page 1 is the workspace being protected.
    const s = pin(running(12), 1);
    const after = closeCell(s, 0);
    expect(uidsOnPage(after, 1)).toEqual([10, 11]); // nothing drained backwards
    expect(uidsOnPage(after, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("still reflows across pages that are NOT pinned (the pre-workspace behaviour)", () => {
    const after = closeCell(make(running(12)), 0);
    expect(uidsOnPage(after, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // uid 10 flowed back
    expect(after.cells.some(isHole)).toBe(false); // and no slot was reserved
  });

  it("un-pinning drops the reserved slots and lets the list pack forward again", () => {
    const closed = closeCell(pin(running(12), 0), 0);
    const loose = togglePagePin(closed, 0);
    expect(loose.cells.some(isHole)).toBe(false);
    expect(uidsOnPage(loose, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // Un-pinning is the only action that REMOVES pages, so it is the only one that can strand the
  // active tab past the end — and a stranded page shows an empty grid with no tab row left to
  // click back from, which persists.
  it("un-pinning from a later tab does not strand the view on a page that no longer exists", () => {
    let s = pin(running(11), 0); // page 0 pinned + full, one terminal on page 1
    for (const uid of [0, 1, 2, 3, 4, 5, 6, 7, 8]) s = closeCell(s, uid);
    s = switchPage(s, 1);
    expect(s.page).toBe(1);
    const loose = togglePagePin(s, 0);
    expect(loose.page).toBeLessThan(pageCount(loose.cells.length));
  });

  it("adds a new column to the page being LOOKED AT, not the end of the grid", () => {
    const s = closeCell(pin(running(12), 0), 0); // page 0: 9 columns + 1 reserved slot
    const after = addCell({ ...s, page: 0 });
    expect(after.page).toBe(0);
    expect(uidsOnPage(after, 0)).toHaveLength(10); // the slot was refilled
    expect(uidsOnPage(after, 1)).toEqual([10, 11]); // page 1 untouched
  });

  it("falls back to a new page when the active pinned page is full", () => {
    const s = { ...pin(running(12), 0), page: 0 };
    const after = addCell(s);
    expect(uidsOnPage(after, 0)).toHaveLength(10);
    expect(after.cells).toHaveLength(13);
    expect(after.page).toBe(1);
  });

  it("puts an adjacent terminal in its own page's slot instead of shoving a column onto the next", () => {
    const s = closeCell(pin(running(12), 0), 9); // page 0 has a slot free at the end
    const after = insertCellAfter(s, 0, { session: null, cwd: "/x" });
    expect(uidsOnPage(after, 0)).toHaveLength(10);
    expect(after.cells[1].cwd).toBe("/x"); // the new column sits next to uid 0
    expect(uidsOnPage(after, 1)).toEqual([10, 11]); // and page 1 is untouched
  });

  it("keeps an entry cell by reusing a reserved slot rather than growing past the workspaces", () => {
    const emptied = closeCell(pin([cell(0, U(0))], 0), 0);
    expect(emptied.cells).toHaveLength(10);
    expect(realCells(emptied.cells)).toHaveLength(1);
    expect(realCells(emptied.cells)[0].session).toBeNull();
  });

  it("never counts, zooms, orders or navigates to a reserved slot", () => {
    const s = closeCell(pin(running(12), 0), 7);
    const holeUid = s.cells.filter(isHole)[0].uid;
    const order = s.cells.map((c) => c.uid);
    expect(countByStatus(s.cells, {})).toEqual(counts({ idle: 11 }));
    expect(nextAttentionUid(s, order, {}, 6)).toBe(8); // steps over the slot at index 7
    expect(zoomedUid({ ...s, expanded: holeUid })).toBeNull();
    expect(moveZoom({ ...s, expanded: 6 }, order, 1).expanded).toBe(8);
    expect(cancelableLaunchUid(s)).toBeNull(); // a slot is not an open launcher
  });

  it("refuses to drag a column into another workspace, or onto a reserved slot", () => {
    const s = closeCell(pin(running(12), 0), 7);
    const holeUid = s.cells.filter(isHole)[0].uid;
    expect(moveCellTo(s, 0, 10)).toBe(s); // page 0 -> page 1
    expect(moveCellTo(s, 0, holeUid)).toBe(s);
    expect(canMoveCell(s.cells, 9, 1, true)).toBe(false); // the next slot is reserved
    const within = moveCellTo(s, 0, 3).cells.map((c) => c.uid);
    expect(within.slice(0, 4)).toEqual([1, 2, 3, 0]); // within the page is fine
  });

  // The roster's up/down items are the same reorder affordance as the drag, so they answer to
  // the same rule. Without this a FULL pinned page has no reserved slot to block the swap, and
  // its last column trades places with the next workspace's first.
  it("refuses the roster's move across a page boundary while any workspace is pinned", () => {
    const s = pin(running(12), 0); // page 0 pinned AND full — no hole to stop the swap
    expect(isSealed(s)).toBe(true);
    expect(canMoveCell(s.cells, 9, 1, isSealed(s))).toBe(false);
    expect(moveCell(s, 9, 1)).toBe(s);
    expect(canMoveCell(s.cells, 8, 1, isSealed(s))).toBe(true); // inside the page, still fine
  });

  it("still allows a cross-page swap when nothing is pinned", () => {
    const s = make(running(12));
    expect(isSealed(s)).toBe(false);
    expect(canMoveCell(s.cells, 7, 1, isSealed(s))).toBe(true);
    expect(moveCell(s, 7, 1).cells.map((c) => c.uid)[7]).toBe(8);
  });

  it("attention-sorts INSIDE each page once a workspace is pinned, and across all pages when none is", () => {
    const across = make(running(12), { sortMode: "auto" });
    expect(orderGrid(across, { 10: "approval" }).map((c) => c.uid)[0]).toBe(10); // floats onto page 1
    const sealed = togglePagePin(across, 0);
    const ordered = orderGrid(sealed, { 10: "approval" });
    expect(pageSlice(ordered, 0).map((c) => c.uid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // page 0 unchanged
    expect(pageSlice(ordered, 1).map((c) => c.uid)[0]).toBe(10); // sorted, but only within page 1
  });
});

describe("workspace persistence (page meta + reserved slots)", () => {
  it("round-trips names, pins and the reserved slots through a reload", () => {
    const saved = setPageLabel(closeCell(togglePagePin(make(running(12)), 0), 0), 0, "orosy");
    const restored = parseGridState(JSON.stringify(saved));
    if (!restored) throw new Error("expected parsed state");
    expect(pageLabel(restored, 0)).toBe("orosy");
    expect(isPagePinned(restored, 0)).toBe(true);
    expect(pageSlice(restored.cells, 0)).toHaveLength(10);
    expect(realCells(pageSlice(restored.cells, 0))).toHaveLength(9);
    expect(realCells(pageSlice(restored.cells, 1)).map((c) => c.session)).toEqual([U(10), U(11)]);
  });

  it("reads a pre-workspace grid_v2 unchanged: no pages, no slots, uids still renumbered", () => {
    const older = JSON.stringify({ cells: [cell(4, U(0)), cell(9, U(1))], expanded: 9, page: 0, nextUid: 10 });
    const s = parseGridState(older);
    if (!s) throw new Error("expected parsed state");
    expect(s.pages).toBeUndefined();
    expect(s.cells.some(isHole)).toBe(false);
    expect(s.cells.map((c) => c.uid)).toEqual([0, 1]); // the renumbering rule is untouched
    expect(s.expanded).toBe(1);
    expect(s.nextUid).toBe(2);
  });

  it("repairs a blob whose slots and pins disagree instead of trusting either", () => {
    // Pinned page 0 but only 2 cells saved: the padding is re-derived, not assumed.
    const raw = JSON.stringify({ cells: [cell(0, U(0)), cell(1, U(1))], pages: [{ pinned: true }], page: 0 });
    const s = parseGridState(raw);
    if (!s) throw new Error("expected parsed state");
    expect(s.cells).toHaveLength(10);
    expect(realCells(s.cells)).toHaveLength(2);
  });

  it("survives malformed page metadata rather than losing a grid of live sessions", () => {
    const raw = JSON.stringify({ cells: [cell(0, U(0))], pages: ["nope", 7, { label: 5, pinned: "yes" }, { label: " a " }] });
    const s = parseGridState(raw);
    if (!s) throw new Error("expected parsed state");
    expect(s.cells).toHaveLength(1);
    expect(pageLabel(s, 3)).toBe("a");
    expect(isPagePinned(s, 2)).toBe(false);
  });

  it("drops page metadata entirely when nothing is named or pinned", () => {
    expect(parseGridState(JSON.stringify({ cells: [cell(0, U(0))], pages: [{}, {}] }))?.pages).toBeUndefined();
  });

  // MAX_TERMINALS caps TERMINALS, which is what it means everywhere else (it is checked through
  // runningCount, and a reserved slot is not a terminal). Counting slots against it would trim
  // the array's TAIL — live sessions on the last pages — and do it silently.
  it("caps the parse by terminals, not by slots, so a padded grid keeps its last columns", () => {
    const pinnedPages = Array.from({ length: 8 }, () => ({ pinned: true }));
    const cells = [
      ...Array.from({ length: 8 }, (_, i) => cell(i, U(i))), // page 0, real
      ...Array.from({ length: 56 }, (_, i) => ({ uid: 100 + i, session: null, cwd: null, hole: true as const })),
      cell(200, U(7)), // a terminal past the reserved region — the one a slot-based cap would eat
    ];
    const s = parseGridState(JSON.stringify({ cells, pages: pinnedPages, page: 0 }));
    if (!s) throw new Error("expected parsed state");
    expect(runningCount(s.cells)).toBe(9);
    expect(realCells(s.cells)).toHaveLength(9);
  });

  it("reserveSlots is idempotent", () => {
    const once = reserveSlots(make(running(5), { pages: [{ pinned: true }] }));
    const twice = reserveSlots(once);
    expect(twice.cells.map((c) => c.uid)).toEqual(once.cells.map((c) => c.uid));
  });
});

describe("per-window workspaces (?ws=)", () => {
  it("gives a named window its own saved grid and leaves an unnamed one on the original key", () => {
    expect(stateKeyFor(null)).toBe(STATE_KEY);
    expect(stateKeyFor("left")).toBe(`${STATE_KEY}:left`);
  });

  it("takes the workspace name from the query string", () => {
    expect(workspaceFromSearch("?ws=workspace-1")).toBe("workspace-1");
    expect(workspaceFromSearch("?foo=1&ws=tools_2")).toBe("tools_2");
    expect(workspaceFromSearch("")).toBeNull();
    expect(workspaceFromSearch("?ws=")).toBeNull();
  });

  // The name becomes a localStorage key, so anything that could collide with the base key or
  // smuggle a separator through is refused rather than sanitised into something else's grid.
  it("refuses a name that is not a plain identifier", () => {
    for (const bad of ["?ws=a:b", "?ws=../x", "?ws=-lead", `?ws=${"x".repeat(40)}`]) expect(workspaceFromSearch(bad)).toBeNull();
  });
});

// R3 (keymap defaults). The two transforms the un-zoomed grid's keys drive. Everything upstream
// bound acts on the ZOOMED cell; these are the plain grid's own, so they are the ones that have
// to answer "what happens at the edge" and "what happens while zoomed".
describe("keyboard column moves (focusStepUid)", () => {
  it("moves one column and stops at both ends instead of wrapping", () => {
    const cells = running(3);
    expect(focusStepUid(cells, 0, 1)).toBe(1);
    expect(focusStepUid(cells, 1, 1)).toBe(2);
    expect(focusStepUid(cells, 2, 1)).toBeNull(); // last column — the key does nothing
    expect(focusStepUid(cells, 2, -1)).toBe(1);
    expect(focusStepUid(cells, 0, -1)).toBeNull(); // first column
  });

  it("enters from the near end when nothing is focused yet", () => {
    const cells = running(3);
    expect(focusStepUid(cells, null, 1)).toBe(0);
    expect(focusStepUid(cells, null, -1)).toBe(2);
  });

  // A cell on another page, or one already closed, is not a neighbour of anything on screen.
  it("treats an off-screen origin as no origin", () => {
    expect(focusStepUid(running(3), 99, 1)).toBe(0);
  });

  // An empty launch cell is a column but holds no terminal, so focusing it would put the cursor
  // nowhere and the key would read as dead.
  it("steps OVER an empty launch cell rather than landing on it", () => {
    const cells = [cell(0, U(0)), cell(1), cell(2, U(2))];
    expect(focusStepUid(cells, 0, 1)).toBe(2);
    expect(focusStepUid(cells, 2, -1)).toBe(0);
  });

  it("does nothing on a grid with no terminals at all", () => {
    expect(focusStepUid([cell(0)], null, 1)).toBeNull();
    expect(focusStepUid([], null, 1)).toBeNull();
  });
});

describe("keyboard page moves (stepPage)", () => {
  const threePages = running(PAGE_SIZE * 2 + 1);

  it("moves one page and stops at both ends instead of wrapping", () => {
    expect(stepPage(make(threePages, { page: 0 }), 1).page).toBe(1);
    expect(stepPage(make(threePages, { page: 1 }), 1).page).toBe(2);
    expect(stepPage(make(threePages, { page: 2 }), 1).page).toBe(2); // last page — stays
    expect(stepPage(make(threePages, { page: 2 }), -1).page).toBe(1);
    expect(stepPage(make(threePages, { page: 0 }), -1).page).toBe(0); // first page
  });

  it("does nothing on a single-page grid", () => {
    const one = make(running(3), { page: 0 });
    expect(stepPage(one, 1)).toBe(one); // the same object: nothing to persist
    expect(stepPage(one, -1)).toBe(one);
  });

  // Zoom invariant 1: only toggleZoom changes WHETHER the grid is zoomed, and switchPage clears
  // the zoom. A page key that collapsed the layout would be doing something it never claimed to.
  it("refuses to act while zoomed, so it can never collapse the zoom", () => {
    const zoomed = make(threePages, { page: 0, expanded: 0 });
    expect(stepPage(zoomed, 1)).toBe(zoomed);
    expect(zoomedUid(stepPage(zoomed, 1))).toBe(0);
  });

  // It routes through switchPage, so it inherits that behaviour rather than re-implementing it.
  it("drops an abandoned trailing launch cell on the way, like clicking the tab does", () => {
    const withLaunch = make([...running(PAGE_SIZE), cell(PAGE_SIZE)], { page: 0 });
    expect(stepPage(withLaunch, 1).cells).toHaveLength(PAGE_SIZE);
  });
});
