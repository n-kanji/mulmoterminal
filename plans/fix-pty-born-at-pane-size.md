# Fix: a pane's PTY is born at the pane's size (2026-09-28)

## Symptom

Every pane opened on overlapping fragments of Claude Code's banner ("Claude Code v2.1.2 /
82Channels (experimental) mes / Fable 5.1 withphigh effort") after a reload, a server restart
or a park/unpark, and cleaned itself up a little later, on the program's next full repaint.
The operator read it as "the pane layout is broken"; the layout was fine.

## Cause

`spawnPty` opened every PTY at a fixed 120x30. The browser only told the server the pane's real
size in a `resize` frame after the socket opened. Two things happen in that gap:

- a fresh spawn: the program starts and may paint at 120 columns;
- a tmux reattach (server restart, unpark): the tmux client attaches at 120x30, and with
  `window-size latest` tmux widens the surviving window to it, so the program repaints for
  120 columns.

Then the resize frame arrives and the terminal is crushed to the pane's real width (26 to 28
columns on the operator's 12-column page). Lines painted at 120 wrap; Claude Code's renderer
cannot erase wrapped lines it did not draw at that width, so the ghosts stay until a full repaint.
The narrower the pane, the bigger the shrink and the worse the ghosts.

## Change

- Client (`src/components/wsUrl.ts`, `useTerminalConnections.ts`): every terminal socket URL
  (`/ws`, `/ws/codex`, `/ws/launch`, `/ws/run`) carries `?cols=&rows=`, measured with
  `fitAddon.proposeDimensions()` at connect time. Measured rather than read off `term`, because
  the callers connect before their fit. Omitted when the host is not laid out yet.
- Server (`server/session/ws-frames.ts` `termSizeFromParams`): parsed with the same bounds as a
  resize frame (2..500 x 1..200). Threaded to `spawnPty` through every spawner (claude, codex,
  launcher, run command, sandbox) so the PTY is created at that size. On a live reattach the PTY
  is resized to it before the replay (`presized` in `ws-routes.ts`).
- Absent or malformed: the old default, the old behaviour.

## Not changed

The 120x30 default stays for hidden workers and old clients. The equal-split grid is untouched:
12 columns on a 2560px window are still 26 characters each, which is a separate conversation.

## Verify

`tmux -L mulmoterminal list-clients -F '#{client_width}x#{client_height}'` right after a
reload: the new client appears at the pane's size, never at 120x30 first.
