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
type MouseNavTarget = Pick<Window, "addEventListener" | "removeEventListener">;

const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

export function isNavButton(button: number): boolean {
  return button === BACK_BUTTON || button === FORWARD_BUTTON;
}

export function installMouseNavGuard(target: MouseNavTarget = window): () => void {
  const guard = (event: Event) => {
    if (isNavButton((event as MouseEvent).button)) event.preventDefault();
  };
  target.addEventListener("mousedown", guard);
  target.addEventListener("mouseup", guard);
  target.addEventListener("auxclick", guard);
  return () => {
    target.removeEventListener("mousedown", guard);
    target.removeEventListener("mouseup", guard);
    target.removeEventListener("auxclick", guard);
  };
}
