// The browser's back/forward mouse buttons (button 3 / button 4) history-navigate the
// tab by default — swapping the SPA view out from under every live session, exactly like
// the stray file drop useFileDropGuard exists for. Nothing in this app listens to those
// buttons, so anyone pressing them over the page is either doing it by accident or —
// the case that surfaced this — using a mouse whose side buttons normally mean something
// else entirely: Logi Options+ remaps them (to desktop switching etc.), but while macOS
// secure input is held that remap is blocked and the buttons fall through as raw
// back/forward. This window-level net preventDefaults them on every event Chrome might
// hang the navigation off (mousedown, mouseup, auxclick), so the press does nothing
// instead of tearing the user away from their terminals.
//
// Operator report 2026-09-02: preventDefault alone was not enough. The listeners ran in the
// bubble phase, so xterm's own mousedown handler had already fired — and xterm focuses the
// terminal on ANY mousedown, whichever button. A side button pressed while the pointer rested
// over some other pane moved keyboard focus to that pane. So the guard now runs in the
// CAPTURE phase on window (the first listener the event meets) and also stops propagation:
// nothing below — xterm, a cell header, a drag handle — ever sees a side-button press.
type MouseNavTarget = Pick<Window, "addEventListener" | "removeEventListener">;

const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

// Every event a side-button press produces that anything might act on. `pointer*` are
// included because a handler bound to those would otherwise still see the press.
export const NAV_BUTTON_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick"] as const;

export function isNavButton(button: number): boolean {
  return button === BACK_BUTTON || button === FORWARD_BUTTON;
}

export function installMouseNavGuard(target: MouseNavTarget = window): () => void {
  const guard = (event: Event) => {
    if (!isNavButton((event as MouseEvent).button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of NAV_BUTTON_EVENTS) target.addEventListener(type, guard, { capture: true });
  return () => {
    for (const type of NAV_BUTTON_EVENTS) target.removeEventListener(type, guard, { capture: true });
  };
}
