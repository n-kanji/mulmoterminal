// Column widths the operator sets by hand (operator request 2026-09-08).
//
// Two independent things share this file because they follow the same rule — "a width
// you dragged is yours until you drag it again":
//
// 1. The parked dock's width, one number per browser (localStorage). 232px was a guess that
//    turned out too wide next to ten narrow columns.
// 2. Each grid column's share of the page, a per-cell `width` weight persisted with the cell.
//    The tracks are `<weight>fr`, so a page with no dragged column is still an equal split and
//    a drag between two neighbours moves width from one to the other — the rest of the page
//    never shifts. The weight rides with the cell through reorders, auto-sort and page moves.

// ---- parked dock ----------------------------------------------------------------------

export const DOCK_WIDTH_KEY = "parked_dock_width";
export const DEFAULT_DOCK = 232;
// Narrow enough that the cards become one word plus a dot; below this they stop being readable.
export const MIN_DOCK = 140;
export const MAX_DOCK = 520;
export const DOCK_STEP = 16;

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DOCK;
  return Math.max(MIN_DOCK, Math.min(MAX_DOCK, Math.round(width)));
}

export function readDockWidth(raw: string | null): number {
  return raw === null ? DEFAULT_DOCK : clampDockWidth(Number(raw));
}

// Arrow keys nudge, Home/End jump; null for a key that is not ours (the caller must not
// preventDefault on null, or the splitter swallows Tab and Escape while focused).
export function dockKeyWidth(key: string, current: number): number | null {
  if (key === "ArrowLeft") return clampDockWidth(current - DOCK_STEP);
  if (key === "ArrowRight") return clampDockWidth(current + DOCK_STEP);
  if (key === "Home") return MIN_DOCK;
  if (key === "End") return MAX_DOCK;
  return null;
}

// ---- grid columns ---------------------------------------------------------------------

// A pane narrower than this reflows xterm into garbage, so a drag stops here — unless the
// pair is already narrower than that (ten columns on a laptop): then the floor is a quarter of
// the pair, so a narrow page still trades width instead of the handle going silently dead.
export const MIN_COLUMN_PX = 200;
export const columnFloor = (pairPx: number, minPx = MIN_COLUMN_PX): number => Math.min(minPx, pairPx / 4);
export const COLUMN_STEP = 16;
// The persisted weight is bounded: a page never has more than MAX_CELLS columns, so a weight
// beyond this can only come from a hand-edited blob, and one that large would starve the
// other columns to zero.
export const MAX_WEIGHT = 50;
const WEIGHT_DECIMALS = 3;

export const DEFAULT_WEIGHT = 1;

// A cell's persisted weight, or undefined for anything that is not a sane positive number
// (absent, hand-edited to a string, zero, NaN, absurd).
export function cellWidth(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const w = Number(Math.min(v, MAX_WEIGHT).toFixed(WEIGHT_DECIMALS));
  // Checked AFTER rounding: 0.0004 rounds to 0, and a 0fr track is a pane with no width.
  return w > 0 && w !== DEFAULT_WEIGHT ? w : undefined;
}

export const weightOf = (cell: { width?: number }): number => cell.width ?? DEFAULT_WEIGHT;

// The two neighbours after the operator dragged the line between them by `dx` pixels.
// `leftPx` / `rightPx` are what the two columns measure now; the pair's total is conserved
// and neither may go under the floor (columnFloor: `minPx`, or a quarter of the pair when
// the pair is narrower than two of those).
export function dragSplit(leftPx: number, rightPx: number, dx: number, minPx = MIN_COLUMN_PX): { leftPx: number; rightPx: number } {
  const total = leftPx + rightPx;
  const floor = columnFloor(total, minPx);
  const next = Math.max(floor, Math.min(total - floor, leftPx + dx));
  return { leftPx: next, rightPx: total - next };
}

// The pair's weights after a drag of `dx` pixels. The pair's COMBINED weight is conserved —
// the left column's new share of it is its new share of the pair's pixels — so the other
// columns on the page keep exactly their share; the scale comes from the pair itself (its
// pixels over its weights), never from one column's stale weight. Null when the drag moved
// nothing (clamped, or the pair cannot hold two minimums).
export function dragWeights(
  leftPx: number,
  rightPx: number,
  leftWeight: number,
  rightWeight: number,
  dx: number,
  minPx = MIN_COLUMN_PX,
): { left: number; right: number } | null {
  const next = dragSplit(leftPx, rightPx, dx, minPx);
  if (next.leftPx === leftPx) return null;
  const pairWeight = leftWeight + rightWeight;
  const left = Number(((next.leftPx / (leftPx + rightPx)) * pairWeight).toFixed(WEIGHT_DECIMALS));
  return { left, right: Number((pairWeight - left).toFixed(WEIGHT_DECIMALS)) };
}

// The key's pixel nudge on the line, or null for a key that is not ours.
export function columnKeyDelta(key: string): number | null {
  if (key === "ArrowLeft") return -COLUMN_STEP;
  if (key === "ArrowRight") return COLUMN_STEP;
  return null;
}
