// Starting a claude session in a PTY and wiring it to the browser. The most entangled
// piece of index.ts (#548 step 3c): it spans the sandbox decision, the CLI args, the
// sidebar's optimistic row, the draft typed into the input box, and teardown on exit.
import type { WebSocket } from "ws";
import { CLAUDE_CWD } from "../config/env.js";
import { getUserMcpServers } from "../config/config-routes.js";
import { SANDBOX_HOST } from "../infra/sandbox.js";
import { buildClaudeArgs } from "../agents/claude-args.js";
import { knownSessions, launchChoices, ptys } from "./registry.js";
import { resolveAliasedSessionId } from "./session-alias.js";
import { ptySpawn, sandboxWouldRun, spawnSandboxEntry } from "./pty-spawn.js";
import { attachDraftInjection } from "./draft-injection.js";
import { withChannelConsent } from "./channel-consent.js";
import { sendExitAndClose, sendFrame } from "./ws-frames.js";
import { appendBoundedOutput } from "./terminal-replay.js";
import { sessionExistsOnDisk } from "./session-reads.js";
import type { PtyEntry } from "./types.js";
import type { SpawnDeps } from "./spawn-deps.js";
import { loadDirConfig } from "../config/dir-config.js";
import { getProviders } from "../config/config-routes.js";
import { requireResolution, resolveProvider, type DirModelChoice } from "./provider-env.js";
import { settingsArgument, mcpConfigArgument, withSettingsCleanup } from "./session-settings.js";
import { effectiveChoice } from "./launch-choice.js";

export interface SpawnClaudeOptions {
  // Passed to claude as the first turn, so the session starts working before anyone
  // opens it. Mutually exclusive with `draft`.
  initialPrompt?: string;
  cwd?: string;
  attachGuiMcp?: boolean;
  // Typed into the input box once claude is ready, NOT submitted — the user reviews it.
  draft?: string;
  // What the browser picked in the launch form (#584). Replaces the directory's default
  // as a PAIR: a provider from one source with a model from the other is a combination
  // neither of them asked for. Absent — the usual case — means "use the directory's".
  launch?: DirModelChoice;
  // Fork-local (iTerm2 mode, R12): `resume` is the session to BRANCH, not to continue —
  // this pane runs as `sessionId` with a copy of that conversation, and the source keeps
  // running untouched wherever it is.
  fork?: boolean;
}

// The provider/model a spawn continues on, when it continues one at all (#584). A fork is the
// only spawn whose id this server has never seen a choice for: it is a NEW session carrying an
// OLD conversation, so the source's choice is the only defensible answer — a branch that lands
// on a different backend than the pane it came from is the silent wrong-backend that contract
// exists to prevent.
function rememberedChoice(sessionId: string, resume: string | null, fork: boolean): DirModelChoice | undefined {
  const own = launchChoices.get(sessionId);
  if (own || !fork || !resume) return own;
  // A fork's `resume` may be the source pane's post-/clear agent id (ws-routes translates it
  // so the branch carries what the pane SHOWS); launch choices are keyed by the PANE id, so
  // translate back or a cleared pane's fork would silently fall to the directory default.
  return launchChoices.get(resume) ?? launchChoices.get(resolveAliasedSessionId(resume));
}

// Brand-new (or restarted-idle) session: surface it in the sidebar before it's persisted. A
// spawned session (an initialPrompt or a draft) gets its title from that text, so it is
// recognizable in the sidebar before anyone opens it.
function announceNewSession(deps: SpawnDeps, sessionId: string, seed: string | undefined): void {
  const title = seed ? seed.replace(/\s+/g, " ").trim().slice(0, 60) || "New session" : "New session";
  knownSessions.set(sessionId, { createdAt: Date.now(), title });
  deps.publishSessionCreated(sessionId);
}

// What the connection log calls this spawn. Named so the log line stays one expression.
function spawnKind(fork: boolean, canResume: boolean, resume: string | null): string {
  if (fork) return `fork of ${resume}`;
  return canResume ? "resume" : "new";
}

export function createClaudeSpawner(deps: SpawnDeps) {
  // Spawn a fresh claude PTY for this session, register it, and wire its output /
  // exit back to the browser socket. `ws` may be null for a session spawned without
  // a viewer yet (e.g. spawnBackgroundChat) — output just buffers until a client
  // reattaches.
  function spawnClaudePty(sessionId: string, resume: string | null, ws: WebSocket | null, options: SpawnClaudeOptions = {}): PtyEntry {
    const { initialPrompt, cwd = CLAUDE_CWD, attachGuiMcp = true, draft, launch, fork = false } = options;
    // attachGuiMcp picks the MCP mode (see buildClaudeArgs): the single view (default)
    // attaches the GUI MCP + --strict-mcp-config (main's classic behavior); the grid's
    // dev terminals attach neither, so the user's + project's MCP servers load normally.
    // Only --resume when the session has an on-disk transcript — claude doesn't write
    // a session's .jsonl until its first prompt, so a started-but-unused session can't
    // be resumed; we restart fresh (reusing the id via --session-id) instead.
    // Sandbox only the SINGLE-VIEW interactive session: attachGuiMcp=true excludes grid
    // dev terminals (?gui=0), and ws!==null excludes hidden background/translation workers.
    // Falls back to the host spawn if the Docker daemon isn't reachable.
    const sandbox = sandboxWouldRun(attachGuiMcp) && ws !== null;
    const canResume = resume !== null && sessionExistsOnDisk(resume, cwd);

    // What this directory asked its sessions to run (#579). A refusal THROWS: falling back
    // to Anthropic would send this session's prompts to a backend the directory did not
    // select, which is exactly what the provider contract exists to prevent. The ws route
    // turns it into a message in the terminal.
    const dir = loadDirConfig(cwd);
    const choice = effectiveChoice({
      launch,
      remembered: rememberedChoice(sessionId, resume, fork),
      dir: { provider: dir.provider, model: dir.model },
      resuming: canResume,
    });
    const resolved = requireResolution(resolveProvider(choice, getProviders(), process.env, sandbox));
    // Remembered so a later resume continues on the backend this session began on, instead
    // of silently moving to the directory's default mid-conversation.
    if (launch) launchChoices.set(sessionId, choice);

    const hookSettings = deps.hookSettingsJson(sandbox ? SANDBOX_HOST : "localhost", sessionId, resolved.env);
    const mcpJson = deps.mcpConfigJson(sessionId, sandbox ? SANDBOX_HOST : "127.0.0.1", sandbox);
    // File-ized only when it is actually passed (attachGuiMcp), so a cell that never carries
    // the GUI MCP leaves no file behind for reap to clean up.
    const mcpConfig = attachGuiMcp ? mcpConfigArgument(sessionId, mcpJson) : mcpJson;
    const args = buildClaudeArgs({
      model: resolved.model,
      sessionId,
      resume,
      canResume,
      // In the sandbox the hooks + GUI MCP are reached over host.docker.internal. A
      // provider session's settings carry its token, so they go to a 0600 file instead of
      // argv — see session-settings.ts.
      settings: settingsArgument(sessionId, hookSettings, Object.keys(resolved.env).length > 0),
      permissionMode: deps.permissionMode,
      attachGuiMcp,
      mcpConfig,
      // Auto-allow the GUI tools + the user's own configured MCP servers (mcp__<id>), so
      // their tools don't trip a permission prompt on every call.
      guiMcpTools: [deps.guiMcpTools, ...getUserMcpServers().map((s) => `mcp__${s.id}`)].join(","),
      addDirs: dir.addDirs,
      fork,
    });

    console.log(`[ws] client connected (${spawnKind(fork, canResume, resume)} ${sessionId})`);

    // Sandbox → run claude inside a fresh container (no tmux). Otherwise the host path:
    // a live tmux session for this id (survived a restart) reattaches; else create it.
    // The settings file is already on disk and may hold a provider token, so a failed
    // spawn has to take it with it — a session that never starts never reaches reap(),
    // where the cleanup normally happens (#579).
    const entry = withSettingsCleanup(sessionId, spawnEntry);

    function spawnEntry(): PtyEntry {
      if (sandbox) return spawnSandboxEntry(sessionId, args, cwd, ws, dir.addDirs);
      const { term, tmux } = ptySpawn(sessionId, deps.claudeBin, args, cwd, true, resolved.unset);
      console.log(`[pty] spawned claude (pid=${term.pid}${tmux ? " via tmux" : ""}) in ${cwd}`);
      return { term, ws, buffer: "", cwd, tmux, active: false, agent: "claude" };
    }
    ptys.set(sessionId, entry);

    // A fork resumes a transcript but IS new (its own id, its own future), so it needs the
    // sidebar row every other new session gets — `canResume` alone would skip it.
    if (!canResume || fork) announceNewSession(deps, sessionId, initialPrompt ?? draft);

    // The auto-run prompt / editable draft is typed into the input box once ready (see
    // attachDraftInjection) — its scanner is fed the pty output below. Fork-local: the
    // draft scanner is wrapped so an opted-in dev-channels consent chooser (see
    // channel-consent.ts) gets its Enter first; without it a CLAUDE_BIN wrapper that
    // loads a local channel leaves every new cell looking hung.
    const scanForDraftReady = withChannelConsent(entry, attachDraftInjection(entry, initialPrompt, draft));

    // PTY -> browser (buffering a bounded tail for reattach).
    entry.term.onData((data) => {
      entry.buffer = appendBoundedOutput(entry.buffer, data, deps.outputBufferLimit);
      sendFrame(entry.ws, { type: "output", data });
      scanForDraftReady(data);
    });

    entry.term.onExit(({ exitCode, signal }) => {
      console.log(`[pty] exited code=${exitCode} signal=${signal}`);
      sendExitAndClose(entry.ws, exitCode, signal);
      // Clear the dot if it died mid-turn, then tear down everything (deletes
      // ptys/knownSessions/activity and publishes "closed") so a process that
      // exits on its own — e.g. a brand-new session that never persisted —
      // doesn't linger in the sidebar.
      deps.setWorking(sessionId, false);
      deps.reap(sessionId);
    });

    return entry;
  }

  return { spawnClaudePty };
}
