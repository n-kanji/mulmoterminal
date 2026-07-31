// Whether POST /api/workspace/column can be served, and what to publish (R8). Pure (no I/O)
// so every refusal is unit-tested; the caller supplies the directory check and how many
// browsers are listening — the same split decideLaunchTerminal (#831) uses.
import { isRecord } from "../../common/isRecord.js";

export interface AgentColumnRequest {
  /** The directory the column runs in, as the host resolved it. */
  cwd: string;
  /** The first turn to auto-run, or null. Held server-side (agent-prompt-queue.ts). */
  prompt: string | null;
  label: string | null;
}

export type AgentColumnDecision = { ok: true; request: AgentColumnRequest } | { ok: false; status: number; error: string };

export interface AgentColumnInput {
  body: unknown;
  /** The absolute, existing directory for the requested cwd, or null when it is neither.
   *  A silent fallback to the default workspace is wrong here: the caller named a project,
   *  and opening a column somewhere else is worse than refusing. */
  resolveDir: (cwd: string) => string | null;
  /** Browsers subscribed to the column channel. The grid is browser state, so with none
   *  listening nothing can open the cell and the caller must be told, not left waiting. */
  listenerCount: number;
}

/** Same shape as decideLaunchTerminal's refusal, and for the same reason: "no browser is
 *  open" is not an error the caller can fix by retrying the same request. */
export const NO_GRID_ERROR = "no MulmoTerminal browser is open — the grid opens the column, so a tab must be connected";

// A pasted plan can be long — that is why prompts are typed rather than passed as a CLI
// argument at all — but a megabyte of text is a mistake, not a first turn.
const MAX_PROMPT = 100_000;
const MAX_LABEL = 120;

function optionalText(value: unknown, max: number, field: string): { ok: true; text: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, text: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const text = value.trim();
  if (text.length > max) return { ok: false, error: `${field} is too long (max ${max} characters)` };
  return { ok: true, text: text || null };
}

export function decideAgentColumn({ body, resolveDir, listenerCount }: AgentColumnInput): AgentColumnDecision {
  const record = isRecord(body) ? body : {};
  const requested = typeof record.cwd === "string" ? record.cwd.trim() : "";
  if (!requested) return { ok: false, status: 400, error: "cwd is required (an absolute path to an existing directory)" };
  const cwd = resolveDir(requested);
  if (!cwd) return { ok: false, status: 400, error: `not an absolute path to an existing directory: ${requested}` };

  const prompt = optionalText(record.prompt, MAX_PROMPT, "prompt");
  if (!prompt.ok) return { ok: false, status: 400, error: prompt.error };
  const label = optionalText(record.label, MAX_LABEL, "label");
  if (!label.ok) return { ok: false, status: 400, error: label.error };

  // Checked last so a malformed request is told what is wrong with it rather than about the
  // browser, and asked BEFORE publishing: a fire-and-forget publish cannot report delivery,
  // so "nobody was there" would otherwise be indistinguishable from success.
  if (listenerCount < 1) return { ok: false, status: 409, error: NO_GRID_ERROR };
  return { ok: true, request: { cwd, prompt: prompt.text, label: label.text } };
}
