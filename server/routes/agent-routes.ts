// The agent self-drive API (R8): the two things a Claude session on this machine can ask the
// app to do for it.
//
//   POST /api/workspace/column  — open a new grid column in a directory, running claude, with
//                                 an optional first turn. Replaces the operator's dependency
//                                 on claudecode-notify's POST /api/workspace/add.
//   POST /api/broadcast         — type one instruction into every running Claude session
//                                 (optionally only those in one directory).
//
// No new authentication: both are ordinary state-changing routes behind the same
// same-origin gate as everything else (routes/same-origin-guard.ts), which admits a local
// non-browser caller — a curl from a session on this machine — and refuses a website the
// user happens to be visiting.
//
// Neither route touches a terminal directly. Opening a column is browser state, so the host
// publishes a request and reports whether a tab took it (409 when none did — a launch nobody
// performed must not answer 200). Broadcasting types through the same sender the phone's
// remote input uses, so the paste/submit behaviour of the two is one implementation.
import type { Express, Request, Response } from "express";
import { AGENT_COLUMN_CHANNEL, type AgentColumnEvent, type AgentColumnResponse, type BroadcastResponse, type BroadcastSkip } from "../../common/agentApi.js";
import { decideAgentColumn, NO_GRID_ERROR } from "../session/agent-column.js";
import { decideBroadcast, planBroadcast, type BroadcastCandidate } from "../session/agent-broadcast.js";
import { dropAgentPrompt, queueAgentPrompt } from "../session/agent-prompt-queue.js";
import { messageOf } from "../errors.js";

export interface AgentRouteDeps {
  /** The absolute existing directory for a requested cwd, or null. */
  resolveDir: (cwd: string) => string | null;
  /** Browsers currently subscribed to a pub/sub channel. */
  subscriberCount: (channel: string) => number;
  /** Deliver to exactly ONE subscriber; false when nobody got it. ONE, not all: with two
   *  MulmoTerminal windows open a broadcast would open a column in each, so a single API
   *  call would spawn as many agents as there are tabs (the reason publishToOne exists,
   *  #831). "All clients" is the wrong reading of "reach whichever browser is there". */
  publishToOne: (channel: string, data: unknown) => boolean;
  /** Every live session this process holds a PTY for, with what it runs and whether it is
   *  mid-turn. */
  candidates: () => BroadcastCandidate[];
  /** Type text into a session's input box and submit it (remoteHost/terminalInput.ts). */
  sendToSession: (sessionId: string, text: string) => Promise<{ sent: boolean }>;
}

function openColumn(req: Request, res: Response, deps: AgentRouteDeps): void {
  const decision = decideAgentColumn({
    body: req.body,
    resolveDir: deps.resolveDir,
    listenerCount: deps.subscriberCount(AGENT_COLUMN_CHANNEL),
  });
  if (!decision.ok) {
    res.status(decision.status).json({ error: decision.error });
    return;
  }
  const { cwd, prompt, label, parent } = decision.request;
  // Parked BEFORE the request goes out so it cannot lose a race with a browser that opens
  // the socket immediately, and taken back below if no browser took the request at all —
  // otherwise it would ambush the next column the user opens here by hand.
  if (prompt) queueAgentPrompt(cwd, prompt);
  const event: AgentColumnEvent = { cwd, label, parent };
  if (!deps.publishToOne(AGENT_COLUMN_CHANNEL, event)) {
    if (prompt) dropAgentPrompt(cwd, prompt);
    res.status(409).json({ error: NO_GRID_ERROR });
    return;
  }
  const named = label ? `, named ${label}` : "";
  console.log(`[agent-api] column requested in ${cwd}${named}${prompt ? " with a first turn" : ""}`);
  const body: AgentColumnResponse = { ok: true, cwd, label, prompt: !!prompt };
  res.json(body);
}

// One send per target, in parallel — the sender already serialises per session (its paste and
// its Enter are two writes), and different sessions never wait on each other.
async function deliver(deps: AgentRouteDeps, targets: readonly string[], text: string): Promise<{ sessions: string[]; failed: BroadcastSkip[] }> {
  const results = await Promise.all(
    targets.map(async (id) => {
      try {
        await deps.sendToSession(id, text);
        return { id, ok: true };
      } catch (err) {
        console.warn(`[agent-api] broadcast to ${id} failed: ${messageOf(err)}`);
        return { id, ok: false };
      }
    }),
  );
  return {
    sessions: results.filter((r) => r.ok).map((r) => r.id),
    failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, reason: "send-failed" as const })),
  };
}

async function broadcast(req: Request, res: Response, deps: AgentRouteDeps): Promise<void> {
  const decision = decideBroadcast(req.body);
  if (!decision.ok) {
    res.status(decision.status).json({ error: decision.error });
    return;
  }
  const plan = planBroadcast(deps.candidates(), decision.cwd);
  const { sessions, failed } = await deliver(deps, plan.targets, decision.text);
  const body: BroadcastResponse = { sent: sessions.length, sessions, skipped: [...plan.skipped, ...failed] };
  console.log(`[agent-api] broadcast reached ${body.sent} session(s), skipped ${body.skipped.length}`);
  res.json(body);
}

export function mountAgentRoutes(app: Express, deps: AgentRouteDeps): void {
  app.post("/api/workspace/column", (req, res) => openColumn(req, res, deps));
  // The promise is RETURNED, not voided: Express 5 forwards a rejected handler promise to the
  // error middleware (a voided one would be an unhandled rejection), and it lets a spec await
  // the send rather than poll for the response.
  app.post("/api/broadcast", (req, res) => broadcast(req, res, deps));
}
