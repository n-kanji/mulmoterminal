// How many lines of history each xterm keeps (fork-local, iTerm2 mode, R13).
//
// Shared because both sides decide from it: the client builds every terminal with it, and
// the server's tmux config must not hold LESS — the tmux pane is where a reattached session's
// past comes back from, so a smaller history-limit there silently caps what the browser can
// ever show. A spec pins that relationship.
//
// 10,000 is the operator's iTerm2 setting, carried over so a day's transcript is still
// scrollable at the end of it. xterm's own default is 1000, which in a 10-column grid means a
// single long turn can push the start of the task out of reach.
export const TERMINAL_SCROLLBACK_DEFAULT = 10_000;
