// @vitest-environment node
// The account switcher's fleet restart. Entries and the hidden set are injected — no real
// ptys, sockets, or tmux.
import { describe, it, expect, beforeEach, vi } from "vitest";

import { restartClaudePanes } from "../../../server/session/restart-claude-panes.js";
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

describe("restartClaudePanes", () => {
  beforeEach(clearResumeNudges);

  it("detaches the socket BEFORE reaping, then closes it, and queues the nudge", () => {
    const entry = fakeEntry("claude", true);
    const entries = new Map([["s1", entry as PtyEntry]]);
    // The order is the mechanism: if the socket were still on the entry when reap kills the
    // pty, the exit handler would send an exit frame and the client would never reconnect.
    const reap = vi.fn((id: string) => {
      expect(entry.ws).toBeNull();
      expect(entry.closedWs?.close).not.toHaveBeenCalled(); // closed only after the kill completes
      entries.delete(id);
    });
    const restarted = restartClaudePanes(reap, "carry on", entries, new Set());
    expect(restarted).toBe(1);
    expect(reap).toHaveBeenCalledWith("s1");
    expect(entry.closedWs?.close).toHaveBeenCalledOnce();
    expect(takeResumeNudge("s1")).toBe("carry on");
  });

  it("restarts detached claude panes too (their live pty would pin the old account)", () => {
    const entry = fakeEntry("claude", false);
    const entries = new Map([["s1", entry as PtyEntry]]);
    const reap = vi.fn((id: string) => void entries.delete(id));
    expect(restartClaudePanes(reap, "carry on", entries, new Set())).toBe(1);
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
    expect(restartClaudePanes(reap, "carry on", entries, new Set(["h1"]))).toBe(0);
    expect(reap).not.toHaveBeenCalled();
    expect(codex.closedWs?.close).not.toHaveBeenCalled();
    expect(takeResumeNudge("c1")).toBeUndefined();
    expect(takeResumeNudge("h1")).toBeUndefined();
  });

  it("queues no nudge when nudge is null, and survives a close() that throws", () => {
    const entry = fakeEntry("claude", true);
    entry.closedWs?.close.mockImplementation(() => {
      throw new Error("gone");
    });
    const entries = new Map([["s1", entry as PtyEntry]]);
    expect(restartClaudePanes(vi.fn(), null, entries, new Set())).toBe(1);
    expect(takeResumeNudge("s1")).toBeUndefined();
  });
});
