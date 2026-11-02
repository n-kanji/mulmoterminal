import { describe, it, expect } from "vitest";
import pty from "node-pty";
import { countPtyMasterFds, ptyFdLeakWarning, PTY_FD_LEAK_SLACK } from "../../../server/infra/pty-fd-watch.js";

// The leak this watch exists for (node-pty 1.1.0 on macOS, plans/fix-pty-fd-leak.md) was
// invisible while the pane lived and only showed once it had exited: the master stayed open.
// So the test measures the exit edge, not just the spawn. Real pty on purpose — a mocked
// node-pty cannot leak.
describe("countPtyMasterFds", () => {
  it.skipIf(process.platform === "win32")("sees a live pty's master and sees it go when the pty exits", async () => {
    const before = countPtyMasterFds() ?? -1;
    expect(before).toBeGreaterThanOrEqual(0);
    const term = pty.spawn("/bin/sh", ["-c", "exit 0"], { name: "xterm", cols: 80, rows: 24, cwd: "/", env: process.env });
    term.onData(() => {});
    expect(countPtyMasterFds()).toBeGreaterThanOrEqual(before + 1);
    await new Promise<void>((resolve) => term.onExit(() => resolve()));
    // node-pty fires exit after it has destroyed the socket; give the fd close a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(countPtyMasterFds()).toBe(before);
  });
});

describe("ptyFdLeakWarning", () => {
  it("is quiet while the excess over live sessions is within the slack", () => {
    expect(ptyFdLeakWarning(5, 5)).toBeNull();
    expect(ptyFdLeakWarning(5 + PTY_FD_LEAK_SLACK, 5)).toBeNull();
    expect(ptyFdLeakWarning(0, 0)).toBeNull();
  });

  it("names the counts and the wall once the excess passes the slack", () => {
    const text = ptyFdLeakWarning(5 + PTY_FD_LEAK_SLACK + 1, 5);
    expect(text).toContain(`${5 + PTY_FD_LEAK_SLACK + 1} pseudo-terminal master fds`);
    expect(text).toContain("5 live session(s)");
    expect(text).toContain("511");
    expect(text).toContain("posix_spawnp failed");
  });

  // The 2026-11-02 numbers: 499 held for 6 live panes, 12 short of the wall.
  it("would have fired on the incident that motivated it", () => {
    expect(ptyFdLeakWarning(499, 6)).not.toBeNull();
  });
});
