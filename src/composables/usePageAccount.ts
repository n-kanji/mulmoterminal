// The bridge between the grid (which owns the pages) and the toolbar's account chip
// (which lives in AppToolbar, nowhere near that state) — operator request 2026-09-14.
//
// Same seam as useNewTerminal: GridView REGISTERS an applier on mount and reports the
// active page as it changes; the chip reads what to show and calls back to set it. With no
// grid mounted (any full-screen overlay) there is no applier, and the chip falls back to
// describing the default login only — which is all a page-less view can honestly say.
import { computed, ref } from "vue";

export interface PageAccountView {
  // The account this page starts new panes as; null = it follows the default login.
  account: string | null;
  // What to call the page in the menu ("Page 2", or its name when it has one).
  pageName: string;
}

// What a move did: `moved` are the sessions whose stamp just changed (to restart), `staying`
// the page's other running claude panes — already on the account, so untouched. The chip
// needs both: when nothing moved, `staying` is what a reload-the-login restart would hit.
export interface PagePanesMove {
  moved: string[];
  staying: string[];
}

// What the grid does for the chip: point the active page at an account, and — the running
// panes' move (operator request 2026-09-28) — re-stamp the page's live panes with that account
// and hand back their session ids for the restart. Two functions, one registration: they
// belong to the same grid, and a chip that could set a page it cannot move is half a control.
export interface PageAccountHandler {
  setAccount: (email: string | null) => void;
  movePanes: () => PagePanesMove;
}

const view = ref<PageAccountView | null>(null);
let handler: PageAccountHandler | null = null;

// GridView owns the pages: it registers the handler and keeps `view` current.
export function registerPageAccountHandler(h: PageAccountHandler): () => void {
  handler = h;
  // Guarded like useNewTerminal's: a second mount registering before the first unmounts must
  // keep ITS handler and ITS view, or the chip goes blank for the grid that is actually up.
  return () => {
    if (handler !== h) return;
    handler = null;
    view.value = null;
  };
}

export function reportPageAccount(next: PageAccountView): void {
  view.value = next;
}

// Point the ACTIVE page at an account (null = follow the default login). No-op without a
// grid — the chip hides the per-page section in that case rather than offering a dead click.
export function applyPageAccount(email: string | null): void {
  handler?.setAccount(email);
}

// Re-stamp the active page's running panes with the page's account and return the session
// ids to restart (plus the ones already there). Without a grid there is nothing to move, and
// two empty lists say so.
export function movePagePanes(): PagePanesMove {
  return handler?.movePanes() ?? { moved: [], staying: [] };
}

export function usePageAccount() {
  return { pageAccount: computed(() => view.value) };
}
