// Fork-local (iTerm2 mode): the grid is COLUMNS ONLY — every cell is a full-height
// vertical pane, adding a cell adds a column, and nothing ever stacks into rows.
// These specs pin that: rows is always 1, and a second row (which would halve the
// visible transcript lines per pane on the operator's 27" 4K) can never come back
// silently through a layout table edit.
import { describe, it, expect } from "vitest";
import { LAYOUTS, MAX_CELLS, isLayout, dims, trackStyle, layoutForCount } from "../../../src/components/gridLayout.js";

describe("gridLayout (columns only)", () => {
  it("exposes the layouts smallest→largest, one per column count", () => {
    expect(LAYOUTS).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(MAX_CELLS).toBe(8);
  });

  it("isLayout accepts known layouts and rejects everything else — including the old stacked ones", () => {
    expect(isLayout("1")).toBe(true);
    expect(isLayout("8")).toBe(true);
    expect(isLayout("2x2")).toBe(false);
    expect(isLayout("3x3")).toBe(false);
    expect(isLayout(null)).toBe(false);
    expect(isLayout(42)).toBe(false);
  });

  it("dims: N columns, always exactly one row", () => {
    LAYOUTS.forEach((layout) => {
      const { cols, rows, cellCount } = dims(layout);
      expect(cols).toBe(Number(layout));
      expect(rows).toBe(1);
      expect(cellCount).toBe(cols);
    });
  });

  it("layoutForCount: one column per cell, clamped to 1..MAX_CELLS", () => {
    expect(layoutForCount(1)).toBe("1");
    expect(layoutForCount(5)).toBe("5");
    expect(layoutForCount(8)).toBe("8");
    expect(layoutForCount(0)).toBe("1");
    expect(layoutForCount(-3)).toBe("1");
    expect(layoutForCount(12)).toBe("8");
  });

  it("trackStyle: one equal column track per cell, a single full-height row", () => {
    expect(trackStyle("3")).toEqual({
      gridTemplateColumns: "1fr 1fr 1fr",
      gridTemplateRows: "1fr",
      gap: "4px",
    });
    LAYOUTS.forEach((layout) => {
      const style = trackStyle(layout);
      expect(style.gridTemplateColumns.split(" ")).toHaveLength(dims(layout).cols);
      expect(style.gridTemplateRows).toBe("1fr");
    });
  });
});
