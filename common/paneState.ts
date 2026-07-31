// The words a pane's status strip may say, and the rule that picks one.
//
// BOTH sides decide from this, which is why it is here and not in src/ or server/: only the
// server sees the Notification hook's payload, so only it can tell a permission request from a
// question — but only the client renders the word, colours the frame and ranks the auto sort.
// Naming the vocabulary once is what keeps "approval" meaning the same thing at both ends.
//
// The vocabulary is what the OPERATOR should do, never what the process is doing. That is the
// point of the change: "IDLE" is true of a process and useless to a person, and a column where
// every pane says the same word carries no information at all.
//
// Six words, and deliberately no seventh for `idle`. A pane that finished and was read has
// nothing to ask of anyone, so it says nothing — the summary takes the space. `idle` stays in
// the TYPE because the sort, the tally and the status map all need a floor value; it simply has
// no entry in PANE_STATE_WORD, and rendering code must treat "no word" as a real outcome.

/** Which kind of Notification is holding a session up. Classified server-side (activity-hook). */
export type WaitKind = "approval" | "question";

export type PaneState = "approval" | "question" | "working" | "unread" | "disconnected" | "shell" | "idle";

/** The status word for every state that has one. `idle` is absent on purpose — see above. */
export const PANE_STATE_WORD: Record<Exclude<PaneState, "idle">, string> = {
  approval: "承認待ち",
  question: "質問",
  working: "実行中",
  unread: "完了・未読",
  disconnected: "切断",
  shell: "シェル",
};

/** The word for a state, or "" for the one state that says nothing. */
export const paneStateWord = (state: PaneState): string => (state === "idle" ? "" : PANE_STATE_WORD[state]);

export interface PaneActivity {
  working: boolean;
  waiting: boolean;
  /** The hook that set the current state ("Stop" | "Notification" | …), or null. */
  event: string | null | undefined;
  /** Which kind of Notification is blocking. Only meaningful while `event` is "Notification". */
  waitKind: WaitKind | null | undefined;
  /** False once this pane's PTY or WebSocket is gone — the client knows the socket, the
   *  server knows the PTY, and either being dead means the same thing to the operator. */
  connected: boolean;
  /** True for a launcher (shell) pane. It runs no agent, so no hook ever reports the rest. */
  shell?: boolean;
}

export function paneStateOf(a: PaneActivity): PaneState {
  // A dead pane outranks whatever it was last doing: a permission prompt in a terminal that is
  // no longer there cannot be answered, and telling the operator to answer it wastes the trip.
  if (!a.connected) return "disconnected";
  if (a.shell) return "shell";
  // `waiting` means "needs the user"; the hook that set it says which kind of needing. An
  // unclassified Notification falls to "question" — the state that asks the operator to LOOK,
  // which is the safe way to be wrong (mislabelling a question as an approval would promise a
  // yes/no button that is not there).
  if (a.waiting) return a.event === "Notification" ? (a.waitKind ?? "question") : "unread";
  if (a.working) return "working";
  return "idle";
}
