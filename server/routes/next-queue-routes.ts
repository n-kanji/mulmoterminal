// The per-pane next-instruction queue over HTTP (plans/feat-next-instruction-queue.md).
//
//   GET    /api/session/:id/queue            — the state
//   POST   /api/session/:id/queue            — {text}: park an instruction
//   DELETE /api/session/:id/queue/:itemId    — drop one
//   PUT    /api/session/:id/queue/auto       — {enabled}: type the head as soon as a turn ends
//   POST   /api/session/:id/queue/send-next  — type the head now (ignores the auto flag)
//   POST   /api/session/:id/queue/read       — the operator has read the hand-offs
//
// Same gate as the mission route: every write is a state-changing method, so the same-origin
// guard covers it, and a local curl (the agent in the pane parking its own follow-up) is
// admitted. The id is translated through session-alias.ts for the same reason the mission
// route does it — the agent knows only its own post-/clear id.
//
// Mounted from index.ts, not the app-routes table: the drain needs the typing sender and the
// transcript reader that only index.ts composes (same reason as mountAgentRoutes).
import type { Express, Request, Response } from "express";
import { SESSION_ID_RE } from "../config/env.js";
import { resolveAliasedSessionId } from "../session/session-alias.js";
import { dequeueNext, enqueueNext, markHandoffsRead, nextQueueOf, nextQueuesHydrated, normalizeQueueText, setNextAuto } from "../session/next-queue.js";
import { drainNextQueue, type DrainDeps } from "../session/next-queue-drain.js";

export type NextQueueRouteDeps = DrainDeps;

function sessionIdOf(req: Request<{ id: string }>, res: Response): string | null {
  const id = resolveAliasedSessionId(req.params.id);
  if (!SESSION_ID_RE.test(id)) {
    res.status(400).json({ error: "invalid session id" });
    return null;
  }
  return id;
}

const bodyOf = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

export function mountNextQueueRoutes(app: Express, deps: NextQueueRouteDeps): void {
  app.get("/api/session/:id/queue", async (req: Request<{ id: string }>, res) => {
    const id = sessionIdOf(req, res);
    if (!id) return;
    await nextQueuesHydrated;
    res.json({ id, state: nextQueueOf(id) });
  });

  app.post("/api/session/:id/queue", async (req: Request<{ id: string }>, res) => {
    const id = sessionIdOf(req, res);
    if (!id) return;
    const raw = bodyOf(req).text;
    if (typeof raw !== "string") return res.status(400).json({ error: "text must be a string" });
    const text = normalizeQueueText(raw);
    if (!text) return res.status(400).json({ error: "text is required" });
    await nextQueuesHydrated;
    const { state, item } = enqueueNext(id, text);
    deps.publish(id, state);
    res.json({ id, item, state });
  });

  app.delete("/api/session/:id/queue/:itemId", async (req: Request<{ id: string; itemId: string }>, res) => {
    const id = sessionIdOf(req, res);
    if (!id) return;
    await nextQueuesHydrated;
    const { state, removed } = dequeueNext(id, req.params.itemId);
    if (!removed) return res.status(404).json({ error: "no such queued item" });
    deps.publish(id, state);
    res.json({ id, state });
  });

  app.put("/api/session/:id/queue/auto", async (req: Request<{ id: string }>, res) => {
    const id = sessionIdOf(req, res);
    if (!id) return;
    const enabled = bodyOf(req).enabled;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    await nextQueuesHydrated;
    const state = setNextAuto(id, enabled);
    deps.publish(id, state);
    res.json({ id, state });
  });

  app.post("/api/session/:id/queue/send-next", async (req: Request<{ id: string }>, res) => {
    const id = sessionIdOf(req, res);
    if (!id) return;
    await nextQueuesHydrated;
    const result = await drainNextQueue(id, deps, { force: true });
    if (!result.sent) {
      const status = result.reason === "empty" ? 404 : 502;
      return res.status(status).json({ error: result.reason === "empty" ? "queue is empty" : "could not type into the session", state: result.state });
    }
    res.json({ id, sent: true, state: result.state });
  });

  app.post("/api/session/:id/queue/read", async (req: Request<{ id: string }>, res) => {
    const id = sessionIdOf(req, res);
    if (!id) return;
    await nextQueuesHydrated;
    const state = markHandoffsRead(id);
    deps.publish(id, state);
    res.json({ id, state });
  });
}
