// Pure decision for how a /ws connection should (re)connect a requested session id.
// Split out from index.ts so the flag choice — the one that decides `--resume` vs
// `--session-id` — is unit-testable without a pty, tmux, or the filesystem.

export interface SessionFacts {
  // A live pty for this id in THIS server process (reattach without respawning claude).
  hasLivePty: boolean;
  // A persistent tmux session for this id is alive (survived a restart / another cell).
  tmuxAlive: boolean;
  // An on-disk transcript exists in the target workspace (claude writes it after the
  // first prompt) — the only id claude will `--resume`.
  onDisk: boolean;
}

export interface SessionResolution {
  reattachId: string | null; // reattach this same-process pty (no new claude)
  resume: string | null; // `--resume` this on-disk transcript
  sessionId: string; // the id claude effectively runs as
}

// `resume` is set whenever a transcript exists on disk — REGARDLESS of tmux liveness.
// An on-disk id must never be launched under `--session-id`: claude refuses it with
// "Session ID <id> is already in use." When a tmux session is alive the arg is ignored
// (tmux attaches to the running claude), but if that session died since we checked it
// (reap, /exit, or another instance on the shared tmux server), `tmux new-session -A`
// re-creates it and RUNS the command — and there `--resume <id>` reattaches the
// conversation where `--session-id <id>` would abort. Gating `resume` on `!tmuxAlive`
// (the old behavior) left that window fatal.
export function resolveSession(requested: string | null, facts: SessionFacts, mintId: () => string): SessionResolution {
  const reattachId = requested && facts.hasLivePty ? requested : null;
  const resume = !reattachId && requested && facts.onDisk ? requested : null;
  // Reuse the requested id when we can actually serve it (reattach, a live tmux
  // session, or an on-disk transcript to resume); otherwise it can't be reused —
  // mint a fresh one.
  const sessionId = reattachId ?? (requested && (facts.tmuxAlive || resume) ? requested : mintId());
  return { reattachId, resume, sessionId };
}

// ── forking a conversation into a second column (fork-local, iTerm2 mode, R12) ──

// What a `?fork=<id>` connection should do.
//   none        — no fork asked for, or this connection already has a session of its own
//   fork        — spawn `--resume <from> --fork-session` under a freshly minted id
//   unavailable — a fork WAS asked for and cannot be served; the caller must say so in the
//                 terminal. Never degraded into `none`: a pane that quietly comes up as a
//                 brand-new session looks like the fork worked and loses the conversation
//                 the operator meant to branch (e.g. a source that ran /clear, so claude
//                 wrote no transcript to resume).
export type ForkPlan = { kind: "none" } | { kind: "fork"; from: string } | { kind: "unavailable"; from: string | null };

export interface ForkFacts {
  // This connection is starting a genuinely new session: nothing to reattach, nothing to
  // resume. A reconnect of the FORKED pane arrives with its own id and lands here as false,
  // which is what stops the browser's retry from forking a second time.
  fresh: boolean;
  // The source has an on-disk transcript in this workspace — the only thing `--resume` reads.
  sourceOnDisk: boolean;
}

// `from` is the already-shape-validated source id, or null when the request carried a fork
// param that is not a session id at all — still a failed fork, not a silent plain session.
export function resolveFork(from: string | null, asked: boolean, facts: ForkFacts): ForkPlan {
  if (!asked) return { kind: "none" };
  if (!facts.fresh) return { kind: "none" };
  if (!from || !facts.sourceOnDisk) return { kind: "unavailable", from };
  return { kind: "fork", from };
}

export interface ForkRequestFacts {
  fresh: boolean;
  // The agent's CURRENT own id for a pane that /clear-ed or /compact-ed (session-alias.ts),
  // or undefined when the two still agree. The on-screen conversation lives in the
  // transcript named by THIS id — the pane-id file stopped growing at the /clear.
  currentAgentId: (pane: string) => string | undefined;
  sourceOnDisk: (id: string) => boolean;
}

// The full `?fork=` decision, deps injected so the whole rule is testable without a
// filesystem. The grid can only send the PANE's id, so the source is translated to the
// pane's current agent id first — forking the pane id itself branched a stale pre-/clear
// conversation the operator read as "a different pane's content" (operator report
// 2026-08-31). Deliberately NO pane-id fallback when the current id has no transcript yet
// (a /clear with no prompt since): that fallback IS the stale-fork bug, so it must refuse
// (resolveFork's `unavailable`) instead.
export function resolveForkRequest(raw: string | null, isSessionId: (s: string) => boolean, facts: ForkRequestFacts): ForkPlan {
  const pane = raw && isSessionId(raw) ? raw : null;
  const from = pane ? (facts.currentAgentId(pane) ?? pane) : null;
  return resolveFork(from, raw !== null, { fresh: facts.fresh, sourceOnDisk: !!from && facts.sourceOnDisk(from) });
}

// ── telling the operator a requested session could not be continued ────────────

// The notice for a pane whose requested session id could NOT be served — no live pty, no
// tmux session, no on-disk transcript — so the connection minted a fresh id. The mint
// itself is right (see resolveSession: an unservable id cannot be reused), but doing it
// SILENTLY read as "my conversation vanished" when the 2026-08-25 account-switch fleet
// restart hit a pane whose id had no transcript. null when nothing was lost: no id was
// requested, the id was actually served (reattach, resume, or a live tmux session kept
// it), or this is a fork (a fork mints its own id by design).
export function resumeLossNotice(requested: string | null, resolution: SessionResolution, fork: boolean): string | null {
  if (!requested || fork || resolution.sessionId === requested) return null;
  return (
    `could not continue session ${requested} — no transcript found for it here. ` +
    `This pane is a NEW conversation (${resolution.sessionId}); if the old one had any turns it is still on disk — run /resume in this pane to look for it.`
  );
}

// ── the same decision for the two non-claude terminals ─────────────────────────

/** Which id a launcher or codex connection runs as. A live pty in this process always
 *  wins; otherwise the requested id is reused only when something can actually serve it
 *  (a surviving tmux session, or — for codex — a rollout to resume). Anything else mints
 *  a fresh id, because reusing an id nothing can serve strands the client on a dead one. */
export function resolveReattachableId(
  requested: string | null,
  facts: { hasLivePty: boolean; tmuxAlive: boolean; canResume: boolean },
  mintId: () => string,
): { reattachId: string | null; sessionId: string } {
  const reattachId = requested && facts.hasLivePty ? requested : null;
  const sessionId = reattachId ?? (requested && (facts.tmuxAlive || facts.canResume) ? requested : mintId());
  return { reattachId, sessionId };
}

/** Whether a launcher connection may start at all. A reattach needs no launcher index —
 *  the pty already IS the chosen program — and the header's "new terminal" button runs the
 *  default shell with no configured index. Otherwise the index must name a real launcher,
 *  or there is nothing to run. */
export function canStartLauncher(facts: { hasLivePty: boolean; tmuxAlive: boolean; hasLauncher: boolean; isShell: boolean }): boolean {
  return facts.hasLivePty || facts.tmuxAlive || facts.hasLauncher || facts.isShell;
}
