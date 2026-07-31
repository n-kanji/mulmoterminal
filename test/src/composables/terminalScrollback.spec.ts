import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TERMINAL_SCROLLBACK_DEFAULT } from "../../../common/terminalScrollback.js";

// R13 (fork-local, iTerm2 mode). Two claims about the terminals this app builds, made against
// the real xterm it ships rather than its documentation, because both are the reason the
// operator can stop reaching for iTerm2 for "scroll back and read what happened".
const write = (t: Terminal, data: string) => new Promise<void>((done) => t.write(data, done));
const lineAt = (t: Terminal, i: number) => t.buffer.normal.getLine(i)?.translateToString(true) ?? "";

describe("terminal scrollback + reflow", () => {
  it("keeps far more history than xterm's default 1000 lines", async () => {
    const term = new Terminal({ cols: 40, rows: 5, scrollback: TERMINAL_SCROLLBACK_DEFAULT });
    await write(term, Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\r\n"));
    // At the default 1000 the first 2000 lines would be gone; the buffer holds every one.
    expect(term.buffer.normal.length).toBeGreaterThanOrEqual(3000);
    expect(lineAt(term, 0)).toBe("line 0");
    term.dispose();
  });

  // The one iTerm2 cannot do. iTerm2 wraps at WRITE time, so narrowing a pane leaves old lines
  // wrapped for the old width — the operator's long-standing complaint about resizing a column
  // and finding the history unreadable. xterm re-wraps the NORMAL buffer on resize, which is the
  // buffer Claude Code's TUI writes to (it does not take over the alternate screen), so the same
  // resize re-flows the past instead of tearing it.
  it("re-wraps existing history when a column is made narrower", async () => {
    const term = new Terminal({ cols: 20, rows: 4, scrollback: TERMINAL_SCROLLBACK_DEFAULT });
    await write(term, "abcdefghijklmnopqrstuvwxyz0123456789\r\n");
    expect([lineAt(term, 0), lineAt(term, 1)]).toEqual(["abcdefghijklmnopqrst", "uvwxyz0123456789"]);

    term.resize(10, 4);
    expect([lineAt(term, 0), lineAt(term, 1), lineAt(term, 2), lineAt(term, 3)]).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz0123", "456789"]);
    term.dispose();
  });
});
