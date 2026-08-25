# Page size 12 + send-a-pane-to-another-page (operator request, 2026-08-25)

Two operator requests from the same conversation, shipped together because they are both
"the grid's pages, as furniture I rearrange":

1. **A page holds 12 columns, not 10.** The operator hit the 10-column overflow and asked
   for headroom to 12 before the grid spills onto a second page.
2. **A pane can be SENT to another page** — page 1 to page 2 and back — from the pane's
   own toolbar, without forking or relaunching anything.

## What changed

- `gridLayout.ts`: `MAX_CELLS` 10 → 12, `LAYOUTS` gains `"11"`/`"12"`. Everything else
  (PAGE_SIZE, MAX_TERMINALS = 8 pages, MAX_SLOTS, the `asPages` page cap) derives from it.
- `gridTabs.ts`: new pure transforms `canMoveCellToPage` / `moveCellToPage`. The grid is one
  flat array sliced into pages, so "move to page N" is a slot change: `removeAt` (leaves a
  hole on a sealed source page) + `freeSlot`/`insertAt` on the target. Rules:
  - A sealed (pinned) target only accepts into a reserved hole; full sealed pages refuse.
  - A full elastic target takes the column as its last slot; the overflow reflows on.
  - The trailing open launch cell stays the last real cell.
  - Only existing pages are targets (deliberately asymmetric with addCell's overflow).
- `gridCell.ts`: `pageTargets` prop + `move-to-page` emit join the shared cell contract, so
  all three cell kinds (Claude / launcher / command) offer the same menu.
- `CellPageMenu.vue`: the shared popover (Material Symbols `drive_file_move`, targets named
  "N枚目" or "N枚目（label）"). Auto-closes when the grid shrinks to one page.
- `GridView.vue`: `pageTargetsByUid` decides per-cell targets against the full list;
  `onMoveToPage` switches auto sort to manual first (choosing a page IS a placement
  statement, same as the header drag).

## Known consequences (accepted)

- Upgrading a saved grid with pinned pages re-slices at the new 12-wide boundary once:
  the old page 2's first columns are absorbed into pinned page 1 before re-padding. No
  sessions are lost; the operator may re-arrange once.
- In auto sort, the menu's notion of "the pane's current page" is its manual-order page;
  picking a target switches to manual, so the destination is always honored.
