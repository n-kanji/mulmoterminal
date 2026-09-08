// The agent self-drive API (R8): what a Claude session running on this machine may ask the
// app to do for it over HTTP — open a new grid column in a directory, and speak to every
// running Claude session at once.
//
// It exists because the operator's ~/.claude/CLAUDE.md workflow depends on an agent being
// able to branch its own work into a new pane (previously claudecode-notify's
// POST /api/workspace/add) and to address the whole fleet at once. Both sides read these
// shapes: the Express routes answer with them, the grid consumes the pub/sub event.
//
// Fork-local (iTerm2 mode). There is no MulmoClaude counterpart to match these paths
// against — MulmoClaude has no terminal grid, so nothing there owns "open a column".
import { isRecord } from "./isRecord.js";

/** The pub/sub channel the grid listens on for "open a column here" requests. The grid is
 *  browser state, so the host cannot open a cell itself — it asks whichever tab is connected,
 *  exactly like LAUNCH_TERMINAL_CHANNEL (#831) does for the phone. */
export const AGENT_COLUMN_CHANNEL = "agent-column";

/** What the grid needs to open the column. Deliberately NOT the prompt: the text stays on
 *  the server and is typed into the PTY at spawn (server/session/agent-prompt-queue.ts), so
 *  nothing that auto-runs in an agent ever travels through a browser. */
export interface AgentColumnEvent {
  cwd: string;
  /** A human name for the column, or null. The grid has no per-cell name field yet (R10);
   *  it is carried here so the cell can wear it the day that lands, and is logged meanwhile. */
  label: string | null;
  /** Parent (operator request 2026-09-08): the mulmoterminal session id of the pane that ASKED
   *  for this column — its tmux session name minus the `mt-` prefix — or null. The grid seats
   *  the new column right beside that pane and shows the two as a set (a shared colour band,
   *  the child naming its parent), so a Layer 2 / worker pane reads as belonging to the pane
   *  that spawned it. Absent on events from before this existed. */
  parent?: string | null;
}

export const agentColumnEventOf = (data: unknown): AgentColumnEvent | null => {
  if (!isRecord(data)) return null;
  const { cwd, label, parent } = data;
  if (typeof cwd !== "string" || !cwd) return null;
  return { cwd, label: typeof label === "string" && label ? label : null, parent: typeof parent === "string" && parent ? parent : null };
};

/** POST /api/workspace/column answers with this on success. `prompt` says whether a first
 *  turn was queued for the session the column is about to start — a caller that sent one and
 *  reads false has learned something (see the queue's TTL). */
export interface AgentColumnResponse {
  ok: true;
  cwd: string;
  label: string | null;
  prompt: boolean;
}

/** Why a running session did NOT receive a broadcast. "working" is the safety rule: typing
 *  into a session mid-turn corrupts whatever prompt is being composed there. */
export type BroadcastSkipReason = "working" | "send-failed";

export interface BroadcastSkip {
  id: string;
  reason: BroadcastSkipReason;
}

/** POST /api/broadcast answers with this. `sessions` are the ids that got the text, so a
 *  caller can say what it reached rather than assuming the fleet heard it. Sessions that are
 *  not Claude (a shell or codex cell) are not in either list — they were never candidates. */
export interface BroadcastResponse {
  sent: number;
  sessions: string[];
  skipped: BroadcastSkip[];
}
