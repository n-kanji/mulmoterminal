// Fork-local (iTerm2 mode, R14). "Put me in front of THAT session" — what clicking an OS
// notification asks for. The notification names a session id; only the grid knows which cell
// holds it, which page that cell is on, and how to move the cursor there.
//
// Modelled on useAgentColumn, and different from it in one way that matters: only the NEWEST
// request is kept. A queued column is work the host already promised an agent, so dropping one
// loses a column; a queued reveal is a place the operator wanted to be several notifications
// ago, and replaying a backlog of them would walk the cursor through every session that called
// while the grid was closed, landing on the oldest-but-one.
import { router } from "../router";

type Handler = (sessionId: string) => void;

let handler: Handler | null = null;
let pending: string | null = null;

/** GridView registers its reveal while it is the ACTIVE view; a request that arrived before
 *  then is delivered immediately. The returned function unregisters it. */
export function registerRevealSessionHandler(h: Handler): () => void {
  handler = h;
  const queued = pending;
  pending = null;
  if (queued !== null) h(queued);
  return () => {
    if (handler === h) handler = null;
  };
}

/** Reveal now if the grid is listening, else remember it and switch to the grid, which
 *  registers on activation and drains it. */
export function revealSession(sessionId: string): void {
  if (handler) {
    handler(sessionId);
    return;
  }
  pending = sessionId;
  router.push("/terminals").catch(() => {});
}
