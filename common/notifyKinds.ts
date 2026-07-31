// Fork-local (iTerm2 mode, R14). Which pane states raise an OS notification in the browser,
// and the rules that keep it from becoming noise.
//
// Separate from `pushKinds` on purpose, and not a rename of it. `pushKinds` is the SERVER
// deciding what to send a phone over Web Push; this is the BROWSER deciding what to raise on
// the machine the operator is sitting at. They gate different transports, are wanted at
// different times (the phone wants the finished turn; the desk does not), and the desk one is
// spoken in the pane-state vocabulary rather than in hook names.
//
// Both sides read this file: the server sanitizes and persists the setting, the client filters
// on it. Which is why it lives here — see CLAUDE.md on `common/`.
import type { PaneState } from "./paneState.js";

// A notification is only ever raised for a state that ASKS the operator for something, so the
// kinds are a subset of the pane-state vocabulary rather than a parallel list of their own.
// Typed as an Extract so deleting or renaming a pane state breaks this at compile time.
export const NOTIFY_KINDS = ["approval", "question", "unread"] as const;

export type NotifyKind = Extract<PaneState, (typeof NOTIFY_KINDS)[number]>;

// What a config with no `notifyKinds` gets: the two states that BLOCK an agent. `unread` is a
// finished turn — the work is done and nothing is stuck behind it, so a desk notification for
// it is an interruption with no deadline. It is left out for the same reason DEFAULT_PUSH_KINDS
// is a separate list from PUSH_KINDS: a kind must never start notifying someone who did not ask.
export const DEFAULT_NOTIFY_KINDS: NotifyKind[] = ["approval", "question"];

export const isNotifyKind = (value: unknown): value is NotifyKind => NOTIFY_KINDS.some((kind) => kind === value);

// One notification per session per kind per five minutes, matching claudecode-notify's own
// cooldown. A session that asks permission repeatedly during one long task is the case this
// exists for: every ask is a real state change, and without the cooldown each one is a popup.
export const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

// The states that mean the operator has to answer something. This is the tab badge's tally and
// the "needs you" half of the vocabulary — `unread` is deliberately absent: a finished turn is
// reading, not a queue of replies owed, and counting it would make the badge never reach zero.
export const isActionState = (state: PaneState): boolean => state === "approval" || state === "question";
