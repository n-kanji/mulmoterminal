// Pure decision for the `view` frame a terminal reports to the server (see the WS
// protocol in server/index.ts). Split out from Terminal.vue so the rules are unit-
// testable independent of the xterm/keep-alive machinery.

// A command (Run) or launcher terminal has no Claude/Codex attention hooks, so it
// never reports a view state — the server has nothing to gate on it.
export function terminalManagesAttention(command: boolean, launcher: boolean): boolean {
  return !command && !launcher;
}

// Whether this terminal is the user's actively-viewed pane while shown: a grid
// dev-terminal cell counts while zoomed OR while it holds keyboard focus; the single
// view counts whenever it's on screen.
//
// Focus counts (R14): the operator reads and replies in the TILED grid — expanding is
// the exception, not the reading flow — so "unread" cleared only on zoom meant every
// read pane stayed 完了・未読 forever. Clicking into a tile is the read signal that
// actually happens. An unfocused, unzoomed cell still surfaces blocked/done (#321).
export function terminalViewActive(devTerminal: boolean, expanded: boolean, focused = false): boolean {
  return devTerminal ? expanded || focused : true;
}
