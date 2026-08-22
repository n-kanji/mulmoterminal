// Restart every claude pane so it picks up freshly-switched credentials (see
// backends/claude-account.ts). A running claude holds its OAuth token in-process for its
// whole life, so swapping the Keychain reaches NEW processes only — and when a usage limit
// hits, it is exactly the twenty EXISTING panes the operator wants moved to the other
// account, mid-conversation.
//
// The trick is to make each restart look like a server restart, the one teardown the client
// is already built to survive: null the entry's socket BEFORE reaping, so the pty's exit
// handler has nobody to send an exit frame to (sendExitAndClose on a null socket is a no-op),
// then close the socket plainly. A close without an exit frame is precisely what the client's
// reconnect policy retries (reconnectPolicy.ts `sawExit`), and its reconnect carries
// ?session=<id> — by then the pty AND its tmux session are gone (reap's tmuxKillSession is
// spawnSync, so it completes before the close is even sent), the transcript is on disk, and
// ws-routes cold-resumes it: a fresh `claude --resume` that reads the swapped Keychain.
//
// Detached panes (a grid page the operator isn't looking at) restart too — their live pty
// would otherwise keep the old account AND swallow the next reattach (a live pty reattaches
// as-is, no respawn), leaving a pane silently on the wrong account with no signal. With the
// pty reaped, their next viewer cold-resumes onto the new credentials. Hidden background
// workers (translation etc.) are excluded by `hiddenSessions` — nothing ever reconnects
// those, so a restart would just kill them.
import { ptys, hiddenSessions } from "./registry.js";
import { queueResumeNudge } from "./resume-nudge.js";
import type { PtyEntry } from "./types.js";

// Typed into each restarted pane once claude is back up, so the fleet resumes work without
// the operator visiting twenty panes. Japanese because that is the language the operator
// runs their agents in.
export const RESTART_NUDGE_TEXT = "アカウントを切り替えて再起動しました。中断していた作業があれば、そのまま続けてください。";

export function restartClaudePanes(
  reap: (id: string) => void,
  nudge: string | null,
  entries: Map<string, PtyEntry> = ptys,
  hidden: Set<string> = hiddenSessions,
): number {
  let restarted = 0;
  // Snapshot the entries: reap deletes from the live map mid-iteration.
  for (const [id, entry] of [...entries]) {
    if (entry.agent !== "claude" || hidden.has(id)) continue;
    const ws = entry.ws;
    // Detach the socket first — the pty exit this reap causes must read as a DROP to the
    // client (reconnect), never as an EXIT (permanent).
    entry.ws = null;
    if (nudge) queueResumeNudge(id, nudge);
    reap(id);
    try {
      ws?.close();
    } catch {
      // socket already gone — the client is reconnecting anyway
    }
    restarted += 1;
  }
  return restarted;
}
