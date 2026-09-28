import { describe, it, expect } from "vitest";
import { sendFrame, sendExitAndClose, closeWithError, isResizeFrame, termSizeFromParams, type FrameSocket } from "../../../server/session/ws-frames.js";

const OPEN = 1;
const CLOSED = 3;

// A stand-in for the browser's socket that records what reached the wire, so the
// send/close decisions can be asserted without a live connection.
function fakeSocket(readyState = OPEN) {
  const sent: string[] = [];
  let closed = 0;
  const socket: FrameSocket = {
    readyState,
    OPEN,
    send: (data) => {
      sent.push(data);
    },
    close: () => {
      closed++;
    },
  };
  return {
    socket,
    sent,
    closeCount: () => closed,
    parsed: () => sent.map((s) => JSON.parse(s)),
  };
}

describe("sendFrame", () => {
  it("serializes the payload to an open socket and reports it went out", () => {
    const f = fakeSocket();
    expect(sendFrame(f.socket, { type: "output", data: "hi" })).toBe(true);
    expect(f.parsed()).toEqual([{ type: "output", data: "hi" }]);
  });

  it("sends nothing on a socket that is no longer open", () => {
    // The PTY keeps producing output after the viewer navigates away; writing to a
    // closing socket throws, so this guard is what keeps an exit from crashing us.
    const f = fakeSocket(CLOSED);
    expect(sendFrame(f.socket, { type: "output", data: "hi" })).toBe(false);
    expect(f.sent).toEqual([]);
  });

  it("tolerates a missing socket, so callers need no null check of their own", () => {
    expect(sendFrame(null, { type: "output" })).toBe(false);
    expect(sendFrame(undefined, { type: "output" })).toBe(false);
  });
});

describe("sendExitAndClose", () => {
  it("reports the exit, then hangs up", () => {
    const f = fakeSocket();
    sendExitAndClose(f.socket, 0, undefined);
    expect(f.parsed()).toEqual([{ type: "exit", exitCode: 0, signal: undefined }]);
    expect(f.closeCount()).toBe(1);
  });

  it("carries a non-zero code and a signal through", () => {
    const f = fakeSocket();
    sendExitAndClose(f.socket, 137, 9);
    expect(f.parsed()).toEqual([{ type: "exit", exitCode: 137, signal: 9 }]);
  });

  it("does not close a socket the exit frame never reached", () => {
    // Closing a socket we could not write to would double-close one a reattach
    // has already swapped in.
    const f = fakeSocket(CLOSED);
    sendExitAndClose(f.socket, 0, undefined);
    expect(f.closeCount()).toBe(0);
  });

  it("tolerates a missing socket", () => {
    expect(() => sendExitAndClose(null, 0, undefined)).not.toThrow();
    expect(() => sendExitAndClose(undefined, 1, 15)).not.toThrow();
  });
});

describe("closeWithError", () => {
  it("sends the message and closes", () => {
    const f = fakeSocket();
    closeWithError(f.socket, "no such workspace");
    expect(f.parsed()).toEqual([{ type: "error", message: "no such workspace" }]);
    expect(f.closeCount()).toBe(1);
  });

  it("does nothing to an already-closed socket", () => {
    const f = fakeSocket(CLOSED);
    closeWithError(f.socket, "boom");
    expect(f.sent).toEqual([]);
    expect(f.closeCount()).toBe(0);
  });
});

// The frame arrives from a client we do not control, so anything that is not a
// well-formed, in-bounds resize must be rejected before it reaches node-pty.
describe("isResizeFrame", () => {
  it("accepts a well-formed frame", () => {
    expect(isResizeFrame({ type: "resize", cols: 120, rows: 30 })).toBe(true);
  });

  it("rejects a frame of another type", () => {
    expect(isResizeFrame({ type: "input", cols: 120, rows: 30 })).toBe(false);
    expect(isResizeFrame({ cols: 120, rows: 30 })).toBe(false);
  });

  it("accepts the exact bounds", () => {
    expect(isResizeFrame({ type: "resize", cols: 2, rows: 1 })).toBe(true);
    expect(isResizeFrame({ type: "resize", cols: 500, rows: 200 })).toBe(true);
  });

  it("rejects just outside the bounds", () => {
    expect(isResizeFrame({ type: "resize", cols: 1, rows: 30 })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: 501, rows: 30 })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: 120, rows: 0 })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: 120, rows: 201 })).toBe(false);
  });

  it("rejects a zero or negative terminal", () => {
    expect(isResizeFrame({ type: "resize", cols: 0, rows: 0 })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: -80, rows: -24 })).toBe(false);
  });

  it("rejects non-integer dimensions", () => {
    expect(isResizeFrame({ type: "resize", cols: 120.5, rows: 30 })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: NaN, rows: 30 })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: Infinity, rows: 30 })).toBe(false);
  });

  it("rejects dimensions that are not numbers at all", () => {
    expect(isResizeFrame({ type: "resize", cols: "120", rows: "30" })).toBe(false);
    expect(isResizeFrame({ type: "resize", cols: null, rows: 30 })).toBe(false);
    expect(isResizeFrame({ type: "resize" })).toBe(false);
  });
});

// 2026-09-28: ?cols=&rows= on the connect URL — the browser's measured pane size, so a PTY (or a
// reattached tmux window) opens at the real width instead of the 120-column default and a shrink.
describe("termSizeFromParams", () => {
  const of = (qs: string) => termSizeFromParams(new URLSearchParams(qs));

  it("reads a well-formed pair", () => {
    expect(of("cols=26&rows=67")).toEqual({ cols: 26, rows: 67 });
  });

  it("is null when either half is missing — the spawn keeps its default", () => {
    expect(of("")).toBeNull();
    expect(of("cols=26")).toBeNull();
    expect(of("rows=67")).toBeNull();
  });

  it("rejects what a resize frame would reject: non-integers and out-of-bounds sizes", () => {
    expect(of("cols=26.5&rows=67")).toBeNull();
    expect(of("cols=abc&rows=67")).toBeNull();
    expect(of("cols=-26&rows=67")).toBeNull();
    expect(of("cols=1&rows=67")).toBeNull(); // below the 2-column floor
    expect(of("cols=501&rows=67")).toBeNull();
    expect(of("cols=26&rows=0")).toBeNull();
    expect(of("cols=26&rows=201")).toBeNull();
  });

  it("agrees with isResizeFrame on the bounds", () => {
    for (const [cols, rows] of [
      [2, 1],
      [500, 200],
      [80, 24],
    ]) {
      expect(of(`cols=${cols}&rows=${rows}`)).toEqual({ cols, rows });
      expect(isResizeFrame({ type: "resize", cols, rows })).toBe(true);
    }
  });
});
