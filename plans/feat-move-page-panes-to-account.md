# Move a page's RUNNING panes onto its account (operator request 2026-09-28)

Page 1's chip said `board@` while eight of its panes still ran on `kanji@` — they were
launched before the page was assigned, and the per-page account model
(`feature-per-page-claude-account.md`) deliberately never touches a running pane: a cell's
stamp is fixed at launch, and `cellConnectAccount` sends the stamp (or nothing) forever after.
So there was no way to say "everything on this page, on this subscription, now" short of the
global switch — which moves the whole fleet, every page.

## What this adds

One menu item in the chip's per-page section: **このページの起動済みペインも <account> に移す**.
It does, in order:

1. **Client** re-stamps every claude cell on the active page whose stamp differs from the
   page's account (`restampPagePanes`, gridTabs.ts). A page that follows the default login
   clears the stamps instead. Cells already on the account are left alone — no restart.
2. **Client** POSTs `/api/claude-account/restart-panes` with `{ sessions: [...] }` — the ids
   of the cells it just re-stamped.
3. **Server** runs the existing fleet restart (`restartClaudePanes`) filtered to those ids:
   socket detached, pty reaped, plain close, so the client reconnects as it would after a
   server restart. The reconnect carries the NEW stamp as `?account=`, which wins over the
   server's memory of the session (`effectiveAccount`: requested first) — and reap has deleted
   that memory anyway. `accountEnvForSpawn` then points the cold `claude --resume` at the
   account's own credential store.

Nothing about the ownership rules changes: no credential is copied, the store is seeded only
if absent (it already exists for board@), and the default slot is untouched.

## Why the stamp is rewritten BEFORE the restart

The socket close that triggers the reconnect arrives asynchronously after the POST. Stamping
first is what makes the order irrelevant: whenever the reconnect fires, it reads the new account.

## Caught by testing it live (2026-09-28)

The first cut re-stamped the cell and restarted the pane — and the pane came back on the OLD
login. The reconnect URL is not built from the component's props: `useTerminalConnections`
keeps a `target` per slot, captured at `attach` and replaced only by `retarget` (which also
reconnects, on a `connectKey` change). A prop change alone never reached it, so the reconnect
carried the stamp the pane had launched with. `updateTarget` (manager) + a `watch` on
`props.account` (`Terminal.vue`) hand the new stamp to the slot without reconnecting; the spec
in `useTerminalConnections.spec.ts` drives the close and checks the second socket's URL.

The same live run also found that the DEFAULT login (kanji@) had been logged out since about
2026-09-24 (the Keychain slot held empty tokens), so seven of the eight panes running on it
were sitting on "Not logged in". Not caused by this change — but it is what the operator was
actually seeing when they said page 1 "runs on kanji".

## What the operator's usage meter then revealed (2026-09-28, after the move)

board@'s Claude Code usage stayed at 0% while kanji@'s climbed. Asking the Anthropic profile
endpoint with the token in the board@ STORE answered `kanji@spaceengine.io`: the
`MulmoTerminal-claude-account:board@orosy.co.jp` snapshot (saved 2026-09-15) was kanji@'s
login filed under board@'s name — the exact hazard the ownership rule above describes, and
the store had been seeded from it. So every "board@" pane, this one included, had been
spending kanji@'s subscription, and the SAME refresh token living in two Keychain entries is
why the default slot died on 09-24: the store's copy rotated it.

Repair, done by the operator by hand because the auto-mode classifier refused the pane
restarts and Keychain deletes (`~/fix-accounts*.sh`, three rounds):
1. default slot <- the live kanji@ token; identity re-checked via the profile endpoint;
   the duplicate store entry, the mislabeled board@ snapshot and the expired kanji@ snapshot
   deleted (backups kept as `MulmoTerminal-backup-20260928:*`); fleet restart.
2. `/login` as board@ in one page-1 pane — the first genuine board@ login on this machine.
3. That login rewrote the shared `~/.claude.json` to board@, MulmoTerminal's record of the
   default slot followed it, and two kanji-stamped panes were spawned onto an EMPTY kanji
   store (login wizard). Record set back to kanji@ by editing
   `~/.mulmoterminal/claude-accounts.json` directly — `POST /api/claude-account/default`
   accepts an email only while the two sources disagree, and only records it, so the
   ambiguity banner stays until a default-slot pane rewrites `~/.claude.json` again.
   Empty store dropped, those two panes restarted with `sessions: [...]`.

Three gaps worth a follow-up, none fixed here:
- Snapshotting the live slot trusts `~/.claude.json` for the NAME. A pane on its own store
  rewrites that file on login, so a snapshot can be filed under the wrong account. The
  profile endpoint (`/api/oauth/profile` with the access token) is the only honest name.
- `declareDefault` cannot be used to correct a record that drifted while the sources agree,
  and does not clear the ambiguity it is offered for.
- Nothing shows which account a pane's token actually bills. The status strip shows the
  stamp; the operator caught this from claude.ai's usage meter.

## Deliberate override of an earlier rule

`launch-account.ts` says "a conversation has to continue on the credentials it began on".
That protected against a page default silently moving a running pane. An explicit operator
click on a menu item that names the count and the account is the opposite of silent, and the
global switch has resumed conversations across accounts since 2026-08-25 without trouble —
the transcript is a local file, `--resume` does not care who is logged in.

## Verification

- Vitest: `restartClaudePanes` with `only`; the route parsing `sessions`; `restampPagePanes`.
- Live: a throwaway `?ws=` workspace, one pane on the default login, page pointed at
  board@, click the item, check the new claude process's env carries
  `CLAUDE_SECURESTORAGE_CONFIG_DIR=…/board@orosy.co.jp-…` and the pane resumed.
