import { describe, it, expect } from "vitest";
import { NOTIFY_KINDS, DEFAULT_NOTIFY_KINDS, isNotifyKind, isActionState, NOTIFY_COOLDOWN_MS } from "../../common/notifyKinds.js";
import { PANE_STATE_WORD } from "../../common/paneState.js";

describe("notify kinds", () => {
  it("accepts only the kinds that exist", () => {
    for (const kind of NOTIFY_KINDS) expect(isNotifyKind(kind)).toBe(true);
    for (const other of ["", "working", "idle", "shell", "waiting", null, undefined, 0, ["approval"]]) expect(isNotifyKind(other)).toBe(false);
  });

  // Every kind must be a real pane state, or the notification body (paneStateWord) would come
  // out blank for it — the one failure mode this Extract-typed list exists to prevent.
  it("is a subset of the pane-state vocabulary", () => {
    for (const kind of NOTIFY_KINDS) expect(PANE_STATE_WORD[kind]).toBeTruthy();
  });

  // A finished turn is reading to catch up on, not work blocked behind an answer. Adding it
  // here would notify every user who never asked — the same trap DEFAULT_PUSH_KINDS documents.
  it("defaults to the blocking kinds only, leaving unread opt-in", () => {
    expect(DEFAULT_NOTIFY_KINDS).toEqual(["approval", "question"]);
    expect(DEFAULT_NOTIFY_KINDS).not.toContain("unread");
  });

  // The tab badge's tally. `unread` counting here would leave the badge permanently lit.
  it("counts only the states that owe the operator an answer as action states", () => {
    expect(isActionState("approval")).toBe(true);
    expect(isActionState("question")).toBe(true);
    for (const state of ["unread", "working", "idle", "shell", "disconnected"] as const) expect(isActionState(state)).toBe(false);
  });

  it("keeps claudecode-notify's five-minute cooldown", () => {
    expect(NOTIFY_COOLDOWN_MS).toBe(300_000);
  });
});
