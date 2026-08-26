// Delivering the head of a session's next-instruction queue (plans/feat-next-instruction-queue.md).
//
// The order matters and is the operator's requirement: record the exchange that is about to be
// pushed off the screen FIRST, then type. A send that fails puts the item back — losing what
// the operator meant to say is worse than a duplicate.
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
}

export type DrainResult =
  { sent: true; text: string; state: NextQueueState } | { sent: false; reason: "empty" | "auto-off" | "send-failed"; state: NextQueueState };

/** Send the head item now. `force` ignores the auto flag (the "send now" button). */
export async function drainNextQueue(sessionId: string, deps: DrainDeps, opts: { force?: boolean } = {}): Promise<DrainResult> {
  const before = nextQueueOf(sessionId);
  if (before.items.length === 0) return { sent: false, reason: "empty", state: before };
  if (!before.auto && !opts.force) return { sent: false, reason: "auto-off", state: before };

  const item = takeNext(sessionId);
  if (!item) return { sent: false, reason: "empty", state: nextQueueOf(sessionId) };

  // Read the transcript BEFORE typing: once the new prompt is submitted, "last turn" is it.
  let turn: LastTurn = { prompt: null, reply: null };
  try {
    turn = await deps.lastTurn(sessionId);
  } catch {
    // no transcript is not a reason to hold the instruction
  }
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
