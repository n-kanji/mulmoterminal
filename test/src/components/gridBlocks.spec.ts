import { describe, it, expect } from "vitest";
import { closeCell, parseGridState, PAGE_SIZE, MAX_PARK_NOTE, MAX_SEPARATOR_LABEL, type Cell, type GridState } from "../../../src/components/gridTabs.js";
import {
  addSeparator,
  canPark,
  moveParkedTo,
  moveSeparator,
  parkCell,
  removeParked,
  removeSeparator,
  separatorsByUid,
  setParkNote,
  setSeparatorLabel,
  unparkCell,
} from "../../../src/components/gridBlocks.js";

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
const uids = (s: GridState) => s.cells.map((c) => c.uid);
const sep0 = (s: GridState) => {
  const sep = s.separators?.[0];
  if (!sep) throw new Error("no separator");
  return sep;
};
const parsed = (raw: string): GridState => {
  const s = parseGridState(raw);
  if (!s) throw new Error("unparseable");
  return s;
};
const NOW = 1_700_000_000_000;

describe("separators", () => {
  it("adds one line before a cell, once, with a fresh id", () => {
    const s = addSeparator(make(running(3)), 1);
    expect(s.separators).toEqual([{ id: 3, beforeUid: 1 }]);
    expect(s.nextUid).toBe(4);
    expect(addSeparator(s, 1)).toBe(s); // one per cell
    expect(addSeparator(s, 99)).toBe(s); // unknown cell
  });

  it("names, walks and removes a line", () => {
    let s = addSeparator(make(running(4)), 2);
    const id = sep0(s).id;
    s = setSeparatorLabel(s, id, "  返信待ち  ");
    expect(separatorsByUid(s)[2]?.label).toBe("返信待ち");
    s = moveSeparator(s, id, -1, uids(s));
    expect(separatorsByUid(s)[1]).toBeDefined();
    s = moveSeparator(s, id, -1, uids(s));
    expect(sep0(s).beforeUid).toBe(0);
    expect(moveSeparator(s, id, -1, uids(s))).toBe(s); // at the left edge
    s = moveSeparator(s, id, 1, uids(s));
    s = moveSeparator(s, id, 1, uids(s));
    s = moveSeparator(s, id, 1, uids(s));
    expect(sep0(s).beforeUid).toBe(3);
    expect(moveSeparator(s, id, 1, uids(s))).toBe(s); // at the right edge
    expect(removeSeparator(s, id).separators).toBeUndefined();
  });

  it("will not walk onto a cell that already has a line", () => {
    let s = addSeparator(make(running(3)), 1);
    s = addSeparator(s, 2);
    const first = sep0(s).id;
    expect(moveSeparator(s, first, 1, uids(s))).toBe(s);
  });

  it("clips a label and clears a blank one", () => {
    let s = addSeparator(make(running(2)), 1);
    const id = sep0(s).id;
    expect(sep0(setSeparatorLabel(s, id, "x".repeat(MAX_SEPARATOR_LABEL + 5))).label).toHaveLength(MAX_SEPARATOR_LABEL);
    s = setSeparatorLabel(s, id, "named");
    expect(sep0(setSeparatorLabel(s, id, "   ")).label).toBeUndefined();
  });

  // The line marks a position; the column that takes the closed one's place inherits it.
  it("hands the line to the next cell when its cell closes, and drops it at the end", () => {
    let s = addSeparator(make(running(3)), 1);
    s = closeCell(s, 1);
    expect(s.separators).toEqual([{ id: 3, beforeUid: 2 }]);
    s = closeCell(s, 2);
    expect(s.separators).toBeUndefined();
  });

  it("drops a line rather than doubling one the heir already has", () => {
    let s = addSeparator(addSeparator(make(running(3)), 1), 2);
    s = closeCell(s, 1);
    expect(s.separators).toHaveLength(1);
    expect(sep0(s).beforeUid).toBe(2);
  });

  it("survives a reload keyed to the renumbered cell, one per cell, labels re-trimmed", () => {
    const raw = JSON.stringify({
      cells: [cell(10, U(0)), cell(11, U(1)), cell(12, U(2))],
      expanded: null,
      page: 0,
      nextUid: 13,
      sortMode: "manual",
      separators: [
        { id: 50, beforeUid: 11, label: "  block B " },
        { id: 51, beforeUid: 11 }, // duplicate for the same cell
        { id: 52, beforeUid: 99 }, // no such cell
        "junk",
      ],
    });
    const s = parsed(raw);
    expect(s.separators).toEqual([{ id: 3, beforeUid: 1, label: "block B" }]);
    expect(s.nextUid).toBe(4);
  });
});

describe("parking", () => {
  it("only a cell with a session can be parked", () => {
    expect(canPark(cell(0, U(0)))).toBe(true);
    expect(canPark(cell(0))).toBe(false);
    expect(canPark({ ...cell(0, U(0)), command: { label: "x", cmd: "x" } as never })).toBe(false);
    expect(canPark({ uid: 0, session: null, cwd: null, hole: true })).toBe(false);
  });

  it("parks a cell out of the grid, keeping its uid, session and name, with the note", () => {
    const s0 = make([cell(0, U(0)), { ...cell(1, U(1), "/p"), name: "決済" }, cell(2, U(2))]);
    const s = parkCell(s0, 1, "  川上さんの返信が来たら  再開 ", NOW);
    expect(uids(s)).toEqual([0, 2]);
    expect(s.parked).toEqual([
      {
        cell: { uid: 1, session: U(1), cwd: "/p", launcher: undefined, agent: undefined, name: "決済", parkNote: "川上さんの返信が来たら 再開" },
        note: "川上さんの返信が来たら 再開",
        at: NOW,
      },
    ]);
    expect(parkCell(s0, 5, "x", NOW)).toBe(s0);
  });

  it("parking the last pane leaves the entry cell, like closing does", () => {
    const s = parkCell(make(running(1)), 0, "later", NOW);
    expect(s.cells).toHaveLength(1);
    expect(s.cells[0].session).toBeNull();
    expect(s.parked).toHaveLength(1);
  });

  it("restores onto the current page's end with the same uid, and clears the dock entry", () => {
    let s = parkCell(make(running(3)), 1, "wait", NOW);
    s = unparkCell(s, 1);
    expect(uids(s)).toEqual([0, 2, 1]);
    expect(s.cells[2].session).toBe(U(1));
    expect(s.parked).toBeUndefined();
    expect(unparkCell(s, 1)).toBe(s);
  });

  it("restores onto a later page when the first is full", () => {
    let s = parkCell(make(running(PAGE_SIZE + 1)), 0, "wait", NOW);
    expect(s.cells).toHaveLength(PAGE_SIZE);
    s = unparkCell({ ...s, page: 0 }, 0);
    expect(s.cells).toHaveLength(PAGE_SIZE + 1);
    expect(s.page).toBe(1);
    expect(s.cells[PAGE_SIZE].uid).toBe(0);
  });

  it("restoring un-zooms, like any add", () => {
    let s = parkCell(make(running(3), { expanded: 0 }), 1, "wait", NOW);
    s = unparkCell(s, 1);
    expect(s.expanded).toBeNull();
  });

  // Operator request 2026-09-13: the dock is drag-ordered, so the array is the order — a fresh
  // park goes on top (what the old newest-first sort showed) and a hand-placed card stays put.
  it("puts a newly parked pane at the front of the dock", () => {
    let s = parkCell(make(running(3)), 0, "a", NOW);
    s = parkCell(s, 1, "b", NOW + 1);
    s = parkCell(s, 2, "c", NOW + 2);
    expect(s.parked?.map((p) => p.cell.uid)).toEqual([2, 1, 0]);
  });

  it("moves a card to another's place, splicing rather than swapping", () => {
    let s = parkCell(make(running(3)), 0, "a", NOW);
    s = parkCell(s, 1, "b", NOW + 1);
    s = parkCell(s, 2, "c", NOW + 2);
    // [2, 1, 0] — drag the bottom card to the top.
    s = moveParkedTo(s, 0, 2);
    expect(s.parked?.map((p) => p.cell.uid)).toEqual([0, 2, 1]);
    // And back down one place.
    s = moveParkedTo(s, 0, 2);
    expect(s.parked?.map((p) => p.cell.uid)).toEqual([2, 0, 1]);
    // A card onto itself, an unknown uid, or a grid cell's uid: no move, same object.
    expect(moveParkedTo(s, 0, 0)).toBe(s);
    expect(moveParkedTo(s, 0, 9)).toBe(s);
    expect(moveParkedTo(make(running(2)), 0, 1)).toEqual(make(running(2)));
  });

  it("keeps the hand-placed order when a pane comes back or is dropped", () => {
    let s = parkCell(make(running(3)), 0, "a", NOW);
    s = parkCell(s, 1, "b", NOW + 1);
    s = parkCell(s, 2, "c", NOW + 2);
    s = moveParkedTo(s, 0, 2); // [0, 2, 1]
    s = unparkCell(s, 2);
    expect(s.parked?.map((p) => p.cell.uid)).toEqual([0, 1]);
    s = removeParked(s, 0);
    expect(s.parked?.map((p) => p.cell.uid)).toEqual([1]);
  });

  it("edits and drops a dock entry", () => {
    let s = parkCell(make(running(2)), 0, "a", NOW);
    s = setParkNote(s, 0, "b".repeat(MAX_PARK_NOTE + 3));
    expect(s.parked?.[0].note).toHaveLength(MAX_PARK_NOTE);
    expect(removeParked(s, 0).parked).toBeUndefined();
    expect(removeParked(s, 7)).toBe(s);
  });

  // Operator report 2026-09-03: the note used to live only on the dock entry, so a pane that
  // came back and went out again started from an empty box every time.
  it("a pane brought back remembers its note, and re-parking offers it as the default", () => {
    let s = parkCell(make(running(3)), 1, "川上さんの返信が来たら", NOW);
    expect(s.parked?.[0].cell.parkNote).toBe("川上さんの返信が来たら");
    s = setParkNote(s, 1, "価格が決まったら");
    s = unparkCell(s, 1);
    expect(s.cells.find((c) => c.uid === 1)?.parkNote).toBe("価格が決まったら");
    // The grid cell is what the park menu reads its default from; parking again with that
    // default keeps the note, parking with a new one replaces it.
    s = parkCell(s, 1, "価格が決まったら", NOW + 1);
    expect(s.parked?.[0].note).toBe("価格が決まったら");
    s = unparkCell(s, 1);
    s = parkCell(s, 1, "  別の条件  ", NOW + 2);
    expect(s.parked?.[0]).toMatchObject({ note: "別の条件", cell: { parkNote: "別の条件" } });
  });

  it("a note cleared in the dock comes back as no note, not an empty string", () => {
    let s = parkCell(make(running(2)), 0, "wait", NOW);
    s = setParkNote(s, 0, "   ");
    s = unparkCell(s, 0);
    expect(s.cells.find((c) => c.uid === 0)).not.toHaveProperty("parkNote");
    expect(parkCell(s, 0, "", NOW).parked?.[0].cell).not.toHaveProperty("parkNote");
  });

  it("the remembered note survives a reload on grid and parked cells alike, re-trimmed", () => {
    const raw = JSON.stringify({
      cells: [
        { ...cell(0, U(0)), parkNote: "  on the grid  " },
        { ...cell(1, U(1)), parkNote: "" },
        { ...cell(2, U(2)), parkNote: 5 },
      ],
      expanded: null,
      page: 0,
      nextUid: 3,
      sortMode: "manual",
      parked: [{ cell: { uid: 7, session: U(7), cwd: "/q", parkNote: "x".repeat(MAX_PARK_NOTE + 5) }, note: "when X", at: NOW }],
    });
    const s = parsed(raw);
    expect(s.cells.map((c) => c.parkNote)).toEqual(["on the grid", undefined, undefined]);
    expect(s.parked?.[0].cell.parkNote).toHaveLength(MAX_PARK_NOTE);
  });

  it("survives a reload after the grid's uids, dropping entries without a session", () => {
    const raw = JSON.stringify({
      cells: [cell(3, U(0)), cell(4, U(1))],
      expanded: null,
      page: 0,
      nextUid: 9,
      sortMode: "manual",
      parked: [
        { cell: { uid: 7, session: U(7), cwd: "/q", name: "  q " }, note: "  when X ", at: NOW },
        { cell: { uid: 8, session: null, cwd: null }, note: "never", at: NOW },
        { nope: true },
      ],
      separators: [{ id: 1, beforeUid: 4 }],
    });
    const s = parsed(raw);
    expect(uids(s)).toEqual([0, 1]);
    expect(s.parked).toEqual([{ cell: { uid: 2, session: U(7), cwd: "/q", launcher: null, agent: undefined, name: "q" }, note: "when X", at: NOW }]);
    expect(s.separators).toEqual([{ id: 3, beforeUid: 1 }]);
    expect(s.nextUid).toBe(4);
  });
});
