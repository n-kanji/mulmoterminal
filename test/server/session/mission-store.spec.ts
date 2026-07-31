// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  MISSION_MAX_AGE_MS,
  MISSION_MAX_LENGTH,
  normalizeMission,
  parseMissions,
  pruneMissions,
  type MissionRecord,
} from "../../../server/session/mission-store.js";

const anyId = () => true;
const NOW = 1_700_000_000_000;
const rec = (mission: string, updatedAt = NOW): MissionRecord => ({ mission, updatedAt });

describe("normalizeMission", () => {
  it("keeps a plain mission", () => {
    expect(normalizeMission("ship the release branch")).toBe("ship the release branch");
  });

  // It renders on a 22px strip in a column that may be a fifth of a 4K screen: a newline or a
  // run of spaces would either break the row or spend its width on nothing.
  it("collapses whitespace onto one line", () => {
    expect(normalizeMission("  ship   the\n  release\tbranch  ")).toBe("ship the release branch");
  });

  // Blank is not a mission, it is a request to clear one. The route relies on this to make
  // `-d '{"mission":""}'` the way to remove a line without a second endpoint.
  it("treats blank as no mission", () => {
    expect(normalizeMission("")).toBeNull();
    expect(normalizeMission("   \n  ")).toBeNull();
  });

  it("rejects a non-string rather than stringifying it", () => {
    expect(normalizeMission(42)).toBeNull();
    expect(normalizeMission(undefined)).toBeNull();
    expect(normalizeMission({ mission: "x" })).toBeNull();
  });

  // Anything past the cap is not read on the strip, and storing it would let a caller grow
  // the file without limit.
  it("clips an over-long mission", () => {
    const clipped = normalizeMission("x".repeat(MISSION_MAX_LENGTH + 50));
    expect(clipped).toHaveLength(MISSION_MAX_LENGTH);
  });
});

describe("parseMissions", () => {
  it("parses id -> {mission, updatedAt}", () => {
    expect(parseMissions({ a: { mission: "ship it", updatedAt: 5 } }, anyId)).toEqual([{ id: "a", mission: "ship it", updatedAt: 5 }]);
  });

  it("drops ids that fail validation, non-object entries and empty missions", () => {
    const raw = { good: { mission: "ship it" }, "../bad": { mission: "escape" }, weird: "nope", blank: { mission: "   " } };
    expect(parseMissions(raw, (id) => id !== "../bad")).toEqual([{ id: "good", mission: "ship it", updatedAt: 0 }]);
  });

  it("returns [] for non-object input", () => {
    expect(parseMissions(null, anyId)).toEqual([]);
    expect(parseMissions("x", anyId)).toEqual([]);
  });
});

describe("pruneMissions", () => {
  const live =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id);

  it("keeps a live session's mission however old it is", () => {
    const entries: Array<[string, MissionRecord]> = [["a", rec("ship it", NOW - MISSION_MAX_AGE_MS * 3)]];
    expect(pruneMissions(entries, { isLive: live("a"), now: NOW })).toEqual({ a: rec("ship it", NOW - MISSION_MAX_AGE_MS * 3) });
  });

  // A reaped pane is routinely resumed by id, so its mission is kept for a while: dropping it
  // the moment the PTY dies would silently lose the line on every reload.
  it("keeps a recent mission for a session that is no longer live", () => {
    const entries: Array<[string, MissionRecord]> = [["a", rec("ship it", NOW - 60_000)]];
    expect(Object.keys(pruneMissions(entries, { isLive: () => false, now: NOW }))).toEqual(["a"]);
  });

  it("drops a dead session's mission once it is past the age cap", () => {
    const entries: Array<[string, MissionRecord]> = [["a", rec("ship it", NOW - MISSION_MAX_AGE_MS - 1)]];
    expect(pruneMissions(entries, { isLive: () => false, now: NOW })).toEqual({});
  });

  // A hard ceiling regardless of age, so a machine that opens many short-lived panes cannot
  // grow the file without bound. Newest kept.
  it("caps the file at maxEntries, keeping the most recently updated", () => {
    const entries: Array<[string, MissionRecord]> = [
      ["old", rec("oldest", NOW - 3)],
      ["mid", rec("middle", NOW - 2)],
      ["new", rec("newest", NOW - 1)],
    ];
    const kept = pruneMissions(entries, { isLive: () => false, now: NOW, maxEntries: 2 });
    expect(Object.keys(kept).sort()).toEqual(["mid", "new"]);
  });

  it("returns an empty record for no entries", () => {
    expect(pruneMissions([], { isLive: () => false, now: NOW })).toEqual({});
  });
});
