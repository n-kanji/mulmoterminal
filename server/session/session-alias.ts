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
// translate through it. Process-lifetime only: after a restart the pane's next hook re-teaches
// it, and until then the un-aliased id is returned, which is correct for every pane that never
// cleared.
const aliases = new Map<string, string>(); // the agent's current id -> the mulmoterminal id

/** Record what a hook revealed: `header` is the mulmoterminal id, `bodyId` the agent's own.
 *  A no-op when they agree (the common case) or when either is missing. */
export function noteSessionAlias(header: unknown, bodyId: unknown): void {
  if (typeof header !== "string" || typeof bodyId !== "string") return;
  if (!header || !bodyId || header === bodyId) return;
  aliases.set(bodyId, header);
}

/** The mulmoterminal session an id refers to. An id nothing has aliased is returned as-is,
 *  which is what every pane that never cleared sends. */
export const resolveAliasedSessionId = (id: string): string => aliases.get(id) ?? id;

/** Drop a torn-down session's aliases, so the map does not grow for the life of the process. */
export function forgetSessionAliases(mulmoId: string): void {
  for (const [agentId, mtId] of aliases) if (mtId === mulmoId) aliases.delete(agentId);
}
