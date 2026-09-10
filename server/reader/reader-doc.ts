// Pure helpers over one brief's HTML (plans/reader-view.md). No I/O — the routes read and
// write the file, these decide what the bytes mean and what to send back.
//
// A brief is an HTML page written by the operator's html-summary skill. What makes it one
// is the comment layer's data block:
//   <script type="application/json" id="annotations-data">{ "items": [...] }</script>
// That block is the ONLY part of the file the reader ever rewrites (the skill's own rule:
// Claude edits the body, the browser edits the block, neither touches the other's part).

/** The data block's opening tag, as the skill writes it (attribute order and all). Found
 *  by plain string search rather than a regex over the tag: a freer pattern backtracks
 *  super-linearly on a large page, and every brief on disk uses this exact form. */
export const ANNOTATIONS_OPEN_TAG = '<script type="application/json" id="annotations-data">';
const SCRIPT_CLOSE = "</script>";

export interface AnnotationsBlock {
  /** Offsets of the JSON body inside the page: [bodyStart, bodyEnd). */
  bodyStart: number;
  bodyEnd: number;
}

/** Locate the data block, or null when the page has none (then it is not a brief). */
export function findAnnotationsBlock(html: string): AnnotationsBlock | null {
  const open = html.indexOf(ANNOTATIONS_OPEN_TAG);
  if (open < 0) return null;
  const bodyStart = open + ANNOTATIONS_OPEN_TAG.length;
  const first = html.indexOf(SCRIPT_CLOSE, bodyStart);
  if (first < 0) return null;
  // The block the reader writes escapes "</" (scriptSafeJson), but one the comment layer
  // wrote through its own download path may carry a raw "</script>" inside a comment. The
  // body ends at the FIRST close tag after which the text parses as JSON; a close tag inside
  // a string leaves a truncated, unparsable prefix. A body that never parses (a broken
  // block) ends at the first close tag, as before.
  for (let end = first; end >= 0; end = html.indexOf(SCRIPT_CLOSE, end + SCRIPT_CLOSE.length)) {
    if (parsesAsJson(html.slice(bodyStart, end))) return { bodyStart, bodyEnd: end };
  }
  return { bodyStart, bodyEnd: first };
}

function parsesAsJson(text: string): boolean {
  if (!text.trim()) return true; // an empty block is a (comment-less) brief, not a broken one
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export const isBrief = (html: string): boolean => findAnnotationsBlock(html) !== null;

/** Drop any markup inside the title text; a linear scan, not a regex (lint's backtracking rule). */
function stripTags(s: string): string {
  let out = "";
  let inTag = false;
  for (const ch of s) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** The page title, or the file name when the page has none. */
export function docTitle(html: string, fallback: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  const openEnd = open < 0 ? -1 : lower.indexOf(">", open);
  const close = openEnd < 0 ? -1 : lower.indexOf("</title>", openEnd);
  const raw = close < 0 ? "" : stripTags(html.slice(openEnd + 1, close));
  const text = raw
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
  const body = extractAnnotationsJson(html);
  if (body === null) return { comments: 0, open: 0 };
  let items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(body || "{}");
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
  const block = findAnnotationsBlock(html);
  return block ? html.slice(block.bodyStart, block.bodyEnd) : null;
}

/** Replace ONLY the data block's content — by slicing, never String.replace with a `$n`
 *  pattern: a comment containing "$1" would be expanded into the tag (the skill's
 *  documented trap). Null when the page has no block to replace. */
export function replaceAnnotationsJson(html: string, json: string): string | null {
  const block = findAnnotationsBlock(html);
  if (!block) return null;
  return `${html.slice(0, block.bodyStart)}${scriptSafeJson(json)}${html.slice(block.bodyEnd)}`;
}

/** JSON that cannot end the <script> it sits in. A comment saying "</script>" would
 *  otherwise close the data block early — the rest of the comment lands in the page as
 *  markup, and findAnnotationsBlock reads a truncated block next time. `\u003c` is the JSON
 *  escape for "<", so the parsed value is unchanged; `<!--` is escaped too, since it
 *  opens the script-data escape state that changes how a later "</script>" is read. */
export function scriptSafeJson(json: string): string {
  return json.replace(/<\//g, "\\u003c/").replace(/<!--/g, "\\u003c!--");
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
//     reader has written the file, the bridge lets the reload through. The reader then
//     reloads the page (the layer restarts clean from the file it just wrote), and the
//     bridge puts the scroll position back.
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
  var SCROLL_KEY = 'reader:scroll:' + location.pathname;
  var DOC_PREFIX = '/api/reader/doc';
  var ownPath = null;
  try { ownPath = decodeURIComponent(location.pathname.slice(DOC_PREFIX.length)); } catch (e) {}
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'reader:saved') return;
    // Addressed: the reader may have moved on to another brief while the save was in
    // flight, and an ack for that one must not clear THIS page's draft and unload guard.
    if (typeof d.path === 'string' && ownPath !== null && d.path !== ownPath) return;
    clean = true;
    try { localStorage.removeItem('annotations:' + location.pathname); } catch (err) {}
    try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch (err) {}
    var label = document.getElementById('ann-save-label');
    if (label) label.textContent = '保存しました';
    var badge = document.getElementById('ann-save-badge');
    if (badge) badge.style.display = 'none';
  });
  window.addEventListener('load', function () {
    var y = null;
    try { y = sessionStorage.getItem(SCROLL_KEY); sessionStorage.removeItem(SCROLL_KEY); } catch (err) {}
    if (y !== null) window.scrollTo(0, Number(y));
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
