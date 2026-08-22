// @vitest-environment node
// The account switcher's fleet restart. Entries, the hidden set and the per-pane nudge
// decision are injected — no real ptys, sockets, tmux, or screen captures.
import { describe, it, expect, beforeEach, vi } from "vitest";

import { restartClaudePanes, paneNeedsNudge } from "../../../server/session/restart-claude-panes.js";
import { takeResumeNudge, clearResumeNudges } from "../../../server/session/resume-nudge.js";
import type { PtyEntry } from "../../../server/session/types.js";

function fakeEntry(agent: "claude" | "codex", withWs: boolean): PtyEntry & { closedWs: { close: ReturnType<typeof vi.fn> } | null } {
  const ws = withWs ? { close: vi.fn() } : null;
  return {
    term: { kill: vi.fn() } as unknown as PtyEntry["term"],
    ws: ws as unknown as PtyEntry["ws"],
    buffer: "",
    cwd: "/w",
    active: false,
    agent,
    closedWs: ws,
  };
}

describe("paneNeedsNudge", () => {
  it("nudges a pane that was mid-turn, screen or no screen", () => {
    expect(paneNeedsNudge(true, null)).toBe(true);
    expect(paneNeedsNudge(true, "anything")).toBe(true);
  });

  it("nudges an idle pane whose screen tail shows the limit banner", () => {
    expect(paneNeedsNudge(false, "conversation...\n5-hour limit reached ∙ resets 3am\n> ")).toBe(true);
    expect(paneNeedsNudge(false, "...\nWeekly limit reached\n> ")).toBe(true);
    expect(paneNeedsNudge(false, "...\nApproaching 5-hour limit\n> ")).toBe(true);
    expect(paneNeedsNudge(false, "...\nYou've hit your usage limit.\n> ")).toBe(true);
  });

  it("leaves a finished / parked pane alone — including one that merely TALKED about limits", () => {
    expect(paneNeedsNudge(false, null)).toBe(false);
    expect(paneNeedsNudge(false, "done. anything else?\n> ")).toBe(false);
    // The banner phrase far above the tail (scrolled-past conversation) does not count.
    const talkedAbout = "we discussed the usage limit reached case here\n" + Array(20).fill("more output").join("\n") + "\n> ";
    expect(paneNeedsNudge(false, talkedAbout)).toBe(false);
  });
});

describe("restartClaudePanes", () => {
  beforeEach(clearResumeNudges);

  it("detaches the socket BEFORE reaping, then closes it, and queues the pane's own nudge", () => {
    const entry = fakeEntry("claude", true);
    const entries = new Map([["s1", entry as PtyEntry]]);
    // The order is the mechanism: if the socket were still on the entry when reap kills the
    // pty, the exit handler would send an exit frame and the client would never reconnect.
    const reap = vi.fn((id: string) => {
      expect(entry.ws).toBeNull();
      expect(entry.closedWs?.close).not.toHaveBeenCalled(); // closed only after the kill completes
      entries.delete(id);
    });
    const fleet = restartClaudePanes(reap, () => "carry on", entries, new Set());
    expect(fleet).toEqual({ restarted: 1, nudged: 1 });
    expect(reap).toHaveBeenCalledWith("s1");
    expect(entry.closedWs?.close).toHaveBeenCalledOnce();
    expect(takeResumeNudge("s1")).toBe("carry on");
  });

  it("asks the nudge decision per pane, BEFORE that pane is reaped (the screen must still exist)", () => {
    const stuck = fakeEntry("claude", true);
    const parked = fakeEntry("claude", true);
    const entries = new Map<string, PtyEntry>([
      ["stuck", stuck as PtyEntry],
      ["parked", parked as PtyEntry],
    ]);
    const reaped: string[] = [];
    const asked: string[] = [];
    const nudgeFor = (id: string) => {
      asked.push(id);
      expect(reaped).not.toContain(id); // decided while alive
      return id === "stuck" ? "carry on" : null;
    };
    const fleet = restartClaudePanes((id) => void reaped.push(id), nudgeFor, entries, new Set());
    expect(fleet).toEqual({ restarted: 2, nudged: 1 });
    expect(asked.sort()).toEqual(["parked", "stuck"]);
    expect(takeResumeNudge("stuck")).toBe("carry on");
    expect(takeResumeNudge("parked")).toBeUndefined();
  });

  it("restarts detached claude panes too (their live pty would pin the old account)", () => {
    const entry = fakeEntry("claude", false);
    const entries = new Map([["s1", entry as PtyEntry]]);
    const reap = vi.fn((id: string) => void entries.delete(id));
    expect(restartClaudePanes(reap, () => null, entries, new Set())).toEqual({ restarted: 1, nudged: 0 });
    expect(reap).toHaveBeenCalledWith("s1");
  });

  it("skips codex panes and hidden background workers", () => {
    const codex = fakeEntry("codex", true);
    const hiddenWorker = fakeEntry("claude", false);
    const entries = new Map<string, PtyEntry>([
      ["c1", codex as PtyEntry],
      ["h1", hiddenWorker as PtyEntry],
    ]);
    const reap = vi.fn();
    expect(restartClaudePanes(reap, () => "carry on", entries, new Set(["h1"]))).toEqual({ restarted: 0, nudged: 0 });
    expect(reap).not.toHaveBeenCalled();
    expect(codex.closedWs?.close).not.toHaveBeenCalled();
    expect(takeResumeNudge("c1")).toBeUndefined();
    expect(takeResumeNudge("h1")).toBeUndefined();
  });

  it("survives a close() that throws", () => {
    const entry = fakeEntry("claude", true);
    entry.closedWs?.close.mockImplementation(() => {
      throw new Error("gone");
    });
    const entries = new Map([["s1", entry as PtyEntry]]);
    expect(restartClaudePanes(vi.fn(), () => null, entries, new Set())).toEqual({ restarted: 1, nudged: 0 });
  });
});
