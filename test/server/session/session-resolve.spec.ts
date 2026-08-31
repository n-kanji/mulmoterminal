import { describe, it, expect } from "vitest";
import {
  resolveSession,
  type SessionFacts,
  resolveFork,
  resolveForkRequest,
  resolveReattachableId,
  resumeLossNotice,
  canStartLauncher,
} from "../../../server/session/session-resolve.js";

const FIXED = "fresh-minted-id";
const mint = () => FIXED;
const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({ hasLivePty: false, tmuxAlive: false, onDisk: false, ...over });

describe("resolveSession", () => {
  it("mints a fresh id when nothing is requested", () => {
    expect(resolveSession(null, facts(), mint)).toEqual({ reattachId: null, resume: null, sessionId: FIXED });
  });

  it("mints a fresh id when the requested session can't be served (not live, tmux, or on disk)", () => {
    // e.g. reloading an idle session claude never persisted — reusing its id under
    // --session-id would abort, so we start fresh and the browser adopts the new id.
    expect(resolveSession("s1", facts(), mint)).toEqual({ reattachId: null, resume: null, sessionId: FIXED });
  });

  it("reattaches a same-process live pty (no resume, id preserved)", () => {
    expect(resolveSession("s1", facts({ hasLivePty: true }), mint)).toEqual({ reattachId: "s1", resume: null, sessionId: "s1" });
  });

  it("resumes an on-disk transcript", () => {
    expect(resolveSession("s1", facts({ onDisk: true }), mint)).toEqual({ reattachId: null, resume: "s1", sessionId: "s1" });
  });

  it("reuses the id for a live tmux session with no transcript yet (idle, --session-id attaches)", () => {
    expect(resolveSession("s1", facts({ tmuxAlive: true }), mint)).toEqual({ reattachId: null, resume: null, sessionId: "s1" });
  });

  it("resumes an on-disk transcript EVEN when a tmux session is alive (the fix)", () => {
    // Regression: the old logic gated resume on !tmuxAlive, so this yielded resume:null
    // and a --session-id launch that aborts with "already in use" if the tmux session
    // died between the check and the spawn.
    expect(resolveSession("s1", facts({ tmuxAlive: true, onDisk: true }), mint)).toEqual({ reattachId: null, resume: "s1", sessionId: "s1" });
  });

  it("prefers a live pty over tmux/disk", () => {
    expect(resolveSession("s1", facts({ hasLivePty: true, tmuxAlive: true, onDisk: true }), mint)).toEqual({ reattachId: "s1", resume: null, sessionId: "s1" });
  });
});

describe("resumeLossNotice", () => {
  it("names both ids when a requested session was silently replaced by a minted one", () => {
    // The 2026-08-25 account-switch case: the fleet restart reconnected a pane whose id
    // had no transcript, and the pane came back as a blank new conversation with no word.
    const notice = resumeLossNotice("s1", resolveSession("s1", facts(), mint), false);
    expect(notice).toContain("s1");
    expect(notice).toContain(FIXED);
    expect(notice).toContain("/resume");
  });

  it("is null when the requested id was actually served (reattach / resume / live tmux)", () => {
    expect(resumeLossNotice("s1", resolveSession("s1", facts({ hasLivePty: true }), mint), false)).toBeNull();
    expect(resumeLossNotice("s1", resolveSession("s1", facts({ onDisk: true }), mint), false)).toBeNull();
    expect(resumeLossNotice("s1", resolveSession("s1", facts({ tmuxAlive: true }), mint), false)).toBeNull();
  });

  it("is null when no id was requested (a deliberately fresh session)", () => {
    expect(resumeLossNotice(null, resolveSession(null, facts(), mint), false)).toBeNull();
  });

  it("is null for a fork — a fork mints its own id by design", () => {
    expect(resumeLossNotice("s1", resolveSession("s1", facts(), mint), true)).toBeNull();
  });
});

// /ws/launch and /ws/codex reuse a requested id only when something can actually serve it.
// Handing back an id nothing can serve strands the client on a dead session.
describe("resolveReattachableId", () => {
  const mint = () => "FRESH";
  const facts = (over = {}) => ({ hasLivePty: false, tmuxAlive: false, canResume: false, ...over });

  it("mints a fresh id when nothing was requested", () => {
    expect(resolveReattachableId(null, facts(), mint)).toEqual({ reattachId: null, sessionId: "FRESH" });
  });

  it("reattaches a live pty in this process", () => {
    expect(resolveReattachableId("REQ", facts({ hasLivePty: true }), mint)).toEqual({ reattachId: "REQ", sessionId: "REQ" });
  });

  it("keeps the id for a surviving tmux session, without reattaching a pty", () => {
    expect(resolveReattachableId("REQ", facts({ tmuxAlive: true }), mint)).toEqual({ reattachId: null, sessionId: "REQ" });
  });

  it("keeps the id when there is something to resume", () => {
    expect(resolveReattachableId("REQ", facts({ canResume: true }), mint)).toEqual({ reattachId: null, sessionId: "REQ" });
  });

  it("mints a fresh id when the requested one cannot be served", () => {
    expect(resolveReattachableId("REQ", facts(), mint)).toEqual({ reattachId: null, sessionId: "FRESH" });
  });

  it("prefers the live pty when several facts hold at once", () => {
    expect(resolveReattachableId("REQ", facts({ hasLivePty: true, tmuxAlive: true, canResume: true }), mint)).toEqual({ reattachId: "REQ", sessionId: "REQ" });
  });

  it("never reattaches without a requested id, whatever the facts say", () => {
    expect(resolveReattachableId(null, facts({ hasLivePty: true, tmuxAlive: true, canResume: true }), mint)).toEqual({ reattachId: null, sessionId: "FRESH" });
  });
});

// A launcher connection needs SOMETHING to run: an existing process to reattach to, a
// configured launcher at the requested index, or the "new terminal" shell button.
describe("canStartLauncher", () => {
  const facts = (over = {}) => ({ hasLivePty: false, tmuxAlive: false, hasLauncher: false, isShell: false, ...over });

  it("refuses when there is nothing to reattach and no launcher at that index", () => {
    expect(canStartLauncher(facts())).toBe(false);
  });

  it("allows a reattach even when the index names no launcher", () => {
    // The pty already IS the chosen program, so the index is irrelevant.
    expect(canStartLauncher(facts({ hasLivePty: true }))).toBe(true);
    expect(canStartLauncher(facts({ tmuxAlive: true }))).toBe(true);
  });

  it("allows a fresh spawn of a configured launcher", () => {
    expect(canStartLauncher(facts({ hasLauncher: true }))).toBe(true);
  });

  it("allows the shell button, which has no configured index", () => {
    expect(canStartLauncher(facts({ isShell: true }))).toBe(true);
  });
});

// R12 (fork-local, iTerm2 mode): `?fork=<id>` — the Fork button opened this column to branch
// that conversation. Two rules carry the whole feature: a fork only applies to a connection
// with no session of its own, and a fork that cannot be served is an ERROR, never a plain new
// session (a blank pane that looks like the branch worked is the failure the button exists to
// avoid).
describe("resolveFork", () => {
  const SOURCE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("forks when a fresh connection names a source with a transcript", () => {
    expect(resolveFork(SOURCE, true, { fresh: true, sourceOnDisk: true })).toEqual({ kind: "fork", from: SOURCE });
  });

  it("does nothing when no fork was asked for", () => {
    expect(resolveFork(null, false, { fresh: true, sourceOnDisk: true })).toEqual({ kind: "none" });
  });

  // The reconnect guard. Once the branch has an id, the browser's retries arrive with it — a
  // fork param still on the URL must not open the source's conversation a second time.
  it("ignores the param once this connection has a session of its own", () => {
    expect(resolveFork(SOURCE, true, { fresh: false, sourceOnDisk: true })).toEqual({ kind: "none" });
  });

  it("reports unavailable — not a fresh session — when the source has no transcript", () => {
    // The source was cleared, or never sent a prompt: claude has no transcript to --resume.
    expect(resolveFork(SOURCE, true, { fresh: true, sourceOnDisk: false })).toEqual({ kind: "unavailable", from: SOURCE });
  });

  it("reports unavailable when the param is not a session id at all", () => {
    expect(resolveFork(null, true, { fresh: true, sourceOnDisk: false })).toEqual({ kind: "unavailable", from: null });
  });
});

// The full `?fork=` decision, with the /clear translation folded in. The grid can only send
// the PANE's id; after a /clear the on-screen conversation lives in the transcript named by
// Claude's own newer id, and forking the pane id branched the stale pre-/clear conversation
// (operator report 2026-08-31: "the new pane showed a different pane's content").
describe("resolveForkRequest", () => {
  const PANE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const CURRENT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const isSessionId = (s: string) => /^[0-9a-f-]{36}$/.test(s);
  const never = () => undefined;

  it("forks the pane id itself for a pane that never cleared", () => {
    const plan = resolveForkRequest(PANE, isSessionId, { fresh: true, currentAgentId: never, sourceOnDisk: (id) => id === PANE });
    expect(plan).toEqual({ kind: "fork", from: PANE });
  });

  // The regression this exists for: the source pane /clear-ed days ago, so its pane-id file
  // is a frozen pre-/clear conversation while the on-screen one lives under the newer id.
  it("forks the pane's CURRENT agent id after a /clear, not the stale pane id", () => {
    const plan = resolveForkRequest(PANE, isSessionId, {
      fresh: true,
      currentAgentId: (pane) => (pane === PANE ? CURRENT : undefined),
      sourceOnDisk: (id) => id === CURRENT || id === PANE, // BOTH exist — the stale one must lose
    });
    expect(plan).toEqual({ kind: "fork", from: CURRENT });
  });

  // No pane-id fallback: right after a /clear with no prompt since, the newer id has no
  // transcript yet. Falling back to the (existing!) pane-id file would silently branch the
  // pre-/clear conversation — the exact bug — so it must refuse instead.
  it("refuses rather than fall back to the stale pane id when the current id has no transcript", () => {
    const plan = resolveForkRequest(PANE, isSessionId, {
      fresh: true,
      currentAgentId: () => CURRENT,
      sourceOnDisk: (id) => id === PANE,
    });
    expect(plan).toEqual({ kind: "unavailable", from: CURRENT });
  });

  it("reports unavailable for a param that is not a session id, without consulting the lookups", () => {
    const plan = resolveForkRequest("not-an-id", isSessionId, { fresh: true, currentAgentId: never, sourceOnDisk: () => true });
    expect(plan).toEqual({ kind: "unavailable", from: null });
  });

  it("does nothing without a fork param", () => {
    expect(resolveForkRequest(null, isSessionId, { fresh: true, currentAgentId: never, sourceOnDisk: () => true })).toEqual({ kind: "none" });
  });

  it("ignores the param once this connection has a session of its own", () => {
    expect(resolveForkRequest(PANE, isSessionId, { fresh: false, currentAgentId: never, sourceOnDisk: () => true })).toEqual({ kind: "none" });
  });
});
