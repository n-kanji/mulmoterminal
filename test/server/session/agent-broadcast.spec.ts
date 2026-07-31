import { describe, it, expect } from "vitest";
import { decideBroadcast, planBroadcast, sameDir, type BroadcastCandidate } from "../../../server/session/agent-broadcast.js";

const PROJECT = "/home/u/project";
const OTHER = "/home/u/other";

const claude = (id: string, over: Partial<BroadcastCandidate> = {}): BroadcastCandidate => ({
  id,
  cwd: PROJECT,
  agent: "claude",
  working: false,
  ...over,
});

describe("planBroadcast", () => {
  it("targets idle Claude sessions and skips the ones mid-turn", () => {
    const plan = planBroadcast([claude("a"), claude("b", { working: true }), claude("c")], null);

    expect(plan.targets).toEqual(["a", "c"]);
    expect(plan.skipped).toEqual([{ id: "b", reason: "working" }]);
  });

  it("treats an unreported session as busy, not idle", () => {
    // A session spawned with a first turn runs it before any hook fires, so `undefined`
    // covers a live turn — typing into it would land inside that turn.
    const plan = planBroadcast([claude("fresh", { working: undefined })], null);

    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([{ id: "fresh", reason: "working" }]);
  });

  it("never considers a shell or codex session, in either list", () => {
    const plan = planBroadcast([claude("sh", { agent: "shell" }), claude("cx", { agent: "codex", working: true })], null);

    expect(plan).toEqual({ targets: [], skipped: [] });
  });

  it("scopes to one directory when asked", () => {
    const plan = planBroadcast([claude("here"), claude("there", { cwd: OTHER })], PROJECT);

    expect(plan.targets).toEqual(["here"]);
    expect(plan.skipped).toEqual([]);
  });

  it("matches directories that differ only in spelling", () => {
    expect(sameDir("/home/u/project/", "/home/u/project")).toBe(true);
    expect(sameDir("/home/u/project/./sub/..", "/home/u/project")).toBe(true);
    expect(sameDir("/home/u/project-two", "/home/u/project")).toBe(false);
  });
});

describe("decideBroadcast", () => {
  it("requires text", () => {
    expect(decideBroadcast({ text: "   " })).toEqual({ ok: false, status: 400, error: expect.stringContaining("text is required") });
    expect(decideBroadcast({})).toMatchObject({ ok: false, status: 400 });
    expect(decideBroadcast(null)).toMatchObject({ ok: false, status: 400 });
  });

  it("trims the text and defaults to every directory", () => {
    expect(decideBroadcast({ text: "  ship it  " })).toEqual({ ok: true, text: "ship it", cwd: null });
  });

  it("refuses a relative cwd rather than silently matching nothing", () => {
    expect(decideBroadcast({ text: "ship it", cwd: "project" })).toMatchObject({ ok: false, status: 400 });
    expect(decideBroadcast({ text: "ship it", cwd: 7 })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a body long enough to be a mistake", () => {
    expect(decideBroadcast({ text: "x".repeat(10_001) })).toMatchObject({ ok: false, status: 400 });
  });
});
