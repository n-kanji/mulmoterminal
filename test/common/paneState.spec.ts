import { describe, it, expect } from "vitest";
import { PANE_STATE_WORD, paneStateOf, paneStateWord, type PaneActivity, type PaneState } from "../../common/paneState";

const act = (over: Partial<PaneActivity> = {}): PaneActivity => ({
  working: false,
  waiting: false,
  event: null,
  waitKind: null,
  connected: true,
  ...over,
});

describe("paneStateOf", () => {
  it("splits a Notification wait by the kind the server classified", () => {
    expect(paneStateOf(act({ waiting: true, event: "Notification", waitKind: "approval" }))).toBe("approval");
    expect(paneStateOf(act({ waiting: true, event: "Notification", waitKind: "question" }))).toBe("question");
  });

  // "question" only asks the operator to look; "approval" promises a yes/no button. Being
  // wrong towards "question" costs a glance, being wrong the other way costs trust in the word.
  it("falls back to question for a Notification with no kind", () => {
    expect(paneStateOf(act({ waiting: true, event: "Notification" }))).toBe("question");
  });

  it("reads any other wait as unread (a finished turn nobody has looked at)", () => {
    expect(paneStateOf(act({ waiting: true, event: "Stop" }))).toBe("unread");
    expect(paneStateOf(act({ waiting: true, event: null }))).toBe("unread");
  });

  it("is working when only working, and idle when neither flag is set", () => {
    expect(paneStateOf(act({ working: true, event: "UserPromptSubmit" }))).toBe("working");
    expect(paneStateOf(act())).toBe("idle");
  });

  it("waiting wins over working (a permission pause mid-turn is blocked, not busy)", () => {
    expect(paneStateOf(act({ working: true, waiting: true, event: "Notification", waitKind: "approval" }))).toBe("approval");
  });

  // A permission prompt in a terminal that is no longer there cannot be answered, so telling
  // the operator to answer it wastes the trip. The pane needs relaunching first.
  it("reports a dead pane as disconnected, whatever it was last doing", () => {
    expect(paneStateOf(act({ working: true, connected: false }))).toBe("disconnected");
    expect(paneStateOf(act({ waiting: true, event: "Notification", waitKind: "approval", connected: false }))).toBe("disconnected");
    expect(paneStateOf(act({ connected: false }))).toBe("disconnected");
  });

  it("reports a launcher pane as shell", () => {
    expect(paneStateOf(act({ shell: true }))).toBe("shell");
  });

  // Dead beats shell: an exited launcher is not "a shell you can type in".
  it("prefers disconnected over shell", () => {
    expect(paneStateOf(act({ shell: true, connected: false }))).toBe("disconnected");
  });
});

describe("paneStateWord", () => {
  const SPOKEN: Exclude<PaneState, "idle">[] = ["approval", "question", "working", "unread", "disconnected", "shell"];

  it("gives every state but idle a word", () => {
    for (const state of SPOKEN) expect(paneStateWord(state)).toBe(PANE_STATE_WORD[state]);
  });

  // The whole point of the vocabulary change: a pane with nothing to ask says nothing, rather
  // than repeating a process word ("IDLE") on most panes most of the time.
  it("gives idle no word at all", () => {
    expect(paneStateWord("idle")).toBe("");
  });

  it("uses six distinct words, all non-empty", () => {
    const words = SPOKEN.map(paneStateWord);
    expect(words.every(Boolean)).toBe(true);
    expect(new Set(words).size).toBe(6);
  });
});
