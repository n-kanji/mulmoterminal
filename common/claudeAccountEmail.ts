// The one reading of a claude.ai account address (the per-page account, 2026-09-14). BOTH
// sides decide from it — the grid persists it into its state and puts it on the /ws query,
// the server turns it into a Keychain lookup and a store directory — so it lives here rather
// than as two validators that agree until one of them is edited.
//
// Deliberately loose: the real check is whether a credential store exists for it. This only
// has to rule out what must never reach a path or a Keychain query — separators, whitespace,
// the absurdly long — and normalize case so two spellings are never two accounts.

// Split into two linear passes rather than one regex with a nested quantifier: a `(?:\.x+)+`
// domain reads fine and backtracks badly on hostile input.
const SHAPE_RE = /^[^\s@/\\]+@[^\s@/\\]+$/;
const MAX_EMAIL = 254;

export function claudeAccountEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL || !SHAPE_RE.test(email)) return undefined;
  const domain = email.slice(email.indexOf("@") + 1);
  // A domain needs a dot, and neither end of it may be one ("a@.com", "a@com.").
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".") ? email : undefined;
}
