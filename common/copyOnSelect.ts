// Fork-local (iTerm2 mode): copy a terminal selection to the system clipboard as soon as
// the drag ends, the way iTerm2's "Copy to pasteboard on selection" does. Shared because
// BOTH sides decide from it — the server sanitizes/persists the flag, the browser's
// terminal manager reads it at selection time — and a default that disagreed across the
// two would be invisible until a user's selection silently stopped copying.
//
// Defaults ON, so it is inverted against most booleans here: anything that is not an
// explicit `false` — including a missing key, which is what every existing config.json has
// — leaves it enabled. That is the point of the feature: the operator should not have to
// discover a setting to get the behaviour that removes the copy-paste pain.
export const DEFAULT_COPY_ON_SELECT = true;

export function sanitizeCopyOnSelect(input: unknown): boolean {
  return input !== false;
}
