// Fork-local (iTerm2 mode, operator request 2026-08-26): the two ways the operator groups and
// shelves columns without closing anything.
//
//   SEPARATORS — a named vertical line between two columns ("here starts the waiting-on-reply
//   block"). It belongs to the cell on its right and can be walked left/right one column at a
//   time. Pure grouping: it never changes a page boundary or a column's width.
//
//   PARKING — a pane leaves the grid for a dock of small cards, session intact, with a note
//   saying what it is waiting for. The dock is a list of whole cells (uid included), so a
//   restored pane re-attaches to the very same durable connection (`cell-<uid>`) it left with.
//
// Same house rules as gridTabs.ts: pure `state => state` transforms, a no-op returns the same
// object identity, and nothing here touches a session.
import {
  MAX_TERMINALS,
  clampPage,
  closeCell,
  freeSlot,
  insertAt,
  isHole,
  pageCount,
  pageOfIndex,
  parkNote,
  runningCount,
  separatorLabel,
  zoomedUid,
  type Cell,
  type GridState,
  type ParkedCell,
  type Separator,
} from "./gridTabs";

// ---------------------------------------------------------------------------------- separators

export const separatorsOf = (state: GridState): readonly Separator[] => state.separators ?? [];

/** The separator standing before each cell, keyed by that cell's uid. */
export function separatorsByUid(state: GridState): Record<number, Separator> {
  const out: Record<number, Separator> = {};
  for (const s of separatorsOf(state)) out[s.beforeUid] = s;
  return out;
}

/** Put a line before `beforeUid`. One per cell; a hole or an unknown uid gets none. */
export function addSeparator(state: GridState, beforeUid: number): GridState {
  const target = state.cells.find((c) => c.uid === beforeUid);
  if (!target || isHole(target)) return state;
  if (separatorsOf(state).some((s) => s.beforeUid === beforeUid)) return state;
  const id = state.nextUid;
  return { ...state, nextUid: id + 1, separators: [...separatorsOf(state), { id, beforeUid }] };
}

export function removeSeparator(state: GridState, id: number): GridState {
  if (!separatorsOf(state).some((s) => s.id === id)) return state;
  const separators = separatorsOf(state).filter((s) => s.id !== id);
  return { ...state, separators: separators.length ? separators : undefined };
}

export function setSeparatorLabel(state: GridState, id: number, label: string): GridState {
  if (!separatorsOf(state).some((s) => s.id === id)) return state;
  return { ...state, separators: separatorsOf(state).map((s) => (s.id === id ? { ...s, label: separatorLabel(label) } : s)) };
}

/** Walk the line one column left (-1) or right (+1) along `order` — the uids as they stand on
 *  screen, which is what "left" and "right" mean to the operator. Stops at the ends, and will
 *  not land on a cell that already has a line. */
export function moveSeparator(state: GridState, id: number, dir: -1 | 1, order: readonly number[]): GridState {
  const sep = separatorsOf(state).find((s) => s.id === id);
  if (!sep) return state;
  const idx = order.indexOf(sep.beforeUid);
  if (idx < 0) return state;
  const target = order[idx + dir];
  if (target === undefined || separatorsOf(state).some((s) => s.beforeUid === target)) return state;
  return { ...state, separators: separatorsOf(state).map((s) => (s.id === id ? { ...s, beforeUid: target } : s)) };
}

// ------------------------------------------------------------------------------------- parking

export const parkedOf = (state: GridState): readonly ParkedCell[] => state.parked ?? [];

/** Can this cell be parked? It needs a session to come back to — a launch form, a running
 *  command (never persisted) or a reserved slot has nothing to shelve. */
export function canPark(cell: Cell | undefined): boolean {
  return !!cell && !isHole(cell) && cell.session !== null && cell.command == null;
}

/** Shelve `uid` with the operator's note. Leaves the grid exactly as closing would (reflow,
 *  hole on a sealed page, zoom handed to a neighbour, entry cell kept) — minus the session,
 *  which lives on in the dock entry. `order` is the on-screen uid order, as for closeCell.
 *
 *  Newly parked goes to the FRONT: the dock renders the array as-is (operator request
 *  2026-09-13, drag-to-reorder), so the array is the operator's order and cannot also be
 *  re-sorted by time. Front-insertion keeps the default the dock always had — the thing
 *  shelved a minute ago sits on top — while a hand-dragged order below it survives. */
export function parkCell(state: GridState, uid: number, note: string, now: number, order?: number[]): GridState {
  const cell = state.cells.find((c) => c.uid === uid);
  if (!canPark(cell) || !cell) return state;
  const next = closeCell(state, uid, order);
  const trimmed = parkNote(note);
  const kept: Cell = { uid: cell.uid, session: cell.session, cwd: cell.cwd, launcher: cell.launcher ?? undefined, agent: cell.agent, name: cell.name };
  if (trimmed) kept.parkNote = trimmed;
  return { ...next, parked: [{ cell: kept, note: trimmed, at: now }, ...parkedOf(next)] };
}

/** Bring a parked pane back, onto the page being looked at (its first free slot, else the end
 *  of the grid — the same placement "+ Terminal" uses), un-zooming like any add. Refused when
 *  the grid is full. The dock's note (as last edited there) rides back on the cell as
 *  `parkNote`, so the next park starts from it (operator report 2026-09-03). */
export function unparkCell(state: GridState, uid: number): GridState {
  const entry = parkedOf(state).find((p) => p.cell.uid === uid);
  if (!entry) return state;
  if (runningCount(state.cells) >= MAX_TERMINALS) return state;
  const parked = parkedOf(state).filter((p) => p.cell.uid !== uid);
  const base = { ...state, parked: parked.length ? parked : undefined };
  const expanded = zoomedUid(state) !== null ? null : state.expanded;
  const back: Cell = { ...entry.cell };
  if (entry.note) back.parkNote = entry.note;
  else delete back.parkNote;
  const slot = freeSlot(state, state.page);
  const filled = slot >= 0 ? insertAt(state, slot, back) : null;
  if (filled) return clampPage({ ...base, cells: filled, page: pageOfIndex(slot), expanded });
  const cells = [...state.cells, back];
  return { ...base, cells, page: pageCount(cells.length) - 1, expanded };
}

/** Drop a parked pane from the dock (the caller terminates its session). */
export function removeParked(state: GridState, uid: number): GridState {
  if (!parkedOf(state).some((p) => p.cell.uid === uid)) return state;
  const parked = parkedOf(state).filter((p) => p.cell.uid !== uid);
  return { ...state, parked: parked.length ? parked : undefined };
}

/** Move a parked pane to another card's place in the dock (operator request 2026-09-13):
 *  drag-and-drop, and the same splice the grid's column drag does — the dragged card lands AT
 *  the target's index and the rest close up, rather than the two swapping. The dock renders the
 *  array in order, so this IS the persisted order. */
export function moveParkedTo(state: GridState, uid: number, targetUid: number): GridState {
  const parked = parkedOf(state);
  const from = parked.findIndex((p) => p.cell.uid === uid);
  const to = parked.findIndex((p) => p.cell.uid === targetUid);
  if (from < 0 || to < 0 || from === to) return state;
  const next = [...parked];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { ...state, parked: next };
}

export function setParkNote(state: GridState, uid: number, note: string): GridState {
  if (!parkedOf(state).some((p) => p.cell.uid === uid)) return state;
  return { ...state, parked: parkedOf(state).map((p) => (p.cell.uid === uid ? { ...p, note: parkNote(note) } : p)) };
}
