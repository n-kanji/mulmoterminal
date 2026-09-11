// The reader's registry: which briefs exist, where they group, and which ones the operator
// has opened (plans/reader-view.md).
//
// A REGISTRY rather than a scan on every listing: the roots hold ~1,200 HTML files, and a
// cold walk of them measured 30s on this machine. So the list is a JSON file of paths —
// `viewhtml` registers a brief the moment Claude writes it — and a walk is a deliberate,
// slow "rescan" the operator asks for (once, to seed the old briefs; again if the file moved).
// Everything ELSE about a doc (title, comment counts, mtime) is read from the file itself
// on every listing, cached by mtime, so the registry never goes stale on what it does not
// own: it owns only "this path is a brief" and "opened at".
import fs from "node:fs";
import path from "node:path";
import { countComments, docTitle, isBrief } from "./reader-doc.js";
import { isWithin } from "../infra/path-within.js";
import { readerDocState, type ReaderDoc } from "../../common/readerApi.js";

/** A directory briefs live under. The first path segment inside it is the PROJECT
 *  (~/Projects/orosy-v2), the rest of the directory is the FOLDER (marketing). */
export interface ReaderRoot {
  dir: string;
}

/** The roots on the operator's machine that exist: ~/Projects, where nearly every brief
 *  is, and the Obsidian vault. NOT the Google Drive folder under ~/Library/CloudStorage —
 *  a file-provider location, which macOS guards with an "access data from other apps"
 *  prompt aimed at this process (node, under launchd) every time it is touched. Each
 *  server start probed it, and the operator got a prompt that never went away (2026-09-10).
 *  A root that is not there is dropped, so a machine without a vault lists what it has. */
export function defaultReaderRoots(home: string, exists: (p: string) => boolean = fs.existsSync): ReaderRoot[] {
  const candidates = [path.join(home, "Projects"), path.join(home, "Obsidian")];
  return candidates.filter((dir) => exists(dir)).map((dir) => ({ dir }));
}

export interface DocPlace {
  root: string;
  project: string;
  folder: string;
}

/** Where a path sits: under which root, in which project, in which folder. Null when it is
 *  under none of the roots — such a file is never listed or served. */
export function placeOf(abs: string, roots: readonly ReaderRoot[]): DocPlace | null {
  for (const { dir } of roots) {
    if (!isWithin(dir, abs)) continue;
    const rel = path.relative(dir, abs);
    const segments = rel.split(path.sep);
    if (segments.length < 2) return { root: dir, project: "", folder: "" }; // a file directly in the root
    const project = segments[0];
    const folder = segments.slice(1, -1).join("/");
    return { root: dir, project, folder };
  }
  return null;
}

interface RegistryEntry {
  registeredAt: number;
  readAt: number | null;
}

interface RegistryFile {
  docs: Record<string, RegistryEntry>;
}

interface FileFacts {
  mtime: number;
  createdAt: number;
  size: number;
  title: string;
  comments: number;
  open: number;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Directories a rescan never enters: build output, dependencies, VCS, anything hidden. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__pycache__", "Library"]);
const MAX_DEPTH = 8;

export type RegisterResult = { ok: true; doc: ReaderDoc; added: boolean } | { ok: false; status: number; error: string };

export class ReaderRegistry {
  private docs = new Map<string, RegistryEntry>();
  private facts = new Map<string, FileFacts>();
  private loaded = false;

  constructor(
    private readonly file: string,
    readonly roots: readonly ReaderRoot[],
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<RegistryFile>;
      for (const [p, entry] of Object.entries(parsed.docs ?? {})) {
        if (!entry || typeof entry !== "object") continue;
        this.docs.set(p, {
          registeredAt: typeof entry.registeredAt === "number" ? entry.registeredAt : Date.now(),
          readAt: typeof entry.readAt === "number" ? entry.readAt : null,
        });
      }
    } catch {
      // No registry yet, or a corrupt one: start empty. A rescan rebuilds it.
    }
  }

  private save(): void {
    const body: RegistryFile = { docs: Object.fromEntries(this.docs) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Read what the file says about itself, re-parsing only when it changed on disk. */
  private factsOf(abs: string): FileFacts | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const cached = this.facts.get(abs);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached;
    let html: string;
    try {
      html = fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
    if (!isBrief(html)) return null;
    const counts = countComments(html);
    const facts: FileFacts = {
      mtime: stat.mtimeMs,
      createdAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs,
      size: stat.size,
      title: docTitle(html, path.basename(abs, ".html")),
      ...counts,
    };
    this.facts.set(abs, facts);
    return facts;
  }

  private docOf(abs: string, entry: RegistryEntry, facts: FileFacts, place: DocPlace): ReaderDoc {
    return {
      path: abs,
      title: facts.title,
      mtime: facts.mtime,
      createdAt: facts.createdAt,
      root: place.root,
      project: place.project,
      folder: place.folder,
      comments: facts.comments,
      open: facts.open,
      readAt: entry.readAt,
      state: readerDocState(facts.comments, facts.open, entry.readAt),
    };
  }

  /** Every registered brief that still exists, newest first. One that is gone (moved,
   *  deleted) is dropped from the registry — `viewhtml` re-registers it at its new place. */
  list(): ReaderDoc[] {
    this.load();
    const out: ReaderDoc[] = [];
    let dropped = false;
    for (const [abs, entry] of this.docs) {
      const place = placeOf(abs, this.roots);
      const facts = place ? this.factsOf(abs) : null;
      if (!place || !facts) {
        this.docs.delete(abs);
        this.facts.delete(abs);
        dropped = true;
        continue;
      }
      out.push(this.docOf(abs, entry, facts, place));
    }
    if (dropped) this.save();
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /** Register one brief by absolute path. Refused when it is outside every root, is not an
   *  .html file, does not exist, or is not a brief (no data block). */
  register(abs: string): RegisterResult {
    this.load();
    if (!path.isAbsolute(abs)) return { ok: false, status: 400, error: "path must be absolute" };
    abs = path.resolve(abs);
    if (!abs.toLowerCase().endsWith(".html")) return { ok: false, status: 400, error: "not an .html file" };
    const place = placeOf(abs, this.roots);
    if (!place) return { ok: false, status: 403, error: "path is outside the reader roots" };
    const facts = this.factsOf(abs);
    if (!facts) return { ok: false, status: 404, error: "not found, or not a brief (no annotations-data block)" };
    let entry = this.docs.get(abs);
    const added = !entry;
    if (!entry) {
      entry = { registeredAt: Date.now(), readAt: null };
      this.docs.set(abs, entry);
      this.save();
    }
    return { ok: true, doc: this.docOf(abs, entry, facts, place), added };
  }

  /** Record that the operator opened a brief. Unknown paths are registered first, so a doc
   *  opened by URL (a link pasted from a pane) joins the list. */
  markRead(abs: string): RegisterResult {
    const result = this.register(abs);
    if (!result.ok) return result;
    const entry = this.docs.get(result.doc.path);
    if (entry) {
      entry.readAt = Date.now();
      this.save();
      result.doc.readAt = entry.readAt;
      result.doc.state = readerDocState(result.doc.comments, result.doc.open, entry.readAt);
    }
    return result;
  }

  /** Is `abs` inside the folder of a registered brief (or a folder below it)? Assets — a
   *  screenshot next to the page — are served only there. */
  isBesideBrief(abs: string): boolean {
    this.load();
    // Both sides canonical: the route hands over a realpath (a macOS temp dir is /private/var
    // while its registered spelling is /var), and a brief may sit behind a symlinked dir.
    const target = realpathOr(abs);
    for (const docPath of this.docs.keys()) {
      if (isWithin(realpathOr(path.dirname(docPath)), target)) return true;
    }
    return false;
  }

  /** Forget cached facts for a path (after the reader wrote it), so the next listing
   *  re-reads the counts. The stat cache would catch the mtime change anyway; this makes
   *  the very next call see the write even on a filesystem with coarse mtimes. */
  invalidate(abs: string): void {
    this.facts.delete(path.resolve(abs));
  }

  /** Walk the roots and register every brief found. Slow (tens of seconds cold) and meant
   *  to be: a one-time seed for the briefs written before the reader existed, and a repair
   *  after files were moved by hand. Returns how many were new. */
  async rescan(): Promise<{ found: number; added: number }> {
    this.load();
    const tally = { found: 0, added: 0 };
    for (const { dir } of this.roots) await this.walk(dir, 0, tally);
    return tally;
  }

  private async walk(dir: string, depth: number, tally: { found: number; added: number }): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) await this.walk(path.join(dir, entry.name), depth + 1, tally);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) this.tallyRegister(path.join(dir, entry.name), tally);
    }
  }

  private tallyRegister(abs: string, tally: { found: number; added: number }): void {
    const result = this.register(abs);
    if (!result.ok) return;
    tally.found += 1;
    if (result.added) tally.added += 1;
  }
}
