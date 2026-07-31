import type { PushKind } from "../../common/pushKinds.js";
import type { WaitKind } from "../../common/paneState.js";

// Pure decision for a Claude activity hook (UserPromptSubmit / Stop / Notification).
//
// `active` = this session is the user's actively-viewed pane: the single-view open
// session, or a focused/zoomed grid cell. An active pane never raises the attention
// flag (the user is already looking at it). A grid cell the user is NOT focused on is
// inactive even though its socket is attached, so it can surface `blocked` (Notification)
// or `done` (Stop) among its siblings — the whole point of the parallel grid.
//
// Extracted from index.ts so the grid attention semantics are unit-testable; the
// caller applies the effects via setWorking/setWaiting (which publish + arm reaps).

export type ActivityEffect = { kind: "working" | "waiting"; value: boolean };

// A prompt starts a turn and a tool call is the middle of one — both mean the session is
// working right now. Tool events matter beyond the obvious: `working` is set once at
// UserPromptSubmit and cleared at Stop, so across a long turn nothing re-asserts it. If it
// is ever lost mid-turn (a --watch restart between the prompt and the Stop), the session
// reads idle until it finally stops — unless each tool call puts `working` back. nextActivity
// no-ops when the flag is already true, so this re-asserts only after a loss, never spams.
const WORKING_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"]);

export function activityHookEffects(event: string, active: boolean): ActivityEffect[] {
  if (WORKING_EVENTS.has(event)) return [{ kind: "working", value: true }];
  // A finished turn (Stop) has unseen output; a paused turn (Notification) waits on the
  // user. Either flags the session for attention UNLESS it's the actively-viewed pane.
  if (event === "Stop") {
    return active
      ? [{ kind: "working", value: false }]
      : [
          { kind: "waiting", value: true },
          { kind: "working", value: false },
        ];
  }
  if (event === "Notification") return active ? [] : [{ kind: "waiting", value: true }];
  return [];
}

// Which kind of Notification is holding the session up: one the operator can ANSWER with a
// yes/no (a permission dialog), or one that needs them to read and type something. Both stop
// the turn, but they cost the operator different amounts of attention, and a grid of thirty
// panes is unreadable when they share one word.
//
// The payload names it. Claude Code's Notification hook carries `notification_type` alongside
// `message` (verified against the shipped CLI, 2.1.220: the hook input is built as
// `{hook_event_name:"Notification", message, title, notification_type}`), and the values that
// reach it are `permission_prompt` (the tool/plan/browser permission dialog), `idle_prompt`
// ("Claude is waiting for your input"), `elicitation_dialog` / `elicitation_url_dialog` (an MCP
// server asking), `worker_permission_prompt` (a teammate agent needing permission or network
// access), plus informational ones. So the type is read first — it is a field, not prose, and
// it does not move when the wording is reworded.
//
// The message is only a FALLBACK, for a Claude old enough to send no type. It matches the
// permission families by their distinctive verb ("needs your permission", "needs permission
// for", "needs your approval", "needs network access", "wants to use your browser", "wants to
// enter plan mode") and nothing else — "Claude Code needs your input" is an elicitation, and
// must not be dragged into approval by the word "needs".
//
// Anything unrecognised is a question. That is the direction to be wrong in: "question" asks
// the operator to look, while "approval" promises a yes/no that may not be there.
const APPROVAL_NOTIFICATION_TYPES = new Set(["permission_prompt", "worker_permission_prompt"]);
const APPROVAL_MESSAGE_PATTERNS = [
  "needs your permission",
  "needs permission for",
  "needs your approval",
  "needs network access",
  "wants to use your browser",
  "wants to enter plan mode",
];

export function notificationWaitKind(notificationType: unknown, message: unknown): WaitKind {
  if (typeof notificationType === "string" && notificationType) {
    return APPROVAL_NOTIFICATION_TYPES.has(notificationType) ? "approval" : "question";
  }
  if (typeof message !== "string") return "question";
  const text = message.toLowerCase();
  return APPROVAL_MESSAGE_PATTERNS.some((p) => text.includes(p)) ? "approval" : "question";
}

// The wait kind a hook implies, or null when the hook is not a wait at all. Only a Notification
// splits; a Stop is "finished, unread" and carries no kind, and clearing the flag must clear it.
export function waitKindFor(event: string, notificationType: unknown, message: unknown): WaitKind | null {
  return event === "Notification" ? notificationWaitKind(notificationType, message) : null;
}

// Which kind of Web Push a hook warrants, or null for none. Two events reach the
// phone, and they mean different things to a user glancing at a lock screen:
//   - "finished"  (Stop):         the turn ended, output is waiting to be reviewed.
//   - "waiting"   (Notification): the agent is blocked on input — a permission
//                                 prompt or a question — and answering it from the
//                                 phone actually unblocks work.
// Only "finished" fired before; "waiting" is the one the user is most likely to want
// (they cannot know a session is stuck otherwise). Unlike the attention beep, both
// fire regardless of `active` — the phone is elsewhere. pushEnabled / hidden /
// translation gates stay with the caller.

export function pushKindFor(event: string): PushKind | null {
  if (event === "Stop") return "finished";
  if (event === "Notification") return "waiting";
  return null;
}

// The push title/body for a kind. Pure so the wording is unit-testable without a PTY.
//   finished: "\u2705 <dir>"        body = the prompt/title, or a done fallback
//   waiting:  "\u2753 <dir>"        body = the hook's message (e.g. a permission ask), or a fallback
// `where` is the working-dir basename; `detail` is the session's prompt/title;
// `message` is the Notification hook's own text (empty for a finished turn).
export interface PushText {
  title: string;
  body: string;
}

const clip = (text: string, max: number): string => text.slice(0, max);

// A push body renders as one run of text, but the finished-turn body is now the agent's
// reply — markdown with newlines and indentation. Collapsed, the first 160 characters are
// a sentence; left alone they are ragged fragments with the useful part pushed off the end.
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// Replace "[text](url)" with "text", scanning rather than matching — the obvious regex
// backtracks (lint bans those, as in the scheduler's time parsing). An unclosed "[" ends
// the scan and the remainder is kept verbatim.
const flattenLinks = (text: string): string => {
  const parts: string[] = [];
  let rest = 0;
  for (let open = text.indexOf("["); open !== -1; open = text.indexOf("[", rest)) {
    const label = text.indexOf("](", open);
    const close = label === -1 ? -1 : text.indexOf(")", label + 2);
    if (close === -1) break;
    parts.push(text.slice(rest, open), text.slice(open + 1, label));
    rest = close + 1;
  }
  parts.push(text.slice(rest));
  return parts.join("");
};

// A lock screen renders no markdown: emphasis arrives as literal asterisks, and a link's
// target spends a third of the 160-character budget on something the user cannot click
// from the text. Heading markers are left alone — "#" also starts an issue number.
const plainText = (text: string): string => flattenLinks(text).replace(/\*\*/g, "");

export function buildPushText(kind: PushKind, where: string, detail: string, message: string, limits: { title: number; body: number }): PushText {
  if (kind === "waiting") {
    return {
      title: clip(`\u2753 ${where}`, limits.title),
      body: clip(oneLine(plainText(message)) || oneLine(plainText(detail)) || "\u5165\u529b\u5f85\u3061\u3067\u3059", limits.body),
    };
  }
  return {
    title: clip(`\u2705 ${where}`, limits.title),
    body: clip(oneLine(plainText(detail)) || "\u30bf\u30b9\u30af\u304c\u5b8c\u4e86\u3057\u307e\u3057\u305f", limits.body),
  };
}

// Which session a hook belongs to, or null when neither source names one usably.
//
// The `x-mt-session` header wins: Claude reissues its own session_id on /clear and
// /compact, while the mulmoterminal id is the one hooks must stay attributed to.
//
// BOTH sources are validated against the same UUID shape. The id does not stay inside
// this process — it becomes a Firestore document id (backends/remoteHost/sessionActivity)
// and travels to the phone as push routing, where a value containing "/" would change
// the document path rather than address a session. The rest of the codebase already
// treats a SESSION_ID_RE match as the precondition for using an id as a filename, so
// the fallback has no business being the one place that skips it.
export function resolveHookSessionId(header: unknown, bodyValue: unknown, isValidId: (id: string) => boolean): string | null {
  const usable = (value: unknown): string | null => (typeof value === "string" && isValidId(value) ? value : null);
  return usable(header) ?? usable(bodyValue);
}

// Which directory a hook's relative paths resolve against. The CLI reports its live cwd in
// the payload, but the PTY table only holds the dir the session was SPAWNED in — that value
// goes stale the moment the session `cd`s. So the payload cwd wins, falling back to the spawn
// dir only when the hook carries none. Shared by every hook path so they can't disagree on
// which directory a relative write (e.g. a `.mulmoterminal.json` live-reload) belongs to.
export function resolveHookCwd(bodyCwd: unknown, spawnCwd: string | undefined): string | undefined {
  return typeof bodyCwd === "string" ? bodyCwd : spawnCwd;
}
