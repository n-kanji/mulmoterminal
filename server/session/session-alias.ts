// Which mulmoterminal session an agent's OWN idea of its session id belongs to.
//
// A pane is spawned with `--session-id <mt id>`, so for most of its life the two agree. Then
// `/clear` or `/compact` makes Claude mint a fresh id for itself while the PTY, the grid cell
// and everything keyed off it stay on the original. Hooks already survive that: they carry
// `x-mt-session`, and resolveHookSessionId prefers it over the body's `session_id`.
//
// Nothing else did. The agent inside a pane knows only its own id (`$CLAUDE_CODE_SESSION_ID`),
// so a `PUT /api/session/$CLAUDE_CODE_SESSION_ID/mission` after a /clear would write to a key
// no pane reads — a silent no-op, the worst failure for a line whose whole job is to still be
// there hours later.
//
// So every hook that shows both ids records the pairing here, and routes an AGENT calls
// translate through it. The Fork button leans on it too (ws-routes resolveClaudeFork): the
// grid can only send the PANE's id, but after a /clear the conversation the pane SHOWS lives
// in the transcript named by the agent's newer id — forking the pane id branched a stale,
// pre-/clear conversation (operator report 2026-08-31). That is also why the map is now
// PERSISTED: a deploy restarts this server, and an idle-but-cleared pane forked right after
// would otherwise fork stale again until its next hook re-taught the pairing.
import { promises as fs } from "node:fs";
import path from "node:path";
import { MULMOTERMINAL_HOME, SESSION_ID_RE } from "../config/env.js";
import { isRecord } from "../../common/isRecord.js";
import { messageOf } from "../errors.js";

/** One pairing: the agent's own id maps to the pane (`mt`) it runs in; `at` is when the
 *  pairing was first seen, which is what "newest /clear wins" and pruning sort by. */
export interface AliasRecord {
  mt: string;
  at: number;
}

// An alias whose pane died without a reap (a crash, a server that was down when tmux went
// away) has nothing left to invalidate it; beyond this age it is landfill.
export const ALIAS_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// A hard ceiling regardless of age — one entry per /clear or /compact per pane, so a fleet
// of long-lived panes grows this slowly, but never without bound.
export const ALIAS_MAX_ENTRIES = 2000;

const aliases = new Map<string, AliasRecord>(); // the agent's current id -> its pane

/** Record what a hook revealed: `header` is the mulmoterminal id, `bodyId` the agent's own.
 *  When they AGREE the pane provably runs as its own id again — e.g. it was relaunched with a
 *  plain `--resume <pane id>` after its tmux died, which continues the pane-id transcript —
 *  so any recorded alias now points AWAY from what the pane shows and is dropped, or a fork
 *  would branch the wrong conversation in the opposite direction of the bug this store fixes. */
export function noteSessionAlias(header: unknown, bodyId: unknown): void {
  if (typeof header !== "string" || typeof bodyId !== "string") return;
  if (!header || !bodyId) return;
  if (header === bodyId) {
    if (aliases.size) forgetSessionAliases(header);
    return;
  }
  if (aliases.get(bodyId)?.mt === header) return; // every hook repeats the pair — record once
  aliases.set(bodyId, { mt: header, at: Date.now() });
  persistAliases();
}

/** The mulmoterminal session an id refers to. An id nothing has aliased is returned as-is,
 *  which is what every pane that never cleared sends. */
export const resolveAliasedSessionId = (id: string): string => aliases.get(id)?.mt ?? id;

/** The agent's CURRENT own id for a mulmoterminal session, or undefined when it never
 *  cleared (the two agree). After several /clears the newest pairing wins. This is what a
 *  reader of the agent's transcript needs: after a /clear the file named by the mulmoterminal
 *  id stops growing, and the conversation continues in the file named by this id. */
export function currentAgentSessionId(mulmoId: string): string | undefined {
  let latest: string | undefined;
  let latestAt = -1;
  // `>=` so two pairings in the same millisecond fall back to insertion order (later wins),
  // matching the pre-persistence behavior that leaned on Map insertion order alone.
  for (const [agentId, rec] of aliases) {
    if (rec.mt === mulmoId && rec.at >= latestAt) {
      latest = agentId;
      latestAt = rec.at;
    }
  }
  return latest;
}

/** Drop a torn-down session's aliases, so the map does not grow for the life of the process. */
export function forgetSessionAliases(mulmoId: string): void {
  let dropped = false;
  for (const [agentId, rec] of aliases) {
    if (rec.mt === mulmoId) {
      aliases.delete(agentId);
      dropped = true;
    }
  }
  if (dropped) persistAliases();
}

/** Parse the persisted file, dropping anything malformed rather than trusting the shape. */
export function parseAliases(raw: unknown): Array<{ agent: string } & AliasRecord> {
  if (!isRecord(raw)) return [];
  const out: Array<{ agent: string } & AliasRecord> = [];
  for (const [agent, v] of Object.entries(raw)) {
    if (!SESSION_ID_RE.test(agent) || !isRecord(v)) continue;
    if (typeof v.mt !== "string" || !SESSION_ID_RE.test(v.mt)) continue;
    out.push({ agent, mt: v.mt, at: typeof v.at === "number" ? v.at : 0 });
  }
  return out;
}

/** Which entries survive a save: recent ones, newest first and capped. Pure so the aging
 *  rule is testable without a filesystem. */
export function pruneAliases(
  entries: Iterable<readonly [string, AliasRecord]>,
  opts: { now: number; maxAgeMs?: number; maxEntries?: number },
): Record<string, AliasRecord> {
  const maxAgeMs = opts.maxAgeMs ?? ALIAS_MAX_AGE_MS;
  const maxEntries = opts.maxEntries ?? ALIAS_MAX_ENTRIES;
  const kept = [...entries]
    .filter(([, rec]) => opts.now - rec.at <= maxAgeMs)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, maxEntries);
  return Object.fromEntries(kept);
}

const ALIASES_FILE = path.join(MULMOTERMINAL_HOME, "session-aliases.json");

// Persistence is armed by the server at boot (initSessionAliasPersistence), never at module
// import: the spec exercises noteSessionAlias/forgetSessionAliases directly, and an
// import-time writer would scribble into the developer's real ~/.mulmoterminal (the same
// reason session-mission-route.spec mocks the mission store).
let persistEnabled = false;
// Serialised into one chain like the other persisted tables: two saves racing would
// interleave a read-modify-write and lose one of them.
let persistChain: Promise<void> = Promise.resolve();
function persistAliases(): void {
  if (!persistEnabled) return;
  persistChain = persistChain
    .then(() => fs.mkdir(MULMOTERMINAL_HOME, { recursive: true }))
    .then(async () => {
      const next = pruneAliases(
        [...aliases].map(([agent, rec]) => [agent, rec] as const),
        { now: Date.now() },
      );
      // Prune the in-memory map to match, or a dropped entry comes straight back on the next save.
      for (const agent of [...aliases.keys()]) if (!(agent in next)) aliases.delete(agent);
      await fs.writeFile(ALIASES_FILE, JSON.stringify(next));
    })
    .catch((e) => console.error(`[session-alias] failed to persist: ${messageOf(e)}`));
}

/** Hydrate from disk and arm persistence. Called once at server boot; a hook that lands
 *  during the file read simply wins — only ids nothing live has claimed are restored. */
export async function initSessionAliasPersistence(): Promise<void> {
  try {
    const parsed = parseAliases(JSON.parse(await fs.readFile(ALIASES_FILE, "utf8")));
    for (const { agent, mt, at } of parsed) if (!aliases.has(agent)) aliases.set(agent, { mt, at });
  } catch {
    // no file yet / unreadable => nothing to restore
  }
  persistEnabled = true;
}
