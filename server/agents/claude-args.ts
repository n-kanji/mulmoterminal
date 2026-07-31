// Pure builder for the `claude` CLI argv. Kept separate so the exact flag set —
// especially the GUI-MCP / --strict-mcp-config switch — is unit-testable without
// spawning a PTY.

export interface ClaudeArgsInput {
  sessionId: string;
  resume: string | null;
  // Whether the requested session has an on-disk transcript to --resume. When
  // false we start fresh, reusing the id via --session-id.
  canResume: boolean;
  settings: string; // hook settings JSON (--settings)
  permissionMode: string; // --permission-mode
  // true  (single view): attach the in-process GUI MCP, auto-allow its tools, and
  //        isolate to it with --strict-mcp-config (main's classic behavior).
  // false (grid dev terminal): no GUI MCP and no --strict-mcp-config, so the user's
  //        + project's MCP servers load normally.
  attachGuiMcp: boolean;
  mcpConfig: string; // GUI MCP config JSON (--mcp-config), used only when attachGuiMcp
  guiMcpTools: string; // comma-joined GUI tool names (--allowedTools), used only when attachGuiMcp
  // What this session runs (#579): an alias (sonnet/opus/haiku) or a backend's own model
  // name. Null leaves the choice to Claude Code. `--model` outranks both the settings
  // `model` key and ANTHROPIC_MODEL, so it is the one place the decision has to be made.
  model?: string | null;
  // Extra directories the session may read/edit (#908). Absolute, existing, deduped by the
  // config layer — this builder only places them.
  addDirs?: string[] | null;
  // Fork-local (iTerm2 mode, R12): branch `resume`'s conversation into a SECOND session
  // instead of continuing it — `claude --resume <src> --session-id <new> --fork-session`.
  // The source transcript is left untouched and keeps running wherever it already is.
  fork?: boolean;
}

// A fork with nothing to fork FROM would run as a brand-new session — the one outcome the
// button must never produce silently (the operator asked to branch a conversation, and a
// blank pane that looks like it worked is worse than an error). The route refuses this case
// before spawning; this is the invariant restated where the argv is actually built, so a
// future caller cannot reintroduce the fallback by accident.
export class ForkNotResumableError extends Error {
  constructor() {
    super("Cannot fork: the source session has no transcript to resume.");
    this.name = "ForkNotResumableError";
  }
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const guiArgs = ["--permission-mode", input.permissionMode];
  if (input.model) guiArgs.push("--model", input.model);
  if (input.attachGuiMcp) {
    guiArgs.push("--mcp-config", input.mcpConfig, "--strict-mcp-config", "--allowedTools", input.guiMcpTools);
  }
  // LAST, and one flag for the whole list: `--add-dir` is variadic (`<directories...>`), so a
  // flag placed after it would be fine but a VALUE would be swallowed. Keeping it at the end
  // means nothing can ever follow it.
  if (input.addDirs?.length) guiArgs.push("--add-dir", ...input.addDirs);

  // A fork reads the source transcript AND names the new session, so it carries both flags.
  // `--session-id` is what keeps the branch on an id this server minted: without it claude
  // picks its own, and nothing here would know which transcript the new pane is writing —
  // no resume after a restart, no `copy last reply`, no activity for the cell.
  if (input.fork) {
    if (!input.canResume || input.resume === null) throw new ForkNotResumableError();
    return ["--resume", input.resume, "--session-id", input.sessionId, "--fork-session", "--settings", input.settings, ...guiArgs];
  }

  // No initial-prompt positional: an auto-run prompt is TYPED into the input box after
  // claude is ready (see spawnClaudePty), not passed as an arg — a large prompt as a
  // tmux `new-session` command arg overflows tmux's length limit ("command too long").
  return input.canResume && input.resume !== null
    ? ["--resume", input.resume, "--settings", input.settings, ...guiArgs]
    : ["--session-id", input.sessionId, "--settings", input.settings, ...guiArgs];
}
