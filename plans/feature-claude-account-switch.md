# Claude account switcher in the toolbar

Ported from the operator's ClaudeBar menu app: the toolbar shows which claude.ai account
Claude Code is logged into, and one click swaps to another account — the escape hatch when
a usage limit hits on one subscription.

## Where the login actually lives

Claude Code keeps its OAuth tokens in one macOS Keychain entry (`Claude Code-credentials`)
and mirrors the account profile into the `oauthAccount` block of `~/.claude.json` (which is
what `/status` and the UI render). Whether Claude Code would eventually re-derive that block
from the token is unverified (`profileFetchedAt` hints it refetches periodically) — we swap
it together with the credentials defensively; harmless either way. Switching accounts is
therefore: swap that Keychain value and that JSON block, atomically enough for a
single-operator machine.

## Design: snapshot swap, not logout/login every time

ClaudeBar's button runs `claude /logout && claude` in a Terminal — a fresh OAuth login per
switch. Here the server can do better: it snapshots the *pair* (keychain value +
`oauthAccount`) per account, so after each account has logged in once, switching is instant
and offline.

- **Snapshots live in the Keychain**, one MT-owned entry per account
  (`MulmoTerminal-claude-account:<email>`). A refresh token in a 0600 file would be a
  security downgrade from the Keychain it was copied out of. Only an email index goes to
  disk (`~/.mulmoterminal/claude-accounts.json`).
- **All keychain IO via `/usr/bin/security`** — the Apple-signed CLI reads without the ACL
  prompt that direct API access from an unsigned/node process triggers (ClaudeBar's own
  technique, verified non-interactive from the launchd server context).
- **Switch order**: read target snapshot first (missing target = 404, zero side effects) →
  snapshot the outgoing account (its live tokens are the only copy, freshest right now) →
  overwrite the live entry → rewrite `oauthAccount` only (read-modify-write; the rest of
  `claude.json` is untouched, and a parse failure aborts rather than clobbers).
- **Registering the second account** = the ClaudeBar flow minus the typing: "Log in with
  another account" snapshots the current login, clears the live slots, and the next pane's
  `claude` starts the OAuth login. The cleared account is one switch away.

## What a switch does NOT do

Running panes hold their token in-process until its next refresh; only NEW panes pick up
the swapped credentials. The UI says "applies to new panes only" instead of pretending
otherwise. A stale snapshot (revoked refresh token) is also not a failure mode to code
around: the next `claude` just asks to log in again.

## Pieces

- `server/backends/claude-account.ts` — pure helpers + injected `ClaudeAccountIo` seam
  (tests never touch the real Keychain) + `GET /api/claude-account`,
  `POST /api/claude-account/switch`, `POST /api/claude-account/logout` (posts
  origin-guarded like the other local-action routes).
- `src/composables/useClaudeAccount.ts` — fetch on mount / dropdown open / after actions.
- `src/components/ClaudeAccountControl.vue` — chip (account icon + email local part) +
  dropdown, modeled on the update badge popover; sits left of the notification bell and
  takes over its `ml-auto`.
- `test/server/backends/claude-account.spec.ts` — helper + route tests over in-memory IO.

macOS-only by nature (Keychain); on other platforms the routes would 500 on POST and the
chip just shows whatever `~/.claude.json` says — acceptable for this fork's single-Mac use.
