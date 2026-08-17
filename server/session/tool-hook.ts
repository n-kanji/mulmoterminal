// What a tool hook means, separated from the recorders and the pty table it currently
// reaches for.
//
// Three decisions live here, and each has its own way of going quietly wrong:
//   - which events OPEN a history entry and which CLOSE one
//   - which payload field carries the output, since the CLI has used two names
//   - whether this event should trigger the directory-config live reload
//
// The last one is deliberately narrower than it looks: only a SUCCESSFUL write signals a
// reload. Letting the failure event through makes every rejected write to
// .mulmoterminal.json tell every watching client to re-read a file that did not change.

export interface ToolHookPayload {
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  tool_response?: unknown;
  duration_ms?: number;
}

export interface ToolCallStart {
  toolUseId?: string;
  toolName?: string;
  toolInput: unknown;
}

export interface ToolCallEnd extends ToolCallStart {
  toolOutput: unknown;
  durationMs?: number;
  status: "completed" | "failed";
}

export type ToolHookRecord = { phase: "start"; call: ToolCallStart } | { phase: "end"; call: ToolCallEnd } | null;

// A failed tool fires PostToolUseFailure, NOT PostToolUse — both close the entry, and the
// difference between them is the whole reason the tools pane can show a failure at all.
// Collapse them and a user debugging a stuck agent reads a history in which nothing failed.
export function toolHookRecord(event: string, payload: ToolHookPayload): ToolHookRecord {
  const call = { toolUseId: payload.tool_use_id, toolName: payload.tool_name, toolInput: payload.tool_input };
  if (event === "PreToolUse") return { phase: "start", call };
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return null;
  return {
    phase: "end",
    call: {
      ...call,
      // The CLI has used both names; whichever is present is the output. Lose this and tool
      // outputs render blank for whichever version uses the other one.
      toolOutput: payload.tool_output ?? payload.tool_response,
      durationMs: payload.duration_ms,
      status: event === "PostToolUseFailure" ? "failed" : "completed",
    },
  };
}

// Only a successful write is a live-reload signal.
export function publishesDirConfig(event: string): boolean {
  return event === "PostToolUse";
}

// R14: the strip's LIVE task — claudecode-notify's trick, ported. A TodoWrite call carries
// the agent's whole task list in its input; the in_progress entry's activeForm ("Running
// tests") is a human-written line of what is happening RIGHT NOW, refreshed every time the
// agent touches its list — no LLM, no turn-end wait, which is why the iTerm2-era status pane
// felt live and the AI summary here felt stale. `content` (and `subject`, its newer name)
// back it up for a payload written without an activeForm.
function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function todoInProgressLabel(toolName: unknown, toolInput: unknown): string | null {
  if (toolName !== "TodoWrite" || !isRecordValue(toolInput) || !Array.isArray(toolInput.todos)) return null;
  for (const todo of toolInput.todos) {
    if (!isRecordValue(todo) || todo.status !== "in_progress") continue;
    for (const key of ["activeForm", "content", "subject"]) {
      const text = todo[key];
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return null;
}
