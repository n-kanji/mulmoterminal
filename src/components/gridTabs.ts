import type { RunCommand } from "./runCommand";
import { isRecord } from "../../common/isRecord";
import { paneStateOf, type PaneState, type WaitKind } from "../../common/paneState";
import { MAX_CELLS } from "./gridLayout";

// The grid is ONE flat, ordered list of terminal cells, split into pages of
// PAGE_SIZE (the tabs). Closing a cell reflows the whole list so later pages pack forward
// into the gap (terminals flow across page boundaries); "+ Terminal" appends a
// launch cell, overflowing into a new page when the last one is full. GridView
// owns a single GridState ref and drives it through these pure transforms;
// TerminalGrid just renders the active page's slice.

// A configured launch command (shell/codex/…) running in a cell. `index` is its
// position in the user's launcher list (the server's allowlist); `label` is kept for
// display and to re-launch after a server restart. `{ shell: true }` is the OS default
// shell ($SHELL) opened by the header "new terminal" button — no configured index.
// Unlike a command, a launcher cell IS persisted (it has a session and reconnects).
export type CellLauncher = { index: number; label: string } | { shell: true; label: string };
export const isShellLauncher = (l: CellLauncher): l is { shell: true; label: string } => "shell" in l;
// A fresh OS-default-shell cell (session arrives from the server, then it persists/reconnects).
export const shellCell = (cwd: string, label = "shell"): Omit<Cell, "uid"> => ({ session: null, cwd, launcher: { shell: true, label } });

export interface Cell {
  uid: number;
  session: string | null;
  cwd: string | null;
  // A running command cell (a script.json entry or a header shell button), with the
  // directory it runs in. Ephemeral — command cells are never persisted.
  command?: RunCommand | null;
  // A running launcher (shell/codex/custom). Persistent & reattachable like a session.
  launcher?: CellLauncher | null;
  // The agent this cell runs. "codex" reconnects via /ws/codex; absent = Claude (the default).
  agent?: "codex";
  // Fork-local (iTerm2 mode, R10): a name the OPERATOR gave this pane ("orosy 決済"), or the
  // one an agent asked for when it opened the column (POST /api/workspace/column `label`).
  // Persisted, unlike everything else on the status strip: the AI summary is rewritten every
  // turn and the directory is shared by half the grid, so neither can say WHICH of the four
  // panes in this repo is which. Absent = the pane has no name and shows its summary.
  name?: string;
  // Fork-local (iTerm2 mode, R12): this cell was opened by another cell's Fork button and
  // starts as a BRANCH of that session (`--resume <id> --fork-session`). One-shot: cleared
  // by setSession the moment the branch has an id of its own, so it can never fork twice.
  // Never persisted — a cell with no session isn't saved at all (parseGridState).
  fork?: string | null;
  // Fork-local (iTerm2 mode, R1): a RESERVED SLOT, not a terminal. Holes exist only to hold a
  // pinned page's width open — see the "workspaces" section below. They are never rendered,
  // never occupied, and never somewhere to send anyone.
  hole?: true;
}
// How the grid orders its cells. "manual": the user's hand-arranged order (the move buttons);
// "auto": attention-first, recomputed from each cell's live status.
export type SortMode = "manual" | "auto";
// A cell's live activity, reported up from the cell. Drives the "auto" order and the cell's
// colour/label. The vocabulary and the rule that picks one live in common/paneState, because
// only the SERVER can split a Notification into approval-vs-question and only the client
// renders it; this alias is the grid's name for the same six words (plus `idle`, the floor
// that renders as no word at all).
export type CellStatus = PaneState;

// Map the server's raw activity to a CellStatus. `connected` and `shell` are facts the
// session table cannot know — a launcher pane runs no agent, and a dead socket is the
// browser's own observation — so the caller supplies them and they win (see paneStateOf).
export function activityStatus(
  working: boolean,
  waiting: boolean,
  event: string | null | undefined,
  waitKind?: WaitKind | null,
  opts?: { connected?: boolean; shell?: boolean },
): CellStatus {
  return paneStateOf({ working, waiting, event, waitKind, connected: opts?.connected ?? true, shell: opts?.shell });
}

// Fork-local (iTerm2 mode, R1): what a page is besides a number. `label` names it ("orosy");
// `pinned` seals it so cells neither flow in nor out. Absent = a plain, elastic page, which is
// what every page was before this existed — so a state with no `pages` behaves exactly as it did.
export interface PageMeta {
  label?: string;
  pinned?: boolean;
}

export interface GridState {
  cells: Cell[];
  expanded: number | null; // uid of the zoomed cell, or null
  page: number;
  nextUid: number;
  sortMode: SortMode;
  // Index-aligned with the page number. Sparse and optional: `pages` may be shorter than the
  // grid has pages, and any missing entry means "plain, elastic".
  pages?: PageMeta[];
}

// Fork-local (iTerm2 mode): a page holds MAX_CELLS full-height columns (see
// gridLayout.ts) — 12, the operator's requested per-page headroom (2026-08-25).
export const PAGE_SIZE = MAX_CELLS;
export const MAX_TERMINALS = PAGE_SIZE * 8; // 8 pages, as before the 10 -> 12 resize
// The array can hold more entries than terminals: a pinned page keeps its width with reserved
// slots (see the workspaces section), so a fully reserved grid is MAX_TERMINALS slots on top of
// the terminals. Only used to bound what a persisted blob may claim.
const MAX_SLOTS = MAX_TERMINALS * 2;
export const STATE_KEY = "grid_v2";
export const LEGACY_KEY = "grid_state_v1";
// A page name is a tab label on a 30px row — long enough for "workspace-1", short enough that
// eight of them still fit without the row wrapping.
export const MAX_PAGE_LABEL = 20;
// R10: a pane name shares its 22px row with the state word and the model badge, so it is capped
// well below a title. Long enough for "orosy 決済リファクタ", short enough that it can never be
// the reason the summary loses its line.
export const MAX_CELL_NAME = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fork-local (iTerm2 mode, R1): a second browser window runs a SECOND workspace by opening
// `?ws=<name>`. Same server and the same live sessions — only the saved grid is separate, so
// two windows are two workspaces instead of two views fighting over one localStorage key.
// No `ws` keeps the original key, so an existing window is untouched.
const WS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export function workspaceFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("ws");
  return raw && WS_NAME_RE.test(raw) ? raw : null;
}
export const stateKeyFor = (workspace: string | null): string => (workspace ? `${STATE_KEY}:${workspace}` : STATE_KEY);

export const pageCount = (cellCount: number) => Math.max(1, Math.ceil(cellCount / PAGE_SIZE));
export const pageSlice = <T>(cells: T[], page: number) => cells.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
// A cell occupies a slot when it runs a Claude session, a command, OR a launcher; only those
// count toward the cap. R12 adds a fourth: a pending fork is a column the operator opened and
// is waiting on — it has no session id YET (the server mints it), but treating it as an empty
// launch cell would let a tab click drop it (switchPage), a preset chip rewrite it
// (addCellWithCwd) or "+ Terminal" cancel it — including in the case where its fork was
// refused and the pane is holding the error message meant to be read.
// A launch cell is what is left: nothing running and nothing asked for.
const isOccupied = (c: Cell) => !isHole(c) && (c.session !== null || c.command != null || c.launcher != null || c.fork != null);
const isLaunchCell = (c: Cell | undefined) => !!c && !isHole(c) && !isOccupied(c);
export const runningCount = (cells: Cell[]) => cells.filter(isOccupied).length;

// =========================================================================================
// WORKSPACES (R1). A page can be NAMED and PINNED, so "workspace-1" and "workspace-2" are
// two pages rather than two apps. Pinned means the page is SEALED: closing a column on it
// must not suck a terminal in from the next page, and its own columns must not drain into
// an earlier one. Everything else about a page is unchanged.
//
// The whole grid is still ONE flat array sliced at PAGE_SIZE, and that is deliberate: every
// page number in this file is `Math.floor(index / PAGE_SIZE)`, including the three the zoom
// invariants below depend on. Variable-length pages would make each of those a different
// question, so instead a sealed page keeps its width by holding RESERVED SLOTS (`hole`
// cells) where its closed terminals were. The renderer drops holes, so the surviving columns
// still widen to fill the page; only the page BOUNDARY is held still.
//
// Reserving is transitive backwards: page p's boundary is only fixed if everything before it
// is too, so every page up to the last pinned one is padded to PAGE_SIZE. Pages after it are
// untouched and reflow across each other exactly as they always have — and with nothing
// pinned there are no holes at all, which is the pre-workspace grid, unchanged.
// =========================================================================================

export const isHole = (c: Cell): boolean => c.hole === true;
const holeCell = (uid: number): Cell => ({ uid, session: null, cwd: null, hole: true });
export const realCells = (cells: readonly Cell[]): Cell[] => cells.filter((c) => !isHole(c));

export const isPagePinned = (state: GridState, page: number): boolean => state.pages?.[page]?.pinned === true;
// What the tab shows: the page's name, or its number when it has none.
export const pageLabel = (state: GridState, page: number): string => state.pages?.[page]?.label?.trim() || String(page + 1);
// The highest pinned page, or -1. Every page at or before it holds its slots.
const lastPinnedPage = (state: GridState): number => (state.pages ?? []).reduce((last, meta, p) => (meta?.pinned ? p : last), -1);
const isReservedPage = (state: GridState, page: number): boolean => page <= lastPinnedPage(state);
const pageOfIndex = (at: number): number => Math.floor(at / PAGE_SIZE);

const withPageMeta = (state: GridState, page: number, patch: PageMeta): GridState => {
  const pages = [...(state.pages ?? [])];
  while (pages.length <= page) pages.push({});
  pages[page] = { ...pages[page], ...patch };
  return { ...state, pages };
};

// Rename a page. An empty (or blank) name clears it, so the tab goes back to its number
// rather than showing nothing.
export function setPageLabel(state: GridState, page: number, label: string): GridState {
  const trimmed = label.trim().slice(0, MAX_PAGE_LABEL);
  return withPageMeta(state, page, { label: trimmed || undefined });
}

// Seal or unseal a page. Pinning pads every page up to it; unpinning drops the padding it no
// longer needs and lets those pages pack forward again, which is the pre-workspace behaviour.
export function togglePagePin(state: GridState, page: number): GridState {
  // Clamped because un-pinning is the one action that can REMOVE pages: dropping the padding
  // packs the list forward, and an un-pin done from a later tab would otherwise leave `page`
  // past the end — a blank grid with no tab row left to click back from.
  return clampPage(reserveSlots(withPageMeta(state, page, { pinned: !isPagePinned(state, page) })));
}

// Restore the invariant "every page up to the last pinned one owns exactly PAGE_SIZE slots,
// terminals first and holes last". Idempotent, and a no-op shape-wise when nothing is pinned
// (it just drops any stale holes, packing the list forward as it always did).
export function reserveSlots(state: GridState): GridState {
  const last = lastPinnedPage(state);
  const out: Cell[] = [];
  let nextUid = state.nextUid;
  // Re-use the uids of the slots already there before minting new ones — this runs on every
  // parse and every pin, and a fresh uid each time would ratchet nextUid up for no reason.
  const spare = state.cells.filter(isHole).map((c) => c.uid);
  const slot = (): Cell => holeCell(spare.length > 0 ? (spare.shift() as number) : nextUid++);
  for (let p = 0; p <= last; p++) {
    out.push(...realCells(pageSlice(state.cells, p)));
    while (out.length < (p + 1) * PAGE_SIZE) out.push(slot());
  }
  // Everything past the reserved pages is one elastic run again: concatenated, it re-pages
  // itself when sliced, which is how closing a cell has always pulled the next one forward.
  out.push(...realCells(state.cells.slice((last + 1) * PAGE_SIZE)));
  return { ...state, cells: out, nextUid };
}

// Drop the cell at `at`. On a reserved page the slot stays with the page — a hole takes its
// place at the page's end — so the pages after it do not slide back over the boundary.
// Anywhere else the list packs forward, unchanged.
//
// The replacement hole takes a FRESH uid rather than the closed cell's: `expanded` still
// points at that uid for one more step, and re-using it would leave the grid "zoomed" on a
// reserved slot.
function removeAt(state: GridState, at: number): { cells: Cell[]; nextUid: number } {
  const cells = state.cells.slice();
  cells.splice(at, 1);
  if (!isReservedPage(state, pageOfIndex(at))) return { cells, nextUid: state.nextUid };
  cells.splice(pageOfIndex(at) * PAGE_SIZE + PAGE_SIZE - 1, 0, holeCell(state.nextUid));
  return { cells, nextUid: state.nextUid + 1 };
}

// Put `cell` at `at`. On a reserved page it consumes that page's trailing hole instead of
// pushing the page's last terminal onto the next one; null means the page has no room left
// and the caller should fall back to appending.
function insertAt(state: GridState, at: number, cell: Cell): Cell[] | null {
  const cells = state.cells.slice();
  cells.splice(at, 0, cell);
  const page = pageOfIndex(at);
  if (!isReservedPage(state, page)) return cells;
  const pushedOut = page * PAGE_SIZE + PAGE_SIZE; // the slot the insert shoved off this page
  if (!isHole(cells[pushedOut])) return null;
  cells.splice(pushedOut, 1);
  return cells;
}

// Where a new column goes on `page`: its first reserved hole, or the end of the page when it
// still has room. -1 when the page is full. With nothing pinned this is the end of the LAST
// page and nowhere else, which is where "+ Terminal" has always appended.
function freeSlot(state: GridState, page: number): number {
  const start = page * PAGE_SIZE;
  const slots = pageSlice(state.cells, page);
  const hole = slots.findIndex(isHole);
  if (hole >= 0) return start + hole;
  return slots.length < PAGE_SIZE ? start + slots.length : -1;
}

// The trailing OPEN launch cell (the one "+ Terminal" cancels), ignoring reserved holes, or
// -1 when the last real cell is a running terminal.
function trailingLaunchIndex(state: GridState): number {
  for (let i = state.cells.length - 1; i >= 0; i--) {
    if (isHole(state.cells[i])) continue;
    return isLaunchCell(state.cells[i]) ? i : -1;
  }
  return -1;
}

const clampPage = (s: GridState): GridState => ({ ...s, page: Math.min(Math.max(0, Math.floor(s.page)), pageCount(s.cells.length) - 1) });

// Always keep at least one cell — the entry launch cell on an otherwise empty grid. On a
// grid that is nothing but reserved slots, the first of them becomes that entry cell rather
// than a ninth column being appended past the pinned pages.
const ensureEntry = (s: GridState): GridState => {
  if (s.cells.some((c) => !isHole(c))) return s;
  const at = s.cells.findIndex(isHole);
  if (at < 0) return { ...s, cells: [{ uid: s.nextUid, session: null, cwd: null }], nextUid: s.nextUid + 1 };
  const cells = s.cells.slice();
  cells[at] = { uid: cells[at].uid, session: null, cwd: null };
  return { ...s, cells };
};

// "+ Terminal": append a launch cell (overflowing into a new page when full), or
// cancel an already-open launch cell. The sole entry cell is never removed.
export function addCell(state: GridState): GridState {
  const open = trailingLaunchIndex(state);
  if (open >= 0) {
    if (realCells(state.cells).length <= 1) return state; // the entry cell — nothing to add or cancel
    return clampPage({ ...state, ...removeAt(state, open) }); // cancel the open launch cell
  }
  if (runningCount(state.cells) >= MAX_TERMINALS) return state;
  const uid = state.nextUid;
  // Fork-local (iTerm2 mode): adding a cell UN-zooms instead of promoting the new
  // cell into the enlarged view. The operator's model is "columns grow sideways";
  // promoting kept them trapped fullscreen and hid where the new pane landed.
  const expanded = zoomedUid(state) !== null ? null : state.expanded;
  // R1: the new column joins the page being LOOKED AT, not the end of the whole grid — a
  // pinned page must be able to refill itself without the view jumping to the last tab.
  // Un-pinned, the only page with room is the last one, so this is the old append.
  const slot = freeSlot(state, state.page);
  const filled = slot >= 0 ? insertAt(state, slot, { uid, session: null, cwd: null }) : null;
  if (filled) return { ...state, cells: filled, nextUid: state.nextUid + 1, page: pageOfIndex(slot), expanded };
  const cells = [...state.cells, { uid, session: null, cwd: null }];
  return { ...state, cells, nextUid: state.nextUid + 1, page: pageCount(cells.length) - 1, expanded };
}

// Fork-local (iTerm2 mode): the drag payload type for column reorder. A custom MIME
// keeps a header drag distinguishable from a FILE drag (file-onto-terminal inserts the
// path — an upstream feature that must keep working untouched).
export const CELL_DRAG_MIME = "text/x-mulmo-cell-uid";

// Fork-local (iTerm2 mode): drag & drop reorder — move `uid` to `targetUid`'s position,
// shifting the cells between them (a splice, not a swap: dragging a column three slots
// left should land it THERE and push the others right, like iTerm2 pane dragging).
export function moveCellTo(state: GridState, uid: number, targetUid: number): GridState {
  const from = state.cells.findIndex((c) => c.uid === uid);
  const to = state.cells.findIndex((c) => c.uid === targetUid);
  if (from < 0 || to < 0 || from === to) return state;
  if (isHole(state.cells[from]) || isHole(state.cells[to])) return state; // reserved slots are not drop targets
  // R1: a drag only ever happens within the page on screen. Refuse a cross-page splice while
  // any page is sealed — it would move a column into another workspace and change both pages'
  // slot counts, which is exactly what pinning promises will not happen.
  if (pageOfIndex(from) !== pageOfIndex(to) && lastPinnedPage(state) >= 0) return state;
  const cells = [...state.cells];
  const [moved] = cells.splice(from, 1);
  cells.splice(to, 0, moved);
  return { ...state, cells };
}

// Page-move (operator request 2026-08-25): "send this column to another page" — the pane toolbar's
// page menu. The cell just changes SLOTS in the flat list, so the session is untouched: nothing
// is forked or relaunched, and the pane reattaches when its new page is looked at, exactly as
// any off-page column always has. Whether a cell can go decides the menu; the move itself is
// below.
//
// A sealed (pinned) target only accepts a column into a reserved hole — full means full, that
// is the pin's promise. An elastic page has no such promise: full there means the incoming
// column lands as the page's LAST slot and the overflow reflows on, the same cascade closing
// and inserting have always caused.
//
// `targetPage === pageCount` is A NEW page (the menu's "N枚目（新規）"). An elastic list
// cannot hold a column past its own end — the reflow packs it straight back onto the last
// page — so a new-page move first PINS the page before it: "there is a boundary here" is
// exactly what pinning means in this grid, and it is what lets 11 columns become 10 + 1
// instead of snapping back together. Needs a second occupied cell, or the "new page" would
// just be the old page with extra steps.
export function canMoveCellToPage(state: GridState, uid: number, targetPage: number): boolean {
  const from = state.cells.findIndex((c) => c.uid === uid);
  if (from < 0 || isHole(state.cells[from]) || !isOccupied(state.cells[from])) return false;
  const total = pageCount(state.cells.length);
  if (targetPage < 0 || targetPage > total || pageOfIndex(from) === targetPage) return false;
  if (targetPage === total) return runningCount(state.cells) >= 2;
  return !(isReservedPage(state, targetPage) && freeSlot(state, targetPage) < 0);
}

export function moveCellToPage(state: GridState, uid: number, targetPage: number): GridState {
  if (!canMoveCellToPage(state, uid, targetPage)) return state;
  let base = state;
  if (targetPage === pageCount(state.cells.length)) {
    // A NEW page. An abandoned trailing launch form would be stranded mid-list by the append
    // below, so it gets the same treatment switchPage gives it — dropped — and the target is
    // re-derived (dropping it can shrink the page count). Then the boundary is sealed (see
    // above), padding every page before it, so the append lands PAST the last page instead
    // of reflowing back onto it.
    const open = trailingLaunchIndex(state);
    if (open >= 0 && realCells(state.cells).length > 1) base = clampPage({ ...state, ...removeAt(state, open) });
    targetPage = pageCount(base.cells.length);
    base = reserveSlots(withPageMeta(base, targetPage - 1, { pinned: true }));
  }
  const from = base.cells.findIndex((c) => c.uid === uid);
  const cell = base.cells[from];
  // removeAt leaves a hole on a sealed source page, so its boundary holds; recomputing the
  // destination on the interim state absorbs the index shift an elastic removal causes.
  const interim: GridState = { ...base, ...removeAt(base, from) };
  let at = freeSlot(interim, targetPage);
  if (at < 0) at = targetPage * PAGE_SIZE + PAGE_SIZE - 1; // full elastic page: land last, overflow reflows on
  // The trailing OPEN launch cell stays the last real cell — landing after it would strand
  // "+ Terminal"'s cancel target mid-list.
  const open = trailingLaunchIndex(interim);
  if (open >= 0 && pageOfIndex(open) === targetPage && open < at) at = open;
  const placed = insertAt(interim, Math.min(at, interim.cells.length), cell);
  return placed ? clampPage({ ...interim, cells: placed }) : state;
}

// Fork-local (iTerm2 mode): a toolbar preset chip opens a NEW COLUMN already pointed at
// its directory — the caller then auto-launches claude in it (TerminalCell's autoLaunch),
// so one click goes straight from chip to running pane with no launcher stop. Reuses an
// already-open trailing launch cell rather than stacking a second one. Returns the cell's
// uid so the caller can target the auto-launch; -1 means "full, nothing added".
// `name` (R10) is the column's operator-visible name. The chip strip never passes one; the agent
// self-drive API does, so a column an agent opened for itself arrives already saying WHY.
export function addCellWithCwd(state: GridState, cwd: string, name?: string | null): { state: GridState; uid: number } {
  const expanded = zoomedUid(state) !== null ? null : state.expanded;
  const named = name ? cellName(name) : undefined;
  const open = trailingLaunchIndex(state);
  if (open >= 0) {
    const reuse = state.cells[open];
    const cells = state.cells.map((c) => (c.uid === reuse.uid ? { ...c, cwd, name: named } : c));
    return { state: { ...state, cells, expanded, page: pageOfIndex(open) }, uid: reuse.uid };
  }
  if (runningCount(state.cells) >= MAX_TERMINALS) return { state, uid: -1 };
  const uid = state.nextUid;
  // Same rule as addCell: the chip opens its column on the page in front of the operator.
  const slot = freeSlot(state, state.page);
  const filled = slot >= 0 ? insertAt(state, slot, { uid, session: null, cwd, name: named }) : null;
  if (filled) return { state: { ...state, cells: filled, nextUid: state.nextUid + 1, page: pageOfIndex(slot), expanded }, uid };
  const cells = [...state.cells, { uid, session: null, cwd, name: named }];
  return { state: { ...state, cells, nextUid: state.nextUid + 1, page: pageCount(cells.length) - 1, expanded }, uid };
}

// The uid of the trailing launch cell that "+ Terminal" (and the launcher's own close button)
// cancels, or null when there's nothing to cancel. The sole entry cell is never
// cancelable, so it's excluded.
export function cancelableLaunchUid(state: GridState): number | null {
  const open = trailingLaunchIndex(state);
  return open >= 0 && realCells(state.cells).length > 1 ? state.cells[open].uid : null;
}

// Fork-local (iTerm2 mode): ALL open launch cells, for the launcher's in-cell close button.
// R1 inserts a new launcher into the page in front of the operator, so it can sit mid-grid
// where trailingLaunchIndex never looks — without its own close button such a launcher had
// no way out (operator report 2026-08-25). The sole entry cell is still excluded, and the
// toolbar's "+ cancels" toggle keeps the stricter trailing-only rule above.
export function cancelableLaunchUids(state: GridState): number[] {
  if (realCells(state.cells).length <= 1) return [];
  return state.cells.filter((c) => isLaunchCell(c)).map((c) => c.uid);
}

export function setSession(state: GridState, uid: number, id: string | null): GridState {
  // R12: an id means the fork request was served — spend it, so a later reconnect of this
  // cell resumes the branch rather than forking the source a second time.
  const cells = state.cells.map((c) => (c.uid === uid ? { ...c, session: id, fork: id === null ? c.fork : null } : c));
  const expanded = id === null && state.expanded === uid ? null : state.expanded;
  return { ...state, cells, expanded };
}

export function setCwd(state: GridState, uid: number, cwd: string): GridState {
  return { ...state, cells: state.cells.map((c) => (c.uid === uid ? { ...c, cwd } : c)) };
}

// R10: normalise a pane name. A blank one CLEARS the name (the field is emptied to remove it),
// which is why this returns undefined rather than "" — an empty string persisted would read as
// "named, with nothing to show" everywhere that tests the field.
export const cellName = (name: string): string | undefined => name.trim().slice(0, MAX_CELL_NAME) || undefined;

// R10: name (or un-name) a pane. The one writer — the header's inline rename and the agent API's
// `label` both land here — so the trimming rule cannot differ between them.
export function setCellName(state: GridState, uid: number, name: string): GridState {
  return { ...state, cells: state.cells.map((c) => (c.uid === uid ? { ...c, name: cellName(name) } : c)) };
}

// Record which agent a cell launched (only "codex" is stored; Claude is the default/absent) so a
// reloaded cell reconnects to the right endpoint.
export function setCellAgent(state: GridState, uid: number, agent: "claude" | "codex"): GridState {
  const codex: "codex" | undefined = agent === "codex" ? "codex" : undefined;
  return { ...state, cells: state.cells.map((c) => (c.uid === uid ? { ...c, agent: codex } : c)) };
}

// A cell's launcher ran a script.json command: attach it, turning the launch cell
// into a command terminal. Ephemeral — command cells aren't persisted.
export function runCommand(state: GridState, uid: number, command: Cell["command"]): GridState {
  return { ...state, cells: state.cells.map((c) => (c.uid === uid ? { ...c, command } : c)) };
}

// A cell launched a configured program (shell/codex/…): attach the launcher and its
// directory, turning the launch cell into a persistent launcher terminal. Its session
// id arrives later from the server (setSession), so it persists and reconnects.
export function launchInCell(state: GridState, uid: number, launcher: CellLauncher, cwd: string | null): GridState {
  return { ...state, cells: state.cells.map((c) => (c.uid === uid ? { ...c, launcher, cwd } : c)) };
}

// Insert a brand-new cell immediately AFTER the cell that triggered it, so the header
// "new terminal" button and the Run button open next to the current cell rather than at
// the end. Falls back to appending when `afterUid` is gone. Jumps to the new cell's page.
export function insertCellAfter(state: GridState, afterUid: number, cell: Omit<Cell, "uid">): GridState {
  if (runningCount(state.cells) >= MAX_TERMINALS) return state;
  const idx = state.cells.findIndex((c) => c.uid === afterUid);
  const at = idx >= 0 ? idx + 1 : state.cells.length;
  const uid = state.nextUid;
  // Fork-local (iTerm2 mode): same un-zoom-on-add rule as addCell above.
  const expanded = zoomedUid(state) !== null ? null : state.expanded;
  // R1: on a sealed page the neighbour lands in that page's reserved slot. A sealed page with
  // no slot left has nowhere to put it, so it falls back to the end of the grid rather than
  // shunting the page's last column onto the next workspace.
  const placed = insertAt(state, at, { ...cell, uid });
  if (placed) return { ...state, cells: placed, nextUid: state.nextUid + 1, page: pageOfIndex(at), expanded };
  const cells = [...state.cells, { ...cell, uid }];
  return { ...state, cells, nextUid: state.nextUid + 1, page: pageCount(cells.length) - 1, expanded };
}

// Fork-local (iTerm2 mode, R12): branch the cell's conversation into the column right beside
// it — the operator's own `claude --resume <id> --fork-session`, as one click. Same directory,
// because a fork of a conversation about THIS project belongs in this project. Returns the new
// uid so the caller can auto-launch it (there is nothing to ask a launch form about); -1 when
// there is nothing to fork (no session yet) or no room left in the grid.
export function forkCell(state: GridState, uid: number): { state: GridState; uid: number } {
  const source = state.cells.find((c) => c.uid === uid);
  if (!source || isHole(source) || !source.session) return { state, uid: -1 };
  const uidNext = state.nextUid;
  const next = insertCellAfter(state, uid, { session: null, cwd: source.cwd, fork: source.session });
  // insertCellAfter returns the SAME state when the grid is full — no cell, so no uid.
  return next === state ? { state, uid: -1 } : { state: next, uid: uidNext };
}

// The Run button opened a script in a spare cell next to the cell that triggered it.
export function runScriptInNewCell(state: GridState, afterUid: number, command: NonNullable<Cell["command"]>): GridState {
  return insertCellAfter(state, afterUid, { session: null, cwd: null, command });
}

// Close a cell: drop it and reflow the list (later cells pack forward across
// pages), keep an entry cell, and clamp the page. If the CLOSED cell was the zoomed
// one, STAY zoomed on its neighbour in the on-screen `order` — the previous cell, or
// the next one when the closed cell was first — so closing walks the expand along the
// filmstrip instead of collapsing to the grid. Falls back to un-zooming when there's
// no surviving neighbour (the last cell) or no `order` is supplied.
export function closeCell(state: GridState, uid: number, order?: number[]): GridState {
  const at = state.cells.findIndex((c) => c.uid === uid);
  // R1: on a pinned page the slot stays with the page (removeAt leaves a hole), so the reflow
  // stops at the workspace boundary instead of dragging the next one's terminals back.
  const { cells, nextUid } = at < 0 ? { cells: state.cells, nextUid: state.nextUid } : removeAt(state, at);
  const expanded = state.expanded === uid ? expandNeighbour(order, uid, cells) : state.expanded;
  return ensureEntry(clampPage({ ...state, cells, nextUid, expanded }));
}

// The uid to keep zoomed after closing the zoomed `uid`: the cell before it in the
// on-screen `order`, or the one after when it was first. null (collapse to the grid)
// when there's no surviving neighbour or no order was given.
function expandNeighbour(order: number[] | undefined, uid: number, remaining: Cell[]): number | null {
  if (!order) return null;
  const idx = order.indexOf(uid);
  if (idx < 0) return null;
  const neighbour = idx > 0 ? order[idx - 1] : order[idx + 1];
  return neighbour !== undefined && remaining.some((c) => c.uid === neighbour) ? neighbour : null;
}

// Walk the zoom one step along the on-screen `order` (dir -1 = previous, +1 = next).
// Stops at either end rather than wrapping.
//
// Refusing to act unless something is zoomed is what makes the `page` update below sound:
// while zoomed `visibleOrdered` returns the WHOLE ordered list, so an index into `order` is
// an index into the un-paged list. Un-zoomed, `order` is only the current page's slice and
// the same arithmetic would land on the wrong page.
export function moveZoom(state: GridState, order: readonly number[], dir: -1 | 1): GridState {
  const uid = zoomedUid(state);
  if (uid === null) return state;
  const from = order.indexOf(uid);
  if (from < 0) return state; // not on screen — without this, -1 + 1 would jump to the front
  // Step OVER reserved slots: the filmstrip does not render them, so stopping on one would
  // read as the key having died halfway along a pinned page.
  for (let at = from + dir; at >= 0 && at < order.length; at += dir) {
    if (state.cells.some((c) => c.uid === order[at] && !isHole(c))) return { ...state, expanded: order[at] };
  }
  return state;
}

// Fork-local (iTerm2 mode, R3): where the keyboard moves the CURSOR to — the neighbour of
// `fromUid` among the columns currently rendered (dir -1 = left, +1 = right).
//
// Stops at either end rather than wrapping. Wrapping is right for `next-attention` (a round of
// cells that are calling) and wrong here: Alt+L on the last column would jump the cursor across
// the whole screen, which reads as the key having done something else entirely.
//
// Only OCCUPIED cells are targets. An empty launch cell is a column on screen but holds no
// terminal to type into, so focusing it would put the cursor nowhere and make the key look dead.
// With no cursor yet the key enters from the near end, so it works on a freshly loaded grid.
//
// Returns a uid for the caller to focus — NOT a new state. There is deliberately no stored
// "selected cell" (zoom invariant 4): the focus the DOM reports is the one notion of where the
// user is, and a second copy here would disagree with it the moment a click moved the cursor.
export function focusStepUid(rendered: readonly Cell[], fromUid: number | null, dir: -1 | 1): number | null {
  const targets = rendered.filter(isOccupied);
  if (targets.length === 0) return null;
  const from = targets.findIndex((c) => c.uid === fromUid);
  if (from < 0) return targets[dir === 1 ? 0 : targets.length - 1].uid;
  const at = from + dir;
  return at >= 0 && at < targets.length ? targets[at].uid : null;
}

// Fork-local (iTerm2 mode, R3): the keyboard's page switch (dir -1 = previous, +1 = next),
// stopping at the first and last page rather than wrapping — same reason as focusStepUid.
//
// A no-op while zoomed, which is what keeps zoom invariant 1 (only `toggleZoom` changes WHETHER
// the grid is zoomed): `switchPage` clears the zoom, so paging from a zoomed grid would collapse
// the layout out from under a key that only claims to change page. Nothing is lost by refusing —
// `page` is unused while zoomed, and releasing the zoom derives it from the enlarged cell anyway,
// so a "successful" page change there would be invisible and then immediately overwritten.
export function stepPage(state: GridState, dir: -1 | 1): GridState {
  if (zoomedUid(state) !== null) return state;
  const page = state.page + dir;
  return page < 0 || page >= pageCount(state.cells.length) ? state : switchPage(state, page);
}

// ---------------------------------------------------------------------------------------
// ZOOM INVARIANTS (#829). Every one of these was broken at least once while building this,
// and each break looked like a different symptom, so they are written down rather than left
// to be re-derived. Anything added here must keep all five; the tests named "zoom invariants"
// in gridTabs.spec.ts and GridView.spec.ts fail loudly if not.
//
//  1. ONLY `toggleZoom` changes WHETHER the grid is zoomed. The movement actions (moveZoom,
//     nextAttention) relocate the enlargement or the page and never enter or leave the zoom.
//     A key that sometimes rearranges the whole layout is unpredictable to use.
//     (`closeCell` is the deliberate exception — closing the enlarged cell has to do
//     something about it, and it walks the zoom to a neighbour.)
//
//  2. `order` is ALWAYS the whole un-paged ordered list. Un-zoomed the grid renders only a
//     page of it, so passing that slice hides cells on other pages from the search AND makes
//     every index-to-page calculation below wrong.
//
//  3. `page` is decided at exactly ONE moment: releasing the zoom, from where the enlarged
//     cell sits. It is unused while zoomed (every cell renders, the tab bar is hidden), and
//     the page someone zoomed in FROM stops being true as soon as they walk the filmstrip.
//
//  4. There is ONE notion of "the current terminal": the enlarged cell while zoomed, the
//     focused cell otherwise. Never a second stored copy — a remembered uid and the live
//     focus disagree the moment the selection moves, and then expanding jumps somewhere the
//     user was not.
//
//  5. Entering the zoom needs two running cells (toggleExpand's rule, #374); LEAVING it is
//     never refused, whatever state the grid got into.
// ---------------------------------------------------------------------------------------

// Zoom `order[at]`, honouring invariant 5. Shared by every action that ENTERS the zoom so the
// rule cannot be forgotten at one entry point.
function zoomAt(state: GridState, order: readonly number[], at: number): GridState {
  const uid = order[at];
  if (uid === undefined || runningCount(state.cells) < 2) return state;
  // A reserved slot is not a terminal, so it is never what the key enlarges. (Holes sit at the
  // END of their page, so the page-first entry index below still lands on a real column.)
  if (!state.cells.some((c) => c.uid === uid && !isHole(c))) return state;
  return { ...state, expanded: uid };
}

// Which page to show once the zoom is released: the one holding the cell that was enlarged.
//
// Derived HERE rather than carried along, because the page someone zoomed in from stops being
// true the moment they walk the filmstrip — after paging through terminals, "go back to where
// you started" lands them nowhere near what they were just reading. `page` is unused while
// zoomed (the grid renders every cell and the tab bar is hidden), so this is the only moment
// it has to be right.
const pageHolding = (order: readonly number[], uid: number, fallback: number): number => {
  const at = order.indexOf(uid);
  return at < 0 ? fallback : Math.floor(at / PAGE_SIZE);
};

// The keyboard's way in and out of the zoom (#829). Every other zoom action needs something
// already enlarged, so without this one a keymap cannot be used at all without first reaching
// for the expand button.
//
// Un-zoomed there is no "current" cell to enlarge, so it takes the first one ON THE PAGE THE
// USER IS LOOKING AT — `order` is the whole un-paged list, so index 0 would be a cell from the
// first tab, enlarging something off-screen and dragging the page back to 0 with it.
export function toggleZoom(state: GridState, order: readonly number[], fromUid: number | null = null): GridState {
  const uid = zoomedUid(state);
  if (uid !== null) return { ...state, expanded: null, page: pageHolding(order, uid, state.page) };
  // Enlarge whatever is SELECTED — the focused cell, which the caller supplies because only it
  // knows where the cursor is. There is deliberately no separate "last enlarged" memory: it
  // would fight the live selection, so collapsing and re-expanding would jump somewhere else.
  const at = fromUid !== null ? order.indexOf(fromUid) : -1;
  return zoomAt(state, order, at >= 0 ? at : state.page * PAGE_SIZE);
}

// Search order for "somewhere worth going": the states that are actually calling — approval
// and question (an answer is owed now), then a dead pane (it needs relaunching, and nothing
// else will tell you), then `unread` (finished, not looked at) — with `idle` as a fallback so
// the key still moves on a board where nothing happens to be waiting.
//
// `working` is deliberately absent: a cell mid-turn is the one place the user has no reason to
// be, and skipping it is what stops this from being a plain "next cell". `shell` is absent for
// the same reason — it is a terminal the user drives, not one that ever asks for them. This
// mirrors the attention RANK the "auto" sort already uses.
const ATTENTION_ORDER: readonly CellStatus[] = ["approval", "question", "disconnected", "unread", "idle"];

// Jump to the next terminal that wants the user, cycling from wherever the zoom is now — the
// "take me to whoever called" key. Also works un-zoomed, where it doubles as a way in.
//
// Wraps deliberately: this is a round of pending cells, not a list with ends, so pressing it
// repeatedly walks all of them and comes back rather than stopping on the last.
export function nextAttention(state: GridState, order: readonly number[], statusByUid: Record<number, CellStatus>, fromUid: number | null = null): GridState {
  const at = nextCandidate(state, order, statusByUid, zoomedUid(state) ?? fromUid);
  if (at === undefined) return state;
  // NEVER enlarges or collapses — that is toggleZoom's job alone. Zoomed, this moves which
  // terminal is enlarged; un-zoomed, it brings the candidate's page on screen and leaves the
  // grid a grid. A key that sometimes changed the whole layout would be unpredictable.
  return zoomedUid(state) !== null ? { ...state, expanded: order[at] } : { ...state, page: Math.floor(at / PAGE_SIZE) };
}

/** The uid of the terminal `nextAttention` would move to, or null. Exported so the caller can
 *  also put the cursor there — in a plain grid that focus IS the visible "you are here". */
export function nextAttentionUid(
  state: GridState,
  order: readonly number[],
  statusByUid: Record<number, CellStatus>,
  fromUid: number | null = null,
): number | null {
  const at = nextCandidate(state, order, statusByUid, zoomedUid(state) ?? fromUid);
  return at === undefined ? null : order[at];
}

// The index in `order` of the next terminal worth going to, starting after `from`, or undefined
// when there is none.
//
// `from` matters more than it looks: without it the rotation always begins at index 0, so every
// press picks the same first candidate and the key appears dead after the first one. Zoomed,
// that origin is the enlarged cell; un-zoomed it has to be the focused one, which only the
// caller knows.
function nextCandidate(state: GridState, order: readonly number[], statusByUid: Record<number, CellStatus>, fromUid: number | null): number | undefined {
  if (order.length === 0) return undefined;
  const from = order.indexOf(fromUid ?? -1); // -1 when nothing is current => search starts at 0
  const rotated = order.map((_, i) => (from + 1 + i) % order.length);
  // The empty launch cell is not a terminal, so it is never somewhere to send anyone — and it
  // would otherwise be picked constantly, since a cell with no reported status reads as `idle`
  // below and a launcher never reports one. countByStatus skips it for the same reason.
  const occupied = new Set(state.cells.filter(isOccupied).map((c) => c.uid));
  for (const status of ATTENTION_ORDER) {
    // Absent = idle, the convention CellStatus documents: a cell whose status has not been
    // reported yet must not fall out of the search entirely.
    const at = rotated.find((i) => occupied.has(order[i]) && (statusByUid[order[i]] ?? "idle") === status);
    if (at !== undefined) return at;
  }
  return undefined;
}

// Zooming shows one cell big with the others as a filmstrip beside it, so it only means
// anything when there IS another cell to switch to. With a single occupied cell the expand button
// used to swap a working layout for a filmstrip containing nothing, and squeeze the
// terminal's status bar and input off the bottom of the viewport for no gain (#374).
//
// Collapsing is never refused: whatever a state got into, ⤡ has to get out of it.
export function toggleExpand(state: GridState, uid: number, order: readonly number[] = []): GridState {
  if (state.expanded === uid) return { ...state, expanded: null, page: pageHolding(order, uid, state.page) };
  if (runningCount(state.cells) < 2) return state;
  return { ...state, expanded: uid };
}

export function setSortMode(state: GridState, sortMode: SortMode): GridState {
  return { ...state, sortMode };
}

// Whether moveCell would actually reorder: not off either end, and never swapping a cell past
// the trailing launch cell (it stays last so "+ Terminal"/cancel keep working on it). Drives the
// enabled/disabled state of the roster's up/down menu items.
// `sealed` (any page pinned) applies the same rule the drag does: a swap across a page boundary
// would move a column into another workspace, which is what pinning promises will not happen.
export function canMoveCell(cells: Cell[], uid: number, dir: -1 | 1, sealed = false): boolean {
  const i = cells.findIndex((c) => c.uid === uid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cells.length) return false;
  // A reserved slot is not a neighbour to trade places with — swapping into one would move a
  // terminal out of its page's used run and leave a hole in the middle of the columns.
  if (isHole(cells[i]) || isHole(cells[j])) return false;
  if (sealed && pageOfIndex(i) !== pageOfIndex(j)) return false;
  return !(isLaunchCell(cells[j]) && j === cells.length - 1);
}
// Whether this grid's reorders are confined to a page, for callers that only hold the cells.
export const isSealed = (state: GridState): boolean => lastPinnedPage(state) >= 0;

// Manual reorder: swap a cell with its neighbour (dir -1 = left/up, +1 = right/down) in the
// flat list. A no-op wherever canMoveCell says the swap isn't allowed.
export function moveCell(state: GridState, uid: number, dir: -1 | 1): GridState {
  if (!canMoveCell(state.cells, uid, dir, isSealed(state))) return state;
  const i = state.cells.findIndex((c) => c.uid === uid);
  const cells = state.cells.slice();
  [cells[i], cells[i + dir]] = [cells[i + dir], cells[i]];
  return { ...state, cells };
}

// The zoomed cell's uid, or null when nothing is zoomed (or `expanded` is stale —
// points at a cell no longer in the list).
export const zoomedUid = (state: GridState): number | null =>
  state.expanded !== null && state.cells.some((c) => c.uid === state.expanded && !isHole(c)) ? state.expanded : null;

// Attention-first rank for the "auto" order, read as "who is holding ME up": the two states
// that block a turn first — approval and question are EQUAL, because which one is more urgent
// depends on the pane, not on the kind — then a pane that has died (nothing can be answered
// until it is relaunched), then finished-unreviewed, then the quiet ones. Working sinks below
// idle for the reason it always has: a pane mid-turn is the one place there is nothing to do.
// A shell pane never calls anyone, so it sits under working, above only an empty launch cell.
const RANK: Record<CellStatus, number> = { approval: 0, question: 0, disconnected: 1, unread: 2, idle: 3, working: 4, shell: 5 };
const LAUNCH_RANK = 6;
const HOLE_RANK = 7; // a reserved slot is not even a launcher — it sorts behind everything
const cellRank = (c: Cell, statusByUid: Record<number, CellStatus>): number => {
  if (isHole(c)) return HOLE_RANK;
  return isLaunchCell(c) ? LAUNCH_RANK : RANK[statusByUid[c.uid] ?? "idle"];
};

// Display order. "manual": the hand-arranged list as-is. "auto": a STABLE sort by
// attention rank — equal-rank cells keep their manual order, so a status change
// only floats that one cell to its bucket and doesn't reshuffle the rest.
export function orderCells(cells: Cell[], statusByUid: Record<number, CellStatus>, mode: SortMode): Cell[] {
  if (mode !== "auto") return cells;
  return cells
    .map((c, i) => ({ c, i }))
    .sort((a, b) => cellRank(a.c, statusByUid) - cellRank(b.c, statusByUid) || a.i - b.i)
    .map((x) => x.c);
}

// Cells in the on-screen view, in manual (base) order: while a cell is zoomed, the
// WHOLE list (so the filmstrip lines up every tab's terminal, live), otherwise just
// the active page's slice.
export const visibleCells = (state: GridState): Cell[] => (zoomedUid(state) !== null ? state.cells : pageSlice(state.cells, state.page));

// The cells to render. "auto" attention-sorts the WHOLE list first, then pages — so a
// waiting cell from any page floats onto the first page. This needs a status map that
// covers EVERY cell (incl. unmounted pages), or a status change on an off-screen page
// would (mis)read as idle; GridView feeds it the server's full session status. While
// zoomed the whole ordered list is shown (the filmstrip).
// The whole grid in display order.
//
// R1: un-pinned this is one attention sort across EVERY page — a blocked cell on page 3 floats
// onto page 1, which is the entire point of auto mode. A pinned page is a promise that its
// columns stay where they were put, and that float would break it, so once any page is pinned
// the sort runs INSIDE each page instead. Both are "attention first"; they differ only in how
// far a cell is allowed to travel to get there.
export function orderGrid(state: GridState, statusByUid: Record<number, CellStatus>): Cell[] {
  if (state.sortMode !== "auto") return state.cells;
  if (lastPinnedPage(state) < 0) return orderCells(state.cells, statusByUid, "auto");
  const out: Cell[] = [];
  for (let p = 0; p < pageCount(state.cells.length); p++) out.push(...orderCells(pageSlice(state.cells, p), statusByUid, "auto"));
  return out;
}

export const visibleOrdered = (state: GridState, statusByUid: Record<number, CellStatus>): Cell[] => {
  const ordered = orderGrid(state, statusByUid);
  return zoomedUid(state) !== null ? ordered : pageSlice(ordered, state.page);
};

export type StatusCounts = Record<CellStatus, number>;

// Tally occupied cells (a running session or command) by status — empty launchers are
// skipped. Powers the toolbar's at-a-glance "N need you" summary across ALL pages.
export function countByStatus(cells: Cell[], statusByUid: Record<number, CellStatus>): StatusCounts {
  const counts: StatusCounts = { approval: 0, question: 0, disconnected: 0, unread: 0, working: 0, idle: 0, shell: 0 };
  for (const c of cells) {
    if (isLaunchCell(c) || isHole(c)) continue;
    counts[statusByUid[c.uid] ?? "idle"]++;
  }
  return counts;
}

// Switch page: drop an abandoned trailing launch cell first and clear the zoom
// (zoom is scoped to a page). Selecting the already-active page is a no-op so it
// doesn't discard the open launch cell or zoom.
export function switchPage(state: GridState, page: number): GridState {
  if (page === state.page) return state;
  const open = trailingLaunchIndex(state);
  const dropped = open >= 0 && realCells(state.cells).length > 1 ? removeAt(state, open) : { cells: state.cells, nextUid: state.nextUid };
  return clampPage({ ...state, ...dropped, expanded: null, page });
}

const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
const asSortMode = (v: unknown): SortMode => (v === "auto" ? "auto" : "manual");
// Keep a persisted launcher only if well-formed; anything else drops to null so a
// reloaded cell reconnects as a plain (Claude) session instead of a broken launcher.
const asLauncher = (v: unknown): CellLauncher | null => {
  if (!isRecord(v) || typeof v.label !== "string") return null;
  if (v.shell === true) return { shell: true, label: v.label };
  return typeof v.index === "number" && Number.isInteger(v.index) && v.index >= 0 ? { index: v.index, label: v.label } : null;
};
// A cell entry is kept if its session/cwd are well-formed; uid is validated only to
// match the persisted `expanded` (it is renumbered below regardless).
const isCell = (c: unknown): c is Cell => {
  const o = c as Cell | null;
  return !!o && (o.session === null || isUuid(o.session)) && (o.cwd === null || typeof o.cwd === "string");
};

// Persisted page metadata. Unknown or malformed entries collapse to a plain page rather than
// failing the whole parse: a grid full of live sessions must never be lost over a tab name.
const asPages = (v: unknown): PageMeta[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const pages = v.slice(0, MAX_TERMINALS / PAGE_SIZE).map((entry): PageMeta => {
    if (!isRecord(entry)) return {};
    const label = typeof entry.label === "string" ? entry.label.trim().slice(0, MAX_PAGE_LABEL) : "";
    return { label: label || undefined, pinned: entry.pinned === true || undefined };
  });
  return pages.some((p) => p.label || p.pinned) ? pages : undefined;
};

export function parseGridState(raw: string | null): GridState | null {
  try {
    const parsed = JSON.parse(raw ?? "");
    if (!Array.isArray(parsed?.cells)) return null;
    // Keep only running cells (the trailing launch cell is ephemeral) and renumber
    // uids from position. Persisted uids are untrusted: duplicates would collide
    // v-for keys, and a near-MAX_SAFE_INTEGER value would overflow the nextUid
    // counter. uid is internal identity only, so a clean 0..n-1 space (nextUid =
    // count) is always safe and in range.
    // Reserved slots are kept alongside the running cells: they carry no session, but they ARE
    // the pinned pages' shape, and dropping them would silently un-pin every workspace on the
    // next reload.
    //
    // The two caps are separate on purpose. MAX_TERMINALS bounds TERMINALS — that is what it
    // means everywhere else in this file, where it is checked through runningCount, which has
    // never counted an empty slot. Applying it to the array would drop the tail, and the tail
    // is real sessions: a grid padded out by pinned pages would lose its last columns on
    // reload, silently. MAX_SLOTS is the separate bound on a hand-written blob's length;
    // reserveSlots re-derives the padding from `pages` below, so surplus holes cost nothing.
    let terminals = 0;
    const running = parsed.cells
      .filter(isCell)
      .filter((c: Cell) => c.session !== null || c.hole === true)
      .filter((c: Cell) => c.hole === true || ++terminals <= MAX_TERMINALS)
      .slice(0, MAX_SLOTS);
    const cells: Cell[] = running.map((c: Cell, i: number) =>
      c.hole === true
        ? holeCell(i)
        : {
            uid: i,
            session: c.session,
            cwd: c.cwd,
            launcher: asLauncher(c.launcher),
            agent: c.agent === "codex" ? "codex" : undefined,
            // Re-trimmed on the way in, not trusted: the blob is hand-editable, and a 10k-char
            // "name" would take the status strip apart on every pane in the workspace.
            name: typeof c.name === "string" ? cellName(c.name) : undefined,
          },
    );
    const expandedIdx = running.findIndex((c: Cell) => c.uid === parsed.expanded);
    const expanded = typeof parsed.expanded === "number" && expandedIdx >= 0 ? expandedIdx : null;
    const page = Number.isSafeInteger(parsed.page) && parsed.page >= 0 ? parsed.page : 0;
    const pages = asPages(parsed.pages);
    // reserveSlots re-derives the padding from `pages`, so a hand-edited or half-written blob
    // (holes without pins, pins without holes) still comes back as a consistent grid.
    return clampPage(ensureEntry(reserveSlots({ cells, expanded, page, nextUid: cells.length, sortMode: asSortMode(parsed.sortMode), pages })));
  } catch {
    return null;
  }
}

// Migrate the legacy single-grid shape ({ sessions, cwds, expanded:position }).
export function migrateLegacy(raw: string | null): GridState | null {
  try {
    const parsed = JSON.parse(raw ?? "");
    if (!Array.isArray(parsed?.sessions)) return null;
    const cells: Cell[] = [];
    parsed.sessions.forEach((s: unknown, i: number) => {
      if (isUuid(s)) cells.push({ uid: cells.length, session: s, cwd: typeof parsed.cwds?.[i] === "string" ? parsed.cwds[i] : null });
    });
    const expanded = typeof parsed.expanded === "number" && parsed.expanded >= 0 && parsed.expanded < cells.length ? cells[parsed.expanded].uid : null;
    return clampPage(ensureEntry({ cells, expanded, page: 0, nextUid: cells.length, sortMode: "manual" }));
  } catch {
    return null;
  }
}

export function initialState(curRaw: string | null, legacyRaw: string | null): { state: GridState; migrated: boolean } {
  const cur = parseGridState(curRaw);
  if (cur) return { state: cur, migrated: false };
  const migrated = migrateLegacy(legacyRaw);
  if (migrated) return { state: migrated, migrated: true };
  return { state: ensureEntry({ cells: [], expanded: null, page: 0, nextUid: 0, sortMode: "manual" }), migrated: false };
}

// Which status a cell sorts and tallies by.
//
// The precedence is the rule: the server's activity for the cell's SESSION wins, because it
// is the only source that knows a turn is blocked. A cell's own reported status is the
// fallback — command cells have no session id, and a just-launched cell has none yet — and
// idle is the floor.
//
// This feeds orderCells and countByStatus, so getting it backwards is not cosmetic: in auto
// mode a blocked cell on page 3 stops floating to page 1, which is the entire point of that
// mode, and the toolbar's "needs you" tally goes with it.
//
// TWO states invert that precedence, because they are things only the CELL can see. The
// server's row describes an agent's turn; it does not know that this browser's socket has
// dropped (`disconnected`), and it has no concept of a pane running a plain shell (`shell`).
// A pane whose socket died while its last row said "working" must not keep claiming to work.
const CELL_OWNED: ReadonlySet<CellStatus> = new Set<CellStatus>(["disconnected", "shell"]);

export function resolveCellStatus(
  cells: readonly { uid: number; session: string | null }[],
  bySession: ReadonlyMap<string, CellStatus>,
  byUid: Readonly<Record<number, CellStatus>>,
): Record<number, CellStatus> {
  const out: Record<number, CellStatus> = {};
  for (const cell of cells) {
    const own = byUid[cell.uid];
    if (own && CELL_OWNED.has(own)) {
      out[cell.uid] = own;
      continue;
    }
    const fromSession = cell.session ? bySession.get(cell.session) : undefined;
    out[cell.uid] = fromSession ?? own ?? "idle";
  }
  return out;
}

// The toolbar's grid-wide, at-a-glance tally. Two decisions, and the asymmetry is deliberate:
//
// The badge shows only when something is actually RUNNING or stuck — the quiet states are not
// counted there: a grid of nothing but idle and shell cells has nothing to triage, and
// surfacing the strip on every quiet session is noise. They ARE in the tooltip text, as the
// trailing part, because once the strip is up "how many are idle" is useful context.
//
// Order is fixed: the ones needing an answer first, then a dead pane, then unreviewed,
// working, and the quiet ones — the reading order for deciding which cell to look at.
export interface GridStatusSummary {
  show: boolean;
  title: string;
}

export function gridStatusSummary(counts: StatusCounts | null | undefined): GridStatusSummary {
  if (!counts) return { show: false, title: "" };
  const parts: string[] = [];
  if (counts.approval) parts.push(`${counts.approval} awaiting approval`);
  if (counts.question) parts.push(`${counts.question} asking`);
  if (counts.disconnected) parts.push(`${counts.disconnected} disconnected`);
  if (counts.unread) parts.push(`${counts.unread} done (review)`);
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.idle) parts.push(`${counts.idle} idle`);
  if (counts.shell) parts.push(`${counts.shell} shell`);
  const active = counts.approval + counts.question + counts.disconnected + counts.unread + counts.working;
  return { show: active > 0, title: parts.join(" · ") };
}
