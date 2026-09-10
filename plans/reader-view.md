# Reader view — a single inbox for the HTML briefs Claude writes for the operator

Status: shipped on the kanji branch, 2026-09-10 (operator request, transcribed from a voice
note). Fork-local: MulmoClaude has no counterpart.

## The problem

The operator runs 15-24 panes and reads none of the terminal output in full. Anything meant
to be read goes out as an annotated HTML page (the `html-summary` skill: title, body,
highlight-and-comment layer, "copy for Claude" button), served one page per throwaway
`~/bin/viewhtml` Python server on a random 127.0.0.1 port, opened in its own Chrome tab.

Measured on this machine: 192 annotated pages under the roots, 137 of them in `orosy-v2`,
whose folders (marketing / research / compliance / ...) map to pane topics.

What broke at that volume:

- Tabs. Titles truncate; the operator cannot tell which tab is which, what is unread, or
  which pane is waiting on a comment.
- Grouping. One pane produces two or three pages per topic; nothing groups them.
- Saving comments needed the File System Access API: drag the file from Finder the first
  time, per page.
- No way back. "Copy for Claude" ends in the clipboard; the operator then finds the pane.

Constraint from the operator: the terminal grid and the reading surface must both stay
visible. A view that replaces the grid (like the Files view) defeats the purpose.

## What shipped

A `/reader` route in MulmoTerminal, opened in **its own browser tab** (the toolbar's
`inbox` button targets a named window, so a second press focuses the tab instead of
adding one). Left, the index; right, the brief in an iframe with its own comment layer
working unchanged.

### Index — `server/reader/reader-registry.ts`

- A **registry**, not a scan on every listing: a cold walk of the roots' ~1,200 HTML
  files measured 30s. The registry (`~/.mulmoterminal/reader.json`) owns two facts per
  path — "this is a brief" and "opened at". Everything else (title, comment counts, mtime)
  is read from the file on every listing, cached by mtime, so it never goes stale.
- `viewhtml` registers a brief the moment Claude writes it. **Rescan** (a button) walks
  the roots for the ones written before or moved by hand; the seed on 2026-09-10 found 192
  in 6s warm.
- Roots: `~/Projects` and `~/Obsidian`, whichever exist. Not the Google Drive folder under
  `~/Library/CloudStorage`: touching a file-provider location makes macOS prompt "node wants
  to access data from other apps" at the launchd server, once per probe, and the prompts
  stacked into one that would not dismiss (2026-09-10). A configurable root list is the
  way to add it back, behind an explicit opt-in.
  Grouping is root → project (first segment) → folder (the rest of the directory).
- State is derived: unread (never opened here) / read / commented (comments without the
  skill's `反映済み` marker) / done (all applied). Filters and a title search on top.

### Page — `server/reader/reader-routes.ts`, `reader-doc.ts`

- `GET /api/reader/doc/<absolute path>` serves the brief from its real location, so
  relative screenshots resolve; only a page with the `annotations-data` block is served,
  and only image/style/font siblings in a registered brief's folder (or below it).
- The page is loaded from the **other loopback host name** (app on 127.0.0.1 → page on
  localhost, and vice versa). Its comment layer keeps a draft in localStorage, which an
  opaque-origin sandbox has none of, so the frame is `allow-same-origin` — on an origin
  that is not the app's. The response CSP keeps `connect-src 'none'` and `form-action
  'none'`; the page's one way out is postMessage to the reader. The app answers on
  BOTH loopback names, so the hostname alone is not a boundary: the sandbox also denies
  popups and nested frames, or the page could open the app as a same-origin document
  free of this CSP (found in review). A listener on its own port would make the origin
  claim real; that is the next step if the boundary ever needs to be more than flags.
- A **bridge** is injected at the top of `<body>` on every serve (files are never
  modified): it removes `showOpenFilePicker`, which sends the layer's save down its
  download fallback, catches that download (the blob and the anchor click) and posts the
  HTML to the reader; the reader PUTs the block to `/api/reader/annotations`, which
  rewrites only that block, atomically. One click, no Finder drag, and every brief on
  disk (all 192 carry the download fallback) works without re-injection. After a save
  the reader remounts the frame and the bridge restores the scroll position.
- "Copy for Claude" also reaches the reader (the bridge wraps `clipboard.writeText`), which
  opens **Send to pane**: the live sessions whose cwd owns the folder, nearest first, typed
  through the same sender as `/api/broadcast` and refused while the session is mid-turn.

### `viewhtml`

- If MulmoTerminal answers: `POST /api/reader/open`. 200 = an open reader tab took it
  (pub/sub, one subscriber). 409 = registered but no tab; open `/reader?doc=` once.
- Otherwise (server down, path outside the roots, not a brief): the old per-file server.

## Rejected

- Chrome tab groups / bookmarks: no state, no grouping by folder, no way back to a pane.
- Reuse the Files view: rooted per terminal, replaces the grid, an editor not a reader.
- Claude Code Artifacts gallery: a list with comments that wake a session, but the pages
  leave the machine, each pane must publish, and there is no project grouping.
- Obsidian: does not run the comment layer's script.
- Scanning as the source of truth (the first draft of this plan): 30s cold on this disk.
- Re-injecting the 192 existing pages with a new layer: unnecessary once the bridge is
  applied at serve time; the files stay exactly as Claude wrote them.
- An opaque-origin iframe (like presentHtml's): the layer's localStorage access throws
  before it renders anything.

## Known gaps

- Per-pane badges in the grid ("N briefs waiting under this cwd") are not built; the
  index's per-project counts stand in for now.
- A `target=_blank` link inside a brief does nothing (no popups). Route such links through
  the bridge as a message if briefs ever need them.
- The comment layer's `beforeunload` guard still fires when switching briefs with an
  unsaved comment — by design (it is the layer's), but it is a browser dialog.
- Off loopback (a LAN host name) there is no "other" host name, so the page shares the
  app's origin; the CSP still fences it, but this is not the intended deployment.
