// Who a POST /api/broadcast reaches, and who it deliberately does not (R8). Pure (no I/O):
// the caller reads the live PTY table and the activity flags, this decides.
//
// Two exclusions, and they are not the same kind of thing:
//
//   - NOT A CLAUDE SESSION (a shell launcher, a codex cell). Never a candidate. The text is
//     an instruction to an agent; pasted into a shell it is a command line, and pressing
//     Enter on it runs whatever it happens to spell.
//   - WORKING. A candidate that is refused THIS time and said so, because typing into a
//     session mid-turn lands in the middle of a prompt someone is composing (or interleaves
//     with the turn's own output) and corrupts it. The caller learns which sessions it
//     missed and can send again when they settle.
import path from "node:path";
import type { SessionAgent } from "../../common/sessionAgent.js";
import type { BroadcastSkip } from "../../common/agentApi.js";
import { isRecord } from "../../common/isRecord.js";

export interface BroadcastCandidate {
  id: string;
  cwd: string;
  agent: SessionAgent;
  /** The session's `working` flag. `undefined` means no hook has reported on it yet — which
   *  is NOT idle: a session spawned with a first turn runs it before any hook fires. Treated
   *  as busy, so an unknown state never gets typed into. */
  working: boolean | undefined;
}

export interface BroadcastPlan {
  targets: string[];
  skipped: BroadcastSkip[];
}

/** Directory equality for the ?cwd filter: both sides normalised (trailing slash, `.` and
 *  `..` segments), never touched on disk. A path that does not resolve to any session's
 *  directory simply matches nothing. */
export const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

export function planBroadcast(candidates: readonly BroadcastCandidate[], cwd: string | null): BroadcastPlan {
  const plan: BroadcastPlan = { targets: [], skipped: [] };
  for (const candidate of candidates) {
    if (candidate.agent !== "claude") continue;
    if (cwd && !sameDir(candidate.cwd, cwd)) continue;
    if (candidate.working !== false) plan.skipped.push({ id: candidate.id, reason: "working" });
    else plan.targets.push(candidate.id);
  }
  return plan;
}

export type BroadcastDecision = { ok: true; text: string; cwd: string | null } | { ok: false; status: number; error: string };

// A cap on one broadcast's text. The same paste goes to every session at once, so a runaway
// body multiplies; a real instruction is nowhere near this.
const MAX_TEXT = 10_000;

export function decideBroadcast(body: unknown): BroadcastDecision {
  const record = isRecord(body) ? body : {};
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return { ok: false, status: 400, error: "text is required (non-empty string)" };
  if (text.length > MAX_TEXT) return { ok: false, status: 400, error: `text is too long (max ${MAX_TEXT} characters)` };
  if (record.cwd === undefined || record.cwd === null) return { ok: true, text, cwd: null };
  // Rejected rather than ignored: a relative filter would quietly match no session, and the
  // caller would read `sent: 0` as "the fleet is busy" instead of "I sent a bad path".
  if (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd)) return { ok: false, status: 400, error: "cwd must be an absolute path" };
  return { ok: true, text, cwd: record.cwd };
}
