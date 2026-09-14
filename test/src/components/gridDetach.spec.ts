// Tearing a page off into its own window, and putting it back (operator request 2026-09-14).
// The transforms only; the two windows' storage handshake is wired in GridView.
import { describe, it, expect } from "vitest";
import {
  MAX_PAGES,
  PAGE_SIZE,
  STATE_KEY,
  isHole,
  pageAccount,
  pageCount,
  pageLabel,
  pageSlice,
  parseGridState,
  realCells,
  isPagePinned,
  runningCount,
  type Cell,
  type GridState,
} from "../../../src/components/gridTabs";
import { parkCell } from "../../../src/components/gridBlocks";
import {
  addDetached,
  canDetachPage,
  detachBlockedReason,
  detachPage,
  detachedKeyFor,
  freeWorkspaceName,
  homeKeyFor,
  normalizePayload,
  pagePayload,
  pagesPayload,
  parseDetached,
  parseHandoff,
  reattachBlockedReason,
  reattachPage,
  reattachPages,
  removeDetached,
  sanitizeWorkspaceName,
  wsFromHomeKey,
  type PagePayload,
} from "../../../src/components/gridDetach";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-2222-3333-4444-555555555555`;
// The repo's specs do not use `!`; this narrows and fails the test if the value is not there.
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value, got none");
  return value;
}
const live = (uid: number, extra: Partial<Cell> = {}): Cell => ({ uid, session: uuid(uid), cwd: "/tmp", ...extra });
const launch = (uid: number): Cell => ({ uid, session: null, cwd: null });

// A two-page grid: page 0 pinned (so the boundary holds), page 1 the one under test.
function twoPages(page1: Cell[] = [live(20), live(21)], page0: Cell[] = [live(0)]): GridState {
  const cells = [...page0];
  while (cells.length < PAGE_SIZE) cells.push({ uid: 100 + cells.length, session: null, cwd: null, hole: true });
  cells.push(...page1);
  const uids = cells.map((c) => c.uid);
  return {
    cells,
    expanded: null,
    page: 1,
    nextUid: Math.max(...uids) + 1,
    sortMode: "manual",
    pages: [
      { pinned: true, label: "home" },
      { label: "work", account: "b@orosy.co.jp" },
    ],
  };
}

describe("whether a page can be torn off", () => {
  it("takes a page with running panes", () => {
    expect(detachBlockedReason(twoPages(), 1)).toBeNull();
    expect(canDetachPage(twoPages(), 1)).toBe(true);
  });

  it("refuses the last page standing — the window would be left empty", () => {
    const one: GridState = { cells: [live(0)], expanded: null, page: 0, nextUid: 1, sortMode: "manual" };
    expect(detachBlockedReason(one, 0)).toMatch(/1枚/);
  });

  it("refuses a page with nothing running on it", () => {
    expect(detachBlockedReason(twoPages([launch(20)]), 1)).toMatch(/動いているペイン/);
  });

  it("refuses while the auto sort is on — the page on screen is not the page in the state", () => {
    expect(detachBlockedReason({ ...twoPages(), sortMode: "auto" }, 1)).toMatch(/自動整列/);
  });

  it("refuses a page holding a Run command, whose process cannot be handed over", () => {
    const state = twoPages([live(20), { uid: 21, session: null, cwd: "/tmp", command: { label: "build", index: 0 } as Cell["command"] }]);
    expect(detachBlockedReason(state, 1)).toMatch(/コマンド/);
  });

  it("refuses a page holding a column that has started but has no session yet", () => {
    // A fork in flight — or one the server refused, whose pane is holding the message saying so.
    // It cannot travel (nothing to reattach to) and must not be destroyed either.
    const forking: Cell = { uid: 21, session: null, cwd: "/tmp", fork: uuid(20) };
    expect(detachBlockedReason(twoPages([live(20), forking]), 1)).toMatch(/起動中/);
    // Same for a launcher between its launch and the server's session frame.
    const starting: Cell = { uid: 21, session: null, cwd: "/tmp", launcher: { shell: true, label: "shell" } };
    expect(detachBlockedReason(twoPages([live(20), starting]), 1)).toMatch(/起動中/);
    expect(detachPage(twoPages([live(20), forking]), 1, STATE_KEY)).toBeNull();
  });

  it("refuses from a window that is itself a detached page — no grandchildren", () => {
    expect(detachBlockedReason({ ...twoPages(), origin: STATE_KEY }, 1)).toMatch(/切り離された/);
  });

  it("refuses a page that is not there", () => {
    expect(canDetachPage(twoPages(), 5)).toBe(false);
  });
});

describe("what leaves with the page", () => {
  it("carries the columns, the page's name and its account", () => {
    const state = twoPages([live(20, { name: "決済", width: 2, account: "b@orosy.co.jp" }), live(21, { agent: "codex" })]);
    const { child, uids, parent } = must(detachPage(state, 1, STATE_KEY));
    expect(uids).toEqual([20, 21]);
    expect(child.cells.map((c) => c.session)).toEqual([uuid(20), uuid(21)]);
    expect(child.cells[0]).toMatchObject({ name: "決済", width: 2, account: "b@orosy.co.jp" });
    expect(child.cells[1]).toMatchObject({ agent: "codex" });
    expect(pageLabel(child, 0)).toBe("work");
    expect(pageAccount(child, 0)).toBe("b@orosy.co.jp");
    expect(child.origin).toBe(STATE_KEY);
    // …and the window it left keeps none of it.
    expect(parent.cells.some((c) => c.session === uuid(20))).toBe(false);
  });

  it("renumbers the child's uids from zero and keeps a parent link inside the page", () => {
    const state = twoPages([live(20), live(21, { parent: 20 }), live(22, { parent: 0 })]);
    const { child } = must(detachPage(state, 1, STATE_KEY));
    expect(child.cells.map((c) => c.uid)).toEqual([0, 1, 2]);
    expect(child.cells[1].parent).toBe(0); // 21 -> 20, remapped
    expect(child.cells[2].parent).toBeUndefined(); // its parent stayed in the other window
  });

  it("leaves the page's number behind so the pages after it keep their own names", () => {
    const state: GridState = {
      cells: [live(0), live(1), live(2)],
      expanded: null,
      page: 0,
      nextUid: 3,
      sortMode: "manual",
      pages: [{ label: "one" }, { label: "two" }, { label: "three" }],
    };
    // Three pages of one column each: pin the first two so the boundaries hold.
    const padded: GridState = {
      ...state,
      cells: [live(0), ...holes(1, PAGE_SIZE - 1), live(1), ...holes(200, PAGE_SIZE - 1), live(2)],
      nextUid: 400,
      pages: [{ label: "one", pinned: true }, { label: "two", pinned: true }, { label: "three" }],
    };
    expect(pageCount(padded.cells.length)).toBe(3);
    const { parent } = must(detachPage(padded, 1, STATE_KEY));
    expect(pageCount(parent.cells.length)).toBe(2);
    expect(pageLabel(parent, 0)).toBe("one");
    expect(pageLabel(parent, 1)).toBe("three"); // NOT "two" — the entry was spliced, not blanked
  });

  it("drops a zoom that pointed at a column which left, and a link to one", () => {
    const state = { ...twoPages([live(20), live(21)]), expanded: 20 };
    const withLink: GridState = { ...state, cells: state.cells.map((c) => (c.uid === 0 ? { ...c, parent: 20 } : c)) };
    const { parent } = must(detachPage(withLink, 1, STATE_KEY));
    expect(parent.expanded).toBeNull();
    expect(parent.cells.find((c) => c.uid === 0)?.parent).toBeUndefined();
  });

  it("carries only the lines that stand before a column which left", () => {
    const state: GridState = {
      ...twoPages([live(20), live(21)]),
      separators: [
        { id: 900, beforeUid: 0 },
        { id: 901, beforeUid: 21, label: "待ち" },
      ],
    };
    const { parent, child } = must(detachPage(state, 1, STATE_KEY));
    expect(parent.separators?.map((s) => s.beforeUid)).toEqual([0]);
    expect(child.separators).toEqual([{ id: 2, beforeUid: 1, label: "待ち" }]);
  });

  it("leaves a launch form behind rather than moving an empty column", () => {
    const { child } = must(detachPage(twoPages([live(20), launch(21)]), 1, STATE_KEY));
    expect(child.cells).toHaveLength(1);
  });

  it("keeps the window it left usable when every real column was on that page", () => {
    const state = twoPages([live(20)], [launch(0)]);
    const { parent } = must(detachPage(state, 1, STATE_KEY));
    expect(realCells(parent.cells).length).toBeGreaterThan(0);
    expect(parent.page).toBeLessThan(pageCount(parent.cells.length));
  });
});

const holes = (from: number, n: number): Cell[] => Array.from({ length: n }, (_, i) => ({ uid: from + i, session: null, cwd: null, hole: true }));

describe("the luggage survives the trip through storage", () => {
  it("comes back out of a reload with its columns' names, widths and accounts", () => {
    const state = twoPages([live(20, { name: "決済", width: 3, account: "b@orosy.co.jp" })]);
    const { child } = must(detachPage(state, 1, STATE_KEY));
    const reloaded = parseGridState(JSON.stringify(child));
    expect(reloaded).not.toBeNull();
    expect(must(reloaded).cells[0]).toMatchObject({ session: uuid(20), name: "決済", width: 3, account: "b@orosy.co.jp" });
    expect(pageAccount(must(reloaded), 0)).toBe("b@orosy.co.jp");
    expect(must(reloaded).origin).toBe(STATE_KEY);
  });

  it("refuses an origin that is not a grid key this app writes", () => {
    const { child } = must(detachPage(twoPages(), 1, STATE_KEY));
    const forged = parseGridState(JSON.stringify({ ...child, origin: "../../evil" }));
    expect(must(forged).origin).toBeUndefined();
  });

  it("re-validates luggage another window wrote", () => {
    const dirty = {
      meta: { label: "x".repeat(80), account: "not-an-address" },
      cells: [
        { uid: 5, session: uuid(5), cwd: "/tmp", name: "y".repeat(200), account: "B@Orosy.co.jp" },
        { uid: 6, session: "nope", cwd: "/tmp" },
      ],
    };
    const clean = must(normalizePayload(dirty));
    expect(clean.cells).toHaveLength(1); // the bad session id is not a session
    expect(must(clean.cells[0].name).length).toBeLessThanOrEqual(32);
    expect(clean.cells[0].account).toBe("b@orosy.co.jp");
    expect(must(clean.meta.label).length).toBeLessThanOrEqual(20);
    expect(clean.meta.account).toBeUndefined();
  });

  it("is nothing at all when it holds no session", () => {
    expect(normalizePayload({ cells: [{ uid: 0, session: null, cwd: "/tmp" }] })).toBeNull();
    expect(normalizePayload({ cells: "not an array" })).toBeNull();
    expect(normalizePayload(null)).toBeNull();
  });
});

describe("putting a page back", () => {
  const home = (): GridState => ({ cells: [live(0), live(1)], expanded: null, page: 0, nextUid: 2, sortMode: "manual" });
  const luggage = (): PagePayload => ({ meta: { label: "work", account: "b@orosy.co.jp" }, cells: [live(20), live(21)] });

  it("arrives as a new page at the end, with its name and account", () => {
    const back = must(reattachPage(home(), luggage()));
    expect(pageCount(back.cells.length)).toBe(2);
    expect(back.page).toBe(1);
    expect(pageLabel(back, 1)).toBe("work");
    expect(pageAccount(back, 1)).toBe("b@orosy.co.jp");
    expect(realCells(pageSlice(back.cells, 1)).map((c) => c.session)).toEqual([uuid(20), uuid(21)]);
  });

  it("seals the page in front of it so it cannot dissolve back into it", () => {
    const back = must(reattachPage(home(), luggage()));
    expect(isPagePinned(back, 0)).toBe(true);
    expect(realCells(pageSlice(back.cells, 0)).map((c) => c.uid)).toEqual([0, 1]);
  });

  it("gives the arriving columns uids this window is not already using", () => {
    const back = must(reattachPage(home(), luggage()));
    const uids = back.cells.map((c) => c.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(back.nextUid).toBeGreaterThan(Math.max(...uids));
  });

  it("un-zooms, like every other way a column arrives", () => {
    expect(must(reattachPage({ ...home(), expanded: 0 }, luggage())).expanded).toBeNull();
  });

  it("refuses a session this window already holds, in the grid or in the dock", () => {
    const held: GridState = { ...home(), cells: [live(0), live(20)] };
    expect(reattachPage(held, { meta: {}, cells: [live(20)] })).toBeNull();
    const parked = parkCell(home(), 1, "待ち", 0);
    expect(reattachPage(parked, { meta: {}, cells: [{ ...live(30), session: uuid(1) }] })).toBeNull();
  });

  it("drops the duplicate but still brings the rest", () => {
    const held: GridState = { ...home(), cells: [live(0), live(20)] };
    const back = must(reattachPage(held, { meta: {}, cells: [live(20), live(21)] }));
    expect(back.cells.filter((c) => c.session === uuid(20))).toHaveLength(1);
    expect(back.cells.some((c) => c.session === uuid(21))).toBe(true);
  });

  it("refuses when this window is already at its last page", () => {
    // Fill out MAX_PAGES pages of one column each, every boundary sealed.
    const cells: Cell[] = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      cells.push(live(p * 30));
      while (cells.length < (p + 1) * PAGE_SIZE) cells.push({ uid: p * 30 + cells.length, session: null, cwd: null, hole: true });
    }
    const state: GridState = {
      cells,
      expanded: null,
      page: 0,
      nextUid: 999,
      sortMode: "manual",
      pages: Array.from({ length: MAX_PAGES }, () => ({ pinned: true })),
    };
    expect(pageCount(state.cells.length)).toBe(MAX_PAGES);
    expect(reattachBlockedReason(state, luggage())).toMatch(/ページ/);
    expect(reattachPage(state, luggage())).toBeNull();
  });

  it("keeps what does not fit rather than dropping it", () => {
    const many: PagePayload[] = Array.from({ length: MAX_PAGES + 2 }, (_, i) => ({ meta: {}, cells: [live(300 + i)] }));
    const { state, rejected } = reattachPages(home(), many);
    expect(pageCount(state.cells.length)).toBe(MAX_PAGES);
    expect(rejected).toHaveLength(many.length - (MAX_PAGES - 1));
  });

  it("brings the lines back with their columns", () => {
    const back = must(reattachPage(home(), { ...luggage(), separators: [{ beforeUid: 21, label: "待ち" }] }));
    const arrived = must(back.cells.find((c) => c.session === uuid(21)));
    expect(back.separators?.map((s) => ({ beforeUid: s.beforeUid, label: s.label }))).toEqual([{ beforeUid: arrived.uid, label: "待ち" }]);
  });
});

describe("the page in front of the returning one", () => {
  it("does not keep an abandoned launch form that '+ Terminal' could no longer cancel", () => {
    const home: GridState = { cells: [live(0), launch(1)], expanded: null, page: 0, nextUid: 2, sortMode: "manual" };
    const back = must(reattachPage(home, { meta: {}, cells: [live(20)] }));
    // The form is gone, exactly as addPage / moveCellToPage / switchPage drop it: left in place
    // it would sit behind the padding with the arriving column after it, where the trailing-only
    // rule can no longer see it.
    expect(back.cells.filter((c) => !isHole(c) && c.session === null)).toHaveLength(0);
    expect(back.cells.filter((c) => c.session !== null).map((c) => c.session)).toEqual([uuid(0), uuid(20)]);
  });
});

describe("there and back", () => {
  it("ends with the same sessions in the same window", () => {
    const start = twoPages([live(20, { name: "決済", account: "b@orosy.co.jp" }), live(21)]);
    const before = start.cells.filter((c) => c.session).map((c) => c.session);
    const { parent, child } = must(detachPage(start, 1, STATE_KEY));
    const { state: merged, rejected } = reattachPages(parent, pagesPayload(child));
    expect(rejected).toEqual([]);
    expect(
      merged.cells
        .filter((c) => c.session)
        .map((c) => c.session)
        .sort(),
    ).toEqual([...before].sort());
    const returned = must(merged.cells.find((c) => c.session === uuid(20)));
    expect(returned).toMatchObject({ name: "決済", account: "b@orosy.co.jp" });
    const page = Math.floor(merged.cells.indexOf(returned) / PAGE_SIZE);
    expect(pageLabel(merged, page)).toBe("work");
    expect(pageAccount(merged, page)).toBe("b@orosy.co.jp");
  });

  it("hands over every page a grown-up detached window has", () => {
    const grown = twoPages([live(20)], [live(0)]);
    expect(pagesPayload(grown).map((p) => p.cells.length)).toEqual([1, 1]);
    expect(must(pagePayload(grown, 0)).meta.label).toBe("home");
  });
});

describe("the keys and the register", () => {
  it("hangs both side keys off the window's own grid key", () => {
    expect(detachedKeyFor("grid_v2")).toBe("grid_v2::detached");
    expect(homeKeyFor("grid_v2", "work")).toBe("grid_v2::home:work");
    expect(wsFromHomeKey("grid_v2", "grid_v2::home:work")).toBe("work");
    // A workspace's own keys are not the default window's.
    expect(wsFromHomeKey("grid_v2", "grid_v2:left::home:work")).toBeNull();
    expect(wsFromHomeKey("grid_v2", "grid_v2::home:not a name")).toBeNull();
    expect(wsFromHomeKey("grid_v2", "grid_v2")).toBeNull();
  });

  it("reads a register, and survives a hand-broken one", () => {
    expect(parseDetached(null)).toEqual([]);
    expect(parseDetached("{oops")).toEqual([]);
    expect(parseDetached(JSON.stringify([{ ws: "not a name" }, { ws: "work", label: "調査", at: 5 }]))).toEqual([{ ws: "work", label: "調査", at: 5 }]);
  });

  it("holds one entry per workspace", () => {
    const one = addDetached([], { ws: "work", label: "a", at: 1 });
    const again = addDetached(one, { ws: "work", label: "b", at: 2 });
    expect(again).toEqual([{ ws: "work", label: "b", at: 2 }]);
    expect(removeDetached(again, "work")).toEqual([]);
  });

  it("reads a home note, and refuses a broken one", () => {
    const note = JSON.stringify({ ws: "work", pages: [{ meta: { label: "work" }, cells: [live(3)] }] });
    expect(parseHandoff(note)).toMatchObject({ ws: "work" });
    expect(must(parseHandoff(note)).pages[0].cells[0].session).toBe(uuid(3));
    expect(parseHandoff(JSON.stringify({ ws: "work", pages: [] }))).toBeNull();
    expect(parseHandoff(JSON.stringify({ ws: "no good", pages: [{ cells: [live(3)] }] }))).toBeNull();
    expect(parseHandoff("nonsense")).toBeNull();
  });
});

describe("naming the new window's workspace", () => {
  it("uses the page's name when it can be one", () => {
    expect(sanitizeWorkspaceName("Orosy Work")).toBe("Orosy-Work");
    expect(freeWorkspaceName("Orosy Work", 1, () => false)).toBe("Orosy-Work");
  });

  it("falls back to the page number when the name is not ASCII", () => {
    expect(sanitizeWorkspaceName("決済")).toBe("");
    expect(freeWorkspaceName("決済", 1, () => false)).toBe("page2");
  });

  it("keeps clear of a workspace that already exists", () => {
    const taken = new Set(["page2", "page2-2"]);
    expect(freeWorkspaceName("", 1, (ws) => taken.has(ws))).toBe("page2-3");
  });

  it("never exceeds what a workspace name may be", () => {
    const long = freeWorkspaceName("a".repeat(60), 0, () => false);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(long)).toBe(true);
  });
});

describe("the cap on how many columns come back", () => {
  it("never brings more than a page holds", () => {
    const crowd: PagePayload = { meta: {}, cells: Array.from({ length: PAGE_SIZE + 4 }, (_, i) => live(400 + i)) };
    const back = must(reattachPage({ cells: [live(0)], expanded: null, page: 0, nextUid: 1, sortMode: "manual" }, crowd));
    expect(runningCount(realCells(pageSlice(back.cells, 1)))).toBe(PAGE_SIZE);
  });
});
