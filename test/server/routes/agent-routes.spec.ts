import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Express } from "express";
import { mountAgentRoutes, type AgentRouteDeps } from "../../../server/routes/agent-routes.js";
import { clearAgentPrompts, queuedAgentPromptCount, takeAgentPrompt } from "../../../server/session/agent-prompt-queue.js";
import { AGENT_COLUMN_CHANNEL } from "../../../common/agentApi.js";
import type { BroadcastCandidate } from "../../../server/session/agent-broadcast.js";

interface FakeRes {
  statusCode: number;
  payload: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

type Handler = (req: { body: unknown }, res: FakeRes) => unknown;

// Mount against a fake Express and hand back the handlers by path — no HTTP server needed
// (the pattern tmux-routes.spec / gitRemote.spec use).
function mountAndCapture(deps: AgentRouteDeps): { column: Handler; broadcast: Handler } {
  const handlers = new Map<string, Handler>();
  const app = { post: (p: string, h: Handler) => handlers.set(p, h) } as unknown as Express;
  mountAgentRoutes(app, deps);
  const column = handlers.get("/api/workspace/column");
  const broadcast = handlers.get("/api/broadcast");
  if (!column || !broadcast) throw new Error("routes were not mounted");
  return { column, broadcast };
}

const PROJECT = "/home/u/project";
const OTHER = "/home/u/other";

function claude(id: string, over: Partial<BroadcastCandidate> = {}): BroadcastCandidate {
  return { id, cwd: PROJECT, agent: "claude", working: false, ...over };
}

function baseDeps(over: Partial<AgentRouteDeps> = {}): AgentRouteDeps {
  return {
    resolveDir: (cwd) => (cwd === PROJECT || cwd === OTHER ? cwd : null),
    subscriberCount: () => 1,
    publishToOne: () => true,
    candidates: () => [],
    sendToSession: async () => ({ sent: true }),
    ...over,
  };
}

beforeEach(clearAgentPrompts);

describe("POST /api/workspace/column", () => {
  it("refuses with 409 when no browser is connected, and keeps no prompt behind", async () => {
    const published = vi.fn(() => true);
    const { column } = mountAndCapture(baseDeps({ subscriberCount: () => 0, publishToOne: published }));
    const res = makeRes();

    await column({ body: { cwd: PROJECT, prompt: "start on the parser" } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual({ error: expect.stringContaining("no MulmoTerminal browser is open") });
    expect(published).not.toHaveBeenCalled();
    expect(queuedAgentPromptCount()).toBe(0);
  });

  it("refuses with 409 when the tab closed between the count and the publish", async () => {
    const { column } = mountAndCapture(baseDeps({ publishToOne: () => false }));
    const res = makeRes();

    await column({ body: { cwd: PROJECT, prompt: "start on the parser" } }, res);

    expect(res.statusCode).toBe(409);
    // The prompt must not survive to ambush a column the user later opens by hand.
    expect(queuedAgentPromptCount()).toBe(0);
  });

  it("publishes the directory and holds the prompt server-side", async () => {
    const published = vi.fn(() => true);
    const { column } = mountAndCapture(baseDeps({ publishToOne: published }));
    const res = makeRes();

    await column({ body: { cwd: PROJECT, prompt: "  start on the parser  ", label: "parser" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, cwd: PROJECT, label: "parser", prompt: true });
    // The event carries WHERE, never the text that will auto-run.
    expect(published).toHaveBeenCalledWith(AGENT_COLUMN_CHANNEL, { cwd: PROJECT, label: "parser", parent: null });
    expect(takeAgentPrompt(PROJECT)).toBe("start on the parser");
  });

  it("rejects a directory the host cannot resolve", async () => {
    const { column } = mountAndCapture(baseDeps());
    const res = makeRes();

    await column({ body: { cwd: "relative/path" } }, res);

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/broadcast", () => {
  it("skips sessions that are mid-turn instead of typing into them", async () => {
    const sent = vi.fn(async () => ({ sent: true }));
    const { broadcast } = mountAndCapture(
      baseDeps({
        candidates: () => [claude("idle-1"), claude("busy", { working: true }), claude("unknown", { working: undefined })],
        sendToSession: sent,
      }),
    );
    const res = makeRes();

    await broadcast({ body: { text: "status please" } }, res);

    expect(res.payload).toEqual({
      sent: 1,
      sessions: ["idle-1"],
      // "unknown" is skipped for the same reason: no hook has reported, which is not idle.
      skipped: [
        { id: "busy", reason: "working" },
        { id: "unknown", reason: "working" },
      ],
    });
    expect(sent).toHaveBeenCalledExactlyOnceWith("idle-1", "status please");
  });

  it("filters to one directory and never reaches a shell or codex cell", async () => {
    const sent = vi.fn(async () => ({ sent: true }));
    const { broadcast } = mountAndCapture(
      baseDeps({
        candidates: () => [claude("here"), claude("elsewhere", { cwd: OTHER }), claude("shell", { agent: "shell" }), claude("codex", { agent: "codex" })],
        sendToSession: sent,
      }),
    );
    const res = makeRes();

    // A trailing slash is the same directory — the filter normalises both sides.
    await broadcast({ body: { text: "ship it", cwd: `${PROJECT}/` } }, res);

    expect(res.payload).toEqual({ sent: 1, sessions: ["here"], skipped: [] });
    expect(sent).toHaveBeenCalledExactlyOnceWith("here", "ship it");
  });

  it("reports a send that failed rather than counting it", async () => {
    const { broadcast } = mountAndCapture(
      baseDeps({
        candidates: () => [claude("gone")],
        sendToSession: async () => {
          throw new Error("session gone has no live terminal on this host");
        },
      }),
    );
    const res = makeRes();

    await broadcast({ body: { text: "status please" } }, res);

    expect(res.payload).toEqual({ sent: 0, sessions: [], skipped: [{ id: "gone", reason: "send-failed" }] });
  });

  it("requires text", async () => {
    const { broadcast } = mountAndCapture(baseDeps());
    const res = makeRes();

    await broadcast({ body: { text: "   " } }, res);

    expect(res.statusCode).toBe(400);
  });
});
