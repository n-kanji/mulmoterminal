// Grid layout definitions shared by App (the picker) and TerminalGrid.
//
// Fork-local (iTerm2 mode): COLUMNS ONLY. Every cell is a full-height vertical
// pane and adding a cell adds a column, exactly like iTerm2's vertical splits.
// Stacking cells into rows was rejected deliberately: on a 27" 4K the operator
// reads long agent transcripts, and a second row halves the visible lines per
// pane. More sessions than MAX_CELLS overflow to the next page instead.

// Ordered smallest→largest: the grid grows through these as terminals are added.
export const LAYOUTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;
export type Layout = (typeof LAYOUTS)[number];

// Max columns on one page; bounds the persisted arrays (page size).
// 10, not 8: the operator's real workspaces run 9-10 columns each (R1), and an
// 8-column cap is exactly why the Claude desktop app was rejected as a host.
export const MAX_CELLS = 10;

export function isLayout(v: unknown): v is Layout {
  return typeof v === "string" && (LAYOUTS as readonly string[]).includes(v);
}

export function dims(layout: Layout) {
  const cols = Number(layout);
  return { cols, rows: 1, cellCount: cols };
}

// The smallest layout whose cells fit `count` terminals (clamped to 1..MAX_CELLS).
export function layoutForCount(count: number): Layout {
  const n = Math.max(1, Math.min(MAX_CELLS, Math.floor(count)));
  return LAYOUTS[n - 1];
}

// CSS grid track template for the layout: equal full-height columns, one row.
export function trackStyle(layout: Layout) {
  const { cols } = dims(layout);
  const tracks = Array.from({ length: cols }, () => "1fr").join(" ");
  // 2px, iTerm2-thin (R14): the separators are for parsing columns apart, not for breathing —
  // at 10 columns every gap pixel is paid ten times over.
  return { gridTemplateColumns: tracks, gridTemplateRows: "1fr", gap: "2px" };
}
