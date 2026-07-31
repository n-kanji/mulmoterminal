// Fork-local (iTerm2 mode): put a pane's last reply — or the last thing the operator asked
// it — on the system clipboard, whole.
//
// The text comes from the agent's OWN LOG (/api/transcript/last-turn), never from the
// terminal's screen buffer, and that is the entire point (R11). A screen read gives back
// what the pane happens to be showing: hard-wrapped at the column width, missing whatever
// scrolled out of the buffer, and carrying spinner debris — which is exactly the copy that
// arrived broken for half a year and grew a pbcopy workaround rule around it. The log has
// the reply as one unwrapped string with a recorded turn boundary.
//
// It reuses the handoff route rather than adding one: same session, same turn, and the raw
// `prompt` / `reply` fields ride along beside the formatted `text` that route already
// returns. `text` is deliberately NOT what lands on the clipboard — it is framed and clipped
// for an agent reading another agent, and a human copying a reply wants the reply.
import { fetchLastTurn, type FetchedTurn, type HandoffSource } from "./useHandoff";
import { writeSystemClipboard } from "./systemClipboard";

/** Which half of the last exchange to copy: what the agent answered, or what was asked. */
export type TurnPart = "reply" | "prompt";

// Every way this ends, so the button can say which one it was in two words. "empty" is a
// normal outcome, not a failure: a pane that has not completed a turn yet has nothing to
// copy, and a fresh session is the common case for it.
export type CopyOutcome = "copied" | "empty" | "read-failed" | "clipboard-blocked";

export interface CopyTurnDeps {
  fetchTurn: (source: HandoffSource) => Promise<FetchedTurn>;
  write: (text: string) => Promise<boolean>;
}

const defaultDeps: CopyTurnDeps = { fetchTurn: (source) => fetchLastTurn(source), write: writeSystemClipboard };

export async function copyLastTurnPart(source: HandoffSource, part: TurnPart, deps: CopyTurnDeps = defaultDeps): Promise<CopyOutcome> {
  let turn: FetchedTurn;
  try {
    turn = await deps.fetchTurn(source);
  } catch {
    return "read-failed";
  }
  // Trimmed before the emptiness test, so a reply of nothing but newlines reads as "nothing
  // to copy" rather than putting whitespace on the clipboard and reporting success.
  const text = (part === "reply" ? turn.reply : turn.prompt)?.trim() ?? "";
  if (!text) return "empty";
  return (await deps.write(text)) ? "copied" : "clipboard-blocked";
}

// What the button shows for a moment after the click. Short enough to sit where an icon was
// without resizing the toolbar row — the cell has one row for these and rows are the scarce
// resource in a column, so this replaces the icon instead of opening a toast.
export function copyOutcomeLabel(outcome: CopyOutcome, part: TurnPart): string {
  switch (outcome) {
    case "copied":
      return "Copied";
    case "empty":
      return part === "reply" ? "No reply" : "No prompt";
    case "read-failed":
      return "Read failed";
    case "clipboard-blocked":
      return "Blocked";
  }
}
