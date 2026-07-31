import { onUnmounted, watch, type Ref } from "vue";
import { usePubSub } from "./usePubSub";
import { paneStateOf, type WaitKind } from "../../common/paneState";
import { isActionState } from "../../common/notifyKinds";

interface ActivityMsg {
  id: string;
  working?: boolean;
  waiting?: boolean;
  // The session's working dir, so a beep can use that directory's custom sound.
  cwd?: string | null;
  // Which hook set the state, and (for a Notification) what kind of wait it is — the two
  // fields that tell a BLOCKED pane from a merely finished one, hence which chime to use.
  event?: string | null;
  waitKind?: WaitKind | null;
}
interface ActivityState {
  working: boolean;
  waiting: boolean;
}
const isActivityMsg = (d: unknown): d is ActivityMsg => typeof d === "object" && d !== null && "id" in d;

// True when this activity push means the session now needs you: it just finished a
// turn (working true→false — Claude's Stop, published for every session) or it set
// `waiting` (a prompt/permission, published for background sessions). First sight is
// baseline only (no beep). Mutates `prev` to the latest state.
export function needsAttention(prev: Map<string, ActivityState>, msg: ActivityMsg): boolean {
  const now: ActivityState = { working: msg.working ?? false, waiting: msg.waiting ?? false };
  const was = prev.get(msg.id);
  prev.set(msg.id, now);
  if (!was) return false;
  const finishedTurn = was.working && !now.working;
  const becameWaiting = !was.waiting && now.waiting;
  return finishedTurn || becameWaiting;
}

// How loud a beep should be about itself (R14). Two agents needing an answer and one that
// merely finished reading cost the operator different amounts, and thirty panes make that
// difference audible: a grid where every event is the same rising two-note chime trains you to
// stop hearing all of them.
//   urgent — a pane is BLOCKED (承認待ち / 質問). The existing two-note chime, unchanged.
//   soft   — a pane finished a turn (完了・未読). One quieter, lower note.
export type AttentionTone = "urgent" | "soft";

/** Which chime a "sessions" payload deserves, decided in the pane-state vocabulary so it can
 *  never drift from the word the cell shows or the kind the notifier filters on. */
export function attentionToneFor(msg: ActivityMsg): AttentionTone {
  const state = paneStateOf({
    working: msg.working ?? false,
    waiting: msg.waiting ?? false,
    event: msg.event,
    waitKind: msg.waitKind,
    connected: true,
  });
  return isActionState(state) ? "urgent" : "soft";
}

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    audioCtx = audioCtx ?? new AudioContext();
    return audioCtx;
  } catch {
    return null;
  }
}

// Autoplay policy: an AudioContext starts suspended until a user gesture, so a beep
// fired from an event (not a gesture) would be silent. Arm a one-shot listener that
// resumes the context on the first click/keypress anywhere; after that, beeps play.
let unlockArmed = false;
function armUnlock() {
  if (unlockArmed) return;
  unlockArmed = true;
  const unlock = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

// The built-in chimes via Web Audio (no asset). `urgent` is the original rising two-note
// figure, unchanged; `soft` is a single lower note at under half the gain, so a finished turn
// registers without competing with a pane that is actually stuck.
function playAttentionSound(tone: AttentionTone = "urgent") {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const note = (freq: number, start: number, dur: number, peak: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = ctx.currentTime + start;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  };
  try {
    if (tone === "soft") {
      note(587, 0, 0.2, 0.1); // D5 — one quiet note
      return;
    }
    note(784, 0, 0.16, 0.25); // G5
    note(1047, 0.14, 0.22, 0.25); // C6
  } catch {
    // no Web Audio — stay silent
  }
}

// The user's custom sound, decoded once into an AudioBuffer (keyed by its path so a
// settings change reloads it). The server streams the configured file at /api/sound;
// a 404 / decode failure leaves the buffer null and we use the chime.
let customBuffer: AudioBuffer | null = null;
let customLoadedFor: string | null = null;
let customLoading: Promise<void> | null = null;

function loadCustomSound(soundFile: string): Promise<void> {
  if (customLoadedFor === soundFile) return customLoading ?? Promise.resolve();
  customLoadedFor = soundFile;
  customBuffer = null;
  customLoading = (async () => {
    const ctx = getCtx();
    if (!ctx) return;
    let decoded: AudioBuffer | null = null;
    try {
      const res = await fetch(`/api/sound?v=${encodeURIComponent(soundFile)}`);
      if (res.ok) decoded = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      decoded = null; // unreadable / not audio — fall back to the chime
    }
    // Only assign if this is still the selected sound: a slower load for a now-stale
    // path (A→B switch) must not overwrite B's buffer.
    if (customLoadedFor === soundFile) customBuffer = decoded;
  })();
  return customLoading;
}

function playBuffer(buf: AudioBuffer) {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = 0.6;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.start();
}

// A directory's own attention sound (<cwd>/.mulmoterminal.json), decoded once and
// cached by cwd. `undefined` = not checked yet; `null` = checked, no sound (so we
// never refetch a dir that has none). Streamed from /api/dir-sound?cwd=<cwd>.
const dirBuffers = new Map<string, AudioBuffer | null>();
const dirLoading = new Map<string, Promise<void>>();

function loadDirSound(cwd: string): Promise<void> {
  if (dirBuffers.has(cwd)) return Promise.resolve();
  const existing = dirLoading.get(cwd);
  if (existing) return existing;
  const loading = (async () => {
    const ctx = getCtx();
    if (!ctx) return; // can't decode without an AudioContext — leave unknown to retry
    let decoded: AudioBuffer | null = null;
    try {
      const res = await fetch(`/api/dir-sound?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) decoded = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      decoded = null; // 404 / unreadable / not audio — the dir has no usable sound
    }
    dirBuffers.set(cwd, decoded);
  })();
  dirLoading.set(
    cwd,
    loading.finally(() => dirLoading.delete(cwd)),
  );
  return loading;
}

// Play the attention sound, preferring the session directory's own sound, then the
// user's global custom file, then the chime. A dir sound not yet decoded is loaded in
// the background (this beep falls back), so later beeps for that dir use it.
//
// `tone` picks between the built-in chimes ONLY. A configured file — the directory's or the
// global one — is the user naming the sound they want for that session, and re-deciding it per
// state would silently override a choice they made explicitly (R14 keeps dir sounds working
// exactly as before).
export function playAttentionFor(cwd: string | null, soundFile: string | null, tone: AttentionTone = "urgent") {
  if (cwd) {
    const buf = dirBuffers.get(cwd);
    if (buf) {
      playBuffer(buf);
      return;
    }
    if (buf === undefined) loadDirSound(cwd);
  }
  playAttention(soundFile, tone);
}

// Play the attention sound: the user's custom file when configured AND already
// loaded, otherwise the built-in chime. A newly-configured file is loaded in the
// background, so the first beep uses the chime and later ones the custom sound.
export function playAttention(soundFile: string | null, tone: AttentionTone = "urgent") {
  if (soundFile) {
    if (customLoadedFor !== soundFile) loadCustomSound(soundFile);
    if (customBuffer && customLoadedFor === soundFile) {
      playBuffer(customBuffer);
      return;
    }
  }
  playAttentionSound(tone);
}

// Test-button variant: AWAIT the custom file's load so a just-configured sound is
// actually heard (the live beep path stays synchronous and chime-first).
export async function previewAttention(soundFile: string | null) {
  if (soundFile) {
    await loadCustomSound(soundFile);
    if (customBuffer && customLoadedFor === soundFile) {
      playBuffer(customBuffer);
      return;
    }
  }
  playAttentionSound();
}

// Beep when any session transitions into `waiting` (needs attention), across every
// page/view, by listening to the same "sessions" activity stream the cells use — so
// the beep tracks the amber header exactly. `enabled` gates it (the sound toggle);
// `soundFile`, when set, plays the user's chosen file instead of the chime.
export function useAttentionSound(enabled: Ref<boolean>, soundFile?: Ref<string | null>) {
  armUnlock();
  // Preload the custom sound whenever it's set/changed, so the first beep can use it.
  if (soundFile) watch(soundFile, (f) => f && loadCustomSound(f), { immediate: true });
  const prev = new Map<string, ActivityState>();
  const { subscribe } = usePubSub();
  const unsubscribe = subscribe("sessions", (d) => {
    if (isActivityMsg(d) && needsAttention(prev, d) && enabled.value) playAttentionFor(d.cwd ?? null, soundFile?.value ?? null, attentionToneFor(d));
  });
  onUnmounted(unsubscribe);
}
