import { describe, it, expect } from "vitest";
import { holdOrder } from "../../../src/components/sortHold";
import type { Cell } from "../../../src/components/gridTabs";

const cell = (uid: number): Cell => ({ uid, session: null, cwd: null });
const uids = (cells: Cell[]) => cells.map((c) => c.uid);

describe("holdOrder", () => {
  // The failure it exists to stop: the auto sort floats a blocked pane to the front while the
  // operator is mid-sentence in another column, and the rest of the keystrokes land in
  // whatever slid under the cursor.
  it("keeps the held arrangement even when the live order has re-sorted", () => {
    const live = [cell(3), cell(1), cell(2)]; // a status change floated uid 3 to the front
    expect(uids(holdOrder(live, [1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("is the live order when nothing was held", () => {
    const live = [cell(3), cell(1)];
    expect(uids(holdOrder(live, []))).toEqual([3, 1]);
  });

  // Reconciled, not replayed: the hold can outlive the cells it was taken over.
  it("drops cells that closed during the hold", () => {
    const live = [cell(2), cell(1)];
    expect(uids(holdOrder(live, [1, 9, 2]))).toEqual([1, 2]);
  });

  it("keeps cells opened during the hold, after everything held, in live order", () => {
    const live = [cell(5), cell(2), cell(4), cell(1)];
    expect(uids(holdOrder(live, [1, 2]))).toEqual([1, 2, 5, 4]);
  });

  it("returns a new array and leaves the live list alone", () => {
    const live = [cell(2), cell(1)];
    const out = holdOrder(live, [1, 2]);
    expect(out).not.toBe(live);
    expect(uids(live)).toEqual([2, 1]);
  });
});
