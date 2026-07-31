// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { forgetSessionAliases, noteSessionAlias, resolveAliasedSessionId } from "../../../server/session/session-alias.js";

const MT = "11111111-1111-1111-1111-111111111111";
const AGENT = "22222222-2222-2222-2222-222222222222";

// The map is module state (there is one server), so each test clears what it added.
beforeEach(() => forgetSessionAliases(MT));

describe("session aliases", () => {
  // `/clear` makes Claude mint a fresh id while the PTY and the grid cell stay on the original.
  // Every hook shows both, which is the only place the pairing is ever visible.
  it("learns the pairing a hook reveals and translates the agent's id", () => {
    noteSessionAlias(MT, AGENT);
    expect(resolveAliasedSessionId(AGENT)).toBe(MT);
  });

  // The common case: the two agree, so there is nothing to remember.
  it("records nothing when the ids agree", () => {
    noteSessionAlias(MT, MT);
    expect(resolveAliasedSessionId(MT)).toBe(MT);
  });

  it("ignores a missing or non-string id", () => {
    noteSessionAlias(undefined, AGENT);
    noteSessionAlias(MT, undefined);
    noteSessionAlias(MT, 42);
    noteSessionAlias("", AGENT);
    expect(resolveAliasedSessionId(AGENT)).toBe(AGENT);
  });

  // Every pane that never cleared sends an id nothing has aliased, and it must come back
  // untouched — this sits in front of the mission write for ALL panes, not just cleared ones.
  it("returns an unknown id unchanged", () => {
    expect(resolveAliasedSessionId("33333333-3333-3333-3333-333333333333")).toBe("33333333-3333-3333-3333-333333333333");
  });

  // A session can clear more than once; the map must not keep the dead ids for the life of
  // the process, and teardown is the one moment that knows they are dead.
  it("drops every alias pointing at a torn-down session", () => {
    const older = "44444444-4444-4444-4444-444444444444";
    noteSessionAlias(MT, AGENT);
    noteSessionAlias(MT, older);
    forgetSessionAliases(MT);
    expect(resolveAliasedSessionId(AGENT)).toBe(AGENT);
    expect(resolveAliasedSessionId(older)).toBe(older);
  });

  it("leaves another session's aliases alone when one is torn down", () => {
    const otherMt = "55555555-5555-5555-5555-555555555555";
    const otherAgent = "66666666-6666-6666-6666-666666666666";
    noteSessionAlias(MT, AGENT);
    noteSessionAlias(otherMt, otherAgent);
    forgetSessionAliases(MT);
    expect(resolveAliasedSessionId(otherAgent)).toBe(otherMt);
    forgetSessionAliases(otherMt);
  });
});
