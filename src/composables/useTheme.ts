import { ref } from "vue";
import type { ITheme } from "@xterm/xterm";
import type { ThemeId } from "../../common/themeIds";

export type { ThemeId };

export interface Theme {
  id: ThemeId;
  label: string;
  // Three representative colors shown as the picker swatch.
  swatch: { base: string; panel: string; accent: string };
  // xterm renders on a canvas and can't read CSS variables, so each theme carries
  // an explicit terminal palette mirroring its CSS tokens. Light themes also set
  // the 16 ANSI colors (mapping bright-white to a dark tone) so colored TUI output
  // stays legible on a light background — xterm's defaults assume a dark canvas.
  term: ITheme;
}

export const THEMES: Theme[] = [
  {
    // Fork-local: the Claude Code desktop app's warm charcoal, so long Japanese
    // transcripts read the same here as in the app. ANSI 16 are muted to match its
    // soft tone — Claude's TUI colors arrive as accents, not neon.
    id: "claude",
    label: "Claude",
    swatch: { base: "#262624", panel: "#2b2a27", accent: "#d97757" },
    // R14: foreground/white sit a step DOWN from brightWhite on purpose. Normal text is a
    // calm grey; bold jumps to brightWhite (drawBoldTextInBrightColors, xterm's default) —
    // the same normal/bold hierarchy iTerm2 renders. With everything at one bright cream
    // the operator read the grid as "a wall of dense white".
    term: {
      background: "#262624",
      foreground: "#c9c6bb",
      cursor: "#d97757",
      selectionBackground: "#4a463e",
      black: "#3a3936",
      red: "#e06c60",
      green: "#7cb974",
      yellow: "#d9a558",
      blue: "#7aa2d8",
      magenta: "#b58fd8",
      cyan: "#72b3ac",
      white: "#b8b5aa",
      brightBlack: "#807d73",
      brightRed: "#ec8a7f",
      brightGreen: "#98cb90",
      brightYellow: "#e7bc77",
      brightBlue: "#97b9e6",
      brightMagenta: "#c9a9e6",
      brightCyan: "#8fc9c2",
      brightWhite: "#e8e6dc",
    },
  },
  {
    // R14: the ANSI 16 are stated, muted, like every other theme's. Without them xterm's
    // defaults apply, whose brights are neon and whose brightWhite is pure #ffffff — and
    // Claude's TUI bolds half its output, so half of every pane glowed ("全部太字でチカチカ").
    id: "midnight",
    label: "Midnight",
    swatch: { base: "#1a1a2e", panel: "#16213e", accent: "#4a8cff" },
    // Same normal/bold split as the claude theme: dim normal, brightWhite for bold.
    term: {
      background: "#1a1a2e",
      foreground: "#c2c4ca",
      cursor: "#e0e0e0",
      selectionBackground: "#3a3a5e",
      black: "#32324a",
      red: "#d97a72",
      green: "#85b585",
      yellow: "#cfa96b",
      blue: "#7a9dd4",
      magenta: "#a98fd4",
      cyan: "#74b0b8",
      white: "#b0b2be",
      brightBlack: "#74748c",
      brightRed: "#e39a93",
      brightGreen: "#a3cba3",
      brightYellow: "#ddbe8a",
      brightBlue: "#98b5e2",
      brightMagenta: "#bfa9e2",
      brightCyan: "#93c5cc",
      brightWhite: "#e0e0e0",
    },
  },
  {
    // The palette is Nord's own — its brights are deliberately close to its normals,
    // which is exactly the muted behaviour wanted here.
    id: "nord",
    label: "Nord",
    swatch: { base: "#2e3440", panel: "#3b4252", accent: "#88c0d0" },
    term: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "daylight",
    label: "Daylight",
    swatch: { base: "#f4f6fb", panel: "#ffffff", accent: "#2563eb" },
    term: {
      background: "#f4f6fb",
      foreground: "#1b2430",
      cursor: "#1b2430",
      selectionBackground: "#cfe0ff",
      black: "#1b2430",
      red: "#cf222e",
      green: "#1a7f37",
      yellow: "#9a6700",
      blue: "#2563eb",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#57606a",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#116329",
      brightYellow: "#7d4e00",
      brightBlue: "#1d4ed8",
      brightMagenta: "#6639ba",
      brightCyan: "#3192aa",
      brightWhite: "#1b2430",
    },
  },
  {
    id: "solarized",
    label: "Solarized Light",
    swatch: { base: "#fdf6e3", panel: "#eee8d5", accent: "#268bd2" },
    term: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#586e75",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#657b83",
      brightBlack: "#073642",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#268bd2",
      brightMagenta: "#6c71c4",
      brightCyan: "#2aa198",
      brightWhite: "#586e75",
    },
  },
];

const STORAGE_KEY = "theme";
// Fork-local: default to the Claude-app-matched theme.
const DEFAULT_THEME: ThemeId = "claude";

// Validate against THEMES, not the id list: an id is only usable if it has a
// theme object here. A THEME_IDS entry with no matching THEMES entry would
// otherwise be accepted, set as data-theme, then silently fall back to THEMES[0]
// for the terminal palette. The useTheme spec asserts the two stay in lockstep.
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((t) => t.id === value);
}

// Storage access can throw (private mode / sandboxed contexts with storage
// blocked), so persistence is best-effort: a failure falls back to the default
// rather than crashing app startup.
function loadThemeId(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const themeId = ref<ThemeId>(loadThemeId());

function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute("data-theme", id);
}

// The xterm palette for the active theme; Terminal.vue feeds this into the
// terminal's `theme` option and refreshes it whenever the theme changes.
export function currentTermTheme(): Theme["term"] {
  return (THEMES.find((t) => t.id === themeId.value) ?? THEMES[0]).term;
}

// The xterm palette for a specific theme — used by a terminal whose directory pins a
// theme via .mulmoterminal.json (overriding the user's app-wide choice for that cell).
export function termThemeFor(id: ThemeId): Theme["term"] {
  return (THEMES.find((t) => t.id === id) ?? THEMES[0]).term;
}

// Called from main.ts before mount so the persisted theme is on <html> before
// the first paint (no flash of the default palette).
export function initTheme() {
  applyTheme(themeId.value);
}

export function useTheme() {
  function setTheme(id: ThemeId) {
    themeId.value = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // storage blocked: the theme still applies for this session, just isn't persisted
    }
    applyTheme(id);
  }
  return { themeId, themes: THEMES, setTheme };
}
