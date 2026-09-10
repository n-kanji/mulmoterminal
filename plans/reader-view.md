# Reader view — a single inbox for the HTML briefs Claude writes for the operator

Status: proposal (2026-09-10). Not started. Operator request, transcribed from a voice note.

## The problem

The operator runs 15-24 panes and reads none of the terminal output in full. Anything meant
to be read goes out as an annotated HTML page (the `html-summary` skill: title, body,
highlight-and-comment layer, "copy for Claude" button), served one page per throwaway
`~/bin/viewhtml` Python server on a random 127.0.0.1 port, opened in its own Chrome tab.

Measured on this machine, last 60 days: 111 annotated pages. 100+ live under
`~/Projects/orosy-v2/{marketing,research,compliance,swf,ads,analytics,...}`; the rest under
`tier2-design`, `famco`, `大阪玩具`.

What breaks at that volume:

- Tabs. Titles truncate; the operator cannot tell which tab is which, what is unread, or
  which pane is waiting on a comment.
- Grouping. One pane produces two or three pages per topic; nothing groups them, and
  nothing says which one is current.
- Saving comments needs the File System Access API: drag the file from Finder the first
  time, per page. It works, but it is friction on every new page.
- No way back. "Copy for Claude" ends in the clipboard; the operator then has to find the
  right pane and paste.

Constraint from the operator: the terminal grid and the reading surface must both be
visible. A view that replaces the grid (like the Files view) defeats the purpose.

## Recommendation

Add a `/reader` route to MulmoTerminal, opened in **its own browser tab** (never inside the
grid). MulmoTerminal is already the always-on local server, already knows every pane's cwd,
and already has a sandboxed HTML preview route (`server/backends/html.ts`), so it is the
natural host; `viewhtml` becomes a thin client that hands the path to it.

Layout: left, an index of pages; right, the page itself in an iframe with the existing
comment layer working unchanged.

### Index (left)

- Source of truth: the files on disk, not a registry. A page is "a brief" iff it contains
  `<script type="application/json" id="annotations-data">`. Scan the allowlisted roots
  (`~/Projects`, `~/Obsidian/iCloud Vault`, the Google Drive project folder) on demand and
  cache by mtime. `viewhtml` additionally POSTs the path so a new page appears instantly.
- Grouping: two levels, project then folder (`orosy-v2 / marketing`). One level is not
  enough: orosy-v2 alone is 100 of 111 pages, and its folders map 1:1 to pane topics.
- Order: newest first within a group; groups by most recent page.
- State per page, derived, no manual bookkeeping:
  - unread: never opened in the reader
  - read: opened
  - commented: `annotations-data` has entries with no `反映済み` marker
  - done: every comment carries `_(反映済み ...)_`, which the skill already writes
- Filters: unread / commented, plus a text search over titles.

### Page (right)

- Served by a new route from the file's real path, path-contained to the allowlisted roots,
  with the existing preview CSP (`sandbox allow-scripts`, `connect-src 'none'`). The page
  stays an opaque origin; it cannot reach `/api/*`.
- Saving comments: a **postMessage bridge**, not the File System Access API. The comment
  layer posts `{type:"annotations", json}` to the parent; the reader (app origin) PUTs it
  to `/api/reader/annotations?path=...`, which rewrites only the `annotations-data` block
  (the skill's existing rule: never touch anything else). One-click save, no Finder drag,
  and the layer keeps its FS-API path for `file://` and `viewhtml` fallback.
- "Send to pane" replaces "copy for Claude": the reader knows which pane's cwd owns the
  folder; the existing send-text path types the comment digest into that pane. Copy stays
  as the fallback when no pane matches.
- Per-pane badge in the grid header: count of unread/commented pages under that pane's cwd.
  This answers "which pane is waiting on me" from the grid itself.

### `viewhtml`

- If MulmoTerminal is up on its port: POST the path to `/api/reader/register`, open
  `/reader?doc=<path>` (reusing the reader tab if one is open), exit. No Python server.
- Otherwise: current behaviour, untouched.

## Rejected

- Chrome tab groups / bookmarks: no state, no grouping by folder, no way back to a pane.
- Reuse the Files view: rooted per terminal, replaces the grid, CodeMirror is an editor
  not a reader.
- Claude Code Artifacts gallery: has a list and comments that wake a session, but pages
  leave the machine, each pane must publish, and there is no project grouping.
- Obsidian: does not render arbitrary HTML with scripts; the comment layer would not run.
- A registry file written by the skill: drifts the moment a page is moved or renamed;
  scanning for the marker is deterministic and costs nothing at this volume.

## Scope and risks

- Fork-only feature (kanji branch); upstream does not have `html-summary`. Keep it in
  `server/reader/` + `src/views/Reader*.vue` so it does not touch upstream files.
- Path allowlist is the security boundary: the route must refuse anything outside the roots,
  and only ever rewrite the `annotations-data` block on save.
- The comment layer edit (postMessage branch) applies to new pages only; existing pages
  need the skill's re-injection procedure or fall back to FS-API save inside the iframe,
  which the sandbox blocks. Decide: re-inject the 111 existing pages once (script exists
  in the skill), or accept read-only for old pages.
- Do not auto-open the reader from a pane; opening a tab is the operator's action.
