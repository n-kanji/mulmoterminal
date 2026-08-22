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
//
// The "carry on" nudge is SELECTIVE (operator request): the fleet holds panes that are
// deliberately parked or simply finished, and twenty agents self-directing on a blanket
// "続けて" is noise and tokens. Only a pane the switch actually interrupted gets one — it
// was mid-turn (`working`), or its screen shows Claude Code's limit banner (the turn ended,
// but only because the OLD account ran dry). Everything else restarts silently and waits.
import { activity, ptys, hiddenSessions } from "./registry.js";
import { tmuxCaptureStyledPane } from "../infra/tmux.js";
import { parseStyledRows, rowsToScreen } from "./screen-rows.js";
import { queueResumeNudge } from "./resume-nudge.js";
import type { PtyEntry } from "./types.js";

// Typed into each nudged pane once claude is back up, so interrupted work resumes without
// the operator visiting each pane. Japanese because that is the language the operator runs
// their agents in.
export const RESTART_NUDGE_TEXT = "アカウントを切り替えて再起動しました。中断していた作業があれば、そのまま続けてください。";

// Claude Code's limit banner, as it renders near the input box — "5-hour limit reached ∙
// resets 3am", "Weekly limit reached", "Approaching 5-hour limit", "usage limit". A
// heuristic on purpose: a miss just means one pane restarts quietly and the operator pokes
// it; a false hit means one unnecessary "carry on".
const LIMIT_RE = /limit reached|usage limit|approaching[^\n]*limit/i;
// Only the bottom of the (visible) screen: the banner lives by the input box, and matching
// the whole pane would false-positive on conversations that merely TALK about limits.
const LIMIT_TAIL_ROWS = 15;

// The nudge decision, pure and tested. `screenText` is the pane's visible screen (plain
// text), or null when there is none to read (no tmux — e.g. a sandbox pane).
export function paneNeedsNudge(working: boolean, screenText: string | null): boolean {
  if (working) return true;
  if (!screenText) return false;
  const tail = screenText.split("\n").slice(-LIMIT_TAIL_ROWS).join("\n");
  return LIMIT_RE.test(tail);
}

// The live decision for one pane. Reads the screen only when the working flag alone does
// not already answer, and BEFORE the pane is reaped (the capture needs the tmux session).
function defaultNudgeFor(id: string): string | null {
  const working = !!activity.get(id)?.working;
  const styled = working ? null : tmuxCaptureStyledPane(id);
  const screen = styled ? rowsToScreen(parseStyledRows(styled)) : null;
  return paneNeedsNudge(working, screen) ? RESTART_NUDGE_TEXT : null;
}

export interface FleetRestart {
  restarted: number;
  nudged: number;
}

export function restartClaudePanes(
  reap: (id: string) => void,
  nudgeFor: (id: string) => string | null = defaultNudgeFor,
  entries: Map<string, PtyEntry> = ptys,
  hidden: Set<string> = hiddenSessions,
): FleetRestart {
  let restarted = 0;
  let nudged = 0;
  // Snapshot the entries: reap deletes from the live map mid-iteration.
  for (const [id, entry] of [...entries]) {
    if (entry.agent !== "claude" || hidden.has(id)) continue;
    // Decide the nudge while the pane is still alive — it may need the screen.
    const nudge = nudgeFor(id);
    const ws = entry.ws;
    // Detach the socket first — the pty exit this reap causes must read as a DROP to the
    // client (reconnect), never as an EXIT (permanent).
    entry.ws = null;
    if (nudge) {
      queueResumeNudge(id, nudge);
      nudged += 1;
    }
    reap(id);
    try {
      ws?.close();
    } catch {
      // socket already gone — the client is reconnecting anyway
    }
    restarted += 1;
  }
  return { restarted, nudged };
}
