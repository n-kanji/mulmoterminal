// Fork-local (iTerm2 mode, operator request 2026-09-14): the two windows' half of "tear this
// page off into its own window" — the storage handshake, the window, and the register of pages
// that are out on loan. Every DECISION lives in components/gridDetach.ts as a pure transform;
// what is here is the part that can only be done in a browser.
//
// Why localStorage and not the server: the page being moved is a piece of THIS BROWSER's saved
// grid (`grid_v2*`), and the sessions inside it are the server's already. Nothing about the move
// is the server's business, and a `storage` event is delivered to every OTHER same-origin
// window — never the one that wrote it — which is exactly the "tell the other window" channel
// this needs, with no polling and no race with our own writes.
import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";
import {
  addDetached,
  detachBlockedReason,
  detachPage,
  detachedKeyFor,
  freeWorkspaceName,
  homeKeyFor,
  homeKeyPrefix,
  pagesPayload,
  parseDetached,
  parseHandoff,
  reattachPages,
  removeDetached,
  stateKeyForWorkspace,
  wsFromHomeKey,
  type DetachedPage,
  type PagePayload,
} from "../components/gridDetach";
import { pageLabel, parseGridState, type GridState } from "../components/gridTabs";
import { suppressNextUnloadGuard } from "./useUnloadGuard";

// How long the window that let a page go keeps that page's terminals in its connection pool.
// It must outlast the new window's page load: closing a socket starts the server's 30s reap
// grace, and a page that has not been picked up by then is a lost session. Five seconds is far
// past a local page load and far short of the grace.
const VACATE_DELAY_MS = 5_000;
const NOTICE_MS = 8_000;
// How long a window that asked to go home waits for the other one to actually take the page.
// The answer comes from a window that is already open, so it arrives in milliseconds; this only
// has to outlast a busy main thread. On timeout the window stays open WITH its sessions rather
// than closing on a hand-over nobody took.
const HANDOVER_ACK_MS = 4_000;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked — the feature is simply unavailable, the grid is not
  }
};
const write = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const drop = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage blocked
  }
};
const keys = (): string[] => {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
};

export interface DetachedPages {
  /** Pages this window has out in other windows, as the tab row shows them. */
  detached: Ref<DetachedPage[]>;
  /** This window IS a torn-off page and can be handed back. */
  isDetached: ComputedRef<boolean>;
  /** The page has been handed back: stop persisting, show the door. */
  wentHome: Ref<boolean>;
  /** Asked to go home, waiting for the other window to take the page. */
  handingOver: Ref<boolean>;
  /** Why the active page cannot be torn off, or null. */
  blockedReason: (page: number) => string | null;
  notice: Ref<string | null>;
  dismissNotice: () => void;
  detach: (page: number) => void;
  recall: (ws: string) => void;
  goHome: () => void;
}

/** Everything the moves need, gathered once so each of them can be read on its own. */
interface Ctx {
  state: Ref<GridState>;
  stateKey: string;
  workspace: string | null;
  detached: Ref<DetachedPage[]>;
  wentHome: Ref<boolean>;
  handingOver: Ref<boolean>;
  say: (text: string) => void;
  /** Returns false when storage refused the write — the register is the ONLY record that a
   *  `grid_v2:<ws>` belongs to this window, so a detach that cannot write it must not happen. */
  setRegister: (list: DetachedPage[]) => boolean;
  /** Start / stop the wait for the other window's answer (see HANDOVER_ACK_MS). */
  armAck: () => void;
  endAck: () => void;
  onVacate: (uids: number[]) => void;
}

// ------------------------------------------------------------------------------------ moves

function detachInto(ctx: Ctx, page: number): void {
  const blocked = detachBlockedReason(ctx.state.value, page);
  if (blocked) return ctx.say(blocked);
  const ws = freeWorkspaceName(ctx.state.value.pages?.[page]?.label ?? "", page, (name) => read(stateKeyForWorkspace(name)) !== null);
  const moved = detachPage(ctx.state.value, page, ctx.stateKey);
  if (!moved) return ctx.say("このページは切り離せません");
  const childKey = stateKeyForWorkspace(ws);
  const label = pageLabel(ctx.state.value, page);
  if (!write(childKey, JSON.stringify(moved.child))) return ctx.say("ブラウザの保存領域に書けませんでした");
  const register = addDetached(ctx.detached.value, { ws, label, at: Date.now() });
  if (!ctx.setRegister(register)) {
    // Without the register entry the page would have no ghost tab AND no way to be recognised
    // when it asks to come home. Better not to move it at all.
    drop(childKey);
    ctx.setRegister(removeDetached(register, ws));
    return ctx.say("ブラウザの保存領域に書けませんでした");
  }
  const before = ctx.state.value;
  // The page must LEAVE this grid before the other window attaches: one socket per session.
  ctx.state.value = moved.parent;
  const win = window.open(`/terminals?ws=${encodeURIComponent(ws)}`, ws);
  if (!win) {
    // Popup blocked. Put the page back exactly as it was — a page half-moved into a window that
    // never opened is a set of panes nobody can see.
    ctx.state.value = before;
    drop(childKey);
    ctx.setRegister(removeDetached(register, ws));
    return ctx.say("ブラウザにポップアップをブロックされました。このサイトのポップアップを許可してください");
  }
  win.focus();
  // Retire the vacated slots once the new window has taken the sessions over (see the delay).
  setTimeout(() => ctx.onVacate(moved.uids), VACATE_DELAY_MS);
}

// Take a set of pages back into this grid. All-or-nothing: a page that does not fit is left
// where it is, with its window and its storage entry intact, rather than being dropped.
function absorb(ctx: Ctx, pages: readonly PagePayload[], ws: string): boolean {
  if (pages.length === 0) return true; // nothing there — the register was stale, clearing it is right
  const { state: merged, rejected } = reattachPages(ctx.state.value, pages);
  if (rejected.length) {
    ctx.say("このウィンドウに空きがないので戻せません（ペインかページを減らしてください）");
    return false;
  }
  const label = ctx.detached.value.find((d) => d.ws === ws)?.label || ws;
  ctx.state.value = merged;
  ctx.say(`「${label}」を戻しました`);
  return true;
}

/** Take a page back into this window, whichever door it came through.
 *
 *  The page of record is always the other window's SAVED GRID, not the note it may have left:
 *  the grid is written on every change, so it is never staler, and a window that asked to come
 *  home and then kept working must not be merged back as it was minutes ago. The note's pages
 *  are the fallback for a grid that is no longer there at all.
 *
 *  Dropping the other window's key is also the ANSWER to its request — it watches that key and
 *  stands down when it disappears — so it happens only once the merge has actually been made. */
function takeBack(ctx: Ctx, ws: string, fallback: readonly PagePayload[]): void {
  const childKey = stateKeyForWorkspace(ws);
  const child = parseGridState(read(childKey));
  if (!absorb(ctx, child ? pagesPayload(child) : fallback, ws)) return;
  drop(childKey);
  drop(homeKeyFor(ctx.stateKey, ws));
  ctx.setRegister(removeDetached(ctx.detached.value, ws));
}

/** The tab row's ghost tab: pull a page back out of the window holding it. */
const recallFrom = (ctx: Ctx, ws: string): void => takeBack(ctx, ws, []);

// A window that wants to come home wrote a note. Take it, or leave it for the next try.
function adoptNote(ctx: Ctx, key: string): void {
  const ws = wsFromHomeKey(ctx.stateKey, key);
  if (!ws) return;
  const note = parseHandoff(read(key));
  // Not one of ours (or already taken back by hand) — drop the note rather than merge a page
  // this window may already be showing.
  if (!note || note.ws !== ws || !ctx.detached.value.some((d) => d.ws === ws)) return drop(key);
  takeBack(ctx, ws, note.pages);
}

/** This window is a torn-off page: ask to be taken back.
 *
 *  It does NOT close on the strength of having asked. The other window may be shut, showing
 *  another view, or too full to take the page, and a window that closes on an unanswered request
 *  drops its sockets — which arms the server's reap timer on sessions nobody else has picked up.
 *  So this writes the note and WAITS: the other window drops this one's grid key once it has
 *  merged the page, and the storage handler closes on that.
 *
 *  Persisting stops while waiting, because the answer deletes this window's grid key and a write
 *  landing after that would put an orphan workspace back. The note stays behind if the wait
 *  times out: a window that opens its grid later still finds the request. */
function goHomeFrom(ctx: Ctx): void {
  if (ctx.handingOver.value) return; // already asked — waiting for the answer
  const origin = ctx.state.value.origin;
  if (!origin || !ctx.workspace) return ctx.say("このウィンドウは切り離されたページではありません");
  const note = JSON.stringify({ ws: ctx.workspace, pages: pagesPayload(ctx.state.value), at: Date.now() });
  if (!write(homeKeyFor(origin, ctx.workspace), note)) return ctx.say("ブラウザの保存領域に書けませんでした");
  ctx.handingOver.value = true;
  ctx.armAck();
}

// Nobody answered. Keep the page, the sessions and the window exactly as they were — the note
// stays, so the other window picks the request up when it next shows its grid.
function ackTimedOut(ctx: Ctx): void {
  ctx.handingOver.value = false;
  ctx.say("元のウィンドウが受け取りませんでした（閉じているか、グリッドを開いていません）。開いたときに戻ります");
}

// Stop being a window on these sessions: no more persisting, no close warning, and close if the
// browser allows it. A window the browser refuses to close falls back to the "this page went
// home" panel, which unmounts the terminals — the other window is attaching to them.
function standDown(ctx: Ctx): void {
  ctx.endAck();
  ctx.handingOver.value = false;
  ctx.wentHome.value = true;
  suppressNextUnloadGuard();
  window.close();
}

// A window may have asked to come home while this one was closed, and a page's window may have
// been cleared by hand. Both are settled once, on the way in.
function settleOnStartup(ctx: Ctx): void {
  for (const key of keys()) if (key.startsWith(homeKeyPrefix(ctx.stateKey))) adoptNote(ctx, key);
  const gone = ctx.detached.value.filter((d) => read(stateKeyForWorkspace(d.ws)) === null && read(homeKeyFor(ctx.stateKey, d.ws)) === null);
  if (gone.length) ctx.setRegister(ctx.detached.value.filter((d) => !gone.some((g) => g.ws === d.ws)));
}

// What another window's write means to this one.
function handleStorage(ctx: Ctx, e: StorageEvent): void {
  if (e.storageArea && e.storageArea !== localStorage) return;
  if (!e.key) return; // storage.clear() — nothing to act on
  // A window asking to hand its page back to us.
  if (e.newValue !== null && wsFromHomeKey(ctx.stateKey, e.key)) return adoptNote(ctx, e.key);
  // Our own grid was taken away: the window we were torn off from holds the page now. That is
  // both the answer to a hand-over we asked for and the whole of a recall we did not.
  if (e.key === ctx.stateKey && e.newValue === null && ctx.state.value.origin && !ctx.wentHome.value) standDown(ctx);
}

// ---------------------------------------------------------------------------------- the shell

// The window's side of the channel: the refs the view renders, the ctx the moves act through,
// and the two timers. Split from the composable so each half stays readable on its own.
function createChannel(state: Ref<GridState>, stateKey: string, workspace: string | null, onVacate: (uids: number[]) => void) {
  const detached = ref<DetachedPage[]>(parseDetached(read(detachedKeyFor(stateKey))));
  const wentHome = ref(false);
  const handingOver = ref(false);
  const notice = ref<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;

  const ctx: Ctx = {
    state,
    stateKey,
    workspace,
    detached,
    wentHome,
    handingOver,
    onVacate,
    armAck: () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = setTimeout(() => ackTimedOut(ctx), HANDOVER_ACK_MS);
    },
    endAck: () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
    },
    say: (text: string) => {
      notice.value = text;
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => (notice.value = null), NOTICE_MS);
    },
    setRegister: (list: DetachedPage[]) => {
      detached.value = list;
      if (!list.length) {
        drop(detachedKeyFor(stateKey));
        return true;
      }
      return write(detachedKeyFor(stateKey), JSON.stringify(list));
    },
  };

  const dismissNotice = () => {
    if (noticeTimer) clearTimeout(noticeTimer);
    notice.value = null;
  };
  const dispose = () => {
    if (noticeTimer) clearTimeout(noticeTimer);
    if (ackTimer) clearTimeout(ackTimer);
  };
  return { ctx, detached, wentHome, handingOver, notice, dismissNotice, dispose };
}

/**
 * @param state      the window's live grid (replaced on a move)
 * @param stateKey   the localStorage key that grid is saved under
 * @param workspace  this window's `?ws=` name, or null for the original window
 * @param onVacate   uids whose terminals this window no longer shows, once the new window has
 *                   had time to take them over — the caller retires their connection slots.
 */
export function useDetachedPages(state: Ref<GridState>, stateKey: string, workspace: string | null, onVacate: (uids: number[]) => void): DetachedPages {
  const { ctx, detached, wentHome, handingOver, notice, dismissNotice, dispose } = createChannel(state, stateKey, workspace, onVacate);
  const onStorage = (e: StorageEvent) => handleStorage(ctx, e);

  // onMounted / onBeforeUnmount deliberately, where the rest of GridView uses activated /
  // deactivated: those install SINGLETON handlers that must belong to whichever view is on
  // screen. This is a plain window listener that should live as long as the cached component —
  // a hand-over arriving while the operator is on another route is still taken, rather than
  // dropped and found only on the next reload.
  onMounted(() => {
    window.addEventListener("storage", onStorage);
    settleOnStartup(ctx);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("storage", onStorage);
    dispose();
  });

  return {
    detached,
    isDetached: computed(() => typeof state.value.origin === "string"),
    wentHome,
    handingOver,
    blockedReason: (page: number) => detachBlockedReason(state.value, page),
    notice,
    dismissNotice,
    detach: (page: number) => detachInto(ctx, page),
    recall: (ws: string) => recallFrom(ctx, ws),
    goHome: () => goHomeFrom(ctx),
  };
}
