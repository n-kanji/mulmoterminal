// Delivering the head of a session's next-instruction queue (plans/feat-next-instruction-queue.md).
//
// The order matters and is the operator's requirement: the exchange that is about to be
// pushed off the screen is recorded FIRST, then the text is typed. A send that fails puts the
// item back and takes the hand-off back — a card saying "sent after this report" for text that
// never went out is misinformation, and losing what the operator meant to say is worse than a
// duplicate.
//
// Timing, measured 2026-08-26: Claude's Stop hook reaches us within ~40ms of the assistant
// record landing in the transcript — sometimes before it. Read at once and the hand-off holds
// the PREVIOUS turn's reply (or nothing), which is exactly the report this exists to keep. And
// the input-box clear (Ctrl-C, terminalInput.ts) arriving in that same window shows up as
// "[Request interrupted by user]" in the pane. So an automatic drain settles first, and the
// transcript is re-read until it shows the turn that just ended (its prompt matches the one
// the UserPromptSubmit hook recorded) or the retries run out.
//
// One drain at a time per session: an automatic drain mid-settle and a "send now" click would
// otherwise type two items in the wrong order, and the second paste could carry the box clear
// into the turn the first one just started. Every drain for a session queues behind the
// previous one, and the gates (auto, idle) are re-read after the wait, not before it.
import type { LastTurn } from "./last-turn.js";
import { dropHandoff, nextQueueOf, recordHandoff, restoreNext, takeNext } from "./next-queue.js";
import type { NextQueueState } from "../../common/nextQueue.js";

export interface DrainDeps {
  /** Type text into a session's input box and submit it (the phone / broadcast sender). */
  sendToSession: (sessionId: string, text: string, opts?: { multiline?: boolean }) => Promise<{ sent: boolean }>;
  /** The session's last completed exchange, from its transcript. */
  lastTurn: (sessionId: string) => Promise<LastTurn>;
  /** Tell every open grid the queue changed. */
  publish: (sessionId: string, state: NextQueueState) => void;
  /** The prompt of the turn that just ended, as the hooks recorded it (may be truncated), or
   *  undefined when nothing is known. Used to tell a fresh transcript from a stale one. */
  currentPrompt?: (sessionId: string) => string | undefined;
  /** Whether the host has SEEN the pane finish a turn and not start another (`working ===
   *  false`). Omitted means "don't know", which holds nothing back. */
  isIdle?: (sessionId: string) => boolean;
  /** Test seam for the settle / retry waits. */
  sleep?: (ms: number) => Promise<void>;
}

export type DrainResult =
  { sent: true; text: string; state: NextQueueState } | { sent: false; reason: "empty" | "auto-off" | "busy" | "send-failed"; state: NextQueueState };

/** How long an automatic drain waits after Stop before reading and typing. */
export const DRAIN_SETTLE_MS = 1500;
export const DRAIN_READ_RETRIES = 4;
export const DRAIN_RETRY_MS = 500;
/** After a send, how long the next drain for the same session is held: long enough for the
 *  UserPromptSubmit hook to mark the pane working, so a following paste cannot carry a box
 *  clear (Ctrl-C) into the turn the previous one just started. */
export const DRAIN_AFTER_SEND_MS = 1000;
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

async function drainOnce(sessionId: string, deps: DrainDeps, opts: { force?: boolean; settleMs?: number }): Promise<DrainResult> {
  const before = nextQueueOf(sessionId);
  if (before.items.length === 0) return { sent: false, reason: "empty", state: before };
  if (!before.auto && !opts.force) return { sent: false, reason: "auto-off", state: before };

  const sleep = deps.sleep ?? defaultSleep;
  const settle = opts.settleMs ?? (opts.force ? 0 : DRAIN_SETTLE_MS);
  if (settle > 0) await sleep(settle);

  // Re-read the gates AFTER the wait: the operator may have switched auto off, deleted the
  // item, or started typing (the pane is working again) while it ran.
  const now = nextQueueOf(sessionId);
  if (!now.auto && !opts.force) return { sent: false, reason: "auto-off", state: now };
  if (!opts.force && deps.isIdle && !deps.isIdle(sessionId)) return { sent: false, reason: "busy", state: now };
  const item = takeNext(sessionId);
  if (!item) return { sent: false, reason: "empty", state: nextQueueOf(sessionId) };

  // Read the transcript BEFORE typing: once the new prompt is submitted, "last turn" is it.
  const turn = await readCurrentTurn(sessionId, deps, sleep);
  const { state, handoff } = recordHandoff(sessionId, { text: item.text, prevPrompt: turn.prompt, prevReply: turn.reply });
  deps.publish(sessionId, state);

  try {
    await deps.sendToSession(sessionId, item.text, { multiline: true });
  } catch (err) {
    console.warn(`[next-queue] send to ${sessionId} failed, item restored: ${err instanceof Error ? err.message : String(err)}`);
    dropHandoff(sessionId, handoff.id);
    const restored = restoreNext(sessionId, item);
    deps.publish(sessionId, restored);
    return { sent: false, reason: "send-failed", state: restored };
  }
  console.log(`[next-queue] sent queued instruction to ${sessionId} (${state.items.length} left)`);
  await sleep(DRAIN_AFTER_SEND_MS);
  return { sent: true, text: item.text, state: nextQueueOf(sessionId) };
}

const inFlight = new Map<string, Promise<unknown>>();

/** Send the head item. `force` ignores the auto flag, the idle check and the settle (the
 *  "send now" button — the pane has been idle for as long as the operator took to click).
 *  Serialised per session: a call made while another drain runs waits for it. */
export function drainNextQueue(sessionId: string, deps: DrainDeps, opts: { force?: boolean; settleMs?: number } = {}): Promise<DrainResult> {
  const previous = inFlight.get(sessionId) ?? Promise.resolve();
  const run = previous.then(() => drainOnce(sessionId, deps, opts));
  const link = run.catch(() => undefined);
  inFlight.set(sessionId, link);
  void link.then(() => {
    if (inFlight.get(sessionId) === link) inFlight.delete(sessionId);
  });
  return run;
}
