// Fork-local (iTerm2 mode, R10): holding the auto sort still while the operator is typing.
//
// "auto" order floats a pane that needs attention to the front, and it recomputes the moment
// ANY pane's status changes — including a pane on another page the operator has never looked
// at. Mid-sentence that pulls the column out from under the cursor and the rest of the
// keystrokes land in whatever slid into its place. The keys are already gone by then; there
// is nothing to undo.
//
// So the ORDER is frozen while a terminal is being typed into, and the frozen order is
// reconciled rather than snapshot-replayed: cells close and open while the hold is on, and a
// held list containing a closed cell (or missing a new one) would be a worse lie than the
// reordering it prevents.
import type { Cell } from "./gridTabs";

/** The live order, re-arranged to the held one.
 *
 *  Cells named in `heldUids` keep their held position. Cells that appeared since (a new column,
 *  a launch) are NOT dropped — they take their live position among the ones that follow, after
 *  every held cell, which is where an appended column sits anyway. Cells that have since closed
 *  simply aren't there to place. */
export function holdOrder(live: readonly Cell[], heldUids: readonly number[]): Cell[] {
  const held = new Map<number, number>();
  heldUids.forEach((uid, at) => held.set(uid, at));
  // Two keys: the held rank (or "after everything held"), then the live index — so cells with
  // no held rank stay in live order relative to each other, and the sort is total (stable
  // sorts guarantee nothing about elements that compare equal across different keys).
  const after = heldUids.length;
  return live
    .map((cell, i) => ({ cell, i, rank: held.get(cell.uid) ?? after }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.cell);
}
