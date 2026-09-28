// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import type { WebSocket } from "ws";
import type { IPty } from "node-pty";

import { beginRunTerminal, holdEarlyFrames, type WsRouteDeps } from "../../../server/routes/ws-routes.js";

// A minimal ws stand-in: just the readyState + OPEN the guard reads and an on/emit pair so a
// test can fire the "close" event the handler wires.
function fakeWs(readyState: number) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    readyState,
    OPEN: 1,
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== cb),
      );
    },
    emit(event: string, ...args: unknown[]) {
      (listeners.get(event) ?? []).forEach((cb) => cb(...args));
    },
  };
}

// 2026-09-28: a frame that arrives while the handler is still awaiting (the Keychain, a git
// subprocess) used to be dropped by `ws` — the browser's on-open resize among them, which left a
// reattached pane at the 120-column spawn default. Held frames are replayed, in order, first.
describe("holdEarlyFrames", () => {
  it("replays what arrived before the handler was wired, then delivers live frames", () => {
    const ws = fakeWs(OPEN);
    const wire = holdEarlyFrames(ws as unknown as WebSocket);
    ws.emit("message", "early-1");
    ws.emit("message", "early-2");
    const seen: string[] = [];
    wire((raw) => seen.push(String(raw)));
    ws.emit("message", "live");
    expect(seen).toEqual(["early-1", "early-2", "live"]);
  });

  it("delivers each held frame once — the holder is detached when the handler takes over", () => {
    const ws = fakeWs(OPEN);
    const wire = holdEarlyFrames(ws as unknown as WebSocket);
    ws.emit("message", "early");
    const seen: string[] = [];
    wire((raw) => seen.push(String(raw)));
    ws.emit("message", "live");
    ws.emit("message", "live-2");
    expect(seen).toEqual(["early", "live", "live-2"]);
  });

  it("beginRunTerminal routes frames through the wire it is handed", () => {
    const term = { kill: vi.fn(), write: vi.fn(), resize: vi.fn() } as unknown as IPty;
    const spawnCommandPty = vi.fn(() => term);
    const ws = fakeWs(OPEN);
    const wire = holdEarlyFrames(ws as unknown as WebSocket);
    ws.emit("message", JSON.stringify({ type: "resize", cols: 26, rows: 67 })); // before the spawn
    beginRunTerminal({ spawnCommandPty } as unknown as WsRouteDeps, ws as unknown as WebSocket, RESOLVED, null, wire);
    expect(term.resize).toHaveBeenCalledWith(26, 67);
  });
});

const OPEN = 1;
const CLOSED = 3;
const RESOLVED = { command: "npm run dev", cwd: "/repo" };

describe("beginRunTerminal", () => {
  it("spawns and kills the ephemeral PTY when the viewer's socket is still open", () => {
    const term = { kill: vi.fn() } as unknown as IPty;
    const spawnCommandPty = vi.fn(() => term);
    const ws = fakeWs(OPEN);

    beginRunTerminal({ spawnCommandPty } as unknown as WsRouteDeps, ws as unknown as WebSocket, RESOLVED);

    // No size on the URL => null: the spawn falls back to its default size.
    expect(spawnCommandPty).toHaveBeenCalledWith(RESOLVED.command, RESOLVED.cwd, ws, null);
    ws.emit("close"); // the viewer leaves — the ephemeral PTY must be killed
    expect(term.kill).toHaveBeenCalledTimes(1);
  });

  // 2026-09-28: the pane's measured size (?cols=&rows=) reaches the spawn, so the command's
  // PTY opens at the pane's width instead of the default followed by a shrink.
  it("hands the viewer's measured size to the spawn", () => {
    const term = { kill: vi.fn() } as unknown as IPty;
    const spawnCommandPty = vi.fn(() => term);
    const ws = fakeWs(OPEN);

    beginRunTerminal({ spawnCommandPty } as unknown as WsRouteDeps, ws as unknown as WebSocket, RESOLVED, { cols: 26, rows: 67 });

    expect(spawnCommandPty).toHaveBeenCalledWith(RESOLVED.command, RESOLVED.cwd, ws, { cols: 26, rows: 67 });
  });

  // The leak: the viewer left during the (git-backed) resolve, so the socket is already
  // closed by the time we get here. Spawning now would leak a PTY whose only kill is a close
  // handler for an event that already fired.
  it("does not spawn a PTY when the socket closed during the async resolve", () => {
    const spawnCommandPty = vi.fn();
    const ws = fakeWs(CLOSED);

    beginRunTerminal({ spawnCommandPty } as unknown as WsRouteDeps, ws as unknown as WebSocket, RESOLVED);

    expect(spawnCommandPty).not.toHaveBeenCalled();
  });
});
