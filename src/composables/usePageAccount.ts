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

const view = ref<PageAccountView | null>(null);
let applier: ((email: string | null) => void) | null = null;

// GridView owns the pages: it registers the setter and keeps `view` current.
export function registerPageAccountHandler(h: (email: string | null) => void): () => void {
  applier = h;
  // Guarded like useNewTerminal's: a second mount registering before the first unmounts must
  // keep ITS applier and ITS view, or the chip goes blank for the grid that is actually up.
  return () => {
    if (applier !== h) return;
    applier = null;
    view.value = null;
  };
}

export function reportPageAccount(next: PageAccountView): void {
  view.value = next;
}

// Point the ACTIVE page at an account (null = follow the default login). No-op without a
// grid — the chip hides the per-page section in that case rather than offering a dead click.
export function applyPageAccount(email: string | null): void {
  applier?.(email);
}

export function usePageAccount() {
  return { pageAccount: computed(() => view.value) };
}
