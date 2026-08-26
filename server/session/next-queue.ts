// The per-pane "next instructions" queue store (plans/feat-next-instruction-queue.md).
//
// Keyed by the grid's session id (the pane), not Claude's own id — a /clear inside the pane
// must keep its queue, and the routes translate the agent's own id through session-alias.ts
// the way the mission route does. Persisted, because a parked instruction is exactly the kind
// of thing that must survive a server restart the way the pane itself does (tmux keeps the
// session; this keeps what the operator meant to send it next).
//
// Same persistence shape as mission-store.ts: pure parse / prune, a hydration promise every
// reader awaits, and one serialised write chain.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MULMOTERMINAL_HOME } from "../config/env.js";
import { isRecord } from "../../common/isRecord.js";
import { EMPTY_NEXT_QUEUE, nextQueueStateOf, type NextQueueHandoff, type NextQueueItem, type NextQueueState } from "../../common/nextQueue.js";
import { messageOf } from "../errors.js";

export interface NextQueueRecord extends NextQueueState {
  updatedAt: number;
}

// A pasted plan can be long — that is why the sender types rather than passes an argument —
// but a megabyte is a mistake, not an instruction. Same ceiling as the column API's prompt.
export const NEXT_QUEUE_MAX_TEXT = 100_000;
// Hand-offs are a reading list, not an archive: past this many the oldest READ ones go.
// Unread ones are never dropped by count — dropping one silently is the failure this exists
// to prevent — so the ceiling applies to read entries only.
export const NEXT_QUEUE_MAX_HANDOFFS = 20;
// The superseded reply is stored in full up to this; the reading view is one popover.
export const NEXT_QUEUE_MAX_REPLY = 20_000;
export const NEXT_QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const NEXT_QUEUE_MAX_ENTRIES = 500;

/** Normalise a caller's text: trim, keep the line structure, clip. Blank is refused (there is
 *  nothing to type), so the caller gets a 400 rather than an empty item. */
export function normalizeQueueText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/gu, "\n").trim();
  if (!text) return null;
  return text.slice(0, NEXT_QUEUE_MAX_TEXT);
}

const clipReply = (text: string | null): string | null => (text === null ? null : text.slice(0, NEXT_QUEUE_MAX_REPLY));

/** Parse the persisted file, dropping anything malformed rather than trusting the shape. */
export function parseQueues(raw: unknown, isValidId: (id: string) => boolean): Array<{ id: string } & NextQueueRecord> {
  if (!isRecord(raw)) return [];
  const out: Array<{ id: string } & NextQueueRecord> = [];
  for (const [id, v] of Object.entries(raw)) {
    if (!isValidId(id) || !isRecord(v)) continue;
    const state = nextQueueStateOf(v);
    if (!state) continue;
    if (state.items.length === 0 && state.handoffs.length === 0 && state.auto) continue; // nothing to keep
    out.push({ id, ...state, updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0 });
  }
  return out;
}

/** Which entries survive a save: live sessions always; others while recent; capped. A record
 *  with nothing in it (empty queue, no hand-offs, default auto) is not worth a line. */
export function pruneQueues(
  entries: Iterable<readonly [string, NextQueueRecord]>,
  opts: { isLive: (id: string) => boolean; now: number; maxAgeMs?: number; maxEntries?: number },
): Record<string, NextQueueRecord> {
  const maxAgeMs = opts.maxAgeMs ?? NEXT_QUEUE_MAX_AGE_MS;
  const maxEntries = opts.maxEntries ?? NEXT_QUEUE_MAX_ENTRIES;
  const kept = [...entries]
    .filter(([, rec]) => rec.items.length > 0 || rec.handoffs.length > 0 || !rec.auto)
    .filter(([id, rec]) => opts.isLive(id) || opts.now - rec.updatedAt <= maxAgeMs)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, maxEntries);
  return Object.fromEntries(kept);
}

/** Keep every unread hand-off and the newest read ones up to the cap. Pure. */
export function trimHandoffs(handoffs: readonly NextQueueHandoff[], max: number = NEXT_QUEUE_MAX_HANDOFFS): NextQueueHandoff[] {
  const unread = handoffs.filter((h) => !h.read);
  const read = handoffs.filter((h) => h.read);
  const keepRead = Math.max(0, max - unread.length);
  const dropped = new Set(read.slice(0, Math.max(0, read.length - keepRead)).map((h) => h.id));
  return handoffs.filter((h) => !dropped.has(h.id));
}

const QUEUE_FILE = path.join(MULMOTERMINAL_HOME, "next-queue.json");

const queues = new Map<string, NextQueueRecord>();

// Test seam: the specs exercise the store without writing into the developer's
// ~/.mulmoterminal. Off only under vitest.
let persistence = process.env.VITEST === undefined;
export function setNextQueuePersistence(enabled: boolean): void {
  persistence = enabled;
}

export const nextQueuesHydrated: Promise<void> = (async () => {
  if (!persistence) return;
  try {
    const parsed = parseQueues(JSON.parse(await fs.readFile(QUEUE_FILE, "utf8")), () => true);
    for (const { id, ...rec } of parsed) if (!queues.has(id)) queues.set(id, rec);
  } catch {
    // no file yet / unreadable => nothing to restore
  }
})();

let persist: Promise<void> = Promise.resolve();
let isLiveFn: (id: string) => boolean = () => true;
/** Who decides "this session is still live" at prune time — index.ts wires the PTY table. */
export function setNextQueueLiveness(isLive: (id: string) => boolean): void {
  isLiveFn = isLive;
}

function persistQueues(): void {
  if (!persistence) return;
  persist = persist
    .then(() => nextQueuesHydrated)
    .then(() => fs.mkdir(MULMOTERMINAL_HOME, { recursive: true }))
    .then(async () => {
      const next = pruneQueues(queues, { isLive: isLiveFn, now: Date.now() });
      for (const id of [...queues.keys()]) if (!(id in next)) queues.delete(id);
      await fs.writeFile(QUEUE_FILE, JSON.stringify(next));
    })
    .catch((e) => console.error(`[next-queue] failed to persist: ${messageOf(e)}`));
}

const snapshot = (rec: NextQueueRecord | undefined): NextQueueState =>
  rec
    ? { auto: rec.auto, items: rec.items.map((i) => ({ ...i })), handoffs: rec.handoffs.map((h) => ({ ...h })) }
    : { ...EMPTY_NEXT_QUEUE, items: [], handoffs: [] };

/** The state as the wire / the grid sees it. Always a fresh copy. */
export const nextQueueOf = (id: string): NextQueueState => snapshot(queues.get(id));

function mutate(id: string, fn: (rec: NextQueueRecord) => void): NextQueueState {
  const rec = queues.get(id) ?? { ...EMPTY_NEXT_QUEUE, items: [], handoffs: [], updatedAt: 0 };
  fn(rec);
  rec.updatedAt = Date.now();
  queues.set(id, rec);
  persistQueues();
  return snapshot(rec);
}

export function enqueueNext(id: string, text: string, now: number = Date.now()): { state: NextQueueState; item: NextQueueItem } {
  const item: NextQueueItem = { id: randomUUID(), text, at: now };
  const state = mutate(id, (rec) => rec.items.push(item));
  return { state, item };
}

/** Remove one queued item. `false` when there was no such item. */
export function dequeueNext(id: string, itemId: string): { state: NextQueueState; removed: boolean } {
  let removed = false;
  const state = mutate(id, (rec) => {
    const before = rec.items.length;
    rec.items = rec.items.filter((i) => i.id !== itemId);
    removed = rec.items.length !== before;
  });
  return { state, removed };
}

export function setNextAuto(id: string, auto: boolean): NextQueueState {
  return mutate(id, (rec) => {
    rec.auto = auto;
  });
}

/** Take the head item off the queue, or undefined when it is empty. */
export function takeNext(id: string): NextQueueItem | undefined {
  const rec = queues.get(id);
  if (!rec || rec.items.length === 0) return undefined;
  let head: NextQueueItem | undefined;
  mutate(id, (r) => {
    head = r.items.shift();
  });
  return head;
}

/** Put an item back at the head — the send failed, and losing the text is worse than
 *  sending it twice. */
export function restoreNext(id: string, item: NextQueueItem): NextQueueState {
  return mutate(id, (rec) => rec.items.unshift(item));
}

export function recordHandoff(
  id: string,
  handoff: { text: string; prevPrompt: string | null; prevReply: string | null },
  now: number = Date.now(),
): NextQueueState {
  return mutate(id, (rec) => {
    rec.handoffs.push({
      id: randomUUID(),
      text: handoff.text,
      sentAt: now,
      prevPrompt: clipReply(handoff.prevPrompt),
      prevReply: clipReply(handoff.prevReply),
      read: false,
    });
    rec.handoffs = trimHandoffs(rec.handoffs);
  });
}

/** Mark every hand-off read (the operator opened the list). */
export function markHandoffsRead(id: string): NextQueueState {
  return mutate(id, (rec) => {
    for (const h of rec.handoffs) h.read = true;
    rec.handoffs = trimHandoffs(rec.handoffs);
  });
}

/** Test seam — the map is module state shared by every spec in a file. */
export function clearNextQueues(): void {
  queues.clear();
}
