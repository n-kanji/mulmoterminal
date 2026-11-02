# fix: node-pty leaked one pseudo-terminal per spawn; the server hit macOS's 511 and no pane could start

Date: 2026-11-02. Operator report: switching the page's Claude account (kanji@ hit the Fable
limit) with "move the running panes too" left every moved pane at `[session ended]` or
`Failed to start Claude. Is the claude CLI installed and on your PATH?`, and new panes failed
the same way. Nothing was wrong with the account move, the CLI or PATH.

## What was actually happening

- `server.log` had `failed to start session …: posix_spawnp failed.` from **13:31**, hours
  before the account move (the first few were sporadic; the move restarted seven panes at once
  and turned it into "everything is dead"). Every line the UI rendered as a PATH problem was
  this.
- The server process held **499 `/dev/ptmx` fds** (`lsof -p <tsx pid> | grep -c ptmx`) for
  **6 live sessions**. Since the server started (10-31 21:35) it had logged **499 `[pty] spawned
  claude`**. One leaked master per spawn, none ever released. macOS allows **511** at once
  (`sysctl kern.tty.ptmx_max`), so the 500th-odd spawn failed, and so did every tmux client and
  a bare `node -e 'pty.spawn(...)'` from a shell — the whole machine was out.
- Memory 94% free, 956 processes of a 10,666 limit, 40 fds on the launcher: nothing else was
  short. The 10 conversations the dead panes showed were all on disk (`~/.claude/projects/…/<id>.jsonl`,
  last written 16:22-16:23); nothing was lost.

## Root cause: node-pty 1.1.0, `src/unix/pty.cc`, macOS branch

`pty_posix_spawn` opens a throwaway `posix_openpt` into `low_fds[]` so the real master does
not land on fd 0-2, and closes them afterwards with

```c
  for (; count > 0; count--) close(low_fds[count]);
```

`count` is the index the loop *broke* at — normally **0** — so the loop never runs, and when
it would run it closes `low_fds[count]` (one past the last opened) and never index 0. The
slave opened for `posix_spawn_file_actions_adddup2` is not closed in the parent either.
Reproduced outside the server (scratch probe: spawn `/bin/sh -c 'exit 0'`, wait for `onExit`,
`lsof` the process): **1 ptmx left per spawn**, identical on Node 25.8.1 and Node 22.22.1,
so not a Node or libuv change. The leaked fd is the throwaway, not `term.fd`; `term.destroy()`
cannot reach it from JS.

Upstream `main` and `1.2.0-beta.18` (2026-10-23) have the fix — `close(slave)` and
`for (i = 0; i <= count; i++) close(low_fds[i])`. Same probe against beta.18: **0 left**.

## The change

1. **`node-pty` 1.1.0 → 1.2.0-beta.18** (exact). The `latest` tag is still 1.1.0; the beta is
   where the fix lives. Prebuilds ship for darwin-arm64/x64, linux, win32; `postinstall`
   (`server/fix-pty-perms.js`) still finds and fixes the `spawn-helper` bit. Typings differ only
   in an optional `pixelSize` on `resize` and a Windows-only `setParentWindow?` — nothing this
   server calls changed.
2. **`spawnFailureMessage`** (`server/routes/ws-routes.ts`): the untyped failure text now carries
   node-pty's own message, and for `posix_spawnp | EAGAIN | EMFILE | ENFILE` says what it is —
   pty/process exhaustion, cleared by restarting the server, or a non-executable spawn-helper —
   instead of blaming PATH. Spec: `test/server/routes/claude-spawn-failure.spec.ts`.
3. **`server/infra/pty-fd-watch.ts`**: hourly, count the ptmx masters this process holds
   (`/dev/fd` scan + `fstat`, matched on `/dev/ptmx`'s major; no lsof) against `ptys.size`, and
   `console.warn` when the excess passes 20. Pure threshold function + a real-pty spec
   (`test/server/infra/pty-fd-watch.spec.ts`) that measures the **exit** edge, which is where the
   leak lived. This would have fired within an hour of the 10-31 restart; the incident took two
   days to surface and arrived as something else entirely.

Not changed: the account-move's burst restart. It only exposed the leak; with the leak gone the
seven simultaneous spawns are fine (the same burst at 16:42 after the fix: 5 live, 5 held).

## Recovery, for next time

- Symptom: `posix_spawnp failed` in server.log, or the PATH message in several panes at once.
- Check: `lsof -p $(pgrep -f 'node --import tsx') | grep -c /dev/ptmx` against
  `tmux -L mulmoterminal ls | grep -c '^mt-'`. A gap in the hundreds is this.
- Relief: `launchctl kickstart -k gui/501/com.kanji.mulmoterminal`. tmux sessions survive;
  panes whose tmux client had already died come back on a page reload via `--resume`.
- Verify after: held == live (`lsof` count vs `tmux ls`), and again an hour later.

## Verification done

- Probe before/after the dependency swap, with the launchd node (25.8.1): 1 leak → 0.
- New specs 8/8; `typecheck`, `typecheck:server`, `typecheck:test`, eslint clean on the touched files.
- Live: kickstart 16:42:05 → 5 tmux sessions survived, server holds exactly 5 ptmx.

## Second finding the same evening: the default login was empty, and the switch had done it

With the panes back, the operator asked whether everything now ran on board@. Seven work panes
did (process env `CLAUDE_SECURESTORAGE_CONFIG_DIR` = the board store; the store's holder
verified as board@orosy.co.jp via the profile API). But the **default Keychain slot**
(`Claude Code-credentials`, kanji@, the primary account and the one the phone launcher and the
Claude Desktop session run on) held `mcpOAuth` only — no `claudeAiOauth` at all.

Timeline from server.log and the Keychain item's own dates:

- 16:24:06 switch default → board@: the live kanji@ login was snapshotted
  (`MulmoTerminal-claude-account:kanji@…`, refresh token valid to 11-25) — this copy was good.
- 16:24:20 switch default → kanji@: `handleSwitch` prefers **the account's own store** over its
  snapshot ("the store holds the live login; the snapshot may be months old"). kanji@ had a
  per-page store, and that store had been wiped to `mcpOAuth`-only — the shape Claude Code
  leaves when a refresh token is rejected (the losing copy of a rotated pair). The switch wrote
  that into the default slot and dropped the store. The item's `mdat` is 16:24:20 and never
  moved again: nothing rotated or deleted anything afterwards; the slot was written empty.
- Result: launcher, Desktop session and the three leftover home panes all logged out; the login
  the operator actually wanted sat untouched in the snapshot.

Repair (done by hand, the same `security add-generic-password -U` the switch uses): write the
snapshot's `credentials` back into the default slot, then one `claude -p --model haiku` with no
store env — answered `ok`, token rotated, access now valid to 01:10. Default = kanji@, store =
board@, as the operator wants it (kanji@ primary, board@ shared with the engineer as the spare).

Code: `storeHoldsNoLogin()` in `backends/claude-account.ts` — a store that parses to an entry
with no usable refresh token is not preferred; the snapshot is restored instead and the empty
store is still dropped (its pages would otherwise keep reading nothing). Specs in
`claude-account.spec.ts` ("when the target's store has been wiped…"). Unparseable store
contents keep the old store-first rule, so the existing opaque-string specs still hold.

## How to switch when one subscription is full (what the operator asked for)

Default = kanji@. board@ lives in its own store. Nothing about the default slot needs to move:

1. On the page whose panes are stuck at the limit, open the account chip and pick **board@**.
2. Tick **"move the running panes too"** (restart + `--resume`). The panes come back in the
   same conversations on board@. (Verified 16:42-16:50: 7 panes, all on the board store.)
3. When kanji@'s window resets, pick kanji@ on the chip the same way — or leave the page on
   board@; new panes follow the chip.

Do not use "switch the default login" for this. It moves the one slot the launcher and the
Desktop app read, and it is where today's second failure came from.
