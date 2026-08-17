// @vitest-environment node
import { describe, it, expect } from "vitest";

import { publishesDirConfig, todoInProgressLabel, toolHookRecord } from "../../../server/session/tool-hook.js";

const payload = { tool_use_id: "t1", tool_name: "Edit", tool_input: { file: "a.ts" }, duration_ms: 42 };

describe("toolHookRecord", () => {
  it("opens an entry on PreToolUse", () => {
    expect(toolHookRecord("PreToolUse", payload)).toEqual({ phase: "start", call: { toolUseId: "t1", toolName: "Edit", toolInput: { file: "a.ts" } } });
  });

  it("closes it as completed on PostToolUse", () => {
    const record = toolHookRecord("PostToolUse", { ...payload, tool_output: "done" });
    expect(record).toMatchObject({ phase: "end", call: { status: "completed", toolOutput: "done", durationMs: 42 } });
  });

  // The distinction the tools pane exists to show. Collapse the two Post events and a user
  // debugging a stuck agent reads a history in which nothing failed.
  it("closes it as failed on PostToolUseFailure", () => {
    expect(toolHookRecord("PostToolUseFailure", payload)).toMatchObject({ phase: "end", call: { status: "failed" } });
  });

  // The CLI has used both field names; whichever is present is the output.
  it("takes the output from tool_output", () => {
    expect(toolHookRecord("PostToolUse", { ...payload, tool_output: "A", tool_response: "B" })).toMatchObject({ call: { toolOutput: "A" } });
  });

  it("falls back to tool_response", () => {
    expect(toolHookRecord("PostToolUse", { ...payload, tool_response: "B" })).toMatchObject({ call: { toolOutput: "B" } });
  });

  // An empty string is a real output — `??` must let it through where `||` would not.
  it("keeps an empty output rather than reaching for the other field", () => {
    expect(toolHookRecord("PostToolUse", { ...payload, tool_output: "", tool_response: "B" })).toMatchObject({ call: { toolOutput: "" } });
  });

  it.each([["Stop"], ["UserPromptSubmit"], ["Notification"], ["SessionStart"], [""], ["posttooluse"]])("ignores %j", (event) => {
    expect(toolHookRecord(event, payload)).toBeNull();
  });

  it("carries a partial payload through rather than dropping the entry", () => {
    expect(toolHookRecord("PreToolUse", {})).toEqual({ phase: "start", call: { toolUseId: undefined, toolName: undefined, toolInput: undefined } });
  });
});

describe("publishesDirConfig", () => {
  it("reloads the directory config after a successful write", () => {
    expect(publishesDirConfig("PostToolUse")).toBe(true);
  });

  // Deliberately NOT the failure event: a rejected write to .mulmoterminal.json would make
  // every watching client re-read a file that did not change.
  it("does not reload after a failed one", () => {
    expect(publishesDirConfig("PostToolUseFailure")).toBe(false);
  });

  it.each([["PreToolUse"], ["Stop"], ["SessionStart"]])("does not reload on %s", (event) => {
    expect(publishesDirConfig(event)).toBe(false);
  });
});

describe("todoInProgressLabel", () => {
  const todos = (list: unknown[]) => ({ todos: list });

  it("mirrors the in_progress todo's activeForm — the live line the strip shows mid-turn", () => {
    expect(
      todoInProgressLabel(
        "TodoWrite",
        todos([
          { content: "Fix the bug", status: "completed", activeForm: "Fixing the bug" },
          { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
          { content: "Ship it", status: "pending", activeForm: "Shipping" },
        ]),
      ),
    ).toBe("Running the tests");
  });

  it("falls back to content, then subject, when activeForm is absent or blank", () => {
    expect(todoInProgressLabel("TodoWrite", todos([{ content: "Run tests", status: "in_progress", activeForm: "  " }]))).toBe("Run tests");
    expect(todoInProgressLabel("TodoWrite", todos([{ subject: "Run tests", status: "in_progress" }]))).toBe("Run tests");
  });

  it("is null for another tool, a malformed payload, or a list with nothing in progress", () => {
    expect(todoInProgressLabel("Bash", todos([{ content: "x", status: "in_progress" }]))).toBeNull();
    expect(todoInProgressLabel("TodoWrite", null)).toBeNull();
    expect(todoInProgressLabel("TodoWrite", { todos: "nope" })).toBeNull();
    expect(todoInProgressLabel("TodoWrite", todos([{ content: "x", status: "pending" }]))).toBeNull();
    expect(todoInProgressLabel("TodoWrite", todos(["junk", { status: "in_progress" }]))).toBeNull();
  });
});
