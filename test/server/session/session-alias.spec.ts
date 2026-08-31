// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  currentAgentSessionId,
  forgetSessionAliases,
  noteSessionAlias,
  parseAliases,
  pruneAliases,
  resolveAliasedSessionId,
} from "../../../server/session/session-alias.js";

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

  // The Fork button (and the next-queue transcript reader) need the pane's CURRENT id:
  // after several /clears the newest pairing is where the on-screen conversation lives —
  // forking an older one branches a stale conversation (operator report 2026-08-31).
  it("reports the newest agent id for a pane that cleared more than once", () => {
    const older = "44444444-4444-4444-4444-444444444444";
    noteSessionAlias(MT, older);
    noteSessionAlias(MT, AGENT);
    expect(currentAgentSessionId(MT)).toBe(AGENT);
  });

  it("reports no agent id for a pane that never cleared", () => {
    expect(currentAgentSessionId(MT)).toBeUndefined();
  });

  // A hook whose two ids AGREE proves the pane runs as its own id again — e.g. relaunched
  // with a plain `--resume <pane id>` after its tmux died, which continues the pane-id
  // transcript. A kept alias would then point AWAY from what the pane shows, and a fork
  // would branch the wrong conversation in the opposite direction of the /clear bug.
  it("drops a pane's aliases when a hook shows it running as its own id again", () => {
    noteSessionAlias(MT, AGENT);
    noteSessionAlias(MT, MT);
    expect(currentAgentSessionId(MT)).toBeUndefined();
    expect(resolveAliasedSessionId(AGENT)).toBe(AGENT);
  });
});

describe("alias persistence rules (pure)", () => {
  const REC = (at: number) => ({ mt: MT, at });

  it("parses only well-shaped uuid pairings and drops the rest", () => {
    const parsed = parseAliases({
      [AGENT]: { mt: MT, at: 5 },
      "not-a-uuid": { mt: MT, at: 5 },
      "33333333-3333-3333-3333-333333333333": { mt: "nope", at: 5 },
      "44444444-4444-4444-4444-444444444444": "junk",
    });
    expect(parsed).toEqual([{ agent: AGENT, mt: MT, at: 5 }]);
  });

  it("parses nothing from a non-object file", () => {
    expect(parseAliases(null)).toEqual([]);
    expect(parseAliases([1, 2])).toEqual([]);
  });

  it("ages out old pairings and caps the count, newest kept", () => {
    const a = "44444444-4444-4444-4444-444444444444";
    const b = "55555555-5555-5555-5555-555555555555";
    const c = "66666666-6666-6666-6666-666666666666";
    const kept = pruneAliases(
      [
        [a, REC(1)],
        [b, REC(100)],
        [c, REC(90)],
      ],
      { now: 100, maxAgeMs: 50, maxEntries: 1 },
    );
    expect(Object.keys(kept)).toEqual([b]);
  });
});
