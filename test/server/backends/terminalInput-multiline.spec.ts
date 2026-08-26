// @vitest-environment node
//
// The multi-line paste variant the next-instruction queue sends with: line breaks survive
// (bracketed paste inserts them without submitting), CR and every other control byte go,
// and the one-line default is untouched.
import { describe, it, expect, vi } from "vitest";
import {
  createTerminalInputSender,
  sanitizeTerminalInput,
  sanitizeTerminalInputMultiline,
  PASTE_START,
  PASTE_END,
} from "../../../server/backends/remoteHost/terminalInput.js";

describe("sanitizeTerminalInputMultiline", () => {
  // The ESC of an embedded paste terminator goes (so it cannot end the paste early), the
  // printable remainder stays — same neutralisation as the one-line sanitizer.
  it("keeps line structure, drops CR and control bytes, collapses spaces within a line", () => {
    expect(sanitizeTerminalInputMultiline("  step 1:\ttest\r\n\r\nstep   2: \x1b[201~ship  \n")).toBe("step 1: test\n\nstep 2: [201~ship");
  });
  it("is not what the one-line sanitizer does", () => {
    expect(sanitizeTerminalInput("a\nb")).toBe("a b");
    expect(sanitizeTerminalInputMultiline("a\nb")).toBe("a\nb");
  });
});

describe("createTerminalInputSender multiline", () => {
  it("pastes the newline-preserving text only when asked", async () => {
    const writes: string[] = [];
    const send = createTerminalInputSender({ writeToSession: (_id, chunk) => (writes.push(chunk), true), scheduleSubmit: (s) => s() });
    await send("s", "a\nb");
    await send("s", "a\nb", { multiline: true });
    expect(writes[0]).toBe(`${PASTE_START}a b${PASTE_END}`);
    expect(writes[2]).toBe(`${PASTE_START}a\nb${PASTE_END}`);
    expect(vi.isMockFunction(send)).toBe(false);
  });
});
