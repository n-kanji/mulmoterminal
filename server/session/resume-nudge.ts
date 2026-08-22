// The one-line "carry on" typed into a pane restarted by the account switcher.
//
// Same shape and rationale as agent-prompt-queue.ts: the text auto-runs in an agent, so it
// must not travel through the browser — the restart route parks it here, keyed by the OLD
// session id, and the WebSocket route takes it back out when the client's auto-reconnect
// spawns the `--resume` for that id (ws-routes.ts). The existing typing machinery
// (draft-injection.ts) then delivers it once claude's input box is ready.
//
// Keyed by session id rather than directory because the restart knows exactly which session
// it killed — and several panes in one directory restart at once, so a directory key would
// hand pane A's nudge to pane B. Single use, and an unclaimed nudge expires rather than
// ambushing a session the user resumes by hand minutes later.

/** How long an unclaimed nudge stays available. The auto-reconnect lands within seconds;
 *  anything later is a human reopening the session, who did not ask to be nudged. */
export const RESUME_NUDGE_TTL_MS = 120_000;

interface QueuedNudge {
  text: string;
  at: number;
}

const nudges = new Map<string, QueuedNudge>();

/** Park a nudge for the reconnect that will resume `sessionId`. Replaces any earlier one. */
export function queueResumeNudge(sessionId: string, text: string, now: number = Date.now()): void {
  nudges.set(sessionId, { text, at: now });
}

/** Take the nudge parked for `sessionId`, or undefined. Single use; expired entries are
 *  dropped as they are passed. */
export function takeResumeNudge(sessionId: string | null | undefined, now: number = Date.now()): string | undefined {
  if (!sessionId) return undefined;
  const entry = nudges.get(sessionId);
  if (!entry) return undefined;
  nudges.delete(sessionId);
  return now - entry.at <= RESUME_NUDGE_TTL_MS ? entry.text : undefined;
}

/** Empty the store. Test seam — the map is module state shared by every spec in a file. */
export function clearResumeNudges(): void {
  nudges.clear();
}
