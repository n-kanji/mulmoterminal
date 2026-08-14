<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, useTemplateRef } from "vue";
import TerminalView from "./Terminal.vue";
import { usePubSub } from "../composables/usePubSub";
import { useDirConfig } from "../composables/useDirConfig";
import { useGitStatus } from "../composables/useGitStatus";
import { formatCwd, worktreeLabel } from "./cwdDisplay";
import { isCellContext, isCellUsage, type CellContext, type CellUsage } from "./cellPayload";
import { unsavedWork } from "./unsavedWork";
import { relativeTime as relativeTimeFrom, usageBadge } from "./cellDisplay";
import { applyActivityPush } from "./cellActivity";
import { preferredLaunchDir, shouldSyncLaunchDir } from "./launchDir";
import { headerStyleFor, cellStyleFor } from "./cellHeaderStyle";
import DirBadge from "./DirBadge.vue";
import GitBranchChip from "./GitBranchChip.vue";
import ModelContextBadge from "./ModelContextBadge.vue";
import ModelPicker from "./ModelPicker.vue";
import type { LaunchChoice } from "./wsUrl";
import type { RunCommand } from "./runCommand";
import { useHeaderButtons } from "../composables/useHeaderButtons";
import TimelineOverlay from "./TimelineOverlay.vue";
import CockpitHeader from "./CockpitHeader.vue";
import CellChromeButtons from "./CellChromeButtons.vue";
import type { CwdPreset } from "./presets";
import type { Launcher, LaunchPick } from "./launchers";
import { activityStatus, CELL_DRAG_MIME, MAX_CELL_NAME, type CellStatus } from "./gridTabs";
import { paneStateWord, type WaitKind } from "../../common/paneState";
import { freshnessOf } from "./paneFreshness";
import { connView, insertText as insertIntoSlot } from "../composables/useTerminalConnections";
import {
  CELL_STATUS,
  CELL_STRIP,
  CELL_STRIP_DOT,
  CELL_STRIP_MAIN,
  CELL_STRIP_WORD,
  FRESHNESS_DOT,
  FRESHNESS_TITLE,
  HEADER_STATUS,
  STATUS_CLASS,
  STATUS_LABEL,
  STRIP_DOT,
  STRIP_STATUS,
} from "./cellStatusStyles";
import { dragCarriesFiles, dropTextFromUriList, toInsertText, toShellArg } from "./dropPaths";
import { IMAGE_PICKER_ACCEPT, imageFilesFrom, pastedImageFile, pasteFailureLabel, uploadImageFiles, uploadPastedImage } from "../composables/usePasteImage";
import type { GridCellEmits, GridCellProps } from "./gridCell";
import { shouldZoomOnHeaderClick } from "./cellHeaderZoom";
import { CELL_ACTIONS, CELL_BTN, CELL_BTN_BOX, CELL_BTN_INK, CELL_BTN_SIZE, CELL_HEADER_ZOOMABLE, CELL_TERM } from "./cellChromeClasses";
import { handoffTargets, pullLastTurn, type HandoffTarget } from "../composables/useHandoff";
import { copyLastTurnPart, copyOutcomeLabel, type TurnPart } from "../composables/useCopyTurn";
import { runOneExchange, liveCrossTalkDeps } from "../composables/useCrossTalk";
import { outcomeMessage } from "../composables/exchangeRules";
import { worktreeFailureMessage } from "./cellChromeRules";

// How long a handoff failure stays on the cell before it clears itself.
const ASK_MSG_MS = 4000;

const termRef = useTemplateRef<InstanceType<typeof TerminalView>>("termRef");

// Clicking the header background zooms this cell (mirrors clicking the terminal body) —
// in the tiled grid and as a filmstrip thumbnail alike. Only the already-expanded cell
// stays inert (restore via the restore button). Header buttons keep their action.
function onHeaderClick(event: MouseEvent) {
  if (shouldZoomOnHeaderClick(event.target, props.expanded)) emit("toggle-expand");
}

// Fork-local (iTerm2 mode): the header doubles as the drag handle for column reorder.
// CELL_DRAG_MIME (gridTabs) keeps this drag distinguishable from a FILE drag — dropping
// a file onto a terminal inserts its path (an upstream feature) and must keep working.
function onHeaderDragStart(e: DragEvent) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(CELL_DRAG_MIME, String(props.uid));
  e.dataTransfer.effectAllowed = "move";
}

// `expanded` reflects whether this cell is zoomed to fill the grid (parent owns
// the state). `initialSessionId` resumes a session on mount (reload restore).
// `initialCwd` is this cell's persisted working dir; `defaultCwd` is the server
// default used to prefill the launch form; `presets` are quick-pick dirs; `home`
// is the server home dir (to anchor the header path on ~).
const props = defineProps<
  GridCellProps & {
    // The grid cell's stable uid — the durable-connection slot key for this cell's
    // terminal, so flipping to an off-page tab detaches the view without reaping the PTY.
    uid: number;
    initialSessionId: string | null;
    initialCwd: string | null;
    // The persisted agent for this cell: "codex" reconnects via /ws/codex on reload; absent
    // (or "claude") resumes as a normal Claude session.
    initialAgent?: "codex" | null;
    defaultCwd: string | null;
    presets: CwdPreset[];
    // Configured launch commands (shell/codex/…) offered next to Claude in this launcher.
    launchers?: Launcher[];
    // Session ids open in other grid cells. Resuming one of them would detach that
    // cell, so the launcher flags such rows and confirms before opening.
    openSessionIds?: string[];
    // Dirs with a running session in another cell, so the launcher can tint preset
    // chips whose dir is already in use.
    openCwds?: string[];
    // An added (not the sole entry) launcher: show a close button to dismiss it before launching.
    cancellable?: boolean;
    // Manual sort mode: show move buttons to swap this cell with its neighbour.
    reorderable?: boolean;
    // Fork-local (iTerm2 mode): a toolbar preset chip opened this cell — launch claude
    // in initialCwd immediately on mount, skipping the launcher form.
    autoLaunch?: boolean;
    // Fork-local (iTerm2 mode, R10): the operator's own name for this pane, persisted in the
    // grid state. Null/absent = unnamed, and the strip shows the AI summary as before.
    name?: string | null;
    // Fork-local (iTerm2 mode, R12): this cell was opened by another cell's Fork button —
    // the session id to branch from. Consumed once (see forkFrom below).
    initialFork?: string | null;
  }
>();
const emit = defineEmits<
  GridCellEmits & {
    // `record-cwd`: auto-record a fresh launch's server-confirmed cwd as a preset.
    // `remove-preset`: drop a preset (its close button) from the shared list — value is the path.
    // `rename`: the operator's own name for this pane (R10); an empty value clears it.
    (e: "session" | "cwd" | "record-cwd" | "remove-preset" | "rename", value: string): void;
    // `run` launches in THIS (empty) cell from the launcher; `runSpare` is the running
    // terminal's header menu, which must NOT replace the session — it runs in a new cell.
    (e: "run" | "runSpare", value: RunCommand): void;
    // The user picked a configured launcher (shell/codex/…) to run in this empty cell.
    (e: "launch", value: LaunchPick): void;
    // The agent chosen (Claude/Codex) for this fresh launch, so the grid persists it.
    (e: "agent", value: "claude" | "codex"): void;
    // Fork-local (iTerm2 mode, R12): branch this cell's conversation into a new column
    // beside it. The grid owns cell creation, so the cell only asks.
    (e: "fork"): void;
  }
>();

// A cell with a persisted session relaunches (resumes) on mount; otherwise it
// starts empty and lazy-launches when the user picks a dir and clicks Start.
const launched = ref(props.initialSessionId !== null);
const sessionId = ref<string | null>(props.initialSessionId);
// The agent this cell runs (Claude by default). Fixed once launched; restored from the
// persisted cell on reload so a codex cell reconnects to /ws/codex.
const agent = ref<"claude" | "codex">(props.initialAgent === "codex" ? "codex" : "claude");
const connectKey = ref(0);
// Fork-local (iTerm2 mode, R12): the session this cell branches from, while it has none of
// its own. Cleared in onSession — the server has named the branch, so every later connect
// (reconnect, reload) resumes THAT id instead of forking the source again.
const forkFrom = ref<string | null>(props.initialFork ?? null);

// The directory this terminal runs in (shown in the header, sent to the server).
const cwd = ref<string | null>(props.initialCwd ?? props.defaultCwd);
// Per-directory overrides (<cwd>/.mulmoterminal.json): pins this cell's terminal
// palette and shows a project badge. Re-fetched when the effective cwd changes.
const { config: dirConfig } = useDirConfig(cwd);
const headerStyle = computed(() => headerStyleFor(dirConfig.value.headerColor, dirConfig.value.headerTextColor));
const cellStyle = computed(() =>
  cellStyleFor(dirConfig.value.cellColor, dirConfig.value.cellBorderColor, dirConfig.value.dotColor, dirConfig.value.buttonColor),
);
// Live git status (branch/dirty/ahead·behind) for the header chip. `refreshGit`
// is called alongside loadDiff() so a finished turn's changes show immediately.
const { status: gitStatus, refresh: refreshGit } = useGitStatus(cwd);
// Activity timeline overlay (the header history button) — only meaningful for a Claude session.
const timelineOpen = ref(false);
// A small filmstrip thumbnail (some OTHER cell is zoomed): strip the header to just
// dir + what it's doing + a zoom button, and hide the second (terminal) header row.
const filmstrip = computed(() => !!props.zoomed && !props.expanded);
// The launch form's editable dir. Prefer this cell's persisted dir, then the most
// recent preset, then the server default. Both `presets` and `defaultCwd` arrive
// async from /api/config, so the watcher upgrades a still-pristine field once they
// load (cold-load / open-before-config) — it never clobbers the user's own edit.
const dirInput = ref(preferredLaunchDir(props));
const dirTouched = ref(false); // true once the user types in / picks a dir
watch([() => props.presets, () => props.defaultCwd], () => {
  if (cwd.value === null && props.defaultCwd) cwd.value = props.defaultCwd;
  if (!shouldSyncLaunchDir({ hasInitialCwd: !!props.initialCwd, touched: dirTouched.value, launched: launched.value })) return;
  const preferred = preferredLaunchDir({ presets: props.presets, defaultCwd: props.defaultCwd });
  if (preferred && dirInput.value !== preferred) dirInput.value = preferred;
});

// Live activity for this session, from the "sessions" pub/sub channel.
const working = ref(false);
const waiting = ref(false);
// The hook that set the current state ("Stop" | "Notification" | …). Splits `waiting`
// into unread (Stop) vs blocked-on-the-user (Notification) — see activityStatus.
const activityEvent = ref<string | null>(null);
// Which KIND of Notification is blocking: an approval the operator can answer yes/no, or a
// question they have to read. Classified server-side from the hook's notification_type.
const waitKind = ref<WaitKind | null>(null);
// Epoch ms of the last state change, for the dot's freshness colour. Null = never reported.
const lastActivityAt = ref<number | null>(null);
// Why this pane exists, as the operator or the agent in it wrote it (PUT /api/session/:id/
// mission). Independent of the turn-by-turn state — that is the point: the summary goes stale
// every turn, this does not.
const mission = ref<string | null>(null);
const lastPrompt = ref<string | null>(null);
// A cheap-model summary of the recent turns (issue #316). Preferred over lastPrompt in
// the header because a raw follow-up prompt goes stale ("ok") or context-dependent once
// the session is a back-and-forth. Null until the server generates/pushes one.
const aiTitle = ref<string | null>(null);

// Cumulative token usage for this session (from /api/session/:id, refreshed when a
// turn finishes). Null until first fetched.
const usage = ref<CellUsage | null>(null);

// The running model + current-turn context size (from /api/session/:id), for the
// model/context badge. Null until first fetched; model may be null with no assistant
// turn yet, which hides the badge.
const context = ref<CellContext | null>(null);

// Configurable row-1 info chips (GET /api/header `chips`). `null` = unconfigured ⇒ the default order/set
// below, so with no config the header is exactly as before. When configured, the built-ins listed here
// (git/diff/ctx/usage) render in that order — others are hidden — and custom chips render as text. `dir`,
// the project badge, the status dot/activity, and the row-2 tools timeline stay structural.
const { chips: headerChips } = useHeaderButtons({ cwd, session: sessionId, agent, model: computed(() => context.value?.model ?? null) });
const ROW1_BUILTIN_CHIPS = new Set(["git", "diff", "ctx", "usage"]);
// Fork-local (iTerm2 mode): usage stays out of the default header — the token-transfer chip
// answered a question the operator never asks. ctx (the model) is BACK in (R14): the strip's
// right-edge badge disappears the moment the strip fills with mission + summary, and "which
// model is this pane on" must be answerable from the header row too. A directory config that
// explicitly lists chips still wins.
const DEFAULT_CELL_CHIP_IDS = ["git", "diff", "ctx"];
interface CellChipView {
  key: string;
  builtin: string | null;
  custom: { label: string; text: string } | null;
}
const cellChips = computed<CellChipView[]>(() => {
  const configured = headerChips.value;
  if (configured === null) return DEFAULT_CELL_CHIP_IDS.map((id) => ({ key: `b-${id}`, builtin: id, custom: null }));
  const views: CellChipView[] = [];
  // Key by index so a config that repeats a built-in (sanitizeChips allows duplicates) can't collide.
  configured.forEach((chip, i) => {
    if (chip.kind === "custom") views.push({ key: `c-${i}`, builtin: null, custom: { label: chip.label, text: chip.text } });
    else if (ROW1_BUILTIN_CHIPS.has(chip.id)) views.push({ key: `b-${i}-${chip.id}`, builtin: chip.id, custom: null });
  });
  return views;
});

const { subscribe, onReconnect } = usePubSub();
let unsubscribe: (() => void) | null = null;
let offReconnect: (() => void) | null = null;

interface ActivityMsg {
  id: string;
  working?: boolean;
  waiting?: boolean;
  event?: string | null;
  lastPrompt?: string | null;
  aiTitle?: string | null;
}
const isActivityMsg = (d: unknown): d is ActivityMsg => typeof d === "object" && d !== null && "id" in d;

// Bumped on every applied activity change. A seed (loadInitial) reads the state as of the
// moment it ASKED; a live push that lands while it is in flight is newer, so the seed must
// not overwrite it — the #620 race, scoped to one cell.
let activityGen = 0;
// Seeds also overlap each other — mount racing a reconnect, or reconnect flaps. Only the
// newest may apply; an older one, even resolving last, describes a moment already overtaken.
let latestSeed = 0;
// The usage/context badges are filled from two async sources — a seed (loadInitial) and
// refreshUsage on turn end — so back-to-back turns can leave two /api/session reads in
// flight at once. Neither path bumps latestSeed for badges, so a stale read resolving last
// would clobber the newer numbers. This token makes the newest badge fetch win. (#620.)
let latestBadgeReq = 0;
function applyActivity(d: ActivityMsg) {
  activityGen++;
  const next = applyActivityPush(
    {
      working: working.value,
      waiting: waiting.value,
      event: activityEvent.value,
      waitKind: waitKind.value,
      lastActivityAt: lastActivityAt.value,
      mission: mission.value,
      lastPrompt: lastPrompt.value,
      aiTitle: aiTitle.value,
    },
    d,
  );
  working.value = next.working;
  waiting.value = next.waiting;
  activityEvent.value = next.event;
  waitKind.value = next.waitKind;
  lastActivityAt.value = next.lastActivityAt;
  mission.value = next.mission;
  lastPrompt.value = next.lastPrompt;
  aiTitle.value = next.aiTitle;
}

// This session's detail, or nothing to apply. Nothing covers three cases the callers all
// treat the same: the read failed (best-effort — pub/sub fills it in on the next event), the
// server refused, or the cell has since closed or switched session, in which case applying
// the answer would leak the old session's state into the new one.
//
// The cell's dir goes along so the server can read the transcript and report the session's
// most recent prompt rather than the bare id after a resume.
type SessionDetail = ActivityMsg & { usage?: unknown; context?: unknown };

async function fetchSessionDetail(id: string): Promise<SessionDetail | null> {
  try {
    const q = cwd.value ? `?cwd=${encodeURIComponent(cwd.value)}` : "";
    const res = await fetch(`/api/session/${id}${q}`);
    if (!res.ok) return null;
    const data = await res.json();
    return id === sessionId.value ? data : null;
  } catch {
    return null;
  }
}

// Cleared rather than kept when the shape is wrong: the server always sends both
// (EMPTY_USAGE / EMPTY_CONTEXT when it has nothing to report), so an unrenderable one means
// something is actually broken — and a badge showing the previous turn's numbers as if they
// were current is the failure the guards exist to stop.
function applyBadges(data: SessionDetail) {
  usage.value = isCellUsage(data.usage) ? data.usage : null;
  context.value = isCellContext(data.context) ? data.context : null;
}

async function loadInitial(id: string) {
  const seedId = ++latestSeed;
  const badgeReq = ++latestBadgeReq;
  const genBeforeFetch = activityGen;
  const data = await fetchSessionDetail(id);
  // A newer seed superseded this one while it was in flight: its answer is the current one,
  // so this stale snapshot applies neither activity nor badges.
  if (!data || seedId !== latestSeed) return;
  // A live push landed while we were fetching: it is newer than this snapshot, so keep it
  // and don't let a stale seed put the cell back to idle. Badges have no such push, so they
  // always refresh — unless a newer badge fetch has since superseded this one.
  if (activityGen === genBeforeFetch) applyActivity(data);
  if (badgeReq === latestBadgeReq) applyBadges(data);
}

// Refresh ONLY the token usage (not the live activity — that's pub/sub's job). Called
// when a turn finishes, so the badge reflects the just-completed turn.
async function refreshUsage() {
  const id = sessionId.value;
  if (!id) return;
  const badgeReq = ++latestBadgeReq;
  const data = await fetchSessionDetail(id);
  if (data && badgeReq === latestBadgeReq) applyBadges(data);
}

onMounted(() => {
  unsubscribe = subscribe("sessions", (d) => {
    if (isActivityMsg(d) && d.id === sessionId.value) applyActivity(d);
  });
  // A dropped socket misses the pushes sent while it was down, and this cell's status is
  // derived state that pub/sub only replays room membership for — not the missed events. So
  // on reconnect re-seed from the authoritative snapshot (guarded by activityGen), or a turn
  // that started during the outage stays showing idle until it ends.
  offReconnect = onReconnect(() => {
    if (sessionId.value) loadInitial(sessionId.value);
  });
  if (sessionId.value) {
    loadInitial(sessionId.value);
    loadDiff(); // a resumed worktree cell shows its diff on restore
  } else {
    loadResumable();
    loadScripts();
    loadWorktrees();
  }
});
onUnmounted(() => {
  unsubscribe?.();
  offReconnect?.();
  if (resumableTimer) clearTimeout(resumableTimer);
});

// Set when the user starts a FRESH session from the launcher, so the next server
// cwd report is recorded as a preset — but a reconnect/restore of an existing
// session (which also reports a cwd) is not, or the preset list would be rewritten
// in mount order on reload instead of reflecting what the user actually launched.
let recordNextCwd = false;

// Start a fresh session in `dir`. Optimistic display only; the persisted/displayed
// truth is the EFFECTIVE cwd the server confirms (onServerCwd), which may fall back.
function launchIn(dir: string | null) {
  cwd.value = dir;
  sessionId.value = null; // new session — the server generates the id
  connectKey.value++;
  launched.value = true;
  emit("agent", agent.value); // let the grid persist which agent this cell launched
  recordNextCwd = true;
  loadDiff(); // no-op for a non-worktree dir
}

// Fork-local (iTerm2 mode): a toolbar preset chip spawned this cell — go straight from
// chip to a running claude pane in that directory, no launcher form stop. One-shot by
// construction: `launched` flips on the first fire, and a reloaded cell arrives with its
// session id (launched=true), so this can never re-launch an existing pane.
onMounted(() => {
  if (props.autoLaunch && !launched.value && props.initialCwd) {
    dirInput.value = props.initialCwd;
    launchIn(props.initialCwd);
  }
});

// The provider/model picked in the launch form, for the session this cell is about to
// start. Null — the usual case — means the directory's own default decides. Kept for the
// life of the cell so a relaunch in the same cell repeats the choice.
const launchChoice = ref<LaunchChoice | null>(null);

function launch() {
  launchIn(dirInput.value.trim() || props.defaultCwd);
}

// Launch a configured program (shell/codex/…) in this cell's chosen dir. The parent
// turns the empty cell into a persistent launcher cell (index is the server allowlist
// position); this cell is then replaced by a LauncherCell.
function launchProgram(index: number, l: Launcher) {
  emit("launch", { index, label: l.label, cwd: dirInput.value.trim() || props.defaultCwd });
}

// The chip's launch button: a one-click quick launch — fill the field and jump straight
// into a fresh session in that dir.
function selectPreset(p: CwdPreset) {
  dirInput.value = p.path;
  launchIn(p.path);
}

// A programmatic dir change (fillDir) loads the lists immediately, so the dirInput watch
// below must skip the debounced reload it would otherwise ALSO fire — or every preset
// click / folder pick would fetch the lists twice.
let skipDirWatch = false;

// The chip's main click (and the folder picker): fill the field WITHOUT launching,
// and refresh the resume / script / worktree lists for that dir so the user can pick a
// session to resume — or start fresh — instead of launching immediately.
function fillDir(path: string) {
  dirTouched.value = true;
  // Set the skip only when the value actually changes (so the watch will fire and consume
  // it) — a same-value click doesn't fire the watch and would leave a stale flag that
  // swallows the next real reload.
  if (dirInput.value !== path) skipDirWatch = true;
  dirInput.value = path;
  loadResumable();
  loadScripts();
  loadWorktrees();
}

// The folder button: the browser can't open a native folder chooser, so the local server does
// (POST /api/pick-file { directory: true }). Fill the Working-directory field with the pick.
async function pickDir() {
  try {
    const res = await fetch("/api/pick-file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: true }) });
    if (!res.ok) return;
    const data = await res.json();
    const dir = Array.isArray(data?.paths) ? data.paths.find((p: unknown): p is string => typeof p === "string") : undefined;
    if (dir) fillDir(dir);
  } catch {
    // best-effort — the native dialog is unavailable or the user canceled
  }
}

// Existing sessions for the dir in the form, so an empty cell can resume one
// instead of starting fresh.
interface ResumableSession {
  id: string;
  title: string;
  mtime: number;
}
const resumable = ref<ResumableSession[]>([]);
// The resolved cwd the listed sessions belong to (the server may resolve/fallback
// the requested dir). resume() uses THIS — not the live input — so the session id
// and cwd always match the row that was clicked.
const resumableCwd = ref<string | null>(null);
let resumableTimer: ReturnType<typeof setTimeout> | null = null;
let resumableReq = 0; // request token: drop out-of-order responses

async function loadResumable() {
  const dir = dirInput.value.trim() || props.defaultCwd;
  const reqId = ++resumableReq;
  if (launched.value || !dir) {
    resumable.value = [];
    resumableCwd.value = null;
    return;
  }
  try {
    const res = await fetch(`/api/sessions?cwd=${encodeURIComponent(dir)}`);
    if (reqId !== resumableReq) return; // a newer request superseded this one
    const data = res.ok ? await res.json() : { sessions: [], cwd: dir };
    if (reqId !== resumableReq) return; // re-check after awaiting the body
    resumable.value = data.sessions ?? [];
    resumableCwd.value = data.cwd ?? dir;
  } catch {
    if (reqId === resumableReq) {
      resumable.value = [];
      resumableCwd.value = null;
    }
  }
}

// The runnable scripts (script.json) for the dir in the form, so an empty cell can
// run one in that directory instead of starting a Claude session.
interface RunnableScript {
  index: number;
  label: string;
  command: string;
  cwd?: string;
}
const scripts = ref<RunnableScript[]>([]);
// The resolved cwd the listed scripts belong to (the server may resolve/fallback the
// requested dir). runScript() uses THIS so the command runs in the dir the list was
// fetched for.
const scriptsCwd = ref<string | null>(null);
let scriptsReq = 0; // request token: drop out-of-order responses

async function loadScripts() {
  const dir = dirInput.value.trim() || props.defaultCwd;
  const reqId = ++scriptsReq;
  if (launched.value || !dir) {
    scripts.value = [];
    scriptsCwd.value = null;
    return;
  }
  try {
    const res = await fetch(`/api/scripts?cwd=${encodeURIComponent(dir)}`);
    if (reqId !== scriptsReq) return;
    const data = res.ok ? await res.json() : { scripts: [], cwd: dir };
    if (reqId !== scriptsReq) return;
    scripts.value = Array.isArray(data.scripts) ? data.scripts : [];
    scriptsCwd.value = data.cwd ?? dir;
  } catch {
    if (reqId === scriptsReq) {
      scripts.value = [];
      scriptsCwd.value = null;
    }
  }
}

function runScript(s: RunnableScript) {
  emit("run", { source: "script", index: s.index, label: s.label, cwd: scriptsCwd.value ?? (dirInput.value.trim() || props.defaultCwd) });
}

// Per-agent isolation: when the dir is a git repo, the launcher can start claude in
// its own throwaway worktree (separate working tree, shared .git) so several agents
// work the repo without clobbering each other. Managed by the server (/api/worktrees).
interface Worktree {
  path: string;
  branch: string | null;
  task: string;
  dirty: boolean;
}
const isGitRepo = ref(false);
const worktrees = ref<Worktree[]>([]);
const worktreeTask = ref("");
let worktreesReq = 0;

async function loadWorktrees() {
  const dir = dirInput.value.trim() || props.defaultCwd;
  const reqId = ++worktreesReq;
  if (launched.value || !dir) {
    isGitRepo.value = false;
    worktrees.value = [];
    return;
  }
  try {
    const res = await fetch(`/api/worktrees?cwd=${encodeURIComponent(dir)}`);
    if (reqId !== worktreesReq) return;
    const data = res.ok ? await res.json() : { isGit: false, worktrees: [] };
    if (reqId !== worktreesReq) return;
    isGitRepo.value = !!data.isGit;
    worktrees.value = Array.isArray(data.worktrees) ? data.worktrees : [];
  } catch {
    if (reqId === worktreesReq) {
      isGitRepo.value = false;
      worktrees.value = [];
    }
  }
}

// Create a fresh worktree for the typed task and launch claude in it.
async function createWorktreeAndLaunch() {
  const repoDir = dirInput.value.trim() || props.defaultCwd;
  const task = worktreeTask.value.trim();
  if (!repoDir || !task) return;
  try {
    const res = await fetch("/api/worktrees/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir, task }),
    });
    if (!res.ok) return;
    const wt = await res.json();
    if (typeof wt.path === "string") {
      worktreeTask.value = "";
      launchIn(wt.path);
    }
  } catch {
    // best-effort — the launcher stays open so the user can retry
  }
}

const reuseWorktree = (w: Worktree) => launchIn(w.path);

// Remove a managed worktree (＋ its branch). A dirty one is confirmed first so work
// is never discarded silently.
async function removeWorktree(w: Worktree) {
  const repoDir = dirInput.value.trim() || props.defaultCwd;
  if (w.dirty && !window.confirm(`"${w.task}" has uncommitted changes. Discard and remove it?`)) return;
  try {
    await fetch("/api/worktrees/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir, path: w.path, deleteBranch: true, force: w.dirty }),
    });
    loadWorktrees();
  } catch {
    // best-effort
  }
}

// Refresh the resume list and the runnable scripts when the target dir changes.
watch([dirInput, () => props.defaultCwd], () => {
  // Cancel any pending debounced reload FIRST — whether we skip (a fillDir just loaded
  // immediately) or reschedule (typing), a stale timer from a prior change (e.g. a type
  // then a preset click) must not fire a duplicate load afterwards.
  if (resumableTimer) clearTimeout(resumableTimer);
  if (skipDirWatch) {
    skipDirWatch = false; // a fillDir() already loaded these immediately — don't schedule another
    return;
  }
  resumableTimer = setTimeout(() => {
    loadResumable();
    loadScripts();
    loadWorktrees();
  }, 300);
});

// A session already live in another grid cell. Resuming it here detaches that
// cell (the server supersedes the prior socket), so we warn before doing so.
const sessionOpenElsewhere = (id: string): boolean => id !== sessionId.value && (props.openSessionIds ?? []).includes(id);

// A preset dir that already has a running session in another cell — the launcher
// tints its chip so the user can tell it's in use before double-launching there.
const runningCwds = computed(() => new Set(props.openCwds ?? []));
const isCwdRunning = (path: string): boolean => runningCwds.value.has(path);

function resume(s: ResumableSession) {
  if (sessionOpenElsewhere(s.id) && !window.confirm(`"${s.title}" is already open in another terminal. Opening it here will detach that one. Continue?`))
    return;
  // Use the cwd those rows were fetched for, not the (possibly-changed) input.
  cwd.value = resumableCwd.value ?? (dirInput.value.trim() || props.defaultCwd);
  sessionId.value = s.id;
  connectKey.value++;
  launched.value = true;
  recordNextCwd = false; // resuming isn't a fresh launch — don't record its cwd
  loadDiff(); // an already-idle worktree session shows its badge right away
}

const relativeTime = (ms: number): string => relativeTimeFrom(ms, Date.now());

// The server reports where the PTY actually runs (it may have rejected the
// requested dir). Adopt it as the truth — display and persist the effective cwd.
function onServerCwd(c: string) {
  cwd.value = c;
  // Only a user-initiated fresh launch records the dir as a preset chip — not a
  // reconnect/restore of an already-running session (see recordNextCwd).
  if (recordNextCwd) {
    recordNextCwd = false;
    emit("record-cwd", c);
  }
  emit("cwd", c);
}

// "Open on GitHub": when this cell's dir is a GitHub repo, the server returns its
// repository URL (null otherwise) and the header shows a popover linking to the
// repo top page / Issues / Pull requests. Refreshed whenever the effective cwd
// changes (launch, server-confirmed cwd, restore).
const githubUrl = ref<string | null>(null);
const ghMenuOpen = ref(false);
const ghWrap = useTemplateRef<HTMLElement>("ghWrap");
let githubReq = 0; // request token: drop out-of-order responses (cwd can change fast)

async function refreshGithubUrl() {
  ghMenuOpen.value = false;
  const reqId = ++githubReq;
  if (!cwd.value) {
    githubUrl.value = null;
    return;
  }
  try {
    const res = await fetch("/api/git-remote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: cwd.value }),
    });
    if (reqId !== githubReq) return; // a newer cwd superseded this lookup
    const data = res.ok ? await res.json() : null;
    if (reqId !== githubReq) return; // re-check after awaiting the body
    githubUrl.value = data && typeof data.githubUrl === "string" ? data.githubUrl : null;
  } catch {
    if (reqId === githubReq) githubUrl.value = null; // best-effort — the link just won't appear
  }
}
watch(cwd, refreshGithubUrl, { immediate: true });

// Repository top page (""), Issues, or Pull requests — opened in a new tab.
function openGithub(suffix: string) {
  if (!githubUrl.value) return;
  window.open(githubUrl.value + suffix, "_blank", "noopener,noreferrer");
  ghMenuOpen.value = false;
}

function onGhOutside(e: MouseEvent) {
  if (ghWrap.value && !ghWrap.value.contains(e.target as Node)) ghMenuOpen.value = false;
}
watch(ghMenuOpen, (open) => {
  if (open) document.addEventListener("mousedown", onGhOutside);
  else document.removeEventListener("mousedown", onGhOutside);
});
onUnmounted(() => document.removeEventListener("mousedown", onGhOutside));

// "Bring another cell's last turn here": pull a sibling terminal's last completed
// exchange into THIS cell's input box, so the two agents can be pointed at each other's
// work without the user copying text between panes. Pulling rather than pushing keeps
// the click and the Enter in one place (#574). The source list is a snapshot taken when
// the menu opens, so it reflects what is connected right now.
const askMenuOpen = ref(false);
const askWrap = useTemplateRef<HTMLElement>("askWrap");
const askTargets = ref<HandoffTarget[]>([]);
const askMsg = ref<string | null>(null);
let askMsgTimer: ReturnType<typeof setTimeout> | null = null;

function openAskMenu() {
  askTargets.value = handoffTargets(`cell-${props.uid}`, props.home);
  askMenuOpen.value = !askMenuOpen.value;
}

function showAskMsg(msg: string) {
  askMsg.value = msg;
  if (askMsgTimer) clearTimeout(askMsgTimer);
  askMsgTimer = setTimeout(() => (askMsg.value = null), ASK_MSG_MS);
}

async function askCell(target: HandoffTarget) {
  askMenuOpen.value = false;
  const error = await pullLastTurn(target, `cell-${props.uid}`);
  if (error) showAskMsg(error);
}

// Fork-local (iTerm2 mode): copy this pane's last reply — or the last prompt the operator
// gave it — to the system clipboard, from the transcript rather than the screen (see
// useCopyTurn for why that distinction is the whole feature).
//
// The outcome replaces the button's icon for a moment instead of raising a toast: this cell
// is one of thirty columns, and a floating notice over a column the operator has already
// looked away from is chrome that costs a reading line and tells them nothing.
const COPY_LABEL_MS = 1500;
const copyLabels = ref<Record<TurnPart, string | null>>({ reply: null, prompt: null });
const copyTimers: Partial<Record<TurnPart, ReturnType<typeof setTimeout>>> = {};

function showCopyLabel(part: TurnPart, label: string) {
  copyLabels.value[part] = label;
  const pending = copyTimers[part];
  if (pending) clearTimeout(pending);
  copyTimers[part] = setTimeout(() => {
    copyLabels.value[part] = null;
  }, COPY_LABEL_MS);
}

async function copyTurn(part: TurnPart) {
  const id = sessionId.value;
  if (!id) return;
  const outcome = await copyLastTurnPart({ sessionId: id, cwd: cwd.value, agent: agent.value }, part);
  showCopyLabel(part, copyOutcomeLabel(outcome, part));
}

onUnmounted(() => {
  for (const timer of Object.values(copyTimers)) clearTimeout(timer);
});

// Fork-local (iTerm2 mode, R10): the pane's own transient line — "saving…", "inserted", a
// failure. It takes over the status strip's flexible slot for a moment instead of raising a
// toast: the strip is already the row the operator reads while scanning columns, and a
// floating notice over one of thirty columns is chrome that costs a reading line.
const CELL_MSG_MS = 3000;
const cellMsg = ref<string | null>(null);
let cellMsgTimer: ReturnType<typeof setTimeout> | null = null;
// `ms = 0` keeps the message up until the next call replaces it — for the "in progress" half of
// an upload, which has no honest duration.
function showCellMsg(msg: string | null, ms: number = CELL_MSG_MS) {
  cellMsg.value = msg;
  if (cellMsgTimer) clearTimeout(cellMsgTimer);
  cellMsgTimer = null;
  if (msg && ms > 0) cellMsgTimer = setTimeout(() => (cellMsg.value = null), ms);
}
onUnmounted(() => {
  if (cellMsgTimer) clearTimeout(cellMsgTimer);
});

// R10: the WHOLE pane takes a file drop, not just the terminal canvas.
//
// The canvas is the smaller half of a column once the header, the strip and (zoomed) the
// terminal's own toolbar are counted, and a drop that lands a few pixels high silently did
// nothing — the operator's report was "it works sometimes". The insert is the same one
// Terminal.vue does; only the target area is bigger.
//
// `defaultPrevented` is the whole coordination: a drop ON the canvas is handled there and
// bubbles up here already prevented, so this must not insert the path a second time. And the
// column-reorder drag carries a custom MIME with no "Files" entry, so it never reaches here.
const fileDragOver = ref(false);

function onCellDragOver(e: DragEvent) {
  if (!launched.value || !e.dataTransfer || !dragCarriesFiles(e.dataTransfer.types)) return;
  e.preventDefault(); // required for the drop event to fire
  e.dataTransfer.dropEffect = "copy";
  fileDragOver.value = true;
}

// Only when the pointer actually left the CELL: dragleave also fires on every internal
// boundary crossing, which would flicker the ring off over the terminal.
function onCellDragLeave(e: DragEvent) {
  const root = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
  if (!root || !to || !root.contains(to)) fileDragOver.value = false;
}

function onCellDrop(e: DragEvent) {
  fileDragOver.value = false;
  if (e.defaultPrevented) return; // the terminal canvas already inserted it
  const dt = e.dataTransfer;
  if (!launched.value || !dt || !dragCarriesFiles(dt.types)) return;
  e.preventDefault();
  const text = dropTextFromUriList(dt.getData("text/uri-list") || dt.getData("text/plain"));
  if (text) {
    insertIntoSlot(`cell-${props.uid}`, text);
    return;
  }
  // Chrome withholds a dropped file's path — but an IMAGE can still ride the paste route:
  // upload the bytes, insert the path the host answers with. Only a non-image drop (a PDF,
  // a folder) is left with the hint, because nothing can be done with it.
  const images = imageFilesFrom(dt.files);
  if (images.length) void insertUploadedImages(images);
  else showCellMsg("このブラウザはパスを渡しません（画像以外は添付ボタンから）");
}

// The shared tail of the drop and the photo button: bytes up, paths in. Partial success still
// inserts what it got — the failure label then explains the missing one.
async function insertUploadedImages(images: File[]) {
  showCellMsg(images.length > 1 ? `画像${images.length}枚を保存中…` : "画像を保存中…", 0);
  const { paths, failed } = await uploadImageFiles(images);
  if (paths.length) insertIntoSlot(`cell-${props.uid}`, toInsertText(paths));
  showCellMsg(failed ? pasteFailureLabel(failed) : "画像のパスを挿入しました");
}

// R14: the photo button — always on the header, because the operator could not find the
// attach path behind the toolbar toggle. Opens the OS picker restricted to what the host
// accepts, then rides the same upload as a drop/paste.
const photoInput = ref<HTMLInputElement | null>(null);

function onPhotoPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const images = imageFilesFrom(input.files);
  if (images.length) void insertUploadedImages(images);
  else if (input.files?.length) showCellMsg("この形式の画像は非対応です");
  input.value = ""; // so picking the same file again re-fires change
}

// R10: Cmd+V an image into the focused pane. A clipboard image has no path — that is exactly
// why the drop path cannot cover it — so the bytes go to the host, which writes them into the
// workspace attachment store and answers with a path to insert.
//
// A paste with no image is left alone: xterm's own paste handling is what types text into the
// terminal, and claiming the event would break the ordinary Cmd+V.
async function onCellPaste(e: ClipboardEvent) {
  if (!launched.value) return;
  const file = pastedImageFile(e.clipboardData);
  if (!file) return;
  e.preventDefault();
  showCellMsg("画像を保存中…", 0);
  const outcome = await uploadPastedImage(file);
  if (!outcome.ok) {
    showCellMsg(pasteFailureLabel(outcome.reason));
    return;
  }
  insertIntoSlot(`cell-${props.uid}`, toShellArg(outcome.path));
  showCellMsg("画像のパスを挿入しました");
}

// One automatic exchange: our turn goes out, their answer comes back, both submitted.
// `exchangeStop` is the only way a running exchange ends early, so it is also what the
// cell unmounting sets — a loop typing into terminals must not outlive its cell.
const exchanging = ref(false);
let exchangeStop = false;

function stopExchange() {
  exchangeStop = true;
}

async function exchangeWith(target: HandoffTarget) {
  askMenuOpen.value = false;
  if (!sessionId.value || exchanging.value) return;
  exchanging.value = true;
  exchangeStop = false;
  const self = { key: `cell-${props.uid}`, source: { sessionId: sessionId.value, cwd: cwd.value, agent: agent.value } };
  const { outcome } = await runOneExchange(
    self,
    target,
    liveCrossTalkDeps(() => exchangeStop),
  );
  exchanging.value = false;
  const message = outcomeMessage(outcome);
  if (message) showAskMsg(message);
}

function onAskOutside(e: MouseEvent) {
  if (askWrap.value && !askWrap.value.contains(e.target as Node)) askMenuOpen.value = false;
}
watch(askMenuOpen, (open) => {
  if (open) document.addEventListener("mousedown", onAskOutside);
  else document.removeEventListener("mousedown", onAskOutside);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onAskOutside);
  if (askMsgTimer) clearTimeout(askMsgTimer);
  exchangeStop = true; // never leave an exchange typing into terminals after this cell is gone
});

// Reap the session and reset the cell back to the empty launcher. The cell isn't
// remounted (stable key), so the dir/diff state is reset explicitly — otherwise the
// launch form would still show the closed session's directory.
function teardown() {
  const id = sessionId.value; // capture before the reset below nulls it
  termRef.value?.terminate();
  // Reap on the server over HTTP too — the WS `terminate` only reaches the server while
  // the socket is open, so a disconnected cell's close button would otherwise leave its tmux alive.
  if (id) fetch(`/api/session/${encodeURIComponent(id)}/terminate`, { method: "POST" }).catch(() => {});
  launched.value = false;
  recordNextCwd = false; // drop any pending fresh-launch record from a torn-down session
  sessionId.value = null;
  working.value = false;
  waiting.value = false;
  activityEvent.value = null;
  lastPrompt.value = null;
  aiTitle.value = null;
  usage.value = null;
  context.value = null;
  cwd.value = props.defaultCwd;
  dirInput.value = props.defaultCwd ?? "";
  dirTouched.value = false; // fresh launcher again — let a late preset sync re-prefill
  diff.value = null;
  diffOpen.value = false;
  closeConfirm.value = false;
  prMsg.value = null;
  emit("close");
  loadResumable();
  loadScripts();
  loadWorktrees();
}

// Closing a WORKTREE cell offers to keep or remove the room first (never silently
// discards uncommitted/unpushed work); other cells just tear down.
const closeConfirm = ref(false);
const closeChecking = ref(false); // refreshing dirty/ahead — the destructive action is held until it's accurate
const closeError = ref<string | null>(null);
const unsaved = computed(() => unsavedWork(diff.value));
const hasUnsaved = computed(() => unsaved.value.has);
const unsavedSummary = computed(() => unsaved.value.summary);

async function close() {
  if (!isWorktreeCell.value) {
    teardown();
    return;
  }
  closeError.value = null;
  closeConfirm.value = true;
  // Refresh dirty/ahead before the Remove button is enabled, so a fast click can't
  // discard work that became newly dirty/ahead since the last refresh.
  closeChecking.value = true;
  await loadDiff();
  closeChecking.value = false;
}
function cancelClose() {
  closeConfirm.value = false;
  closeChecking.value = false;
  closeError.value = null;
}

async function removeAndClose() {
  const dir = cwd.value;
  if (!dir) {
    teardown();
    return;
  }
  closeError.value = null;
  termRef.value?.terminate(); // free the worktree dir first (Windows locks a process's cwd)
  try {
    const res = await fetch("/api/worktrees/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir: dir, path: dir, deleteBranch: true, force: true }),
    });
    if (res.ok) return teardown();
    closeError.value = "Couldn't remove the worktree — it may need manual cleanup.";
  } catch {
    closeError.value = "Couldn't reach the server to remove the worktree.";
  }
}

// Esc dismisses the close confirmation (document-scoped: focus may be on the
// terminal, not the overlay), matching the diff panel's Escape handling.
function onCloseKey(e: KeyboardEvent) {
  if (e.key === "Escape") cancelClose();
}
watch(closeConfirm, (open) => {
  if (open) document.addEventListener("keydown", onCloseKey);
  else document.removeEventListener("keydown", onCloseKey);
});
onUnmounted(() => document.removeEventListener("keydown", onCloseKey));

// Adopt the server-assigned id (esp. for new sessions), bubble it up for
// persistence, and load its initial activity.
function onSession(id: string) {
  sessionId.value = id;
  forkFrom.value = null; // R12: the branch exists now — the fork request is spent
  emit("session", id);
  loadInitial(id);
}

// ~-anchored, front-truncated path for the header (keeps the tail). For a managed
// worktree cell, show "⎇ <repo> (<task>)" instead — the managed path is just noise.
const dirDisplay = computed(() => formatCwd(cwd.value, props.home));
const headerDir = computed(() => {
  const wt = worktreeLabel(cwd.value);
  return wt ? `⎇ ${wt.repo} (${wt.task})` : dirDisplay.value;
});

// R14: the directory identity, back on the pixels. The fork moved it to the hover title
// (the left stripe carrying the color), but with ten columns of the same repo color a hover
// per pane is exactly the recall cost this UI exists to remove. The configured project name
// wins; an unconfigured dir shows its basename, so the badge never renders empty.
const headerDirName = computed(() => {
  if (dirConfig.value.name) return dirConfig.value.name;
  const wt = worktreeLabel(cwd.value);
  if (wt) return `${wt.repo} (${wt.task})`;
  // split + filter rather than a trailing-separator regex (sonarjs flags the backtracking).
  const segments = cwd.value?.split(/[/\\]/).filter(Boolean) ?? [];
  return segments.length ? segments[segments.length - 1] : null;
});

// Whether THIS pane's durable connection is up. The connection manager keys its slots by the
// same `cell-<uid>` used for persistKey below, so the cell can read its own socket state
// without another prop. A cell that has not launched yet has no socket and is not "dead" —
// it is an empty launch form, which reads as idle.
const connStatus = computed(() => connView.get(`cell-${props.uid}`)?.status ?? null);
const disconnected = computed(() => launched.value && connStatus.value === "disconnected");

// The six-word intervention vocabulary (common/paneState): approval / question / working /
// unread / disconnected / shell, with `idle` as the floor that says nothing. `connected` is
// this cell's own observation and outranks whatever the server last said about the session.
const status = computed<CellStatus>(() =>
  activityStatus(working.value, waiting.value, activityEvent.value, waitKind.value, { connected: !disconnected.value }),
);
// The is-* class stays on the element as a state marker (the specs assert it); the tables in
// cellStatusStyles carry the styling that used to live in the .cell.is-* / .cell-header.is-*
// rules. They live there rather than here because the launcher pane wears the same two rows.
const statusClass = computed(() => STATUS_CLASS[status.value]);
const cellStatusClass = computed(() => CELL_STATUS[status.value]);
const headerStatusClass = computed(() => HEADER_STATUS[status.value]);
const statusLabel = computed(() => STATUS_LABEL[status.value]);
watch(status, (s) => emit("status", s), { immediate: true });

// Fork-local (iTerm2 mode): the always-visible status strip under the header — the triage row,
// and the only row the operator actually READS while scanning columns.
//
// Vocabulary is intervention-centric (what should I do), not process-centric, and the six words
// are defined once in common/paneState because the server classifies them. The word for `idle`
// is deliberately EMPTY: the old "待機" appeared on most panes most of the time, which is the
// definition of a column carrying no information — a pane with nothing to ask now gives its
// space to the summary instead.
//
// The AI summary is the one flexible element; the mission sits ahead of it (it is why the pane
// exists, so it reads first), and the last prompt only appears when the column is wide enough
// for it whole. A pane the operator NAMED (R10) shows that name in the summary's place — see
// stripMain below.

// Ticks so the dot ages while the pane sits still — without it a stale pane keeps the colour
// it had when the last push arrived, which is exactly the pane this is meant to surface.
const FRESHNESS_TICK_MS = 60_000;
const nowMs = ref(Date.now());
const freshnessTimer = setInterval(() => (nowMs.value = Date.now()), FRESHNESS_TICK_MS);
onUnmounted(() => clearInterval(freshnessTimer));

const freshness = computed(() => freshnessOf(status.value, lastActivityAt.value, nowMs.value));
const stripStatusClass = computed(() => STRIP_STATUS[status.value]);
const stripDotClass = computed(() => FRESHNESS_DOT[freshness.value] ?? STRIP_DOT[status.value]);
const stripDotTitle = computed(() => FRESHNESS_TITLE[freshness.value]);
const stripLabel = computed(() => paneStateWord(status.value));
const stripPrompt = computed(() => (lastPrompt.value ? `❯ ${lastPrompt.value}` : ""));

// R10 — the pane's NAME, and why it outranks the AI summary.
//
// The summary answers "what is happening right now" and is rewritten every turn. With four
// panes open on one repo, that is the one thing which cannot tell them apart: they all say
// something plausible about the same project. A name the operator typed is stable and is the
// answer to "which pane is this", so when there is one it takes the row's flexible slot and
// the summary steps back into the hover title. Nothing is lost — the summary is one hover away
// and the terminal underneath is showing the same work.
const named = computed(() => !!props.name);
const stripMain = computed(() => cellMsg.value || props.name || aiTitle.value || "—");
const stripMainTitle = computed(() => (props.name && aiTitle.value ? `${props.name} — ${aiTitle.value}` : (props.name ?? aiTitle.value ?? "")));

// Double-clicking the identity text opens the rename in place. Deliberately NOT on the header
// row above: a click there zooms the cell, so a double-click would zoom and un-zoom on its way
// to the input — this row has no click action to fight with, and it is where the name shows.
const renaming = ref(false);
const nameDraft = ref("");
const nameInput = useTemplateRef<HTMLInputElement>("nameInput");

function startRename() {
  nameDraft.value = props.name ?? "";
  renaming.value = true;
  void nextTick(() => nameInput.value?.select());
}
function commitRename() {
  if (!renaming.value) return; // Enter commits and blurs; the blur must not commit a second time
  renaming.value = false;
  emit("rename", nameDraft.value);
}
const cancelRename = () => (renaming.value = false);

// Row 1 shows no path/badge/id anymore (identity lives in the left stripe + hover);
// everything is still one hover away for debugging and resume.
const headerTitle = computed(() => [cwd.value, sessionId.value].filter(Boolean).join(" · "));
// The directory's color as a full-height stripe on the pane's left edge: zero vertical
// cost, survives header truncation, and reads in peripheral vision. The 3 remaining
// border sides keep carrying the state color.
const stripeStyle = computed(() => (dirConfig.value.badgeColor ? { borderLeft: `3px solid ${dirConfig.value.badgeColor}` } : {}));
// The old row 3 (Terminal.vue's header: Skill / attach / folders / voice / timeline) is
// hidden in the tiles and summoned per-cell with the header's "…" — capability moved
// behind one click, not removed. Zoomed cells always show it.
const toolsOpen = ref(false);

// Per-cell token usage badge: ⇡ total input (fresh + cache) · ⇣ output generated.
const usageView = computed(() => usageBadge(usage.value));
const showUsage = computed(() => usageView.value.show);
const usageLabel = computed(() => usageView.value.label);
const usageTitle = computed(() =>
  usage.value
    ? `Tokens — input ${usage.value.inputTokens.toLocaleString()} · cache ${(usage.value.cacheReadTokens + usage.value.cacheCreationTokens).toLocaleString()} · output ${usage.value.outputTokens.toLocaleString()}`
    : "",
);

// Worktree diff (read-only): for a launched worktree cell, show how much the agent
// changed vs the base branch — a header badge (ahead/dirty) and a panel (changed
// files + patch). Refreshed when the agent pauses (the change set is then stable).
interface WorktreeDiffData {
  isWorktree: boolean;
  base: string | null;
  ahead: number;
  dirty: number;
  files: { path: string; additions: number; deletions: number; status: "changed" | "untracked" }[];
  patch: string;
  truncated: boolean;
}
const diff = ref<WorktreeDiffData | null>(null);
const diffOpen = ref(false);
const isWorktreeCell = computed(() => worktreeLabel(cwd.value) !== null);
const showDiffBadge = computed(() => !!diff.value?.isWorktree && (diff.value.ahead > 0 || diff.value.dirty > 0));
let diffReq = 0;

async function loadDiff() {
  if (!launched.value || !isWorktreeCell.value || !cwd.value) {
    diffReq++; // invalidate any in-flight fetch so its (now stale) response can't land
    diff.value = null;
    diffOpen.value = false; // fully close — don't auto-reopen on a later worktree re-entry
    return;
  }
  const reqId = ++diffReq;
  try {
    const res = await fetch(`/api/worktrees/diff?cwd=${encodeURIComponent(cwd.value)}`);
    if (reqId !== diffReq) return;
    const data = res.ok ? await res.json() : null;
    if (reqId !== diffReq) return;
    diff.value = data && data.isWorktree ? data : null;
  } catch {
    if (reqId === diffReq) diff.value = null;
  }
}

function openDiff() {
  diffOpen.value = true;
  prMsg.value = null;
  loadDiff(); // refresh on open
}

// Outward-facing actions (push / open PR) for the worktree's branch. `prBusy`
// disables the buttons during a request; `prMsg` shows the result inline.
const prBusy = ref(false);
const prMsg = ref<string | null>(null);

// Ask the cell's own Claude session to commit the uncommitted changes (so it writes
// a sensible message). After it commits and settles, the working→idle watch
// refreshes the diff: `ahead` rises, `dirty` drops, and Push/PR light up.
const COMMIT_PROMPT = "Commit all current changes in this worktree with a concise, descriptive commit message.";
function commitViaClaude() {
  const delivered = termRef.value?.submitText(COMMIT_PROMPT);
  prMsg.value = delivered ? "Asked Claude to commit…" : "Couldn't reach the session";
}

async function worktreeAction(endpoint: "push" | "pr"): Promise<Record<string, unknown> | null> {
  if (!cwd.value || prBusy.value) return null;
  prBusy.value = true;
  prMsg.value = endpoint === "push" ? "Pushing…" : "Creating PR…";
  try {
    const res = await fetch(`/api/worktrees/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: cwd.value }),
    });
    const data = await res.json().catch(() => null);
    // A non-JSON / empty-body response (e.g. a 403 from the origin guard) must not
    // leave the UI stuck on the optimistic "Pushing…" text.
    if (!data) prMsg.value = res.status === 403 ? "Not allowed (origin)" : "Request failed";
    return data;
  } catch {
    prMsg.value = endpoint === "push" ? "Push failed" : "PR failed";
    return null;
  } finally {
    prBusy.value = false;
  }
}

async function pushBranch() {
  const data = await worktreeAction("push");
  if (data) prMsg.value = data.ok ? `Pushed ${data.branch}` : worktreeFailureMessage(data.reason as string);
}

async function openPR() {
  const data = await worktreeAction("pr");
  if (!data) return;
  if (data.ok && typeof data.url === "string") {
    window.open(data.url, "_blank", "noopener,noreferrer");
    prMsg.value = data.via === "gh" ? "PR created" : "Opened PR page";
  } else {
    prMsg.value = worktreeFailureMessage(data.reason as string);
  }
}

// Refresh when the agent transitions from working → settled: that's when the diff
// is stable and worth re-reading (avoids churn while it's actively editing), and the
// turn's token usage is final.
watch(working, (now, prev) => {
  if (prev && !now) {
    loadDiff();
    refreshUsage();
    refreshGit(); // branch/dirty may have changed (commit, checkout, edits)
  }
});

// Re-read (or clear) the diff when the effective cwd changes — e.g. the server
// confirmed a fallback dir. loadDiff() clears it synchronously for a non-worktree
// dir, so the badge never lingers with a previous worktree's counts.
watch(cwd, () => loadDiff());

// Esc closes the diff panel. Listen at document scope while it's open: focus is
// usually on the badge or the terminal, so a handler on the panel element itself
// wouldn't reliably receive the keydown.
function onDiffKey(e: KeyboardEvent) {
  if (e.key === "Escape") diffOpen.value = false;
}
watch(diffOpen, (open) => {
  if (open) document.addEventListener("keydown", onDiffKey);
  else document.removeEventListener("keydown", onDiffKey);
});
onUnmounted(() => document.removeEventListener("keydown", onDiffKey));
</script>

<template>
  <div
    class="cell @container/pane relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border bg-[var(--cell-bg,var(--bg-base))]"
    :class="[statusClass, cellStatusClass, { 'cell-file-drop [outline:2px_dashed_var(--accent)] [outline-offset:-2px]': fileDragOver }]"
    :style="[cellStyle, stripeStyle]"
    @dragover="onCellDragOver"
    @dragleave="onCellDragLeave"
    @drop="onCellDrop"
    @paste="onCellPaste"
  >
    <template v-if="launched">
      <!-- Filmstrip thumbnail: the same roster header (CockpitHeader) — the dir colour is applied
           regardless of status (status is the dot + badge), so a thumbnail reads as its directory
           the way the roster row does. Expand/close go in its trailing slot. -->
      <CockpitHeader
        v-if="filmstrip"
        class="cell-header flex-none border-b"
        :class="[statusClass, expanded ? '' : `is-zoomable ${CELL_HEADER_ZOOMABLE}`]"
        :status="status"
        :agent="agent"
        :cwd="cwd"
        :home="home"
        :header-color="dirConfig.headerColor"
        :header-text-color="dirConfig.headerTextColor"
        @click="onHeaderClick"
      >
        <span class="cell-actions" :class="CELL_ACTIONS">
          <CellChromeButtons :expanded="expanded" @toggle-expand="emit('toggle-expand')" @close="close" />
        </span>
      </CockpitHeader>
      <!-- Row 1 — INFO only (normal grid / expanded): dir + git + model/token + what it's doing.
           Every icon BUTTON lives on row 2 (the embedded terminal's header, via its slot). -->
      <!-- Fork-local (iTerm2 mode): the header is the drag handle — grab it to move the
           whole column (drop handling lives in TerminalGrid). draggable coexists with
           click-to-zoom: a click without movement never starts a drag. -->
      <div
        v-else
        class="cell-header flex h-6 flex-none cursor-grab items-center gap-1.5 border-b px-1.5"
        :class="[statusClass, headerStatusClass, expanded ? '' : `is-zoomable ${CELL_HEADER_ZOOMABLE}`]"
        :style="headerStyle"
        :title="headerTitle"
        draggable="true"
        @dragstart="onHeaderDragStart"
        @click="onHeaderClick"
      >
        <!-- All the info lives in one shrinkable, clipping track. The chips (badge / git /
             model / tokens / custom) don't shrink, so without this they would overflow and
             push the actions past the cell's `overflow: hidden` edge — the buttons must
             stay reachable no matter how much a dir's config crams in here. -->
        <!-- Fork-local (iTerm2 mode): row 1 is a slim identity row. The dot and session id
             are GONE from the pixels — the strip below carries the status, and cwd ·
             session-id live in the header's hover title. The directory NAME is back (R14):
             the stripe-color-only experiment made "which project is this pane" a hover per
             pane. What renders: dir badge, the config-driven chips (git/diff/ctx/…), actions. -->
        <div data-testid="cell-header-main" class="flex min-w-0 flex-auto items-center gap-1.5 overflow-hidden">
          <!-- Info (git / diff / model / tokens) is dropped on a filmstrip
               thumbnail, leaving only dir + what it's doing + a zoom button. -->
          <template v-if="!filmstrip">
            <DirBadge :name="headerDirName" :color="dirConfig.badgeColor" />
            <template v-for="chip in cellChips" :key="chip.key">
              <GitBranchChip v-if="chip.builtin === 'git'" :status="gitStatus" :hide-dirty="isWorktreeCell" />
              <button
                v-else-if="chip.builtin === 'diff' && showDiffBadge && diff"
                type="button"
                data-testid="cell-wt-badge"
                class="inline-flex flex-none cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-elevated px-[7px] py-px font-mono text-[11px] hover:bg-hover"
                :title="`View changes vs ${diff.base ?? 'base'}`"
                @click="openDiff"
              >
                <span v-if="diff.ahead > 0" data-testid="wt-ahead" class="text-accent">+{{ diff.ahead }}</span>
                <span v-if="diff.dirty > 0" data-testid="wt-dirty-count" class="text-[var(--warn-text,#e0a030)]">●{{ diff.dirty }}</span>
              </button>
              <!-- hide-context: nine narrow columns — the model NAME is the answer here;
                   Claude's own TUI prints Context % at the bottom of every pane. -->
              <ModelContextBadge
                v-else-if="chip.builtin === 'ctx' && context"
                :agent="agent"
                :model="context.model"
                :context-tokens="context.contextTokens"
                hide-context
              />
              <span
                v-else-if="chip.builtin === 'usage' && showUsage"
                data-testid="cell-usage"
                class="flex-none whitespace-nowrap font-mono text-[10px] tracking-[0.02em] text-dim"
                :title="usageTitle"
                >{{ usageLabel }}</span
              >
              <span
                v-else-if="chip.custom"
                data-testid="cell-hdr-chip"
                class="flex-none whitespace-nowrap rounded-full border border-border px-1.5 py-px text-[10px] text-dim"
                :title="chip.custom.label || chip.custom.text"
                >{{ chip.custom.text }}</span
              >
            </template>
          </template>
          <!-- The only stretch element in row 1 — empty on purpose (P0-3: one truncate
               per row, and row 1 has nothing worth truncating). -->
          <span class="min-w-0 flex-auto" />
        </div>
        <!-- Expand/restore + close stay on row 1 (the info row) and OUTSIDE the info
             track, so they're always pinned top-right. `.stop` so they don't trigger the
             header's click-to-zoom. -->
        <span class="cell-actions" :class="CELL_ACTIONS">
          <!-- R14: the photo button, always visible — the operator sends screenshots constantly
               and the picker must not hide behind the toolbar toggle. -->
          <button
            v-if="launched"
            type="button"
            data-testid="cell-photo-btn"
            class="cell-btn inline-flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-inherit hover:bg-hover"
            title="画像を添付（パスを挿入）"
            aria-label="Attach an image"
            @click.stop="photoInput?.click()"
          >
            <span class="material-symbols-outlined text-[14px]" aria-hidden="true">add_photo_alternate</span>
          </button>
          <input ref="photoInput" type="file" :accept="IMAGE_PICKER_ACCEPT" multiple class="hidden" aria-hidden="true" tabindex="-1" @change="onPhotoPick" />
          <button
            v-if="!expanded"
            type="button"
            class="cell-btn inline-flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-inherit hover:bg-hover"
            :class="{ 'bg-hover': toolsOpen }"
            title="ツールバーを表示（Skill・添付・フォルダ・音声など）"
            aria-label="Toggle the terminal tool bar"
            :aria-pressed="toolsOpen"
            @click.stop="toolsOpen = !toolsOpen"
          >
            <span class="material-symbols-outlined text-[14px]" aria-hidden="true">more_horiz</span>
          </button>
          <CellChromeButtons :expanded="expanded" @toggle-expand="emit('toggle-expand')" @close="close" />
        </span>
      </div>
      <!-- Fork-local (iTerm2 mode): per-pane status line — status word + mission + AI summary +
           last prompt, always visible in the tiled columns. Still ONE 22px row: the mission
           takes space from the summary rather than adding a line, because rows are the scarce
           resource in a column and readable lines per column is the top UI metric here. -->
      <div v-if="!filmstrip" data-testid="cell-status-strip" :class="CELL_STRIP">
        <span :class="[CELL_STRIP_DOT, stripDotClass]" :title="stripDotTitle" aria-hidden="true" />
        <!-- No word at all for a pane with nothing to ask (common/paneState): the summary
             takes the space rather than a placeholder taking a column-width of it. -->
        <span v-if="stripLabel" data-testid="cell-strip-state" :class="[CELL_STRIP_WORD, stripStatusClass]" :title="statusLabel">{{ stripLabel }}</span>
        <!-- The mission — why this pane exists — ahead of the summary, dimmer and capped at a
             third of the row: it is read first but must never crowd out what is happening now.
             ALWAYS visible (R14): it used to hide below 340px, but narrow columns are this
             operator's normal case, and "what did I ask this pane to do" is the one thing
             the strip exists to answer — hiding it exactly where it is needed was backwards. -->
        <span
          v-if="mission"
          data-testid="cell-strip-mission"
          class="max-w-[34%] flex-none truncate font-sans text-[11px] text-dim"
          :title="`mission: ${mission}`"
          >[{{ mission }}]</span
        >
        <!-- The one flexible element of the row (P0-3): the pane's NAME if it has one, else the
             AI summary — brightest text in the pane chrome, dynamic info above static (P1-4).
             Double-click to rename in place; Enter commits, Esc cancels, blur commits. -->
        <input
          v-if="renaming"
          ref="nameInput"
          v-model="nameDraft"
          data-testid="cell-strip-name-input"
          class="min-w-0 flex-auto rounded-[3px] border border-accent bg-input px-1 py-0 font-sans text-[12px] leading-[16px] text-fg outline-none"
          :maxlength="MAX_CELL_NAME"
          aria-label="Pane name"
          spellcheck="false"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
          @dblclick.stop
        />
        <span
          v-else
          data-testid="cell-strip-summary"
          :class="[CELL_STRIP_MAIN, named ? 'font-medium' : '']"
          :data-named="named ? 'true' : undefined"
          :title="stripMainTitle"
          @dblclick.stop="startRename"
          >{{ stripMain }}</span
        >
        <!-- The last prompt only when the column can afford it whole — never half-truncated
             into noise next to a half-truncated summary (P0-4). -->
        <span
          v-if="stripPrompt"
          data-testid="cell-strip-prompt"
          class="hidden max-w-[38%] flex-none truncate font-sans text-[11px] text-dim @[340px]/pane:inline"
          :title="lastPrompt ?? ''"
          >{{ stripPrompt }}</span
        >
        <!-- Model + context % pinned at the strip's right edge — the header's ctx chip
             truncates first in a narrow column, and "which model is this pane on" must
             survive at every width (the operator's iTerm2 statusline showed it). -->
        <ModelContextBadge
          v-if="context"
          class="flex-none tabular-nums"
          :agent="agent"
          :model="context.model"
          :context-tokens="context.contextTokens"
          hide-context
        />
      </div>
      <TimelineOverlay :session-id="sessionId" :cwd="cwd" :open="timelineOpen" @close="timelineOpen = false" />
      <TerminalView
        ref="termRef"
        class="cell-term"
        :class="CELL_TERM"
        :persist-key="`cell-${uid}`"
        :session-id="sessionId"
        :connect-key="connectKey"
        :cwd="cwd"
        :codex="agent === 'codex'"
        :launch="launchChoice"
        :fork="forkFrom"
        :dir-header-color="dirConfig.headerColor"
        :dir-header-text-color="dirConfig.headerTextColor"
        :dir-button-color="dirConfig.buttonColor"
        :hide-header="filmstrip || (!expanded && !toolsOpen)"
        :expanded="expanded"
        :zoomed="zoomed"
        dev-terminal
        run-menu
        @session="onSession"
        @cwd="onServerCwd"
        @run="(cmd) => emit('runSpare', cmd)"
      >
        <!-- Row 2 — the cell's icon actions, gathered onto the terminal's header row. -->
        <template #header-actions>
          <span v-if="githubUrl" ref="ghWrap" class="relative inline-flex flex-none">
            <button
              type="button"
              data-testid="cell-gh"
              class="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-[4px] border-none bg-transparent p-0 text-dim hover:bg-hover hover:text-fg"
              title="Open on GitHub"
              aria-label="Open on GitHub"
              aria-haspopup="true"
              :aria-expanded="ghMenuOpen"
              @click="ghMenuOpen = !ghMenuOpen"
            >
              <svg class="block h-[14px] w-[14px]" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 4.6c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
            </button>
            <div
              v-if="ghMenuOpen"
              data-testid="cell-gh-menu"
              class="absolute left-0 top-full z-20 mt-1 flex min-w-[132px] flex-col rounded-md border border-border bg-panel p-1 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
              @keydown.escape="ghMenuOpen = false"
            >
              <button
                type="button"
                data-testid="cell-gh-item"
                class="cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1.5 text-left font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
                @click="openGithub('')"
              >
                Repository
              </button>
              <button
                type="button"
                data-testid="cell-gh-item"
                class="cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1.5 text-left font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
                @click="openGithub('/issues')"
              >
                Issues
              </button>
              <button
                type="button"
                data-testid="cell-gh-item"
                class="cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1.5 text-left font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
                @click="openGithub('/pulls')"
              >
                Pull requests
              </button>
            </div>
          </span>
          <span v-if="sessionId" ref="askWrap" class="relative inline-flex flex-none">
            <button
              type="button"
              data-testid="cell-ask"
              class="cell-btn"
              :class="CELL_BTN"
              title="Bring another terminal's last turn into this input box"
              aria-label="Bring another terminal's last turn here"
              aria-haspopup="true"
              :aria-expanded="askMenuOpen"
              @click="openAskMenu"
            >
              <span class="material-symbols-outlined" aria-hidden="true">forum</span>
            </button>
            <div
              v-if="askMenuOpen"
              data-testid="cell-ask-menu"
              class="absolute right-0 top-full z-20 mt-1 flex min-w-[180px] flex-col rounded-md border border-border bg-panel p-1 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
              @keydown.escape="askMenuOpen = false"
            >
              <div v-for="target in askTargets" :key="target.key" class="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="cell-ask-item"
                  class="flex-1 cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1.5 text-left font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
                  :title="`Bring ${target.label}'s last turn here`"
                  @click="askCell(target)"
                >
                  {{ target.label }}
                </button>
                <button
                  type="button"
                  data-testid="cell-exchange-item"
                  :aria-label="`Exchange one turn with ${target.label}`"
                  class="cursor-pointer rounded-[4px] border-none bg-transparent px-1.5 py-1.5 font-sans text-[12px] text-dim hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40"
                  :disabled="exchanging"
                  title="Send this cell's turn there and bring the answer back, both submitted"
                  @click="exchangeWith(target)"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
                </button>
              </div>
              <p v-if="!askTargets.length" class="m-0 px-2 py-1.5 font-sans text-[12px] text-dim">No other terminal to read</p>
            </div>
            <button
              v-if="exchanging"
              type="button"
              data-testid="cell-exchange-stop"
              aria-label="Stop the exchange in progress"
              class="absolute right-0 top-full z-20 mt-1 cursor-pointer whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1.5 font-sans text-[12px] text-secondary shadow-[0_6px_18px_rgba(0,0,0,0.35)] hover:text-fg"
              @click="stopExchange"
            >
              <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span> exchanging — stop
            </button>
            <p
              v-else-if="askMsg"
              data-testid="cell-ask-msg"
              role="status"
              class="absolute right-0 top-full z-20 m-0 mt-1 whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1.5 font-sans text-[12px] text-dim shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
            >
              {{ askMsg }}
            </p>
          </span>
          <!-- Copy the last reply / the last prompt, whole, from the transcript. The label
               replaces the icon for a moment on click — no toast (see copyTurn). -->
          <button
            v-if="sessionId"
            type="button"
            data-testid="cell-copy-reply"
            class="cell-btn"
            :class="[CELL_BTN_BOX, CELL_BTN_INK, copyLabels.reply ? 'h-[26px] px-1 font-sans text-[10px]' : CELL_BTN_SIZE]"
            title="Copy this pane's last reply, in full, from its transcript (not the wrapped screen text)"
            aria-label="Copy the last reply"
            @click="copyTurn('reply')"
          >
            <span v-if="copyLabels.reply">{{ copyLabels.reply }}</span>
            <span v-else class="material-symbols-outlined" aria-hidden="true">content_copy</span>
          </button>
          <button
            v-if="sessionId"
            type="button"
            data-testid="cell-copy-prompt"
            class="cell-btn"
            :class="[CELL_BTN_BOX, CELL_BTN_INK, copyLabels.prompt ? 'h-[26px] px-1 font-sans text-[10px]' : CELL_BTN_SIZE]"
            title="Copy the last instruction you gave this pane"
            aria-label="Copy the last prompt"
            @click="copyTurn('prompt')"
          >
            <span v-if="copyLabels.prompt">{{ copyLabels.prompt }}</span>
            <span v-else class="material-symbols-outlined" aria-hidden="true">format_quote</span>
          </button>
          <!-- Fork-local (iTerm2 mode, R12): `claude --resume <this session> --fork-session`
               in the column right beside this one — the command the operator was typing by
               hand. Claude only (codex has no equivalent), and only once there is a
               conversation to branch. Lives on this row, not row 1: the tiled columns must
               not grow another always-visible control. -->
          <button
            v-if="sessionId && agent !== 'codex'"
            type="button"
            data-testid="cell-fork"
            class="cell-btn"
            :class="CELL_BTN"
            title="Fork this conversation into a new column (claude --resume --fork-session)"
            aria-label="Fork this session into a new column"
            @click="emit('fork')"
          >
            <span class="material-symbols-outlined" aria-hidden="true">call_split</span>
          </button>
          <button
            v-if="sessionId && agent !== 'codex'"
            class="cell-btn"
            :class="CELL_BTN"
            title="Activity timeline"
            aria-label="Show activity timeline"
            @click="timelineOpen = true"
          >
            <span class="material-symbols-outlined" aria-hidden="true">history</span>
          </button>
          <button v-if="reorderable" class="cell-btn" :class="CELL_BTN" title="Move left" aria-label="Move terminal left" @click="emit('move', -1)">
            <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
          </button>
          <button v-if="reorderable" class="cell-btn" :class="CELL_BTN" title="Move right" aria-label="Move terminal right" @click="emit('move', 1)">
            <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
          </button>
        </template>
      </TerminalView>
      <div
        v-if="diffOpen && diff"
        data-testid="cell-diff"
        class="absolute inset-x-0 bottom-0 top-[34px] z-[15] flex flex-col overflow-hidden border-t border-t-border bg-base"
      >
        <div class="flex flex-none items-center gap-2 border-b border-b-border bg-panel px-2 py-1.5">
          <span class="font-sans text-[12px] font-semibold text-fg">Changes vs {{ diff?.base ?? "base" }}</span>
          <span class="flex-auto font-sans text-[11px] text-dim">{{ diff?.ahead ?? 0 }} ahead · {{ diff?.dirty ?? 0 }} uncommitted</span>
          <button class="cell-btn" :class="CELL_BTN" title="Close diff" aria-label="Close diff" @click="diffOpen = false">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        <div v-if="diff && diff.files.length" class="max-h-[35%] flex-none overflow-y-auto border-b border-b-border px-2 py-1">
          <div v-for="f in diff.files" :key="f.path" data-testid="cell-diff-file" class="flex items-baseline gap-2 py-px font-mono text-[11px]">
            <span class="min-w-0 flex-auto truncate text-secondary [direction:rtl]">{{ f.path }}</span>
            <span v-if="f.status === 'untracked'" data-testid="df-new" class="flex-none text-[#3fae6b]">new</span>
            <span v-else class="flex-none">
              <span class="text-[#3fae6b]">+{{ f.additions < 0 ? "bin" : f.additions }}</span>
              <span class="text-err-text">−{{ f.deletions < 0 ? "bin" : f.deletions }}</span>
            </span>
          </div>
        </div>
        <pre
          v-if="diff && diff.patch"
          data-testid="cell-diff-patch"
          class="m-0 flex-auto overflow-auto whitespace-pre p-2 font-mono text-[11px] leading-[1.45] text-secondary [tab-size:2]"
          >{{ diff.patch }}</pre>
        <p v-if="diff && diff.truncated" class="m-0 p-2 font-sans text-[11px] text-dim">Diff truncated — open the worktree to see the rest.</p>
        <p v-if="diff && !diff.files.length" class="m-0 p-2 font-sans text-[11px] text-dim">No changes yet.</p>
        <div class="flex flex-none items-center gap-2 border-t border-t-border bg-panel px-2 py-1.5">
          <button
            data-testid="cell-diff-btn"
            class="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-elevated px-3 py-1 font-sans text-[12px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="prBusy || working || (diff?.dirty ?? 0) === 0"
            :title="(diff?.dirty ?? 0) === 0 ? 'No uncommitted changes' : working ? 'Wait for the session to finish' : 'Ask Claude to commit the changes'"
            @click="commitViaClaude"
          >
            <span class="material-symbols-outlined" aria-hidden="true">check</span> Commit
          </button>
          <button
            data-testid="cell-diff-btn"
            class="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-elevated px-3 py-1 font-sans text-[12px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="prBusy || (diff?.ahead ?? 0) === 0"
            :title="(diff?.ahead ?? 0) === 0 ? 'Commit changes first' : 'git push -u origin'"
            @click="pushBranch"
          >
            <span class="material-symbols-outlined" aria-hidden="true">arrow_upward</span> Push
          </button>
          <button
            data-testid="cell-diff-btn"
            class="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-elevated px-3 py-1 font-sans text-[12px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="prBusy || (diff?.ahead ?? 0) === 0"
            :title="(diff?.ahead ?? 0) === 0 ? 'Commit changes in the terminal first' : 'Push and open a pull request'"
            @click="openPR"
          >
            <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span> Open PR
          </button>
          <span v-if="prMsg" data-testid="cell-diff-msg" class="min-w-0 flex-auto truncate font-sans text-[11px] text-dim">{{ prMsg }}</span>
        </div>
      </div>
      <div
        v-if="closeConfirm"
        data-testid="cell-close-confirm"
        class="absolute inset-0 z-[25] flex items-center justify-center bg-[color-mix(in_srgb,var(--bg-base)_82%,transparent)] p-4"
        role="dialog"
        aria-modal="true"
        :aria-label="`Close worktree ${headerDir}`"
      >
        <div class="flex max-w-[320px] flex-col gap-2.5 rounded-lg border border-border bg-panel p-4 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
          <p class="m-0 font-sans text-[13px] font-semibold text-fg">Close {{ headerDir }}</p>
          <template v-if="!closeError">
            <p v-if="hasUnsaved" data-testid="ccx-warn" class="m-0 font-sans text-[12px] text-[var(--warn-text,#e0a030)]">
              {{ unsavedSummary }} will be discarded if you remove the worktree.
            </p>
            <p v-else class="m-0 font-sans text-[12px] text-dim">Keep the worktree to reuse it later, or remove it.</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                data-testid="ccx-keep"
                class="cursor-pointer rounded-md border border-accent bg-elevated px-3 py-1.5 font-sans text-[12px] text-fg hover:bg-hover hover:text-fg"
                @click="teardown"
              >
                Keep worktree
              </button>
              <button
                data-testid="ccx-remove"
                class="cursor-pointer rounded-md border border-border bg-elevated px-3 py-1.5 font-sans text-[12px] text-secondary hover:border-err-text hover:bg-[var(--err-hover-bg)] hover:text-err-text"
                :disabled="closeChecking"
                @click="removeAndClose"
              >
                {{ closeChecking ? "Checking…" : hasUnsaved ? "Discard &amp; remove" : "Remove worktree" }}
              </button>
              <button
                data-testid="ccx-cancel"
                class="cursor-pointer rounded-md border border-border bg-elevated px-3 py-1.5 font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
                @click="cancelClose"
              >
                Cancel
              </button>
            </div>
          </template>
          <template v-else>
            <p data-testid="ccx-warn" class="m-0 font-sans text-[12px] text-[var(--warn-text,#e0a030)]">{{ closeError }}</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                data-testid="ccx-remove"
                class="cursor-pointer rounded-md border border-border bg-elevated px-3 py-1.5 font-sans text-[12px] text-secondary hover:border-err-text hover:bg-[var(--err-hover-bg)] hover:text-err-text"
                @click="removeAndClose"
              >
                Retry
              </button>
              <button
                class="cursor-pointer rounded-md border border-border bg-elevated px-3 py-1.5 font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
                @click="teardown"
              >
                Close cell
              </button>
            </div>
          </template>
        </div>
      </div>
    </template>
    <div v-else data-testid="cell-launch" class="flex min-h-0 flex-1 flex-col items-center justify-start gap-2 overflow-y-auto p-4">
      <button
        v-if="cancellable"
        type="button"
        data-testid="cell-launch-cancel"
        class="absolute right-1.5 top-1.5 inline-flex h-[26px] w-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-[16px] leading-none text-secondary hover:bg-[var(--err-hover-bg)] hover:text-err-text"
        title="Cancel new terminal"
        aria-label="Cancel new terminal"
        @click="emit('close')"
      >
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
      <div v-if="presets.length" class="flex max-w-[360px] flex-wrap justify-center gap-1.5">
        <span
          v-for="p in presets"
          :key="p.label + p.path"
          data-testid="cell-chip"
          class="inline-flex items-stretch overflow-hidden rounded-[14px] border"
          :class="[
            { 'is-running': isCwdRunning(p.path) },
            isCwdRunning(p.path)
              ? 'border-[color-mix(in_srgb,#3b82f6_55%,var(--border))] bg-[color-mix(in_srgb,#3b82f6_14%,var(--bg-elevated))]'
              : 'border-border bg-elevated',
          ]"
        >
          <button
            type="button"
            data-testid="cell-chip-main"
            class="cursor-pointer border-none bg-transparent px-2.5 py-1 font-sans text-[12px] hover:bg-hover hover:text-fg"
            :class="isCwdRunning(p.path) ? 'text-fg' : 'text-secondary'"
            :title="p.path"
            :aria-label="`Use ${p.label} — fill the field to browse / resume here (without launching)`"
            @click="fillDir(p.path)"
          >
            <span
              v-if="isCwdRunning(p.path)"
              data-testid="cell-chip-dot"
              class="mr-[5px] inline-block h-1.5 w-1.5 rounded-full bg-[#3b82f6] align-middle"
              aria-hidden="true"
            />{{ p.label }}
          </button>
          <button
            type="button"
            data-testid="cell-chip-launch"
            class="inline-flex cursor-pointer items-center border-0 border-l border-l-border bg-transparent px-[5px] text-secondary hover:bg-hover hover:text-fg"
            :title="isCwdRunning(p.path) ? `${p.path} — a session is already running here in another terminal` : `Launch a new terminal in ${p.path} now`"
            :aria-label="
              isCwdRunning(p.path) ? `${p.label} — a session is already running here in another terminal` : `Launch a new terminal in ${p.label} now`
            "
            @click="selectPreset(p)"
          >
            <span class="material-symbols-outlined text-[14px]" aria-hidden="true">play_arrow</span>
          </button>
          <button
            type="button"
            data-testid="cell-chip-del"
            class="cursor-pointer border-0 border-l border-l-border bg-transparent px-[7px] text-[11px] text-secondary hover:bg-hover hover:text-[var(--danger,#e5484d)]"
            :title="`Remove ${p.path} from the list`"
            :aria-label="`Remove ${p.path} from the list`"
            @click="emit('remove-preset', p.path)"
          >
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </span>
      </div>
      <div class="inline-flex gap-0.5 self-start rounded-[7px] border border-border bg-deep p-0.5" role="radiogroup" aria-label="Agent">
        <button
          type="button"
          class="cursor-pointer rounded-[5px] border-none px-3.5 py-1 font-sans text-[12px] font-medium"
          :class="agent === 'claude' ? 'bg-elevated text-fg' : 'bg-transparent text-dim hover:text-fg'"
          role="radio"
          :aria-checked="agent === 'claude'"
          @click="agent = 'claude'"
        >
          Claude
        </button>
        <button
          type="button"
          class="cursor-pointer rounded-[5px] border-none px-3.5 py-1 font-sans text-[12px] font-medium"
          :class="agent === 'codex' ? 'bg-elevated text-fg' : 'bg-transparent text-dim hover:text-fg'"
          role="radio"
          :aria-checked="agent === 'codex'"
          @click="agent = 'codex'"
        >
          Codex
        </button>
      </div>
      <label class="flex w-full max-w-[360px] flex-col items-center gap-1.5">
        <span class="font-sans text-[11px] uppercase tracking-[0.05em] text-dim">Working directory</span>
        <span class="flex w-full items-stretch gap-1.5">
          <input
            v-model="dirInput"
            data-testid="cell-dir-input"
            class="box-border w-full rounded-md border border-border bg-input px-2.5 py-[7px] font-mono text-[12px] text-fg focus:border-accent focus:outline-none min-w-0 flex-auto"
            type="text"
            placeholder="/path/to/project"
            spellcheck="false"
            @input="dirTouched = true"
            @keydown.enter="launch"
          />
          <button
            type="button"
            class="flex-none inline-flex items-center justify-center px-2 rounded-md border border-border bg-elevated text-secondary cursor-pointer hover:bg-hover hover:text-fg hover:border-accent"
            title="Choose a folder…"
            aria-label="Choose the working directory"
            @click="pickDir"
          >
            <span class="material-symbols-outlined text-[18px]" aria-hidden="true">folder_open</span>
          </button>
          <button
            type="button"
            data-testid="cell-dir-go"
            class="inline-flex flex-none cursor-pointer items-center justify-center rounded-md border border-border bg-elevated px-2 text-secondary enabled:hover:border-accent enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-40"
            :disabled="!dirInput.trim()"
            title="Start a new terminal here (or press Enter)"
            aria-label="Start a new terminal here"
            @click="launch"
          >
            <span class="material-symbols-outlined text-[18px]" aria-hidden="true">play_arrow</span>
          </button>
        </span>
      </label>
      <!-- Codex has its own model configuration and doesn't read this one. -->
      <ModelPicker v-if="agent === 'claude'" v-model="launchChoice" />
      <div v-if="isGitRepo" data-testid="cell-worktrees" class="flex w-full max-w-[360px] flex-col items-stretch gap-1.5">
        <span class="font-sans text-[11px] uppercase tracking-[0.05em] text-dim">or isolate in a worktree (git repo)</span>
        <div class="flex gap-1.5">
          <input
            v-model="worktreeTask"
            data-testid="wt-task"
            class="box-border w-full rounded-md border border-border bg-input px-2.5 py-[7px] font-mono text-[12px] text-fg focus:border-accent focus:outline-none w-auto min-w-0 flex-auto"
            type="text"
            placeholder="task name (e.g. fix-login)"
            aria-label="Worktree task name"
            spellcheck="false"
            @keydown.enter="createWorktreeAndLaunch"
          />
          <button
            data-testid="wt-start"
            class="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-elevated px-4 py-[7px] font-sans text-[14px] font-medium text-secondary flex-none whitespace-nowrap hover:bg-hover hover:text-fg"
            :disabled="!worktreeTask.trim()"
            @click="createWorktreeAndLaunch"
          >
            <span class="material-symbols-outlined" aria-hidden="true">add</span> New worktree
          </button>
        </div>
        <div v-for="w in worktrees" :key="w.path" class="flex items-center gap-1.5">
          <button
            class="flex-auto min-w-0 text-left rounded-md border border-border bg-elevated text-secondary cursor-pointer font-mono text-[12px] py-[5px] px-2.5 truncate hover:bg-hover hover:text-fg"
            data-testid="worktree-reuse"
            :title="w.branch ?? w.path"
            @click="reuseWorktree(w)"
          >
            ⎇ {{ w.task }}<span v-if="w.dirty" data-testid="wt-dirty" class="ml-1.5 text-[var(--warn-text,#e0a030)]" title="uncommitted changes">●</span>
          </button>
          <button
            data-testid="wt-del"
            class="flex-none cursor-pointer rounded-md border-none bg-transparent px-1.5 py-1 text-[13px] hover:bg-[var(--err-hover-bg)]"
            title="Remove worktree"
            aria-label="Remove worktree"
            @click="removeWorktree(w)"
          >
            <span class="material-symbols-outlined" aria-hidden="true">delete</span>
          </button>
        </div>
      </div>
      <div v-if="scripts.length" class="flex w-full max-w-[360px] flex-col items-center gap-1.5">
        <span class="font-sans text-[11px] uppercase tracking-[0.05em] text-dim">or run a script</span>
        <div class="flex w-full flex-wrap justify-center gap-1.5">
          <button
            v-for="s in scripts"
            :key="s.index"
            data-testid="cell-script-item"
            class="inline-flex cursor-pointer items-center gap-1 rounded-[14px] border border-[#2a4e3a] bg-[#16271d] px-2.5 py-1 font-sans text-[12px] text-[#b6e3c7] hover:border-[#3fae6b] hover:bg-[#1f3a2a] hover:text-white"
            :title="s.command"
            @click="runScript(s)"
          >
            <span class="material-symbols-outlined" aria-hidden="true">play_arrow</span> {{ s.label }}
          </button>
        </div>
      </div>
      <div v-if="launchers && launchers.length" class="flex w-full max-w-[360px] flex-col items-center gap-1.5">
        <span class="font-sans text-[11px] uppercase tracking-[0.05em] text-dim">or launch</span>
        <div class="flex w-full flex-wrap justify-center gap-1.5">
          <button
            v-for="(l, i) in launchers"
            :key="l.label"
            data-testid="cell-script-item"
            class="inline-flex cursor-pointer items-center gap-1 rounded-[14px] border border-[#2a4e3a] bg-[#16271d] px-2.5 py-1 font-sans text-[12px] text-[#b6e3c7] hover:border-[#3fae6b] hover:bg-[#1f3a2a] hover:text-white"
            :title="l.command"
            @click="launchProgram(i, l)"
          >
            <span class="material-symbols-outlined" aria-hidden="true">rocket_launch</span> {{ l.label }}
          </button>
        </div>
      </div>
      <div v-if="resumable.length" data-testid="cell-resume" class="flex min-h-0 w-full max-w-[360px] flex-col items-center gap-1.5">
        <span class="font-sans text-[11px] uppercase tracking-[0.05em] text-dim">or resume here</span>
        <div class="flex w-full flex-col gap-1">
          <button
            v-for="s in resumable"
            :key="s.id"
            data-testid="cell-resume-item"
            class="flex cursor-pointer items-baseline justify-between gap-2 rounded-md border bg-deep px-2.5 py-[5px] text-left font-sans text-[12px] text-secondary hover:border-accent hover:bg-elevated"
            :class="[{ 'is-open': sessionOpenElsewhere(s.id) }, sessionOpenElsewhere(s.id) ? 'border-amber' : 'border-border']"
            :title="sessionOpenElsewhere(s.id) ? `${s.title} — already open in another terminal` : s.title"
            @click="resume(s)"
          >
            <span data-testid="ri-title" class="truncate">{{ s.title }}</span>
            <span
              v-if="sessionOpenElsewhere(s.id)"
              data-testid="ri-open"
              class="flex-none whitespace-nowrap text-[11px] text-amber"
              title="Already open in another terminal"
              >● open</span
            >
            <span class="flex-none text-[11px] text-dim">{{ relativeTime(s.mtime) }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
