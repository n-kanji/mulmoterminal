<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from "vue";
import TerminalGrid from "./TerminalGrid.vue";
import AppSettingsModal from "./AppSettingsModal.vue";
import AppToolbar from "./AppToolbar.vue";
import GuideLinks from "./GuideLinks.vue";
import { startCollectionChat } from "../composables/useChatLauncher";
import { router } from "../router";
import {
  initialState,
  addCell,
  addCellWithCwd,
  setSession,
  setCwd,
  setCellAgent,
  closeCell,
  toggleExpand,
  switchPage,
  runCommand,
  runScriptInNewCell,
  insertCellAfter,
  shellCell,
  launchInCell,
  setSortMode,
  moveCell,
  moveCellTo,
  canMoveCell,
  isSealed,
  moveZoom,
  toggleZoom,
  nextAttention,
  nextAttentionUid,
  orderGrid,
  pageSlice,
  realCells,
  pageLabel,
  isPagePinned,
  setPageLabel,
  togglePagePin,
  workspaceFromSearch,
  stateKeyFor,
  MAX_PAGE_LABEL,
  activityStatus,
  countByStatus,
  cancelableLaunchUid,
  pageCount,
  zoomedUid,
  runningCount,
  LEGACY_KEY,
  type GridState,
  type CellStatus,
  type Cell,
  resolveCellStatus,
  MAX_TERMINALS,
} from "./gridTabs";
import { gridShortcutFor, isEditableTarget, type GridShortcut } from "../composables/gridShortcut";
import { useCaptureKeydown } from "../composables/useCaptureKeydown";
import { getActiveKeymap } from "../composables/activeKeymap";
import { preferredLaunchDir } from "./launchDir";
import * as conn from "../composables/useTerminalConnections";
import { rosterCellsKey, staleCacheKeys } from "./rosterCache";
import type { RunCommand } from "./runCommand";
import { EMPTY_SESSION_META, isPrPhase, mergeSessionMeta, type PrPhase, type WorkPhase } from "./rosterPhase";
import { useGridActivity } from "../composables/useGridActivity";
import { registerNewTerminalHandler, type NewTerminalRequest } from "../composables/useNewTerminal";
import { registerAgentColumnHandler } from "../composables/useAgentColumn";
import { usePendingScript } from "../composables/usePendingScript";
import { reportActiveTerminals } from "../composables/useUnloadGuard";
import { useAppConfig } from "../composables/useAppConfig";
import { fetchDirConfig, invalidateDirConfig } from "../composables/useDirConfig";
import { usePubSub } from "../composables/usePubSub";
import type { LaunchAgent } from "../../common/launchAgent";

// The multi-terminal grid view, shown at /terminals. Leaving the grid is just a
// route push from the shared toolbar (Chat / Collections / a favorite), so there's
// no exit emit — App.vue renders this only while route.name === "terminals".

// One flat list of terminal cells; tabs are just pages (9 each) over it. Closing a
// cell reflows the list so terminals flow across page boundaries. Only the active
// page is mounted — other pages' terminals live on as background PTYs and
// reconnect when their page is shown again.
//
// Fork-local (iTerm2 mode, R1): `?ws=<name>` gives this browser window its OWN saved grid
// (`grid_v2:<name>`), so a second window is a second workspace rather than a second view of
// the same one. Sessions live on the server and are untouched by this — only which columns
// this window remembers. A window without `?ws` keeps the original key, and the pre-#883
// migration is only offered there: a named workspace starts empty on purpose.
const workspace = workspaceFromSearch(window.location.search);
const stateKey = stateKeyFor(workspace);
const init = initialState(localStorage.getItem(stateKey), workspace ? null : localStorage.getItem(LEGACY_KEY));
const state = ref<GridState>(init.state);
const persist = () => localStorage.setItem(stateKey, JSON.stringify(state.value));
// Write the migrated state before dropping the legacy key, so a reload between
// migration and the first change can't lose the sessions.
if (init.migrated) {
  persist();
  localStorage.removeItem(LEGACY_KEY);
}
watch(state, persist, { deep: true });

// Feed the tab-close guard: warn on close/reload while any cell runs a session or
// command (counts every page, not just the mounted one).
watch(
  () => runningCount(state.value.cells),
  (n) => reportActiveTerminals("grid", n),
  { immediate: true },
);

const pages = computed(() => pageCount(state.value.cells.length));

// Nothing has been launched yet (only the entry launch cell) — show the newcomer a
// pointer to the guide, cleared the moment any terminal starts.
const noRunningTerminals = computed(() => runningCount(state.value.cells) === 0);

// The "auto" order needs every cell's status, including cells on pages that aren't
// mounted. useGridActivity tracks each cell session's live attention state by id —
// including OFF-PAGE, dev-terminal cells that the /api/sessions list drops and its
// limit would cap — so a waiting cell on any page floats forward. The per-cell
// `statusByUid` (reported up while a cell is mounted) is the fallback for cells with
// no session id (command cells) and a just-launched cell before its id arrives.
const cellSessionIds = computed(() => state.value.cells.map((c) => c.session).filter((s): s is string => !!s));
const { activity: gridActivity } = useGridActivity(cellSessionIds);
const statusByUid = reactive<Record<number, CellStatus>>({});
const onStatus = (uid: number, s: CellStatus) => (statusByUid[uid] = s);
// Which cell the cursor is in, reported up from the grid. Un-zoomed this is the only notion of
// "the terminal I am on", so the keyboard shortcuts rotate from it.
const focusedCellUid = ref<number | null>(null);
const sessionStatus = computed(() => {
  const m = new Map<string, CellStatus>();
  for (const [id, a] of gridActivity) m.set(id, activityStatus(a.working, a.waiting, a.event));
  return m;
});
const statusForSort = computed<Record<number, CellStatus>>(() => resolveCellStatus(state.value.cells, sessionStatus.value, statusByUid));
// At-a-glance tally across ALL pages, for the toolbar summary.
const statusCounts = computed(() => countByStatus(state.value.cells, statusForSort.value));
const reorderable = computed(() => state.value.sortMode === "manual");
// In "auto" mode the whole list is attention-sorted; "manual" keeps the hand-arranged order.
// The ONE ordering both the grid and the cockpit roster read, so the two can't drift (#720).
const orderedCells = computed(() => orderGrid(state.value, statusForSort.value));
// The grid: while a cell is zoomed, render EVERY cell (the filmstrip lines up all tabs' terminals,
// live); otherwise just the active page's slice. A waiting cell from any page floats to the front.
const displayCells = computed(() => (zoomedUid(state.value) !== null ? orderedCells.value : pageSlice(orderedCells.value, state.value.page)));
// What actually gets rendered. A pinned page holds its width open with reserved slots (R1);
// they are page structure, not terminals, so they stay in `orderedCells` — where every page
// calculation reads their index — and are dropped here, letting the surviving columns widen.
const renderCells = computed(() => realCells(displayCells.value));
const expandedUid = computed(() => zoomedUid(state.value));

// The zoomed grid's cockpit roster: a text row per cell — status + dir + AI summary +
// current prompt + the agent's latest reply — so many parallel agents can be supervised
// past the 9-thumbnail grid, and the enlarged terminal is switched by picking a row.
type SessionMeta = { lastPrompt: string | null; aiTitle: string | null; lastResponse: string | null; workPhase: WorkPhase | null };
const sessionMeta = reactive(new Map<string, SessionMeta>());
// Single source of truth for the roster's prompt / summary / reply: each cell's on-disk
// transcript, read via GET /api/session/:id (always current, and works for sessions this
// MulmoTerminal doesn't manage — a plain `claude` you resumed emits nothing over pub/sub).
// Seed on appearance, then poll while the roster is on screen. Merge, never overwrite: a
// fetch that can't find the transcript (absent/mismatched cwd) returns nulls that must not
// wipe a value already shown. (The status badge is separate — it rides `statusForSort`.)
// The roster polls every few seconds, so a slow answer can still be in flight when the next
// one goes out. Only the newest may be applied: an older one describes a moment already
// overtaken, and its fields would put back what the newer answer replaced (#620).
const latestMetaSeed = new Map<string, number>();
async function seedMeta(id: string, cwd: string | null) {
  const seed = (latestMetaSeed.get(id) ?? 0) + 1;
  latestMetaSeed.set(id, seed);
  try {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await fetch(`/api/session/${id}${query}`);
    if (!res.ok || latestMetaSeed.get(id) !== seed) return;
    const d = (await res.json()) as Partial<SessionMeta>;
    if (latestMetaSeed.get(id) !== seed) return;
    sessionMeta.set(id, mergeSessionMeta(sessionMeta.get(id) ?? EMPTY_SESSION_META, d));
  } catch {
    // best-effort — the next poll retries
  }
}
const refreshAllMeta = () => state.value.cells.forEach((c) => c.session && void seedMeta(c.session, c.cwd));
// The PR workflow phase per directory (GET /api/pr-phase), shown in the roster beside the
// agent status. Keyed by cwd, not session — the phase is the branch's, so cells sharing a dir
// share one fetch. Best-effort and cached server-side, so the roster poll can re-fetch cheaply.
const phaseByCwd = reactive(new Map<string, PrPhase>());
const latestPhaseSeed = new Map<string, number>();
async function seedPhase(cwd: string) {
  const seed = (latestPhaseSeed.get(cwd) ?? 0) + 1;
  latestPhaseSeed.set(cwd, seed);
  try {
    const res = await fetch(`/api/pr-phase?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok || latestPhaseSeed.get(cwd) !== seed) return;
    const d = (await res.json()) as { phase?: unknown };
    if (latestPhaseSeed.get(cwd) !== seed) return;
    if (isPrPhase(d.phase)) phaseByCwd.set(cwd, d.phase);
  } catch {
    // best-effort — the next poll retries
  }
}
// Drop what no cell asks for any more, so a day of relaunching cells doesn't leave an entry
// behind for every session the grid ever showed.
// The directory chrome each roster row is tinted with — its configured header colour, so
// a row reads as the same directory as its terminal's header. Keyed by cwd (the config is
// the directory's, like the phase), fetched through the shared dir-config cache.
type RowChrome = { headerColor: string | null; headerTextColor: string | null };
const chromeByCwd = reactive(new Map<string, RowChrome>());
// A freshness token per cwd, exactly like latestPhaseSeed: two rapid dir-config edits can
// leave fetches resolving out of order, and without this a stale one would overwrite the
// newer colour.
const latestChromeSeed = new Map<string, number>();
async function seedChrome(cwd: string) {
  const seed = (latestChromeSeed.get(cwd) ?? 0) + 1;
  latestChromeSeed.set(cwd, seed);
  const config = await fetchDirConfig(cwd);
  if (latestChromeSeed.get(cwd) !== seed) return; // a newer seed for this cwd already won
  chromeByCwd.set(cwd, { headerColor: config.headerColor, headerTextColor: config.headerTextColor });
}
const refreshAllChrome = () => {
  const cwds = new Set(state.value.cells.map((c) => c.cwd).filter((c): c is string => c !== null));
  cwds.forEach((cwd) => void seedChrome(cwd));
};
// A user editing .mulmoterminal.json is announced on the dir-config channel; re-fetch that
// directory's chrome so an open roster recolours without a reload. The unsubscribe is kept
// and called on unmount so a remounted grid doesn't stack duplicate handlers.
const cwdOf = (data: unknown): string | null =>
  typeof data === "object" && data !== null && typeof (data as { cwd?: unknown }).cwd === "string" ? (data as { cwd: string }).cwd : null;
const unsubscribeDirConfig = usePubSub().subscribe("dir-config", (data) => {
  const cwd = cwdOf(data);
  if (cwd) {
    invalidateDirConfig(cwd);
    void seedChrome(cwd);
  }
});
onBeforeUnmount(unsubscribeDirConfig);

const forgetClosedCells = () => {
  const sessions = new Set(state.value.cells.map((c) => c.session).filter((s): s is string => !!s));
  const cwds = new Set(state.value.cells.map((c) => c.cwd).filter((c): c is string => c !== null));
  staleCacheKeys(sessionMeta.keys(), sessions).forEach((id) => {
    sessionMeta.delete(id);
    latestMetaSeed.delete(id);
  });
  staleCacheKeys(phaseByCwd.keys(), cwds).forEach((cwd) => {
    phaseByCwd.delete(cwd);
    latestPhaseSeed.delete(cwd);
  });
  staleCacheKeys(chromeByCwd.keys(), cwds).forEach((cwd) => {
    chromeByCwd.delete(cwd);
    latestChromeSeed.delete(cwd);
  });
};

// This watch runs whether or not the roster is on screen, and it is what fills sessionMeta,
// so the cleanup has to hang off it too — pruning only on the roster poll leaves the cache
// growing for anyone who never opens the roster.
// Keyed on the cwd as well as the session: a cell that keeps its session and only moves
// directory still retires a phaseByCwd entry, and the roster may be hidden for hours.
watch(
  () => rosterCellsKey(state.value.cells),
  () => {
    forgetClosedCells();
    refreshAllMeta();
  },
  { immediate: true },
);

const refreshAllPhases = () => {
  const cwds = new Set(state.value.cells.map((c) => c.cwd).filter((c): c is string => c !== null));
  cwds.forEach((cwd) => void seedPhase(cwd));
};

const refreshRoster = () => {
  forgetClosedCells();
  refreshAllMeta();
  refreshAllPhases();
  refreshAllChrome();
};
const ROSTER_POLL_MS = 4000;
let rosterTimer: ReturnType<typeof setInterval> | null = null;
// The roster is the sole consumer of this poll, and it's shown only while zoomed AND in list
// mode (the grid can be zoomed into the thumbnail strip instead). Poll exactly when it's visible.
const listModeOn = ref(true);
const rosterVisible = () => expandedUid.value !== null && listModeOn.value;
const startPoll = () => {
  if (!rosterVisible() || rosterTimer !== null) return;
  refreshRoster();
  rosterTimer = setInterval(refreshRoster, ROSTER_POLL_MS);
};
const stopPoll = () => {
  if (rosterTimer !== null) clearInterval(rosterTimer);
  rosterTimer = null;
};
const syncPoll = () => (rosterVisible() ? startPoll() : stopPoll());
// immediate: a reload that restores a zoomed grid sets expandedUid up front (no "change"
// to react to), so start here too, or the roster would freeze at its first snapshot.
watch(expandedUid, syncPoll, { immediate: true });
// The header's view toggle (shown only while zoomed) flips roster / thumbnail strip; the poll
// follows since the roster is its sole consumer.
const toggleListMode = () => {
  listModeOn.value = !listModeOn.value;
  syncPoll();
};
// Under <KeepAlive>, leaving /terminals deactivates (doesn't unmount) this view — pause the
// poll so it doesn't keep fetching in the background, and resume it on return.
onActivated(startPoll);
onDeactivated(stopPoll);
onBeforeUnmount(stopPoll);

// A cell with no session/prompt yet still gets a human label from what it IS running.
const fallbackLabel = (c: Cell): string | null => c.command?.label ?? c.launcher?.label ?? (c.session ? "starting…" : "empty");
const listRows = computed(() =>
  realCells(orderedCells.value).map((c) => {
    const meta = c.session ? sessionMeta.get(c.session) : undefined;
    return {
      uid: c.uid,
      cwd: c.cwd,
      agent: c.agent ?? "claude",
      status: statusForSort.value[c.uid] ?? ("idle" as CellStatus),
      summary: meta?.aiTitle ?? null,
      prompt: meta?.lastPrompt ?? null,
      response: meta?.lastResponse ?? null,
      fallback: fallbackLabel(c),
      phase: (c.cwd ? phaseByCwd.get(c.cwd) : undefined) ?? ("none" as PrPhase),
      workPhase: meta?.workPhase ?? null,
      headerColor: (c.cwd ? chromeByCwd.get(c.cwd)?.headerColor : null) ?? null,
      headerTextColor: (c.cwd ? chromeByCwd.get(c.cwd)?.headerTextColor : null) ?? null,
      // Decided here, against the same list `onMove` mutates. The roster renders the
      // hole-filtered cells, so asking it would enable a move the transform then refuses.
      canUp: canMoveCell(state.value.cells, c.uid, -1, isSealed(state.value)),
      canDown: canMoveCell(state.value.cells, c.uid, 1, isSealed(state.value)),
    };
  }),
);
// The cancelable trailing launch cell's uid (null when there's nothing to cancel):
// drives both the toolbar's cancel state and the launcher's in-cell close button.
const cancelUid = computed(() => cancelableLaunchUid(state.value));
const launchOpen = computed(() => cancelUid.value !== null);
// Session ids currently held by cells (across all pages — off-page cells stay
// live as background PTYs). A launcher uses this to warn before resuming a
// session that's already open, since attaching would detach the other cell.
const openSessionIds = computed(() => state.value.cells.map((c) => c.session).filter((s): s is string => s !== null));
// Directories that already have a running session (a launched cell), so the launcher
// can flag preset chips whose dir is in use elsewhere.
const openCwds = computed(() =>
  state.value.cells
    .filter((c) => c.session)
    .map((c) => c.cwd)
    .filter((c): c is string => c !== null),
);

function onAddTerminal() {
  if (runningCount(state.value.cells) >= MAX_TERMINALS && !launchOpen.value) return; // surfaced by the disabled button
  state.value = addCell(state.value);
}
const onSession = (uid: number, id: string) => {
  // Fork-local (iTerm2 mode): the quick-launched cell has its session — the one-shot is spent.
  if (uid === quickLaunchUid.value) quickLaunchUid.value = null;
  state.value = setSession(state.value, uid, id);
};

// Fork-local (iTerm2 mode): a preset chip in the permanent strip — one click opens a new
// column already running claude in that project (addCellWithCwd + TerminalCell autoLaunch).
const quickLaunchUid = ref<number | null>(null);
function onQuickLaunch(path: string) {
  const next = addCellWithCwd(state.value, path);
  if (next.uid < 0) return; // grid full — the chip does nothing rather than half-launching
  state.value = next.state;
  quickLaunchUid.value = next.uid;
}

// Fork-local (iTerm2 mode): chip reorder persistence — the toolbar owns the drag events
// (the chips render there now) and reports "move src to target's slot"; the splice and
// the config write live here with the rest of the preset handlers.
function onReorderPreset(fromPath: string, toPath: string) {
  const list = [...presets.value];
  const from = list.findIndex((p) => p.path === fromPath);
  const to = list.findIndex((p) => p.path === toPath);
  if (from < 0 || to < 0) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  void savePresets(list);
}

// Fork-local (iTerm2 mode): blocked ("needs you") count per directory across ALL pages,
// feeding the toolbar chip badges — an approval prompt on page 2 must still be findable.
const presetAlerts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {};
  for (const c of state.value.cells) {
    if (!c.cwd || statusForSort.value[c.uid] !== "blocked") continue;
    counts[c.cwd] = (counts[c.cwd] ?? 0) + 1;
  }
  return counts;
});

// Fork-local (iTerm2 mode): the strip's trailing "+" — the OS folder dialog, then a new
// column straight in the picked directory (the launch auto-records it as a preset, so a
// new project earns its chip by being opened once).
async function onPickAndLaunch() {
  try {
    const res = await fetch("/api/pick-file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: true }) });
    if (!res.ok) return;
    const data = await res.json();
    const dir = Array.isArray(data?.paths) ? data.paths.find((p: unknown): p is string => typeof p === "string") : undefined;
    if (dir) onQuickLaunch(dir);
  } catch {
    // best-effort — the native dialog is unavailable or the user canceled
  }
}
const onCwd = (uid: number, cwd: string) => (state.value = setCwd(state.value, uid, cwd));
const onAgent = (uid: number, agent: "claude" | "codex") => (state.value = setCellAgent(state.value, uid, agent));
// Pass the on-screen order so closing the zoomed cell stays zoomed on its filmstrip
// neighbour (previous, or next when it was the first) instead of collapsing the grid.
const onClose = (uid: number) =>
  (state.value = closeCell(
    state.value,
    uid,
    renderCells.value.map((c) => c.uid),
  ));
// Pass the on-screen order so releasing the zoom lands on the page holding the cell that was
// enlarged — including when the user got there by clicking a roster row or filmstrip thumbnail,
// which changes what is zoomed without touching the page.
const onToggleExpand = (uid: number) =>
  (state.value = toggleExpand(
    state.value,
    uid,
    orderedCells.value.map((c) => c.uid),
  ));
const onRun = (uid: number, command: RunCommand) => (state.value = runCommand(state.value, uid, command));
// A running cell's header Run menu: launch in a spare cell (next to it) so the session survives.
const onRunSpare = (uid: number, command: RunCommand) => (state.value = runScriptInNewCell(state.value, uid, command));
// The empty cell launcher picked a configured program (shell/codex/…): turn it into a
// persistent launcher cell. Its session id arrives later via onSession.
const onLaunch = (uid: number, pick: { index: number; label: string; cwd: string | null }) =>
  (state.value = launchInCell(state.value, uid, { index: pick.index, label: pick.label }, pick.cwd));
const onMove = (uid: number, dir: -1 | 1) => (state.value = moveCell(state.value, uid, dir));
// Fork-local (iTerm2 mode): header-drag reorder. Auto attention-sort would silently undo
// a hand-placed order on the next status change, so a drop while in auto mode switches
// to manual — dragging IS the statement "I want this order".
const onReorder = (uid: number, targetUid: number) => {
  const base = state.value.sortMode === "manual" ? state.value : setSortMode(state.value, "manual");
  state.value = moveCellTo(base, uid, targetUid);
};
const toggleSortMode = () => (state.value = setSortMode(state.value, state.value.sortMode === "auto" ? "manual" : "auto"));
const switchTo = (page: number) => (state.value = switchPage(state.value, page));

// Fork-local (iTerm2 mode, R1): the tab row is the WHOLE workspace UI. Naming and pinning are
// folded into the buttons that were already there — double-click to rename, right-click to pin
// — because a second toolbar row costs every column its most valuable resource, readable lines.
// The tooltip carries the two gestures so they are not folklore.
const tabTitle = (page: number) =>
  `${pageLabel(state.value, page)} — click to switch, double-click to rename, right-click to ${isPagePinned(state.value, page) ? "unpin" : "pin (hold this page's columns)"}`;
const renamingPage = ref<number | null>(null);
const renameDraft = ref("");
// A function ref, not a string one: the input lives inside the tabs' v-for, where Vue collects
// string refs into an array even though only one input is ever rendered.
const renameInput = ref<HTMLInputElement | null>(null);
const bindRenameInput = (el: unknown) => (renameInput.value = el instanceof HTMLInputElement ? el : null);
function startRename(page: number) {
  renamingPage.value = page;
  renameDraft.value = state.value.pages?.[page]?.label ?? "";
  void nextTick(() => renameInput.value?.select());
}
function commitRename() {
  const page = renamingPage.value;
  if (page === null) return;
  renamingPage.value = null;
  state.value = setPageLabel(state.value, page, renameDraft.value);
}
const cancelRename = () => (renamingPage.value = null);
const togglePin = (page: number) => (state.value = togglePagePin(state.value, page));

// A script the single view's terminal-header Run menu handed off: run it in a spare
// cell now that the grid (where command cells live) is mounted.
const { takePending } = usePendingScript();
const NO_ORIGIN_UID = -1; // no triggering cell (uids are >= 0) → insertCellAfter appends at the end
onMounted(() => {
  const command = takePending();
  if (command) state.value = runScriptInNewCell(state.value, NO_ORIGIN_UID, command);
});

// The header "new terminal" button ($SHELL) opens a cell next to the one that triggered it.
// GridView is cached by <KeepAlive>, so register the opener only while ACTIVE and drop it on
// deactivate — otherwise a button press from the single view would silently mutate this hidden
// grid instead of routing here. openTerminalAt then queues + navigates while we're deactivated.
const SLOT_UID_RE = /^cell-(\d+)$/;
let offNewTerminal: (() => void) | null = null;
// Each kind is already expressible as a cell: a shell is a shell launcher, codex is marked
// with `agent`, and Claude is the plain default. The session id arrives from the server once
// the cell opens its socket, so all three persist and reconnect like any other cell.
const cellForAgent = (cwd: string, agent: LaunchAgent | undefined): Omit<Cell, "uid"> => {
  if (agent === "claude") return { session: null, cwd };
  if (agent === "codex") return { session: null, cwd, agent: "codex" };
  return shellCell(cwd);
};

const openNewTerminal = ({ cwd, afterSlotKey, agent }: NewTerminalRequest) => {
  const match = afterSlotKey?.match(SLOT_UID_RE);
  const afterUid = match ? Number(match[1]) : NO_ORIGIN_UID;
  state.value = insertCellAfter(state.value, afterUid, cellForAgent(cwd, agent));
};
const detachNewTerminal = () => {
  offNewTerminal?.();
  offNewTerminal = null;
};
onActivated(() => (offNewTerminal = registerNewTerminalHandler(openNewTerminal)));
onDeactivated(detachNewTerminal);
onBeforeUnmount(detachNewTerminal);

// Fork-local (iTerm2 mode, R8): an agent asked for a column of its own
// (POST /api/workspace/column). Registered on the same ACTIVE-only lifecycle as the opener
// above, and served by the preset chip's path — the column arrives already running claude,
// which is the point of the request; a launch form waiting for a human would not be a
// self-drive API. Its first turn (if any) is typed by the server at spawn.
let offAgentColumn: (() => void) | null = null;
const detachAgentColumn = () => {
  offAgentColumn?.();
  offAgentColumn = null;
};
onActivated(() => (offAgentColumn = registerAgentColumnHandler(({ cwd }) => onQuickLaunch(cwd))));
onDeactivated(detachAgentColumn);
onBeforeUnmount(detachAgentColumn);

// Server config: the default workspace dir + the auto-recorded dir presets + sound.
const { defaultCwd, home, presets, launchers, loadConfig, recordPreset, removePreset, savePresets } = useAppConfig();
const showSettings = ref(false);
onMounted(loadConfig);

function closeSettings() {
  showSettings.value = false;
}

// Page Up / Page Down walk the zoom between terminals (#829). Listened for on `window` in the
// CAPTURE phase because xterm binds keydown on its own textarea: capture runs first, so the
// key can be claimed before the terminal turns it into a page-forward escape sequence.
function onShortcutKey(e: KeyboardEvent) {
  if (showSettings.value) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (target && isEditableTarget(target.tagName, Array.from(target.classList))) return;
  const shortcut = gridShortcutFor(getActiveKeymap(), e, expandedUid.value !== null);
  if (!shortcut) return;
  e.preventDefault();
  e.stopPropagation();
  runShortcut(shortcut);
}

// gridShortcutFor has already refused the actions that need a terminal to act ON while
// un-zoomed. The ones that reach here un-zoomed are the ways IN: `terminal-new`, plus
// `zoom-toggle` / `next-attention`, which pick the cell to enlarge themselves.
function runShortcut(shortcut: GridShortcut) {
  // The FULL ordered list, not `displayCells` — which un-zoomed is only the current page.
  // Both matter: these helpers derive `page` from the index, so a page slice would send an
  // entry action to page 0 from any other tab, and `next-attention` could not reach a cell
  // calling from another page even though the toolbar counts those.
  const order = orderedCells.value.map((c) => c.uid);
  const uid = expandedUid.value;
  if (shortcut === "zoom-next" || shortcut === "zoom-prev") {
    state.value = moveZoom(state.value, order, shortcut === "zoom-next" ? 1 : -1);
  } else if (shortcut === "zoom-toggle") {
    const wasZoomed = expandedUid.value;
    state.value = toggleZoom(state.value, order, focusedCellUid.value);
    // Keep the cursor on the same terminal through both directions: enlarging focuses the cell
    // that was selected, collapsing focuses the one that WAS enlarged, so the grid selection is
    // where the user just was instead of wherever focus happened to be before.
    const target = expandedUid.value ?? wasZoomed;
    if (target !== null) void nextTick(() => conn.focus(`cell-${target}`));
  } else if (shortcut === "next-attention") {
    // Focus the terminal it moves to, not just the state. In a plain grid nothing else shows
    // WHICH cell was picked — the focused cell lifts, and the cursor lands where the user is
    // being sent, so the next thing they type goes to the terminal that called them.
    const target = nextAttentionUid(state.value, order, statusForSort.value, focusedCellUid.value);
    state.value = nextAttention(state.value, order, statusForSort.value, focusedCellUid.value);
    if (target !== null) void nextTick(() => conn.focus(`cell-${target}`));
  } else if (shortcut === "terminal-new") {
    onAddTerminal();
  } else if (shortcut === "terminal-new-adjacent" && uid !== null) {
    state.value = insertCellAfter(state.value, uid, shellCell(adjacentCwd(uid)));
  } else if (shortcut === "terminal-close" && uid !== null) {
    onClose(uid);
  }
}

// The dir a new adjacent terminal opens in: the one the current terminal is running in, which
// is what "split this terminal" means everywhere else. Falling back through preferredLaunchDir
// rather than straight to defaultCwd keeps this on the SAME rule the launch form uses — it also
// tries the most recent cwd preset, which a cell with no recorded dir would otherwise skip.
const adjacentCwd = (uid: number): string =>
  preferredLaunchDir({
    initialCwd: state.value.cells.find((c) => c.uid === uid)?.cwd,
    presets: presets.value,
    defaultCwd: defaultCwd.value,
  });
useCaptureKeydown(onShortcutKey);

// Launch the config skill in a new auto-running session and switch to the single view so it shows
// (the grid has no single active session). The skill then asks which directory / batch.
function configureAppearance() {
  closeSettings();
  router.push({ name: "chat" });
  void startCollectionChat("/mulmoterminal-config");
}
</script>

<template>
  <div class="flex flex-col h-screen w-screen overflow-hidden">
    <AppToolbar
      :add-terminal-active="launchOpen"
      :auto-sort="state.sortMode === 'auto'"
      :status-counts="statusCounts"
      :show-view-toggle="expandedUid !== null"
      :list-mode="listModeOn"
      :presets="presets"
      :preset-alerts="presetAlerts"
      @add-terminal="onAddTerminal"
      @toggle-sort="toggleSortMode"
      @toggle-view="toggleListMode"
      @settings="showSettings = true"
      @quick-launch="onQuickLaunch"
      @remove-preset="removePreset"
      @reorder-preset="onReorderPreset"
      @pick-launch="onPickAndLaunch"
    />
    <nav
      v-if="pages > 1 && expandedUid === null"
      class="flex-none flex items-center gap-1 h-[30px] px-4 bg-panel border-b border-border"
      aria-label="Grid tabs"
    >
      <template v-for="p in pages" :key="p">
        <input
          v-if="renamingPage === p - 1"
          :ref="bindRenameInput"
          v-model="renameDraft"
          class="border border-accent bg-base text-fg font-mono text-xs w-[104px] py-[3px] px-2 rounded-md outline-none"
          :maxlength="MAX_PAGE_LABEL"
          aria-label="Page name"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <button
          v-else
          class="grid-tab border border-border bg-base text-muted font-mono text-xs min-w-[28px] py-[3px] px-2 rounded-md cursor-pointer inline-flex items-center gap-1 hover:bg-hover hover:text-fg aria-pressed:bg-hover aria-pressed:text-fg aria-pressed:border-accent"
          :aria-pressed="p - 1 === state.page"
          :title="tabTitle(p - 1)"
          @click="switchTo(p - 1)"
          @dblclick="startRename(p - 1)"
          @contextmenu.prevent="togglePin(p - 1)"
        >
          <span v-if="isPagePinned(state, p - 1)" class="material-symbols-outlined text-[13px] leading-none">keep</span>
          {{ pageLabel(state, p - 1) }}
        </button>
      </template>
    </nav>
    <TerminalGrid
      class="flex-1 min-h-0 min-w-0"
      :cells="renderCells"
      :expanded-uid="expandedUid"
      :auto-launch-uid="quickLaunchUid"
      :list-rows="listRows"
      :cancel-uid="cancelUid"
      :default-cwd="defaultCwd"
      :presets="presets"
      :launchers="launchers"
      :home="home"
      :reorderable="reorderable"
      :open-session-ids="openSessionIds"
      :open-cwds="openCwds"
      :list-mode="listModeOn"
      @session="onSession"
      @agent="onAgent"
      @cwd="onCwd"
      @record-cwd="recordPreset"
      @remove-preset="removePreset"
      @close="onClose"
      @toggle-expand="onToggleExpand"
      @focus-cell="focusedCellUid = $event"
      @run="onRun"
      @run-spare="onRunSpare"
      @launch="onLaunch"
      @move="onMove"
      @reorder="onReorder"
      @status="onStatus"
    />
    <footer v-if="noRunningTerminals" class="flex-none border-t border-border bg-panel px-4 py-2 text-center">
      <GuideLinks />
    </footer>
    <AppSettingsModal v-if="showSettings" @configure-appearance="configureAppearance" @close="closeSettings" />
  </div>
</template>
