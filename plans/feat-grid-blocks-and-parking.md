# Block separators and parked panes (operator requests 2026-08-26)

## Separators

A named vertical line between two columns. Model: `GridState.separators: {id, beforeUid,
label}[]` — the line belongs to the cell on its right. Rejected: keying by array position
(every insert / close / reorder would have to shift it) and a separator *cell* (it would count
toward the page's 12 slots and take a `1fr` track). Rendering: TerminalGrid lays a `14px`
track before that cell, so a line never narrows a pane. When the cell closes, the line passes
to the cell that takes its index (a boundary before a position), unless that cell already has
one. Moving is one column at a time along the on-screen order (the line's own arrows); a drag
handle is a possible follow-up. Toolbar "Add separator" puts one before the focused column.

## Parking

A pane shelved out of the grid with a "resume when X" note. Model: `GridState.parked:
{cell, note, at}[]` — the *whole cell*, uid included, leaves `cells` (the same reflow as a
close, so page arithmetic is untouched) and comes back with the same uid. Keeping the uid is
what makes restore cheap: the durable connection pool keys terminals by `cell-<uid>`, and an
unmounted cell only *detaches* (socket and PTY live on), so a restored pane re-attaches to the
connection it left with. Rejected: a `parked` flag on a cell left in `cells` (it would keep
occupying one of the page's 12 slots).

Known: after a browser reload the pool is empty, so a parked pane — like any off-page column
today — loses its PTY after the 30s grace and is resumed with `claude --resume` on restore.
The dock card shows the note, the directory badge and the pane's live attention word
(`useGridActivity` tracks parked session ids too); close from the dock is the real teardown
(`terminate` over WS and HTTP).
