// Fork-local (iTerm2 mode, R10): "is the operator typing into a terminal right now".
//
// The one consumer is the grid's auto sort (see components/sortHold.ts), which must not
// re-arrange the columns under a cursor mid-sentence. Two ways out of the hold, and both are
// needed: the typing STOPS (2s of silence — a pause long enough that a reorder is no longer a
// surprise), or the terminal loses focus (nothing is being typed anywhere, so there is nothing
// left to protect).
//
// Capture phase on `window`, like useCaptureKeydown: xterm binds keydown on its own textarea
// and swallows nothing, but capture is the only phase that is guaranteed to see the event
// whatever the terminal does with it afterwards. This listener never claims a key — it only
// notes that one happened.
import { onScopeDispose, ref, type Ref } from "vue";

export const TYPING_HOLD_MS = 2000;

// xterm.js puts the real focus on a hidden textarea it owns; the canvas never has it. That
// class is xterm's own public DOM contract (it is what its CSS targets), so keying on it is
// how "the cursor is in a terminal" is asked here — an <input> in the launch form or a page
// rename box is deliberately NOT a terminal and must not hold the sort.
export const XTERM_TEXTAREA_CLASS = "xterm-helper-textarea";

export function isTerminalTextarea(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.classList.contains(XTERM_TEXTAREA_CLASS);
}

export interface TypingHold {
  /** True while a terminal has been typed into within TYPING_HOLD_MS and still has focus. */
  holding: Ref<boolean>;
  /** Test seam: report a keystroke without a real DOM event. */
  noteKeystroke: (target: EventTarget | null) => void;
  /** Test seam / teardown: drop the hold now. */
  release: () => void;
}

export function useTypingHold(): TypingHold {
  const holding = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    holding.value = false;
  };

  const noteKeystroke = (target: EventTarget | null) => {
    if (!isTerminalTextarea(target)) return;
    holding.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(release, TYPING_HOLD_MS);
  };

  const onKeyDown = (e: KeyboardEvent) => noteKeystroke(e.target);
  // `focusout` rather than `blur`: blur does not bubble, and the listener is on the window.
  const onFocusOut = (e: FocusEvent) => {
    if (isTerminalTextarea(e.target)) release();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("focusout", onFocusOut, true);
  onScopeDispose(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("focusout", onFocusOut, true);
    release();
  });

  return { holding, noteKeystroke, release };
}
