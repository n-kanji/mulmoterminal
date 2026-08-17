// User-supplied web fonts (R14): font files dropped into ~/.mulmoterminal/fonts/ are served
// to the browser and injected as @font-face by the client (src/composables/useWebFonts.ts).
//
// Why this exists: the terminal font used to be limited to fonts INSTALLED on the viewing
// machine, and Chrome only enumerates installed fonts at launch — so changing the terminal
// face meant restarting a browser with fifty open tabs. Serving the file makes the HOST the
// owner of the face: a page reload picks it up, and a phone viewing over remote-host renders
// the same glyphs as the desk. The font FAMILY still has to be named in `fontFamily`
// (config.json / .mulmoterminal.json) — dropping a file here publishes a face, it does not
// change which stack the terminals use.
//
// No font ships in this repo (the operator's face is proprietary); the directory starts empty
// and everything in it is the operator's own.
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Express } from "express";
import { MULMOTERMINAL_HOME } from "../config/env.js";

export const FONTS_DIR = path.join(MULMOTERMINAL_HOME, "fonts");

// One face the client should register. `style`/`weight` come from the filename suffix, the
// convention every font foundry already uses ("<Family>-BoldItalic.woff2").
export interface WebFontFace {
  /** URL path component, exactly the on-disk basename. */
  file: string;
  /** CSS font-family this face belongs to. */
  family: string;
  style: "normal" | "italic";
  weight: 400 | 700;
}

// Formats browsers accept in @font-face. Anything else in the directory is ignored, not an error.
const FONT_EXT_RE = /\.(woff2|woff|ttf|otf)$/i;

// A served filename must be a bare basename — no separators, no traversal, no hidden files.
// Deny-listing "/" and "\" (rather than allow-listing characters) keeps spaces and non-ASCII
// family names working; "Anthropic Mono Web-Regular.woff2" is a legitimate name.
export function isServableFontFile(name: string): boolean {
  if (!FONT_EXT_RE.test(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return !name.startsWith(".");
}

/** The face a filename describes: "<Family>-<Style>.<ext>", style suffix optional. */
export function fontFaceFromFilename(file: string): WebFontFace | null {
  if (!isServableFontFile(file)) return null;
  const base = file.replace(FONT_EXT_RE, "");
  const m = /-(Regular|Italic|Bold|BoldItalic)$/i.exec(base);
  const family = (m ? base.slice(0, m.index) : base).trim();
  if (!family) return null;
  const suffix = (m?.[1] ?? "Regular").toLowerCase();
  return {
    file,
    family,
    style: suffix.includes("italic") ? "italic" : "normal",
    weight: suffix.includes("bold") ? 700 : 400,
  };
}

export function mountFontsRoutes(app: Express): void {
  // The list the client turns into FontFace registrations. A missing directory is the
  // common case (nothing configured) and answers an empty list, never an error.
  app.get("/api/fonts", async (_req, res) => {
    let names: string[] = [];
    try {
      names = await fs.readdir(FONTS_DIR);
    } catch {
      // ENOENT etc. — no fonts published.
    }
    const fonts = names
      .map(fontFaceFromFilename)
      .filter((f): f is WebFontFace => f !== null)
      .sort((a, b) => a.file.localeCompare(b.file));
    res.json({ fonts });
  });

  app.get("/api/fonts/:file", (req, res) => {
    // Express 5 hands the param through percent-encoded; decode defensively (a malformed
    // sequence falls back to the raw value, which then simply won't match a file).
    const raw = req.params.file;
    let file = raw;
    try {
      file = decodeURIComponent(raw);
    } catch {
      // keep raw
    }
    if (!isServableFontFile(file)) return res.status(404).json({ error: "not found" });
    // `root` rather than a joined absolute path: send() then owns the containment check
    // (a name that escaped the dir is refused by the library, belt to our own suspenders).
    // Immutable-ish cache: a face change in practice arrives as a new filename; a day keeps
    // reloads free without pinning a replaced file forever.
    res.sendFile(file, { root: FONTS_DIR, maxAge: "1d" }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "not found" });
    });
  });
}
