import { createApp } from "vue";
import "./style.css";
import "./tailwind.css";
// Configure the @mulmoclaude/collection-plugin UI binding (data fetch, asset URLs,
// nav, confirm, modal teleport) once, before any presentCollection card mounts.
import "./composables/collectionUi";
// Configure the @mulmoclaude/accounting-plugin host seams (apiCall / subscribe /
// locale) once, before any manageAccounting card mounts.
import "./composables/accountingUi";
import { initTheme } from "./composables/useTheme";
import { hydrateWebFonts } from "./composables/useWebFonts";
import { installFileDropGuard } from "./composables/useFileDropGuard";
import { installPageZoomGuard } from "./composables/usePageZoomGuard";
import { router } from "./router";
import App from "./App.vue";

// Apply the persisted theme to <html> before mount so there's no flash of the
// default palette.
initTheme();

// TEMPORARY (R14 IME debug, 2026-08-17): with ?imedebug in the URL, every keyboard /
// composition event is shipped to POST /api/ime-debug so the host can see whether keys are
// routed through the IME (keyCode 229 + composition events) or passed straight through —
// without the operator driving DevTools. Remove with the server half in fonts-routes.ts.
if (location.search.includes("imedebug")) {
  const buf: string[] = [];
  const record = (e: Event) => {
    const k = e as KeyboardEvent & CompositionEvent & InputEvent;
    const target = e.target instanceof Element ? e.target.className || e.target.tagName : "?";
    buf.push(`${e.type} key=${k.key ?? ""} kc=${k.keyCode ?? ""} comp=${k.isComposing ?? ""} data=${k.data ?? ""} tgt=${target}`);
  };
  for (const ev of ["keydown", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
    window.addEventListener(ev, record, true);
  }
  setInterval(() => {
    if (!buf.length) return;
    const lines = buf.splice(0);
    void fetch("/api/ime-debug", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines }) });
  }, 1000);
}

// Catch a file dropped anywhere in the tab so an imprecise drop can't navigate the
// page to the file and lose every session. Installed on window, before mount, so it
// covers both views and any area between them.
installFileDropGuard();

// A ctrl+wheel or trackpad pinch anywhere in the tab would page-zoom the browser, moving the
// layout and xterm's fit out from under the user. Same window-level shape as the drop guard;
// keyboard zoom stays available for anyone who wants it on purpose.
installPageZoomGuard();

// Mount only AFTER the router's initial (async) navigation resolves. On a hard
// reload / deep-link to /terminals, mounting eagerly would first render the single
// shell (route still at the start location) — and TerminalView.onMounted would
// attach the durable "single" PTY — before the route flips to the grid, leaking a
// hidden Claude session. router.isReady() guarantees the initial URL is honored first.
//
// Host-served web fonts are also awaited (with their own internal timeout): xterm's canvas
// renderer measures the cell grid at terminal construction, so a face landing after mount
// would leave already-drawn panes measured against the fallback font.
const app = createApp(App).use(router);
Promise.all([router.isReady(), hydrateWebFonts()]).then(() => app.mount("#app"));
