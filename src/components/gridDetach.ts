// Fork-local (iTerm2 mode, operator request 2026-09-14): TEARING A PAGE OFF INTO ITS OWN
// WINDOW, and putting it back — the grid's answer to dragging a browser tab out.
//
// Pages are tabs, so two pages can never be looked at AT THE SAME TIME. The sessions are the
// server's, not the window's, so a second window on the same server can hold one of them:
// `?ws=<name>` (gridTabs) already gives a window its own saved grid. What was missing is the
// MOVE — taking a page out of this window's grid and handing it to that one, with everything
// the page carries (its name, its claude.ai account, its columns' names, widths and accounts).
//
// The one rule the server imposes: a session may have ONE socket. A second window attaching to
// a session the first still holds wins, and the first is cut with `superseded`. So a page that
// moves must LEAVE the grid it came from — a page shown in both windows is a pane that goes
// dead in one of them. Every transform here is written around that.
//
// House rules as in gridTabs.ts / gridBlocks.ts: pure `state => state`, no session is touched,
// and nothing here reads or writes storage — the caller (GridView) owns the effects, because
// only it knows whether the window actually opened.
import {
  MAX_PAGES,
  MAX_TERMINALS,
  PAGE_SIZE,
  STATE_KEY,
  clampPage,
  ensureEntry,
  isHole,
  isPagePinned,
  isStateKey,
  isWorkspaceName,
  pageCount,
  pageOfIndex,
  pageSlice,
  parseGridState,
  realCells,
  reserveSlots,
  runningCount,
  setPageAccount,
  setPageLabel,
  togglePagePin,
  type Cell,
  type GridState,
  type Separator,
} from "./gridTabs";
import { parkedOf, separatorsOf } from "./gridBlocks";
import { isRecord } from "../../common/isRecord";

// ------------------------------------------------------------------------------- the luggage

/** One page in transit between two windows. Only what a page IS: its own name and account, its
 *  running columns, and the lines drawn between them. Never `pinned` — a boundary is a
 *  statement about the page's NEIGHBOURS, and in the window it is going to it has none; the
 *  merge re-seals as it needs to. */
export interface PagePayload {
  meta: { label?: string; account?: string };
  cells: Cell[];
  separators?: { beforeUid: number; label?: string }[];
}

/** A page this window tore off, as the tab row shows it. */
export interface DetachedPage {
  ws: string;
  label: string;
  at: number;
}

/** What a window that is going home writes for its origin to pick up. */
export interface Handoff {
  ws: string;
  pages: PagePayload[];
}

// A cell only travels if it has a SESSION. That is the same line persistence already draws
// (parseGridState keeps nothing else): a launch form is nothing to move, and a Run command's
// process is unresumable, so it cannot be handed to another window at all.
const travels = (c: Cell): boolean => !isHole(c) && c.session !== null;

// A parent link is a link to a COLUMN. Kept when that column is in the same luggage, dropped
// otherwise — the same rule closeCell applies when the parent goes away, since a link to a
// pane in another window is a link to nothing.
const withLinksInside = (c: Cell, inside: ReadonlySet<number>): Cell => {
  if (c.parent === undefined || inside.has(c.parent)) return c;
  const next = { ...c };
  delete next.parent;
  return next;
};

// Lines are kept by the COLUMN they stand before, so a line whose column did not come along is
// not a line any more. Ids are minted fresh in the receiving window (they are its own counter).
const remapSeparators = (
  list: readonly { beforeUid: number; label?: string }[] | undefined,
  renumber: ReadonlyMap<number, number>,
  mintId: () => number,
): Separator[] =>
  (list ?? []).flatMap((s) => {
    const beforeUid = renumber.get(s.beforeUid);
    return beforeUid === undefined ? [] : [{ id: mintId(), beforeUid, label: s.label }];
  });

/** The page as luggage, or null when it holds nothing that can travel. */
export function pagePayload(state: GridState, page: number): PagePayload | null {
  const cells = realCells(pageSlice(state.cells, page)).filter(travels);
  if (cells.length === 0) return null;
  const uids = new Set(cells.map((c) => c.uid));
  const separators = separatorsOf(state)
    .filter((s) => uids.has(s.beforeUid))
    .map((s) => ({ beforeUid: s.beforeUid, label: s.label }));
  const meta = state.pages?.[page];
  return {
    meta: { label: meta?.label, account: meta?.account },
    cells: cells.map((c) => withLinksInside(c, uids)),
    separators: separators.length ? separators : undefined,
  };
}

/** Every page of this workspace that has something in it — what a window hands over when it
 *  goes home. A detached window is normally one page, but it may have grown. */
export const pagesPayload = (state: GridState): PagePayload[] =>
  Array.from({ length: pageCount(state.cells.length) }, (_, p) => pagePayload(state, p)).filter((p): p is PagePayload => p !== null);

/** Re-validate luggage that came through storage (another window wrote it, and the blob is
 *  hand-editable) by running it through the SAME parse a reload does: field whitelist, uid
 *  renumbering, separator and parent-link remapping, session-less cells dropped. Null when
 *  nothing survives. */
export function normalizePayload(raw: unknown): PagePayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.cells)) return null;
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const parsed = parseGridState(
    JSON.stringify({ cells: raw.cells, separators: raw.separators, pages: [meta], expanded: null, page: 0, nextUid: 0, sortMode: "manual" }),
  );
  if (!parsed) return null;
  const cells = realCells(parsed.cells).filter(travels).slice(0, PAGE_SIZE);
  if (cells.length === 0) return null;
  const uids = new Set(cells.map((c) => c.uid));
  const separators = separatorsOf(parsed)
    .filter((s) => uids.has(s.beforeUid))
    .map((s) => ({ beforeUid: s.beforeUid, label: s.label }));
  const page = parsed.pages?.[0];
  return {
    meta: { label: page?.label, account: page?.account },
    cells: cells.map((c) => withLinksInside(c, uids)),
    separators: separators.length ? separators : undefined,
  };
}

// ---------------------------------------------------------------------------------- detaching

/** Why this page cannot be torn off, in the operator's words, or null when it can. The UI shows
 *  this as the button's tooltip rather than hiding the button — a control that vanishes teaches
 *  nobody why. */
export function detachBlockedReason(state: GridState, page: number): string | null {
  if (state.origin) return "このウィンドウ自体が切り離されたページです";
  if (page < 0 || page >= pageCount(state.cells.length)) return "このページはありません";
  if (pageCount(state.cells.length) < 2) return "ページが1枚しかありません（先に新しいページを作ってください）";
  if (state.sortMode === "auto") return "自動整列中は切り離せません（表示順とページの対応がずれるため）";
  const slice = pageSlice(state.cells, page);
  // A Run command's process dies with its cell, so a page holding one cannot be handed over
  // whole — and quietly leaving it behind would be a page that is not the page the operator saw.
  if (slice.some((c) => !isHole(c) && c.command != null)) return "実行中のコマンドがあるページは切り離せません";
  if (realCells(slice).filter(travels).length === 0) return "このページには動いているペインがありません";
  return null;
}

export const canDetachPage = (state: GridState, page: number): boolean => detachBlockedReason(state, page) === null;

/** Take `page` out of this window and build the workspace that will hold it.
 *
 *  The page's ENTRY in `pages` is spliced out, not blanked: the array is index-aligned with the
 *  page number, so leaving it in place would hand this page's name and account to whichever
 *  page packs forward into the gap.
 *
 *  `uids` is what left, so the caller can retire those terminals' slots in the connection pool
 *  once the new window has taken them over. */
export function detachPage(state: GridState, page: number, origin: string): { parent: GridState; child: GridState; uids: number[] } | null {
  if (!canDetachPage(state, page)) return null;
  const payload = pagePayload(state, page);
  if (!payload) return null;
  const uids = payload.cells.map((c) => c.uid);
  const moved = new Set(state.cells.filter((_, i) => pageOfIndex(i) === page).map((c) => c.uid));
  const remaining = state.cells.filter((_, i) => pageOfIndex(i) !== page);
  const survivors = new Set(remaining.map((c) => c.uid));
  const cells = remaining.map((c) => withLinksInside(c, survivors));
  const pages = state.pages ? state.pages.filter((_, p) => p !== page) : undefined;
  const separators = separatorsOf(state).filter((s) => !moved.has(s.beforeUid));
  const parent = clampPage(
    ensureEntry(
      reserveSlots({
        ...state,
        cells,
        pages: pages?.length ? pages : undefined,
        separators: separators.length ? separators : undefined,
        // Zoom is a pointer at a column; the column is in the other window now.
        expanded: state.expanded !== null && moved.has(state.expanded) ? null : state.expanded,
        page: Math.min(state.page, Math.max(0, pageCount(cells.length) - 1)),
      }),
    ),
  );
  return { parent, child: detachedState(payload, origin), uids };
}

// The workspace the torn-off page arrives as: one page, its own name and account, uids
// renumbered from zero (they are window-local identity, never shared between the two).
function detachedState(payload: PagePayload, origin: string): GridState {
  const renumber = new Map(payload.cells.map((c, i) => [c.uid, i] as const));
  const cells = payload.cells.map((c, i) => {
    const next: Cell = { ...c, uid: i };
    if (c.parent !== undefined) next.parent = renumber.get(c.parent) ?? undefined;
    if (next.parent === undefined) delete next.parent;
    return next;
  });
  let nextUid = cells.length;
  const separators = remapSeparators(payload.separators, renumber, () => nextUid++);
  return {
    cells,
    expanded: null,
    page: 0,
    nextUid,
    sortMode: "manual",
    pages: [{ label: payload.meta.label, account: payload.meta.account }],
    separators: separators.length ? separators : undefined,
    origin,
  };
}

// ---------------------------------------------------------------------------------- merging

/** Why this luggage cannot come back, or null when it can. */
export function reattachBlockedReason(state: GridState, payload: PagePayload): string | null {
  const incoming = arrivingCells(state, payload);
  if (incoming.length === 0) return "戻すペインがありません（すでにこのウィンドウにあります）";
  if (pageCount(state.cells.length) >= MAX_PAGES) return `ページがもう ${MAX_PAGES} 枚あります`;
  if (runningCount(state.cells) + incoming.length > MAX_TERMINALS) return "ペインの上限に達しています";
  return null;
}

// A session may be held by ONE pane. If the same page somehow arrives twice — the operator
// clicked "bring it back" while the other window was clicking "go home" — the second copy of a
// session must not become a second column, or the two would evict each other from the server.
// Parked panes count: they hold their session too.
function arrivingCells(state: GridState, payload: PagePayload): Cell[] {
  const held = new Set([...state.cells, ...parkedOf(state).map((p) => p.cell)].map((c) => c.session).filter((s): s is string => s !== null && s !== undefined));
  return payload.cells.filter((c) => travels(c) && !held.has(c.session as string)).slice(0, PAGE_SIZE);
}

/** Put a page back, as a NEW page at the end of this grid.
 *
 *  The page before it is pinned first, for the reason addPage pins: an elastic list packs
 *  columns forward, so an un-sealed boundary would let the returning page dissolve into the one
 *  in front of it the moment a column closed. */
export function reattachPage(state: GridState, payload: PagePayload): GridState | null {
  if (reattachBlockedReason(state, payload) !== null) return null;
  const incoming = arrivingCells(state, payload);
  const target = pageCount(state.cells.length);
  const sealed = isPagePinned(state, target - 1) ? reserveSlots(state) : togglePagePin(state, target - 1);
  const start = sealed.nextUid;
  const renumber = new Map(incoming.map((c, i) => [c.uid, start + i] as const));
  const cells = incoming.map((c, i) => {
    const next: Cell = { ...c, uid: start + i };
    if (c.parent !== undefined) next.parent = renumber.get(c.parent) ?? undefined;
    if (next.parent === undefined) delete next.parent;
    return next;
  });
  let nextUid = start + cells.length;
  const arrived = remapSeparators(payload.separators, renumber, () => nextUid++);
  const separatorsBack = [...separatorsOf(sealed), ...arrived];
  let next: GridState = {
    ...sealed,
    cells: [...sealed.cells, ...cells],
    nextUid,
    page: target,
    // Same rule as every other add: arriving columns un-zoom rather than being hidden behind
    // an enlargement the operator left on.
    expanded: null,
    separators: separatorsBack.length ? separatorsBack : undefined,
  };
  next = setPageLabel(next, target, payload.meta.label ?? "");
  next = setPageAccount(next, target, payload.meta.account ?? null);
  return clampPage(next);
}

/** Fold several pages back in, keeping what does not fit rather than dropping it on the floor. */
export function reattachPages(state: GridState, payloads: readonly PagePayload[]): { state: GridState; rejected: PagePayload[] } {
  let next = state;
  const rejected: PagePayload[] = [];
  for (const payload of payloads) {
    const merged = reattachPage(next, payload);
    if (merged) next = merged;
    else rejected.push(payload);
  }
  return { state: next, rejected };
}

// -------------------------------------------------------------------------------- the keys

// The two side keys a window owns, hung off its OWN state key so two workspaces never share a
// register. `::` cannot appear in `grid_v2:<name>` (a workspace name is alphanumerics, `_` and
// `-`), so neither can be mistaken for a grid.
export const detachedKeyFor = (stateKey: string): string => `${stateKey}::detached`;
export const homeKeyPrefix = (stateKey: string): string => `${stateKey}::home:`;
export const homeKeyFor = (stateKey: string, ws: string): string => `${homeKeyPrefix(stateKey)}${ws}`;
/** The workspace a home-key names, or null when the key is not one of ours. */
export function wsFromHomeKey(stateKey: string, key: string): string | null {
  const prefix = homeKeyPrefix(stateKey);
  if (!key.startsWith(prefix)) return null;
  const ws = key.slice(prefix.length);
  return isWorkspaceName(ws) ? ws : null;
}
export const stateKeyForWorkspace = (ws: string): string => `${STATE_KEY}:${ws}`;
export const isOriginKey = isStateKey;

// The register of pages this window has out on loan. It is the ONLY thing that says a
// `grid_v2:<name>` belongs to us: scanning storage for them would also find the workspaces the
// operator opened by hand with `?ws=`, and offering to swallow those would be a data loss bug.
export function parseDetached(raw: string | null): DetachedPage[] {
  try {
    const parsed = JSON.parse(raw ?? "");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: DetachedPage[] = [];
    for (const entry of parsed.slice(0, MAX_PAGES)) {
      if (!isRecord(entry) || typeof entry.ws !== "string" || !isWorkspaceName(entry.ws) || seen.has(entry.ws)) continue;
      seen.add(entry.ws);
      out.push({
        ws: entry.ws,
        label: typeof entry.label === "string" ? entry.label.trim().slice(0, 40) : "",
        at: typeof entry.at === "number" ? entry.at : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export const addDetached = (list: readonly DetachedPage[], entry: DetachedPage): DetachedPage[] => [...list.filter((d) => d.ws !== entry.ws), entry];
export const removeDetached = (list: readonly DetachedPage[], ws: string): DetachedPage[] => list.filter((d) => d.ws !== ws);

/** A window's "I am coming home" note, re-validated end to end. */
export function parseHandoff(raw: string | null): Handoff | null {
  try {
    const parsed = JSON.parse(raw ?? "");
    if (!isRecord(parsed) || typeof parsed.ws !== "string" || !isWorkspaceName(parsed.ws) || !Array.isArray(parsed.pages)) return null;
    const pages = parsed.pages
      .slice(0, MAX_PAGES)
      .map(normalizePayload)
      .filter((p): p is PagePayload => p !== null);
    return pages.length ? { ws: parsed.ws, pages } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------- the ws name

// The name lands in a URL and in a storage key, so it is stripped to what a workspace name may
// be. A Japanese page name survives none of that — it becomes `pageN`, which is what the tab
// said before it was renamed anyway. Short of the 32-char cap so a collision suffix still fits.
const NAME_BUDGET = 28;
const ALLOWED = /[A-Za-z0-9_-]/u;
const ALPHANUMERIC = /[A-Za-z0-9]/u;
export function sanitizeWorkspaceName(base: string): string {
  // Character by character rather than a chain of anchored regexes: the same result, without a
  // pattern that backtracks over a hostile name (sonarjs/super-linear-regex).
  let out = "";
  for (const raw of base.normalize("NFKD")) {
    const ch = ALLOWED.test(raw) ? raw : "-";
    if (out === "" && !ALPHANUMERIC.test(ch)) continue; // a name starts alphanumeric
    if (ch === "-" && out.endsWith("-")) continue; // no runs of separators
    out += ch;
    if (out.length >= NAME_BUDGET) break;
  }
  while (out.length > 0 && !ALPHANUMERIC.test(out.slice(-1))) out = out.slice(0, -1);
  return isWorkspaceName(out) ? out : "";
}

/** A workspace name nothing else is using. `taken` is asked about the STATE KEY, so a name
 *  already holding a grid — one the operator made by hand included — is never re-used. */
export function freeWorkspaceName(base: string, page: number, taken: (ws: string) => boolean): string {
  const root = sanitizeWorkspaceName(base) || `page${page + 1}`;
  if (!taken(root)) return root;
  for (let n = 2; n < 100; n++) {
    const candidate = `${root}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${root}-${Date.now().toString(36).slice(-6)}`;
}
