// Pure derivations from a session's activity record: what a flag change makes it, and what
// the row published to subscribers looks like. The decisions only — no publish, no
// persistence, no reap. Split from index.ts (#548 step 3h):
// setWorking and setWaiting differed by one field but each re-derived the same rules, and
// both are load-bearing. The "unchanged" answer is what keeps an idle session from
// republishing on every hook, and the event fallback is what keeps a row labelled with the
// event that last meant something rather than blanking it.
import type { Activity } from "./types.js";
import type { WaitKind } from "../../common/paneState.js";

/** The record to store, or null when nothing changed and the caller should do nothing.
 *  `event` falls back to the previous one so a change that carries no event keeps the
 *  label the row already had; only an explicit null clears it (via a first-ever write).
 *
 *  ONE case updates without the flag moving: a session already `waiting` that receives a
 *  fresh wait. The flag cannot move (it is already true), so the plain no-op rule would
 *  freeze the pane on whatever asked FIRST — a session that finished a turn unread and then
 *  hit a permission prompt would keep saying "完了・未読" while it blocks. It is scoped to
 *  the waiting flag going/staying true, and still returns null unless the event or the wait
 *  kind actually differs, so the working-flag re-assertions (PreToolUse/PostToolUse fire
 *  constantly with a changing event name) stay no-ops and cannot flood the socket. */
export function nextActivity(
  prev: Activity | undefined,
  patch: { working: boolean } | { waiting: boolean },
  event: string | undefined,
  now: number,
  waitKind?: WaitKind | null,
): Activity | null {
  const current = prev ?? {};
  const isWaiting = "waiting" in patch;
  const key = isWaiting ? "waiting" : "working";
  const value = "working" in patch ? patch.working : patch.waiting;
  const nextEvent = event ?? current.event ?? null;
  if ((current[key] ?? false) === value) {
    return isWaiting && value ? escalatedWait(current, nextEvent, waitKind, now) : null;
  }
  return { ...current, [key]: value, event: nextEvent, waitKind: nextWaitKind(current, isWaiting, value, waitKind), at: now };
}

/** The kind to store alongside a flag that IS moving. It belongs to the wait: raising
 *  `waiting` records it, dropping `waiting` clears it, and a working-flag change leaves
 *  whatever the wait recorded alone. */
function nextWaitKind(current: Activity, isWaiting: boolean, value: boolean, waitKind: WaitKind | null | undefined): WaitKind | null {
  const carried = current.waitKind ?? null;
  if (!isWaiting) return carried;
  return value ? (waitKind ?? carried) : null;
}

/** A new wait arriving at a session that is ALREADY waiting: the flag cannot move, so this is
 *  the only way the row learns about it. Null when nothing actually differs, which is what
 *  keeps a repeated Notification from republishing the row on every hook. */
function escalatedWait(current: Activity, nextEvent: string | null, waitKind: WaitKind | null | undefined, now: number): Activity | null {
  const nextKind = waitKind ?? current.waitKind ?? null;
  if (nextEvent === (current.event ?? null) && nextKind === (current.waitKind ?? null)) return null;
  return { ...current, event: nextEvent, waitKind: nextKind, at: now };
}

/** The session row published to subscribers. Every field is defaulted here rather than at
 *  the receiving end, so a session with no activity yet still reads as idle instead of
 *  arriving with holes. */
export interface SessionRow {
  id: string;
  cwd: string | null;
  working: boolean;
  waiting: boolean;
  event: string | null;
  /** Splits a Notification wait into approval vs question (common/paneState). */
  waitKind: WaitKind | null;
  /** Epoch ms of the last state change, so the client can age the pane's dot. Null for a
   *  session that has never reported anything — which reads as fresh, not as stale. */
  lastActivityAt: number | null;
  /** Why this pane exists, as the operator (or the agent in it) wrote it. Independent of
   *  the turn-by-turn state, which is exactly why it rides on the same row. */
  mission: string | null;
  lastPrompt: string | null;
  aiTitle: string | null;
  lastResponse: string | null;
  /** The agent's in_progress task (TodoWrite mirror) — what is happening RIGHT NOW,
   *  mid-turn, without waiting for the turn-end AI summary. Null outside a turn. */
  liveTask: string | null;
}

export function sessionRow(
  id: string,
  activity: Activity | undefined,
  cwd: string | null,
  texts: { lastPrompt?: string; aiTitle?: string; lastResponse?: string; mission?: string | null; liveTask?: string | null },
): SessionRow {
  const a = activity ?? {};
  return {
    id,
    cwd,
    working: a.working ?? false,
    waiting: a.waiting ?? false,
    event: a.event ?? null,
    waitKind: a.waitKind ?? null,
    lastActivityAt: a.at ?? null,
    mission: texts.mission ?? null,
    lastPrompt: texts.lastPrompt ?? null,
    aiTitle: texts.aiTitle ?? null,
    lastResponse: texts.lastResponse ?? null,
    liveTask: texts.liveTask ?? null,
  };
}

/** Whether to re-read the transcript's tail before publishing. `waiting` means a turn just
 *  ended, which is the moment the roster's copy of the reply goes stale; without a cwd
 *  there is no transcript to read. */
export function shouldRefreshReply(activity: Activity | undefined, cwd: string | null): cwd is string {
  return !!(activity?.waiting && cwd);
}
