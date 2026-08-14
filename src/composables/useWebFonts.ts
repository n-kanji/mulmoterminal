// Host-served web fonts (R14): register every face GET /api/fonts lists, so the terminal
// can use a font the HOST publishes instead of one the viewing machine has installed.
//
// Why: Chrome enumerates INSTALLED fonts once at launch — a newly installed face is
// invisible until the whole browser restarts, which with fifty open tabs is exactly the
// restart nobody does. A FontFace registered from a URL has no such limit: reload and it
// is there, on the desk and on the phone alike.
//
// Loaded to completion BEFORE the app mounts (main.ts awaits hydrateWebFonts): xterm's
// canvas renderer measures the cell grid from the font at terminal construction, so a face
// that finishes loading after attach would leave every already-drawn pane measured against
// the fallback. Guarded by a timeout so a slow or broken answer can only delay startup,
// never wedge it.
import { isRecord } from "../../common/isRecord";

export interface WebFontEntry {
  file: string;
  family: string;
  style: "normal" | "italic";
  weight: 400 | 700;
}

/** Validate the /api/fonts answer — the boundary rule, same as every other hydration. */
export function parseWebFontList(body: unknown): WebFontEntry[] {
  if (!isRecord(body) || !Array.isArray(body.fonts)) return [];
  const out: WebFontEntry[] = [];
  for (const f of body.fonts) {
    if (!isRecord(f)) continue;
    const { file, family, style, weight } = f;
    if (typeof file !== "string" || !file || typeof family !== "string" || !family) continue;
    out.push({
      file,
      family,
      style: style === "italic" ? "italic" : "normal",
      weight: weight === 700 ? 700 : 400,
    });
  }
  return out;
}

// Longer than any local answer needs, shorter than a user notices as "the app is broken".
const HYDRATE_TIMEOUT_MS = 1500;

/** Fetch the host's font list and load every face into document.fonts. Resolves with the
 *  number of faces that loaded; never rejects — fonts are an enhancement, not a dependency. */
export async function hydrateWebFonts(fetchImpl: typeof fetch = fetch): Promise<number> {
  const work = (async () => {
    const res = await fetchImpl("/api/fonts");
    if (!res.ok) return 0;
    const entries = parseWebFontList(await res.json());
    const loads = entries.map(async (e) => {
      // The URL is quoted so a filename with spaces survives the CSS src() grammar.
      const face = new FontFace(e.family, `url("/api/fonts/${encodeURIComponent(e.file)}")`, { style: e.style, weight: String(e.weight) });
      document.fonts.add(await face.load());
      return 1;
    });
    const settled = await Promise.allSettled(loads);
    return settled.filter((s) => s.status === "fulfilled").length;
  })();
  const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(0), HYDRATE_TIMEOUT_MS));
  return Promise.race([work, timeout]).catch(() => 0);
}
