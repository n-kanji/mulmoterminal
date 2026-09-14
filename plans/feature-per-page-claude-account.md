# Per-page Claude account (operator request 2026-09-14)

The header chip swaps ONE global login (Keychain slot `Claude Code-credentials`), so every
pane in the workspace answers as the same claude.ai account. The operator runs two
subscriptions and wants page 1 on one account and page 2 on the other, at the same time.

## What makes it possible

Claude Code 2.1.270 derives its Keychain service name from the credential store directory:

```js
function iH(n=""){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  t=e!==void 0?!e:!process.env.CLAUDE_CONFIG_DIR,
  r=e!==void 0?e.normalize("NFC"):configHome(),
  c=t?"":`-${sha256(r).slice(0,8)}`;
  return `Claude Code${OAUTH_FILE_SUFFIX}${n}${c}`}
```

So `CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir>` gives that PROCESS its own credential entry —
two accounts logged in at once — while `~/.claude` (settings, skills, CLAUDE.md, history)
stays shared. `CLAUDE_CONFIG_DIR` would split those too, which is why it is not used here.

Measured 2026-09-14: `CLAUDE_SECURESTORAGE_CONFIG_DIR=/tmp/probe claude -p 'say ok'` →
`Not logged in · Please run /login`, while the same shell without it is logged in.

## Model

- A page may name an account (`PageMeta.account`). Absent = the global default, i.e. exactly
  today's behaviour.
- A cell stamps the account it LAUNCHED with (`Cell.account`) and keeps it for life: the
  account is fixed at process start, so changing a page default never rewrites a running
  pane, and moving a pane between pages does not re-login it.
- The chip shows the page's account (or the default), and picking one sets THIS page.
  A pane whose stamp differs from its page shows its own account in the status strip, so the
  chip can never quietly describe a pane it does not own.

## Not duplicating a rotating refresh token

Refresh tokens rotate: the same credential in two Keychain entries means the first refresh
invalidates the other copy. So:

- A page set to the account that is CURRENTLY live in the default slot spawns with no env at
  all — it uses the default slot rather than a copy of it.
- A per-account entry is seeded (from MT's own snapshot, or from the live slot) only when it
  is ABSENT. An existing per-account entry is never overwritten — it owns its own rotation.
- With no snapshot to seed from, the pane starts and says `Not logged in · Please run /login`;
  one login in that pane fills its entry permanently.

## Shape

- `server/backends/claude-account-store.ts` — dir + service derivation, seeding, `accountEnv`.
- `server/session/pty-spawn.ts` / `infra/tmux.ts` — an env OVERLAY at spawn. It must be
  process env, not the settings `env` block: the CLI resolves the store before settings and
  says so ("set it in the shell, not a settings file").
- `?account=<email>` on `/ws`, remembered per session id like the launch choice.
- Grid: `PageMeta.account`, `Cell.account`, chip + status strip.

## Verified against the real CLI (2026-09-14)

- **Isolation**: `CLAUDE_SECURESTORAGE_CONFIG_DIR=/tmp/probe claude -p 'say ok'` → `Not logged in`,
  while the same shell without it is logged in.
- **The service name is ours**: seeding `Claude Code-credentials-<sha256(dir)[0:8]>` by hand
  turned that same command's answer into `OAuth session expired and could not be refreshed` —
  only the entry the CLI actually reads can do that. (Both probe entries removed afterwards;
  the CLI had also written an entry at the computed name on its own.)
- **In the app** (a throwaway `?ws=` workspace): assigning a page moves the chip and persists;
  a new column then connects as `…/ws?cwd=/tmp&gui=0&account=board%40orosy.co.jp`, and the cell
  is stamped with what it launched on.
- **Not yet run live**: a pane actually starting on the SECOND account. That seeds its store
  from MT's snapshot and, because that snapshot's access token has expired, the first start
  will refresh — rotating the token and leaving the snapshot the global switcher would restore
  stale. Worth one `/login` if it ever bites, but it is the operator's account, so it waits for
  them rather than being spent on a test.

## Caught by testing it live

The first cut bound the cell's account to its STAMP only, and a launching cell has no stamp —
the stamp is written from the server's answer, one round trip too late. Every pane launched on
the default login while its page said otherwise, invisibly, because the stamp written a moment
later said the right thing. `cellConnectAccount` is that rule, with a test.
