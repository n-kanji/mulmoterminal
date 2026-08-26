// Delivering the head of a session's next-instruction queue (plans/feat-next-instruction-queue.md).
//
// The order matters and is the operator's requirement: the exchange that is about to be
// pushed off the screen is recorded FIRST, then the text is typed. A send that fails puts the
// item back — losing what the operator meant to say is worse than a duplicate.
//
// Timing, measured 2026-08-26: Claude's Stop hook reaches us within ~40ms of the assistant
// record landing in the transcript — sometimes before it. Read at once and the hand-off holds
// the PREVIOUS turn's reply (or nothing), which is exactly the report this exists to keep. And
// the input-box clear (Ctrl-C, terminalInput.ts) arriving in that same window shows up as
// "[Request interrupted by user]" in the pane. So an automatic drain settles first, and the
// transcript is re-read until it shows the turn that just ended (its prompt matches the one
// the UserPromptSubmit hook recorded) or the retries run out.
import type { LastTurn } from "./last-turn.js";
import { nextQueueOf, recordHandoff, restoreNext, takeNext } from "./next-queue.js";
import type { NextQueueState } from "../../common/nextQueue.js";

export interface DrainDeps {
  /** Type text into a session's input box and submit it (the phone / broadcast sender). */
  sendToSession: (sessionId: string, text: string) => Promise<{ sent: boolean }>;
  /** The session's last completed exchange, from its transcript. */
  lastTurn: (sessionId: string) => Promise<LastTurn>;
  /** Tell every open grid the queue changed. */
  publish: (sessionId: string, state: NextQueueState) => void;
  /** The prompt of the turn that just ended, as the hooks recorded it (may be truncated), or
   *  undefined when nothing is known. Used to tell a fresh transcript from a stale one. */
  currentPrompt?: (sessionId: string) => string | undefined;
  /** Test seam for the settle / retry waits. */
  sleep?: (ms: number) => Promise<void>;
}

export type DrainResult =
  { sent: true; text: string; state: NextQueueState } | { sent: false; reason: "empty" | "auto-off" | "send-failed"; state: NextQueueState };

/** How long an automatic drain waits after Stop before reading and typing. */
export const DRAIN_SETTLE_MS = 1500;
export const DRAIN_READ_RETRIES = 4;
export const DRAIN_RETRY_MS = 500;
const PROMPT_MATCH_LEN = 40;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const squash = (s: string) => s.replace(/\s+/gu, " ").trim().slice(0, PROMPT_MATCH_LEN);

/** Whether the transcript's last turn is the one that just ended. Unknown prompt => trust
 *  any turn that has a reply. The hook's copy of the prompt is one-line and truncated, so the
 *  two are compared on the prefix they both have. */
export function turnIsCurrent(turn: LastTurn, expectedPrompt: string | undefined): boolean {
  if (turn.reply === null) return false;
  if (!expectedPrompt || !turn.prompt) return true;
  const a = squash(turn.prompt);
  const b = squash(expectedPrompt);
  const n = Math.min(a.length, b.length);
  return n > 0 && a.slice(0, n) === b.slice(0, n);
}

async function readCurrentTurn(sessionId: string, deps: DrainDeps, sleep: (ms: number) => Promise<void>): Promise<LastTurn> {
  const expected = deps.currentPrompt?.(sessionId);
  let turn: LastTurn = { prompt: null, reply: null };
  for (let attempt = 0; attempt <= DRAIN_READ_RETRIES; attempt++) {
    if (attempt > 0) await sleep(DRAIN_RETRY_MS);
    try {
      turn = await deps.lastTurn(sessionId);
    } catch {
      // no transcript is not a reason to hold the instruction; keep trying, then go on
    }
    if (turnIsCurrent(turn, expected)) return turn;
  }
  return turn;
}

/** Send the head item now. `force` ignores the auto flag and skips the settle (the "send now"
 *  button — the pane has been idle for as long as the operator took to click). */
export async function drainNextQueue(sessionId: string, deps: DrainDeps, opts: { force?: boolean; settleMs?: number } = {}): Promise<DrainResult> {
  const before = nextQueueOf(sessionId);
  if (before.items.length === 0) return { sent: false, reason: "empty", state: before };
  if (!before.auto && !opts.force) return { sent: false, reason: "auto-off", state: before };

  const sleep = deps.sleep ?? defaultSleep;
  const settle = opts.settleMs ?? (opts.force ? 0 : DRAIN_SETTLE_MS);
  if (settle > 0) await sleep(settle);

  // Taken AFTER the settle: an item the operator deletes during that window must not go out.
  const item = takeNext(sessionId);
  if (!item) return { sent: false, reason: "empty", state: nextQueueOf(sessionId) };

  // Read the transcript BEFORE typing: once the new prompt is submitted, "last turn" is it.
  const turn = await readCurrentTurn(sessionId, deps, sleep);
  const state = recordHandoff(sessionId, { text: item.text, prevPrompt: turn.prompt, prevReply: turn.reply });
  deps.publish(sessionId, state);

  try {
    await deps.sendToSession(sessionId, item.text);
  } catch (err) {
    console.warn(`[next-queue] send to ${sessionId} failed, item restored: ${err instanceof Error ? err.message : String(err)}`);
    const restored = restoreNext(sessionId, item);
    deps.publish(sessionId, restored);
    return { sent: false, reason: "send-failed", state: restored };
  }
  console.log(`[next-queue] sent queued instruction to ${sessionId} (${state.items.length} left)`);
  return { sent: true, text: item.text, state: nextQueueOf(sessionId) };
}
