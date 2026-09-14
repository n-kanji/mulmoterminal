// `?account=<email>` on /ws: which claude.ai account this pane runs as (the per-page
// account, 2026-09-14). Validated here rather than trusted — the value becomes a directory
// name and a Keychain lookup, and an unparseable one must fall back to the default login
// rather than invent a store nobody can log into.
//
// Unlike the provider/model pick next door, this IS honored on a resume: a pane's account is
// a property of the PANE (its page named it), and the credentials a conversation continues on
// have to be the ones it was started on. The remembered value covers a reconnect that arrives
// without the param at all.
import { launchAccounts } from "./registry.js";
import { claudeAccountEmail } from "../../common/claudeAccountEmail.js";

export function accountFromParams(params: URLSearchParams): string | null {
  const raw = params.get("account");
  if (raw === null) return null;
  const email = claudeAccountEmail(raw);
  if (!email && raw.trim()) console.warn(`[ws] ignoring unusable account ${JSON.stringify(raw)} — starting on the default login`);
  return email ?? null;
}

// The account a spawn runs as: what this connection asked for, else what this session was
// started as when the server still remembers it.
export function effectiveAccount(sessionId: string, requested: string | null, remembered: ReadonlyMap<string, string> = launchAccounts): string | null {
  return requested ?? remembered.get(sessionId) ?? null;
}
