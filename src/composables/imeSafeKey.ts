// The Enter that CONFIRMS an IME composition (Japanese input) arrives as a plain keydown
// with `key === "Enter"`, and Vue's `.enter` modifier does not filter it — only `isComposing`
// (or the legacy keyCode 229 some browsers report instead) marks it as the composition's own.
// At that moment v-model has NOT received the composed text yet, so a commit handler fired
// here saves a stale draft and closes the editor: type a Japanese name, hit Enter to confirm
// the conversion, and the rename silently vanishes (separator report 2026-08-27). Esc during
// composition is the same trap — it cancels the COMPOSITION, not the rename.
//
// So every rename input's Enter/Esc goes through this wrapper: a composition keystroke passes
// through untouched (no preventDefault either — the key belongs to the IME), a real one
// prevents default and runs the action. Same testable-without-DOM shape as gridShortcut.ts.

export interface RenameKeyEvent {
  isComposing?: boolean;
  keyCode?: number;
  preventDefault(): void;
}

export const imeSafeKey =
  (action: () => void) =>
  (e: RenameKeyEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    action();
  };
