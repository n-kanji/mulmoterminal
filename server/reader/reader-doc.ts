// Pure helpers over one brief's HTML (plans/reader-view.md). No I/O — the routes read and
// write the file, these decide what the bytes mean and what to send back.
//
// A brief is an HTML page written by the operator's html-summary skill. What makes it one
// is the comment layer's data block:
//   <script type="application/json" id="annotations-data">{ "items": [...] }</script>
// That block is the ONLY part of the file the reader ever rewrites (the skill's own rule:
// Claude edits the body, the browser edits the block, neither touches the other's part).

/** The marker every brief carries; a page without it is not served by the reader. */
export const ANNOTATIONS_BLOCK_RE = /(<script[^>]*\bid="annotations-data"[^>]*>)([\s\S]*?)(<\/script>)/;

export const isBrief = (html: string): boolean => ANNOTATIONS_BLOCK_RE.test(html);

/** The page title, or the file name when the page has none. */
export function docTitle(html: string, fallback: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = m?.[1] ?? "";
  const text = raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

/** The skill appends this to a comment once Claude has acted on it. */
const APPLIED_MARK = "反映済み";

export interface CommentCounts {
  comments: number;
  open: number;
}

/** Count the comments in a brief's data block, and how many Claude has not applied yet.
 *  A block that fails to parse counts as no comments — the reader must still list the doc
 *  (the operator wants to find it), and the skill has its own recovery for a broken block. */
export function countComments(html: string): CommentCounts {
  const m = ANNOTATIONS_BLOCK_RE.exec(html);
  if (!m) return { comments: 0, open: 0 };
  let items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(m[2] || "{}");
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) {
      items = (parsed as { items: unknown[] }).items;
    }
  } catch {
    return { comments: 0, open: 0 };
  }
  let open = 0;
  for (const item of items) {
    const comment = item && typeof item === "object" ? (item as { comment?: unknown }).comment : undefined;
    if (typeof comment !== "string" || !comment.includes(APPLIED_MARK)) open += 1;
  }
  return { comments: items.length, open };
}

/** Pull the data block's JSON text out of a page (what the bridge's saved HTML carries). */
export function extractAnnotationsJson(html: string): string | null {
  const m = ANNOTATIONS_BLOCK_RE.exec(html);
  return m ? m[2] : null;
}

/** Replace ONLY the data block's content. The replacement is a function, never a `$n`
 *  string — a comment containing "$1" would otherwise be expanded into the tag (the skill's
 *  documented trap). Null when the page has no block to replace. */
export function replaceAnnotationsJson(html: string, json: string): string | null {
  if (!ANNOTATIONS_BLOCK_RE.test(html)) return null;
  return html.replace(ANNOTATIONS_BLOCK_RE, (_m, open: string, _body: string, close: string) => `${open}${json}${close}`);
}

/** What a saved block must look like before it is written: an object with an `items`
 *  array. Anything else is refused — a blank body would silently erase every comment. */
export function validAnnotationsJson(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    return !!parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items);
  } catch {
    return false;
  }
}

// The bridge the server injects into a brief it serves inside the reader. It runs BEFORE
// the comment layer (injected at the top of <body>), and makes three of the layer's browser
// calls land in the reader instead:
//
//   - Save. The layer saves through the File System Access API when the browser has it
//     (a Finder drag the first time, per page), and otherwise DOWNLOADS the updated page.
//     Removing `showOpenFilePicker` sends it down the download path, and the bridge catches
//     that download (the blob it creates, the anchor it clicks) and posts the HTML to the
//     reader, which writes the block back through PUT /api/reader/annotations. No dialog,
//     no drag, and every brief ever written works unchanged — the download fallback has
//     been in the layer since the start.
//   - Copy. "Copy for Claude" writes the clipboard; the bridge also posts the text so the
//     reader can offer "send to pane" with it.
//   - The unsaved guard. The layer's beforeunload handler fires on any navigation while its
//     own `unsaved` flag is set, and a download does not clear that flag — so after the
//     reader has written the file, the bridge lets the reload through.
//
// Kept as plain ES5-ish script text so it runs inside any brief regardless of its age.
export const READER_BRIDGE_SCRIPT = `<script id="reader-bridge">
(function () {
  if (window.parent === window) return;
  try { delete Window.prototype.showOpenFilePicker; } catch (e) {}
  try { delete window.showOpenFilePicker; } catch (e) {}
  var clean = false;
  var lastBlob = null;
  var createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (blob) { lastBlob = blob; return createObjectURL.call(URL, blob); };
  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && lastBlob) {
      var blob = lastBlob; lastBlob = null;
      blob.text().then(function (html) { window.parent.postMessage({ type: 'reader:save', html: html }, '*'); });
      return;
    }
    return anchorClick.call(this);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function (text) {
      window.parent.postMessage({ type: 'reader:copy', text: String(text) }, '*');
      return writeText(text).catch(function () {});
    };
  }
  var addEventListener = window.addEventListener.bind(window);
  window.addEventListener = function (type, listener, options) {
    if (type !== 'beforeunload' || typeof listener !== 'function') return addEventListener(type, listener, options);
    return addEventListener(type, function (e) { if (!clean) listener.call(window, e); }, options);
  };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'reader:saved') return;
    clean = true;
    try { localStorage.removeItem('annotations:' + location.pathname); } catch (err) {}
    var label = document.getElementById('ann-save-label');
    if (label) label.textContent = '保存しました';
  });
  window.parent.postMessage({ type: 'reader:ready' }, '*');
})();
</script>`;

/** Inject the bridge at the top of <body> (after the tag, whatever attributes a browser
 *  save may have put on it), else before the first <script>, else at the very start. */
export function injectReaderBridge(html: string): string {
  const body = /<body[^>]*>/i.exec(html);
  if (body) {
    const at = body.index + body[0].length;
    return `${html.slice(0, at)}\n${READER_BRIDGE_SCRIPT}\n${html.slice(at)}`;
  }
  const script = html.search(/<script[\s>]/i);
  if (script >= 0) return `${html.slice(0, script)}${READER_BRIDGE_SCRIPT}\n${html.slice(script)}`;
  return `${READER_BRIDGE_SCRIPT}\n${html}`;
}

/** Sibling assets a brief may reference relatively (a screenshot, a stylesheet). Anything
 *  else under the roots is not served — the reader is not a file server. */
const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

export const assetContentType = (ext: string): string | null => ASSET_TYPES[ext.toLowerCase()] ?? null;
