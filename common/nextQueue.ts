// The per-pane "next instructions" queue (operator request 2026-08-26): text parked on a
// session and typed into it when the pane is waiting for input, so the operator can stop
// interrupting a running turn with "oh, and also...".
//
// Both sides read these shapes: the Express routes answer with them and the grid consumes
// the pub/sub event. Fork-local (iTerm2 mode) — MulmoClaude has no terminal grid, so there
// is no counterpart to match.
import { isRecord } from "./isRecord.js";

/** Pub/sub channel carrying `{ id, state }` whenever a session's queue changes. Published to
 *  every browser (it is state, not an action — unlike AGENT_COLUMN_CHANNEL). */
export const NEXT_QUEUE_CHANNEL = "next-queue";

export interface NextQueueItem {
  id: string;
  text: string;
  /** When it was queued (ms epoch). */
  at: number;
}

/** One automatic hand-off: the instruction that was typed, and the exchange it pushed off
 *  the screen. The operator's requirement: a queued item must never silently bury the report
 *  the pane had just finished, so the superseded reply is kept here until read. */
export interface NextQueueHandoff {
  id: string;
  /** The instruction that was sent. */
  text: string;
  sentAt: number;
  /** The prompt / reply of the turn that ended right before the send, as far as the
   *  transcript had them. */
  prevPrompt: string | null;
  prevReply: string | null;
  read: boolean;
}

export interface NextQueueState {
  /** Type the head item as soon as the pane finishes a turn. */
  auto: boolean;
  items: NextQueueItem[];
  handoffs: NextQueueHandoff[];
}

export const EMPTY_NEXT_QUEUE: NextQueueState = { auto: true, items: [], handoffs: [] };

export interface NextQueueEvent {
  id: string;
  state: NextQueueState;
}

function itemOf(v: unknown): NextQueueItem | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.text !== "string") return null;
  return { id: v.id, text: v.text, at: typeof v.at === "number" ? v.at : 0 };
}

function handoffOf(v: unknown): NextQueueHandoff | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.text !== "string") return null;
  return {
    id: v.id,
    text: v.text,
    sentAt: typeof v.sentAt === "number" ? v.sentAt : 0,
    prevPrompt: typeof v.prevPrompt === "string" ? v.prevPrompt : null,
    prevReply: typeof v.prevReply === "string" ? v.prevReply : null,
    read: v.read === true,
  };
}

/** Parse a state off the wire (or off disk), dropping malformed entries rather than trusting
 *  the shape. `null` when the value is not a state at all. */
export function nextQueueStateOf(data: unknown): NextQueueState | null {
  if (!isRecord(data) || !Array.isArray(data.items) || !Array.isArray(data.handoffs)) return null;
  return {
    auto: data.auto !== false,
    items: data.items.map(itemOf).filter((x): x is NextQueueItem => x !== null),
    handoffs: data.handoffs.map(handoffOf).filter((x): x is NextQueueHandoff => x !== null),
  };
}

export function nextQueueEventOf(data: unknown): NextQueueEvent | null {
  if (!isRecord(data) || typeof data.id !== "string") return null;
  const state = nextQueueStateOf(data.state);
  return state ? { id: data.id, state } : null;
}

export const unreadHandoffCount = (state: NextQueueState): number => state.handoffs.filter((h) => !h.read).length;
