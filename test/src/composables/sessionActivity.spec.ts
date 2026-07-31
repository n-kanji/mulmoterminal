import { describe, it, expect } from "vitest";
import { parseSessionActivityPayload } from "../../../src/composables/sessionActivity";

describe("parseSessionActivityPayload", () => {
  it("parses a normal activity push", () => {
    expect(parseSessionActivityPayload({ id: "a", working: true, waiting: false, event: "UserPromptSubmit", lastActivityAt: 90 })).toEqual({
      id: "a",
      activity: { working: true, waiting: false, event: "UserPromptSubmit", waitKind: null, lastActivityAt: 90 },
    });
  });

  it("parses a blocked (Notification) push, keeping the kind the server classified", () => {
    expect(parseSessionActivityPayload({ id: "a", working: false, waiting: true, event: "Notification", waitKind: "approval" })).toEqual({
      id: "a",
      activity: { working: false, waiting: true, event: "Notification", waitKind: "approval", lastActivityAt: null },
    });
  });

  // The wire is not trusted for this one: an unknown kind must not reach the status word,
  // where it would render as no word at all instead of falling back to "質問".
  it("drops a waitKind that is not one of the two", () => {
    const parsed = parseSessionActivityPayload({ id: "a", waiting: true, event: "Notification", waitKind: "urgent" });
    expect(parsed).toEqual({ id: "a", activity: { working: false, waiting: true, event: "Notification", waitKind: null, lastActivityAt: null } });
  });

  it("treats a closed push as a removal", () => {
    expect(parseSessionActivityPayload({ id: "a", working: false, event: "closed" })).toEqual({ id: "a", closed: true });
  });

  it("defaults missing flags to false / null", () => {
    expect(parseSessionActivityPayload({ id: "a" })).toEqual({
      id: "a",
      activity: { working: false, waiting: false, event: null, waitKind: null, lastActivityAt: null },
    });
  });

  it("rejects payloads without a string id", () => {
    expect(parseSessionActivityPayload({ working: true })).toBeNull();
    expect(parseSessionActivityPayload(null)).toBeNull();
    expect(parseSessionActivityPayload("nope")).toBeNull();
    expect(parseSessionActivityPayload({ id: 42 })).toBeNull();
  });
});
