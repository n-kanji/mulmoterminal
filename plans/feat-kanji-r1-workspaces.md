# Workspaces: named + pinned pages, and one grid per window (kanji fork, R1)

The operator runs two iTerm2 + tmux workspaces — nine columns of one project, six of another,
about thirty panes — and switches between them by window, not by number. MulmoTerminal's pages
could not stand in for that: they are numbered `1 2 3`, they are one flat list under the hood so
closing a column drags the next page's terminal back over the boundary, and every browser window
reads the same `grid_v2`, so a second window is a second view of one workspace rather than a
second workspace. This is the gap R1 names (`plans/kanji-it2-parity/05-requirements.md`).

## What a page can now be

- **Named.** Double-click a tab, type, Enter. Escape abandons it, an empty name goes back to the
  number. Capped at `MAX_PAGE_LABEL` so eight tabs still fit one row.
- **Pinned.** Right-click a tab. A pinned page shows a `keep` icon and is *sealed*: closing one of
  its columns does not pull a terminal in from the next page, and its own columns never drain
  back into an earlier one. New columns (`+ Terminal`, a preset chip, an adjacent split) go to
  the page being looked at, not to the end of the grid.
- **Per window.** Opening `?ws=<name>` gives that window its own saved grid, `grid_v2:<name>`.
  Same server, same live sessions — only which columns this window remembers is separate. A
  window with no `?ws` keeps reading `grid_v2` exactly as before.

Nothing above adds a toolbar row. Design principle 2 (`05-requirements.md` §2) makes readable
lines per column the top metric, so both gestures are folded into the tab buttons that were
already there, with the tooltip carrying the two gestures so they are not folklore.

## How pinning is implemented, and why this way

The grid stays **one flat array sliced at `PAGE_SIZE`**. That is the whole design decision.
Every page number in `gridTabs.ts` is `Math.floor(index / PAGE_SIZE)` — including the three the
zoom invariants (#829) depend on: `order` is the un-paged list, `page` is derived from an index
in it on zoom release, and `nextAttention` derives the page it brings on screen the same way.
Variable-length pages would make each of those a different question and would also make page
*identity* unstable (an elastic run shrinking by one cell renumbers every page after it, so a
page named "orosy" would slide).

So a sealed page keeps its width by holding **reserved slots** — `hole` cells — where its closed
terminals were. Closing a column on a pinned page removes the cell and puts a hole at that page's
end; adding one consumes the first hole. The page's slot count never changes, so no boundary ever
moves, and the arithmetic above is untouched.

Reserving is transitive backwards: page *p*'s boundary is only fixed if everything before it is,
so **every page up to the last pinned one is padded to `PAGE_SIZE`**. Pages after it are elastic
and reflow across each other as they always have. With nothing pinned there are no holes at all
and the grid is byte-for-byte the pre-workspace one — which is what makes this backward
compatible rather than merely tolerant of old state.

A hole is page structure, not a terminal. It is dropped at render (`renderCells`), so the
surviving columns still widen to fill the page — only the boundary is held still, not the layout.
It is excluded from the status tally, the attention rotation, the zoom, the roster and the drag
targets, and it sorts behind even a launch cell.

## Auto sort inside a pinned workspace

Auto mode attention-sorts the **whole** grid and then pages it, which is how a blocked cell on
page 3 floats onto page 1 — the reason the mode exists in this fork. That float carries terminals
across exactly the boundary a pin exists to hold. So `orderGrid` keeps the across-all-pages sort
while no page is pinned, and sorts **within each page** once one is. Both are attention-first;
they differ only in how far a cell may travel to get there.

## Reordering, and the two answers that must agree

A column is reordered two ways — dragging its header, and the roster's up/down items — and they
have to give the same answer, or a button renders enabled and then silently does nothing. Both
now go through one rule (`canMoveCell(cells, uid, dir, sealed)`), decided by GridView against the
**un-filtered** cell list, which is the list the move actually mutates. The roster renders the
filtered one, so asking it would have been wrong in exactly the case this feature is for.

While anything is pinned, both refuse a swap across a page boundary. A pinned page that happens
to be *full* has no reserved slot to stop it, so the rule cannot be left to fall out of the hole
check; it has to be stated.

## Persistence and compatibility

- `pages` (`{ label?, pinned? }`, index-aligned, sparse and optional) and the reserved slots are
  both persisted. Dropping the slots would silently un-pin every workspace on reload.
- `parseGridState` runs `reserveSlots` over what it read, so a blob whose slots and pins disagree
  (hand-edited, half-written, or written by an older build) comes back consistent instead of
  being trusted or rejected.
- Malformed page metadata degrades to a plain page. A grid full of live sessions must never be
  lost over a tab name.
- The uid renumbering rule in `parseGridState` is unchanged: persisted uids are still untrusted
  and still renumbered from position, holes included.
- The pre-#883 `grid_state_v1` migration is offered only to a window with no `?ws` — a named
  workspace starts empty on purpose.
- `MAX_TERMINALS` bounds *terminals*, not array entries, and the parse keeps that meaning: it is
  checked through `runningCount` everywhere else, which has never counted an empty slot. Applying
  it to a padded array would trim the tail, and the tail is live sessions. A separate `MAX_SLOTS`
  bounds the blob's length.

## Not covered here

- The tab row still appears only with more than one page, so the first page cannot be named or
  pinned until a second exists. Adding chrome for the single-page case was not worth it.
- A pinned page is capped at `MAX_CELLS` (8) columns like any other, so the operator's nine-column
  workspace-1 does not fit on one page yet. That is a `gridLayout` question, not a paging one.
- Reordering a column into a *different* workspace is refused rather than supported; a drag only
  ever happens within the page on screen.
