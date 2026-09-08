// The first turn POST /api/workspace/column asked for, held until the column's session
// actually spawns.
//
// Why a queue rather than a field on the request the grid receives: the prompt auto-runs in
// an agent, so it must not travel through the browser — a page that can reach the pub/sub
// socket could otherwise put text in front of a fresh Claude. The route parks it here, the
// grid is told only WHERE to open a column, and the WebSocket route takes the prompt back out
// when that column spawns (ws-routes.ts). The existing typing machinery
// (draft-injection.ts) then delivers it: bracketed paste once Claude's input box is up, then
// Enter.
//
// Keyed by directory, because that is the only thing both ends know: the session id does not
// exist yet when the route answers. Two columns asked for in the same directory queue two
// prompts and are served in order (FIFO) — a prompt can land in the sibling column, which is
// the same directory and the same agent, and is the honest limit of matching on a directory.
// An unclaimed prompt expires rather than waiting forever for a column that was closed before
// it connected.

/** How long an unclaimed prompt stays available. Long enough for a browser to render a cell
 *  and open its socket on a busy machine; short enough that a prompt cannot resurface in a
 *  session started by hand minutes later. */
export const AGENT_PROMPT_TTL_MS = 120_000;

interface QueuedPrompt {
  prompt: string;
  at: number;
}

const queued = new Map<string, QueuedPrompt[]>();

/** Park a first turn for the next fresh Claude session in `cwd`. */
export function queueAgentPrompt(cwd: string, prompt: string, now: number = Date.now()): void {
  const list = queued.get(cwd) ?? [];
  list.push({ prompt, at: now });
  queued.set(cwd, list);
}

/** Take the oldest unexpired prompt for `cwd`, or undefined. Single use: the caller is the
 *  session that will run it. Expired entries are dropped as they are passed, so a directory
 *  nobody launches in stops holding memory the next time it is asked about. */
export function takeAgentPrompt(cwd: string, now: number = Date.now()): string | undefined {
  const list = queued.get(cwd);
  if (!list) return undefined;
  while (list.length > 0) {
    const next = list.shift();
    if (list.length === 0) queued.delete(cwd);
    if (next && now - next.at <= AGENT_PROMPT_TTL_MS) return next.prompt;
  }
  return undefined;
}

/** Give back a prompt that could not be handed to a grid after all (nobody was listening),
 *  so it cannot ambush a column the user opens by hand later. */
export function dropAgentPrompt(cwd: string, prompt: string): void {
  const list = queued.get(cwd);
  if (!list) return;
  const index = list.findIndex((entry) => entry.prompt === prompt);
  if (index >= 0) list.splice(index, 1);
  if (list.length === 0) queued.delete(cwd);
}

/** How many prompts are parked for a directory (all of them when `cwd` is omitted). Exported
 *  for the specs and for a future status surface — nothing in the app reads it. */
export function queuedAgentPromptCount(cwd?: string): number {
  if (cwd !== undefined) return queued.get(cwd)?.length ?? 0;
  let total = 0;
  for (const list of queued.values()) total += list.length;
  return total;
}

// ---- the first turn a session was GIVEN, kept for a restart (operator request 2026-09-08) ----
//
// A column opened by the API can die before its first turn ever runs: Claude's "trust this
// folder?" answered No, a wrapper that fails to load, a bad --add-dir. The queued prompt was
// consumed at spawn and typed into a PTY that is now gone, and the pane sits at
// "[session ended]" with nothing to restart. So the typed first turn is remembered under the
// session it was typed into; when that pane is relaunched (the cell keeps asking for its old
// id, which has no transcript because the turn never ran), the restart takes it again.
// Single-keyed by session id, so a hand-opened pane in the same directory never inherits it.

/** How long a first turn stays restartable. Long enough to notice a dead pane after lunch. */
export const FIRST_TURN_TTL_MS = 30 * 60_000;

const firstTurns = new Map<string, QueuedPrompt>();

/** Remember the first turn typed into `sessionId`, so a restart of that pane can retype it. */
export function rememberFirstTurn(sessionId: string, prompt: string, now: number = Date.now()): void {
  firstTurns.set(sessionId, { prompt, at: now });
}

/** The first turn `sessionId` was given, if it is still within its TTL. Not consumed: a pane
 *  that dies twice before the turn runs gets it a third time; a pane whose turn DID run has a
 *  transcript, resumes instead of restarting, and never asks. */
export function recallFirstTurn(sessionId: string | null, now: number = Date.now()): string | undefined {
  if (!sessionId) return undefined;
  const entry = firstTurns.get(sessionId);
  if (!entry) return undefined;
  if (now - entry.at > FIRST_TURN_TTL_MS) {
    firstTurns.delete(sessionId);
    return undefined;
  }
  return entry.prompt;
}

/** Empty the queue and the remembered first turns. Test seam — module state shared by every
 *  spec in a file. */
export function clearAgentPrompts(): void {
  queued.clear();
  firstTurns.clear();
}
