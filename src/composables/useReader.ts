// Navigation seam for the reader, the sibling of useWikiBrowse: the open doc is the URL
// (/reader?doc=<absolute path>), nothing is retained. The reader is meant to live in its
// OWN browser tab beside the terminal grid, so `openReaderTab` targets a named window —
// a second click focuses the tab that is already open instead of piling up another.
import { computed, type ComputedRef } from "vue";
import { router } from "../router";
import { overlayOriginState, overlayReturnPath } from "./overlayOrigin";

export const READER_WINDOW_NAME = "mulmoterminal-reader";

/** Open (or focus) the reader tab, optionally on one doc. */
export function openReaderTab(path?: string): void {
  const url = path ? `/reader?doc=${encodeURIComponent(path)}` : "/reader";
  const win = window.open(url, READER_WINDOW_NAME);
  win?.focus();
}

/** Show a doc in THIS tab's reader (the tab is already the reader). */
export function readerGoto(path: string | null): void {
  router.push({ path: "/reader", query: path ? { doc: path } : {}, state: overlayOriginState() });
}

export function readerClose(): void {
  router.push(overlayReturnPath());
}

export function useReader(): { isOpen: ComputedRef<boolean>; docPath: ComputedRef<string | null>; close: () => void } {
  const isOpen = computed(() => router.currentRoute.value.name === "reader");
  const docPath = computed(() => {
    const doc = router.currentRoute.value.query.doc;
    return typeof doc === "string" && doc ? doc : null;
  });
  return { isOpen, docPath, close: readerClose };
}
