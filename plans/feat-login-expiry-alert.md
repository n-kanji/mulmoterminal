# Login-expiry alert — hear about a lapsing Claude Code login while at the Mac

Operator request 2026-10-21. Status: implemented (`common/loginHealth.ts`,
`server/backends/claude-login-health.ts`, `server/infra/slack-notify.ts`,
`src/composables/useLoginHealth.ts`, chip in `ClaudeAccountControl.vue`).

## The problem

At 22:06 on 2026-10-21 every pane on the default login printed
`Remote Control disconnected — OAuth token unavailable — run /login`. The launcher pane went
with them, so the phone could not open anything either. The fix is a browser `/login`, which
needs a person at the Mac — and the operator was not.

What was learned that evening (see memory `oauth-unavailable-all-panes-recovery`):

- Every pane on one login reads one Keychain entry. One `/login` in one pane restores all of
  them; running panes pick it up without their own `/login` (verified on the launcher).
  Remote Control per pane re-attaches on its own or with `/remote-control`.
- The credential has two lives: the access token (8 h, refreshed by the CLI unattended) and
  the refresh token, whose `refreshTokenExpiresAt` is ~30 days after the browser login and —
  as observed on the board@ store, in daily use since 09-28 with its expiry still 10-28 —
  does NOT move with those refreshes. So a `/login` every ~30 days is unavoidable.
- The 10-21 lapse came a week BEFORE that recorded expiry. Cause unknown. The 09-28 one was a
  refresh token held in two Keychain entries (one refresh invalidates the other's copy).

## What this does

Hourly (and at startup, and on the chip's "re-check"), the server reads the default slot and
each per-account store's Keychain entry — never the whole Keychain — and classifies each:
`ok` / `expiring` (within `loginAlert.warnDays`, default 5) / `dead` (entry present, refresh
token empty: what the CLI writes after a refused refresh, or expiry in the past) / `none`
(no entry — a normal state, never alerted) / `unreadable`. It also fingerprints each refresh
token and reports entries sharing one, the 09-28 precursor.

Surfaces, one wording per condition (`describeSlot`):

- **Toolbar**: a chip before the account chip, amber for expiring, red for dead, saying who
  and how many days; the dropdown lists every login with its expiry and which pane to `/login`
  in (default slot: a pane on an unassigned page; a store: a pane on a page assigned to it).
- **Slack**: when `loginAlert.slack = { channel, tokenFile }` is set, one post per slot per
  state per day, dedup persisted in `~/.mulmoterminal/login-health-notified.json` so a
  kickstart does not re-post. Recovery (dead/expiring → ok) posts once. The bot token is read
  from the named env-style file at post time, never from config.json (which is served).

`GET /api/claude-account/health` serves the cached report; `POST` (same origin) scans now.

## Not done / open

- Whether a running pane's Remote Control bridge re-attaches by itself after a `/login`
  elsewhere is unverified (it did come back for the launcher, mechanism unknown).
- The early (day-23) lapse of 10-21 is unexplained. The duplicate-token report is the first
  instrument for it: if the next lapse is preceded by a `duplicates` entry in the hourly log,
  that is the cause.
- A per-pane `/login` cannot be driven from the phone. Giving the launcher its own store would
  keep the phone entry point alive but not the panes it opens — declined for now.

## 2026-10-24 — the token's owner is checked, not just its expiry

The 09-28 incident repeated on 10-23: the chip said "board@ expires 10/28, /login in a
board@ pane", the operator did, with the browser's claude.ai session on kanji@ — and
kanji@'s token was stored under board@'s name. Every "board@" pane then spent kanji@'s
quota, the Fable limit hit, and "move the running panes to board@" could not help because
they were already there. The health report said `ok` for 20 hours: it reads expiry and a
fingerprint, neither of which says WHOSE token it is.

Now each alive slot with a live access token is asked `GET /api/oauth/profile` who it belongs
to (`profileHolderLookup`, wired in `server/index.ts`; the scan itself defaults to not asking,
so specs stay offline). The answer lands in `slot.holder`; one that differs from the slot's
account makes the state `mismatch`, red on the chip, ranked above `dead`, and its line says
to switch the BROWSER to the right account before the `/login`. Answers are cached per
refresh-token fingerprint, so this is one request per login per rotation, not one per hour.
A lapsed access token is never refreshed by MT (that would rotate it under the pane's feet);
such a slot is simply not asked.
