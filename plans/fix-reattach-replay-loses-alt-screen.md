# fix: a reattached pane could not scroll, and a paste from its own selection submitted itself

Operator report, 2026-09-08: some Claude panes show exactly one screen and cannot scroll back,
and in those panes Cmd+V of text copied from the pane itself is sent as soon as it lands
(text copied from another app pastes normally).

## Cause

Both are one bug in the reattach replay.

- The server keeps the last 1 MiB of each pty's output and replays it into a freshly reset
  xterm when a client reattaches (reload, reconnect, the #846 rebuild, un-parking).
- tmux enters the alternate screen (`CSI ? 1049 h`), application cursor keys, bracketed
  paste and mouse tracking ONCE, as the first bytes after attach (captured from tmux 3.6a in
  this fix's test). Every later redraw repaints in place.
- After a megabyte of output the tail starts inside the repaints. The replay then lands in
  the NORMAL buffer with bracketed paste OFF:
  - the wheel handler (`terminalMouseInput.ts`) only synthesises SGR wheel reports while
    `buffer.active.type === "alternate"`, so the wheel scrolls xterm's own scrollback — which
    holds nothing, because in-place repaints never push a line off screen. One screen, no
    scroll. With `tui: "fullscreen"` in `~/.claude/settings.json` Claude Code repaints the
    whole screen, so there is not even stale history to land on.
  - with bracketed paste off, xterm's paste path converts every `\n` in the clipboard to `\r`.
    A selection copied out of the pane holds a `\n` per wrapped row; text from another app
    usually holds none. So the pane's own text "submits itself" and other text does not.
- Only panes reattached after enough output show it, which is why it looked random. All 8 live
  panes were `alternate_on=1 history_size=0` on the tmux side; the difference was purely
  client-side buffer state.

## Fix

`server/session/terminal-replay.ts`: the tail is now a `ReplayTail { text, headModes }`.
Each time `appendReplayTail` drops bytes off the front, the dropped bytes (always whole
sequences — the cut is on a sequence boundary, and so was the previous head) are folded into
the set of DEC private modes that were on at the new head. A replay starts by re-asserting
those, one `CSI ? n h` per mode (never bundled: the client swallows an all-mouse-modes SET and
lets a mixed one through, #729), alternate-screen modes first.

`replayOf` (reattach) and `screenSourceOf` (phone screen render) prepend the prefix; the
spawners and the sandbox entry start from `EMPTY_REPLAY_TAIL`.

## Verified

- Unit: folding, reset cancels set, combined params, accumulation across appends, prefix order.
- Headless xterm: a tmux-attach byte stream followed by enough in-place frames to slide the
  window past the attach. Before: `buffer.active.type === "normal"`. After: `"alternate"`,
  `mouseTrackingMode === "drag"`, bracketed paste and application cursor keys on, the last
  frame on screen.
- The currently broken panes heal on the next reattach after the server restart, because a
  fresh tmux attach re-sends the modes into an empty tail.
