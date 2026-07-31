import { describe, it, expect } from "vitest";
import { buildClaudeArgs, ForkNotResumableError, type ClaudeArgsInput } from "../../../server/agents/claude-args.js";

const base: ClaudeArgsInput = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  resume: null,
  canResume: false,
  settings: "{hooks}",
  permissionMode: "auto",
  attachGuiMcp: true,
  mcpConfig: "{gui-mcp}",
  guiMcpTools: "mcp__gui__a,mcp__gui__b",
};

const cfg = (over: Partial<ClaudeArgsInput> = {}): ClaudeArgsInput => ({ ...base, ...over });

describe("buildClaudeArgs", () => {
  it("single view (attachGuiMcp): attaches GUI MCP + --strict-mcp-config + --allowedTools", () => {
    const args = buildClaudeArgs(base);
    expect(args).toEqual([
      "--session-id",
      base.sessionId,
      "--settings",
      "{hooks}",
      "--permission-mode",
      "auto",
      "--mcp-config",
      "{gui-mcp}",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__gui__a,mcp__gui__b",
    ]);
  });

  it("grid dev terminal (attachGuiMcp=false): no GUI MCP, no --strict-mcp-config, no --allowedTools", () => {
    const args = buildClaudeArgs({ ...base, attachGuiMcp: false });
    expect(args).toEqual(["--session-id", base.sessionId, "--settings", "{hooks}", "--permission-mode", "auto"]);
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--allowedTools");
  });

  it("resumes with --resume when canResume, keeping the chosen MCP mode", () => {
    const resume = "22222222-2222-2222-2222-222222222222";
    const args = buildClaudeArgs({ ...base, attachGuiMcp: false, resume, canResume: true });
    expect(args.slice(0, 4)).toEqual(["--resume", resume, "--settings", "{hooks}"]);
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("falls back to --session-id when canResume is false even if a resume id is present", () => {
    const args = buildClaudeArgs({ ...base, resume: "33333333-3333-3333-3333-333333333333", canResume: false });
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  // Regression: an auto-run prompt must NOT be a `-- <prompt>` positional. A large seed
  // prompt (e.g. a 20KB collection-action prompt) as a tmux `new-session` command arg
  // overflows tmux's length limit ("command too long", killing the session); it's typed
  // into the input box after spawn instead. So the argv must never carry a bare `--`.
  it("never emits a `--` positional (auto-run text is typed in, not passed as an arg)", () => {
    expect(buildClaudeArgs(base)).not.toContain("--");
    expect(buildClaudeArgs({ ...base, canResume: true, resume: "44444444-4444-4444-4444-444444444444" })).not.toContain("--");
  });
});

// #579: a directory can pin its sessions to a model — an alias or a third-party backend's
// own name. `--model` is the one lever that outranks both the settings `model` key and
// ANTHROPIC_MODEL, so the choice has to land here.
describe("model selection", () => {
  it("passes the chosen model through", () => {
    expect(buildClaudeArgs(cfg({ model: "z-ai/glm-5.2" }))).toContain("--model");
    expect(buildClaudeArgs(cfg({ model: "z-ai/glm-5.2" }))).toContain("z-ai/glm-5.2");
  });

  it("omits the flag entirely when no model is chosen", () => {
    expect(buildClaudeArgs(base)).not.toContain("--model");
    expect(buildClaudeArgs(cfg({ model: null }))).not.toContain("--model");
  });

  it("still passes it on a resumed session", () => {
    const args = buildClaudeArgs(cfg({ model: "opus", resume: "abc", canResume: true }));
    expect(args).toContain("--resume");
    expect(args).toContain("--model");
  });
});

// R12 (fork-local, iTerm2 mode): the Fork button's argv. A fork is a `--resume` that lands in
// a NEW session, and the new id has to be ours: without `--session-id` claude mints its own,
// and nothing on this side would know which transcript the branch is writing — no resume after
// a restart, no "copy last reply", no activity for the cell.
describe("fork (--resume + --fork-session)", () => {
  const source = "55555555-5555-5555-5555-555555555555";

  it("resumes the source into this session's own id", () => {
    const args = buildClaudeArgs(cfg({ attachGuiMcp: false, resume: source, canResume: true, fork: true }));
    expect(args).toEqual(["--resume", source, "--session-id", base.sessionId, "--fork-session", "--settings", "{hooks}", "--permission-mode", "auto"]);
  });

  it("keeps the MCP mode and the model, like any other spawn", () => {
    const args = buildClaudeArgs(cfg({ resume: source, canResume: true, fork: true, model: "opus" }));
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
  });

  // The no-silent-fallback rule. A fork with nothing to resume would otherwise come up as a
  // blank new session that LOOKS like the fork worked — the failure mode the button must never
  // have. The route refuses it first; this is the same invariant where the argv is built.
  it("refuses to build when there is nothing to resume, instead of starting fresh", () => {
    expect(() => buildClaudeArgs(cfg({ resume: source, canResume: false, fork: true }))).toThrow(ForkNotResumableError);
    expect(() => buildClaudeArgs(cfg({ resume: null, canResume: true, fork: true }))).toThrow(ForkNotResumableError);
  });

  it("leaves a plain resume untouched", () => {
    const args = buildClaudeArgs(cfg({ resume: source, canResume: true }));
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("--session-id");
  });
});
