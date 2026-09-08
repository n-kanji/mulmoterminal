import { describe, it, expect } from "vitest";
import {
  clampDockWidth,
  readDockWidth,
  dockKeyWidth,
  DEFAULT_DOCK,
  MIN_DOCK,
  MAX_DOCK,
  DOCK_STEP,
  cellWidth,
  weightOf,
  dragSplit,
  dragWeights,
  columnKeyDelta,
  COLUMN_STEP,
  MAX_WEIGHT,
} from "../../../src/components/columnWidth";

describe("parked dock width", () => {
  it("defaults when nothing is stored and clamps what is", () => {
    expect(readDockWidth(null)).toBe(DEFAULT_DOCK);
    expect(readDockWidth("180")).toBe(180);
    expect(readDockWidth("10")).toBe(MIN_DOCK);
    expect(readDockWidth("9999")).toBe(MAX_DOCK);
    expect(readDockWidth("garbage")).toBe(DEFAULT_DOCK);
    expect(clampDockWidth(200.6)).toBe(201);
  });
  it("keys nudge and jump, other keys are not ours", () => {
    expect(dockKeyWidth("ArrowLeft", 200)).toBe(200 - DOCK_STEP);
    expect(dockKeyWidth("ArrowRight", 200)).toBe(200 + DOCK_STEP);
    expect(dockKeyWidth("Home", 200)).toBe(MIN_DOCK);
    expect(dockKeyWidth("End", 200)).toBe(MAX_DOCK);
    expect(dockKeyWidth("Tab", 200)).toBeNull();
    expect(dockKeyWidth("ArrowLeft", MIN_DOCK)).toBe(MIN_DOCK);
  });
});

describe("column weights", () => {
  it("cellWidth keeps sane weights, drops the default and garbage", () => {
    expect(cellWidth(1.5)).toBe(1.5);
    expect(cellWidth(0.33333)).toBeCloseTo(0.333, 3);
    expect(cellWidth(1)).toBeUndefined();
    expect(cellWidth(0)).toBeUndefined();
    expect(cellWidth(-2)).toBeUndefined();
    // Rounds to 0 — a 0fr track — so it is dropped, not kept.
    expect(cellWidth(0.0004)).toBeUndefined();
    expect(cellWidth(NaN)).toBeUndefined();
    expect(cellWidth("2")).toBeUndefined();
    expect(cellWidth(undefined)).toBeUndefined();
    expect(cellWidth(1e9)).toBe(MAX_WEIGHT);
    expect(weightOf({})).toBe(1);
    expect(weightOf({ width: 2 })).toBe(2);
  });
  it("dragSplit conserves the pair's total and respects the floor", () => {
    expect(dragSplit(400, 400, 100, 200)).toEqual({ leftPx: 500, rightPx: 300 });
    expect(dragSplit(400, 400, -100, 200)).toEqual({ leftPx: 300, rightPx: 500 });
    // Cannot push the neighbour under the floor.
    expect(dragSplit(400, 400, 500, 200)).toEqual({ leftPx: 600, rightPx: 200 });
    expect(dragSplit(400, 400, -500, 200)).toEqual({ leftPx: 200, rightPx: 600 });
    // A pair too narrow for two minimums (ten columns on a laptop) still trades width, down
    // to a quarter of the pair — a dead handle with no feedback was the alternative.
    expect(dragSplit(150, 150, 50, 200)).toEqual({ leftPx: 200, rightPx: 100 });
    expect(dragSplit(150, 150, 500, 200)).toEqual({ leftPx: 225, rightPx: 75 });
  });
  it("dragWeights moves weight between the pair and conserves their total", () => {
    expect(dragWeights(400, 400, 1, 1, 100)).toEqual({ left: 1.25, right: 0.75 });
    // Already-dragged pair: the scale is the pair's own, so the total still holds.
    const w = dragWeights(600, 200, 1.5, 0.5, -200);
    expect(w).toEqual({ left: 1, right: 1 });
    // A drag that the floor clamps to nothing is null, not a no-op emit.
    expect(dragWeights(200, 600, 0.5, 1.5, -50)).toBeNull();
    expect(dragWeights(150, 150, 1, 1, 0)).toBeNull();
    // Many small events do not drift: replaying step by step lands where one jump does.
    let leftPx = 683;
    let rightPx = 683;
    let lw = 1;
    let rw = 1;
    for (let i = 0; i < 20; i++) {
      const step = dragWeights(leftPx, rightPx, lw, rw, 10);
      if (!step) break;
      leftPx += 10;
      rightPx -= 10;
      lw = step.left;
      rw = step.right;
    }
    expect(lw + rw).toBeCloseTo(2, 2);
    expect(lw).toBeCloseTo((883 / 1366) * 2, 2);
  });
  it("columnKeyDelta", () => {
    expect(columnKeyDelta("ArrowLeft")).toBe(-COLUMN_STEP);
    expect(columnKeyDelta("ArrowRight")).toBe(COLUMN_STEP);
    expect(columnKeyDelta("Home")).toBeNull();
  });
});
