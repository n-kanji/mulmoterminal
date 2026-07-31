// A pane's MISSION: why this column exists, in the operator's own words.
//
// It is not the AI summary and must not be derived from one. The summary answers "what is it
// doing right now", which changes every turn and is exactly what goes stale in a wall of thirty
// panes; the mission answers "why am I looking at this at all", which does not change for hours.
// Losing that line is what makes a parallel grid drift — you keep the tabs and forget the point.
//
// Written over HTTP rather than through a hook, so the agent running IN the pane can set its own
// with one curl and nothing has to be wired into the hook payload:
//
//   curl -X PUT http://127.0.0.1:34567/api/session/$CLAUDE_CODE_SESSION_ID/mission \
//        -H 'content-type: application/json' -d '{"mission":"..."}'
//
// `$CLAUDE_CODE_SESSION_ID` is the agent's own id, which is all it knows — the route translates
// it to this pane's id (session-alias.ts), so the line still lands after a /clear. A blank or
// omitted mission clears it; there is no second endpoint for that.
//
// Persisted, because the reason a pane exists must outlive a server restart the way the pane
// itself does (tmux keeps the session; this keeps the label on it).
import { promises as fs } from "node:fs";
import path from "node:path";
import { MULMOTERMINAL_HOME } from "../config/env.js";
import { isRecord } from "../../common/isRecord.js";
import { messageOf } from "../errors.js";

/** One stored mission. `updatedAt` is what pruning sorts and ages by. */
export interface MissionRecord {
  mission: string;
  updatedAt: number;
}

// One status-strip line, in a column that may be a fifth of a 4K screen wide. Anything past
// this is not read, and storing it would only let a caller grow the file without limit.
export const MISSION_MAX_LENGTH = 160;
// A mission whose session no longer exists is kept for a while on purpose: a reaped pane is
// routinely resumed by id, and dropping the line the moment the PTY dies would silently lose it
// on every reload. Beyond this it is landfill.
export const MISSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// A hard ceiling regardless of age, so a machine that opens many short-lived panes cannot grow
// the file without bound. Newest kept.
export const MISSION_MAX_ENTRIES = 500;

/** Normalise a caller's value: collapse whitespace, clip, and treat blank as "clear it". */
export function normalizeMission(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, MISSION_MAX_LENGTH) : null;
}

/** Parse the persisted file, dropping anything malformed rather than trusting the shape. */
export function parseMissions(raw: unknown, isValidId: (id: string) => boolean): Array<{ id: string } & MissionRecord> {
  if (!isRecord(raw)) return [];
  const out: Array<{ id: string } & MissionRecord> = [];
  for (const [id, v] of Object.entries(raw)) {
    if (!isValidId(id) || !isRecord(v)) continue;
    const mission = normalizeMission(v.mission);
    if (!mission) continue;
    out.push({ id, mission, updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0 });
  }
  return out;
}

/** Which entries survive a save: everything for a session that is still live, plus recent
 *  entries for sessions that are not, newest first and capped. Pure so the "does a reaped
 *  session lose its mission" rule is testable without a filesystem. */
export function pruneMissions(
  entries: Iterable<readonly [string, MissionRecord]>,
  opts: { isLive: (id: string) => boolean; now: number; maxAgeMs?: number; maxEntries?: number },
): Record<string, MissionRecord> {
  const maxAgeMs = opts.maxAgeMs ?? MISSION_MAX_AGE_MS;
  const maxEntries = opts.maxEntries ?? MISSION_MAX_ENTRIES;
  const kept = [...entries]
    .filter(([id, rec]) => opts.isLive(id) || opts.now - rec.updatedAt <= maxAgeMs)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, maxEntries);
  return Object.fromEntries(kept);
}

const MISSIONS_FILE = path.join(MULMOTERMINAL_HOME, "missions.json");

// id -> mission. Read by publishActivity and /api/session/:id, written by the PUT route.
export const missions = new Map<string, MissionRecord>();

export const missionOf = (id: string): string | null => missions.get(id)?.mission ?? null;

/** Best-effort hydration at boot, mirroring registry.ts's activity/dev-terminal pattern.
 *  Readers await it so a request served during boot cannot answer "no mission" for one
 *  that is on disk. */
export const missionsHydrated: Promise<void> = (async () => {
  try {
    const parsed = parseMissions(JSON.parse(await fs.readFile(MISSIONS_FILE, "utf8")), () => true);
    for (const { id, mission, updatedAt } of parsed) if (!missions.has(id)) missions.set(id, { mission, updatedAt });
  } catch {
    // no file yet / unreadable => nothing to restore
  }
})();

// Serialised into one chain like the other persisted tables here: two saves racing would
// interleave a read-modify-write and lose one of them.
let missionPersist: Promise<void> = Promise.resolve();
function persistMissions(isLive: (id: string) => boolean): void {
  missionPersist = missionPersist
    .then(() => missionsHydrated)
    .then(() => fs.mkdir(MULMOTERMINAL_HOME, { recursive: true }))
    .then(async () => {
      const next = pruneMissions(missions, { isLive, now: Date.now() });
      // Prune the in-memory map to match, or a dropped entry comes straight back on the next save.
      for (const id of [...missions.keys()]) if (!(id in next)) missions.delete(id);
      await fs.writeFile(MISSIONS_FILE, JSON.stringify(next));
    })
    .catch((e) => console.error(`[missions] failed to persist: ${messageOf(e)}`));
}

/** Set (or clear, with null) a session's mission and persist. Returns what is now stored. */
export function setMission(id: string, mission: string | null, isLive: (id: string) => boolean): string | null {
  if (mission) missions.set(id, { mission, updatedAt: Date.now() });
  else missions.delete(id);
  persistMissions(isLive);
  return mission;
}
