// Fork-local (iTerm2 mode, R8). A Claude session on this machine asked for a column of its
// own (POST /api/workspace/column); the host published the request because the grid is
// browser state and only a tab can open a cell.
//
// Modelled on useNewTerminal: App.vue subscribes (it is always mounted — GridView is `v-if`d
// on the route and does not exist until /terminals has been visited once), GridView registers
// the opener while it is the ACTIVE view, and a request that arrives in between is QUEUED and
// drains when the grid registers. Every waiting request is kept, not just the newest: the host
// already answered the agent that its column was accepted, so a dropped one is a column
// reported as opened that never was.
//
// The request carries no prompt. The first turn stays on the server and is typed into the PTY
// at spawn (server/session/agent-prompt-queue.ts), so text that will auto-run in an agent
// never travels through a browser.
import { router } from "../router";
import { usePubSub } from "./usePubSub";
import { AGENT_COLUMN_CHANNEL, agentColumnEventOf, type AgentColumnEvent } from "../../common/agentApi";

type Handler = (request: AgentColumnEvent) => void;

let handler: Handler | null = null;
let pending: AgentColumnEvent[] = [];

/** GridView registers its opener; every request queued before it was active drains
 *  immediately, in arrival order. The returned function unregisters it. */
export function registerAgentColumnHandler(h: Handler): () => void {
  handler = h;
  // Taken before dispatching so a handler that itself queues isn't cleared out below.
  const queued = pending;
  pending = [];
  queued.forEach((request) => h(request));
  return () => {
    if (handler === h) handler = null;
  };
}

/** Open the column now if the grid is listening, else queue it and switch to the grid. */
export function openAgentColumn(request: AgentColumnEvent): void {
  if (handler) {
    handler(request);
    return;
  }
  pending.push(request);
  router.push("/terminals").catch(() => {});
}

/** Listen for column requests. Called once, from the always-mounted shell; returns the
 *  unsubscribe. */
export function subscribeAgentColumns(): () => void {
  return usePubSub().subscribe(AGENT_COLUMN_CHANNEL, (data) => {
    const request = agentColumnEventOf(data);
    if (request) openAgentColumn(request);
  });
}
