// Fork-local (iTerm2 mode): what each pane state LOOKS like — the frame, the header row, the
// status strip's word and its dot.
//
// Extracted from TerminalCell (R10) once the launcher pane grew the same two-row header: a
// shell pane that said "シェル" in a different colour from every other pane's word would
// undo the point of having one vocabulary (common/paneState). One table per surface, and
// every state names its own colour — a base tint plus a status tint would be two `bg-*`
// utilities on one element, and Tailwind's output order, not this file, would decide.
import type { CellStatus } from "./gridTabs";
import type { Freshness } from "./paneFreshness";

const HEADER_FG = "text-[var(--cell-header-fg,inherit)]";
const CELL_QUIET_BORDER = "border-[var(--cell-border,var(--border))]";
const HEADER_QUIET = `bg-[var(--cell-header-bg,var(--bg-panel))] border-b-border ${HEADER_FG}`;
const STRIP_BLOCKED = "text-[#f59e0b]";

/** The state marker the specs assert on. Carries no styling — the tables below do. */
export const STATUS_CLASS: Record<CellStatus, string> = {
  approval: "is-blocked",
  question: "is-blocked",
  unread: "is-done",
  working: "is-working",
  disconnected: "is-disconnected",
  shell: "is-idle",
  idle: "is-idle",
};

/** The hover title: the same six words, spelled out. */
export const STATUS_LABEL: Record<CellStatus, string> = {
  approval: "Waiting for your approval",
  question: "Asking you something",
  unread: "Done — review",
  working: "Working…",
  disconnected: "Disconnected",
  shell: "Shell",
  idle: "Idle",
};

// R14 second pass: the frame and the header carry NO state colour at all any more — the
// operator asked for iTerm2-flat separators ("両端1ピクセルぐらい、色のハイライトもいらない").
// State lives in the strip's word + dot below, which is where the eye already reads it.
// The one exception is a DEAD pane: a red frame is an error, not a highlight.
export const CELL_STATUS: Record<CellStatus, string> = {
  idle: CELL_QUIET_BORDER,
  shell: CELL_QUIET_BORDER,
  working: CELL_QUIET_BORDER,
  unread: CELL_QUIET_BORDER,
  approval: CELL_QUIET_BORDER,
  question: CELL_QUIET_BORDER,
  disconnected: "border-[var(--err)]",
};

export const HEADER_STATUS: Record<CellStatus, string> = {
  idle: HEADER_QUIET,
  shell: HEADER_QUIET,
  working: HEADER_QUIET,
  unread: HEADER_QUIET,
  approval: HEADER_QUIET,
  question: HEADER_QUIET,
  disconnected: `bg-[var(--err-bg)] border-b-[var(--err)] text-[var(--err-text,var(--err))]`,
};

export const STRIP_STATUS: Record<CellStatus, string> = {
  working: "text-[#3b82f6]",
  approval: STRIP_BLOCKED,
  question: STRIP_BLOCKED,
  unread: "text-[#34d399]",
  disconnected: "text-[var(--err)]",
  shell: "text-muted",
  idle: "text-muted",
};

// The dot's colour is the STATE at full freshness and the AGE once a pane has been sitting:
// amber past five minutes, red past thirty. Two dimensions on one 6px dot, and it works
// because they never compete — a pane the operator is actively working never ages (working is
// exempt, see paneFreshness), so an aged dot always means "nobody has touched this".
export const STRIP_DOT: Record<CellStatus, string> = {
  working: "bg-[#3b82f6]",
  approval: "bg-[#f59e0b]",
  question: "bg-[#f59e0b]",
  unread: "bg-[#34d399]",
  disconnected: "bg-[var(--err)]",
  shell: "bg-[var(--text-dim)]",
  idle: "bg-[var(--text-dim)]",
};

export const FRESHNESS_DOT: Record<Freshness, string | null> = {
  fresh: null, // keep the state colour
  aging: "bg-[var(--warn)]",
  stale: "bg-[var(--err)]",
};

export const FRESHNESS_TITLE: Record<Freshness, string> = {
  fresh: "",
  aging: "5分以上動きなし",
  stale: "30分以上動きなし",
};

/** The always-visible per-pane status row: ONE 22px line, whatever kind of pane it is. Shared
 *  so the Claude cell and the launcher cell cannot drift into two different rows. */
export const CELL_STRIP = "flex h-[22px] flex-none items-center gap-1.5 overflow-hidden border-b border-b-border px-1.5";
export const CELL_STRIP_DOT = "h-1.5 w-1.5 flex-none rounded-full";
export const CELL_STRIP_WORD = "flex-none font-sans text-[11px] font-medium tracking-wide";
/** The row's one flexible element — the pane's own text (name / summary / what it runs). */
export const CELL_STRIP_MAIN = "min-w-0 flex-auto truncate font-sans text-[12px] text-fg";
/** The Claude cell's SECOND strip row — what is happening now (R14). Shorter than row 1
 *  (no rename input lives here) and dimmer: row 1 is identity, this is commentary. */
export const CELL_STRIP_ROW2 = "flex h-[20px] flex-none items-center overflow-hidden border-b border-b-border px-1.5 font-sans text-[11px] text-dim";
