// The reader's HTTP surface (plans/reader-view.md), all under /api/reader:
//
//   GET  /docs                 the index (every registered brief, newest first)
//   POST /register {path}      add a brief (viewhtml, right after Claude writes it)
//   POST /open {path}          register + ask the open reader tab to show it; 409 when no
//                              tab is listening, so viewhtml opens a browser instead
//   POST /read {path}          the operator opened it
//   PUT  /annotations {path, json}   write the comment block back (the bridge's save)
//   POST /rescan               walk the roots for briefs (slow, deliberate)
//   GET  /panes                live sessions the reader can type into
//   POST /send {sessionId, text}     type a comment digest into one pane
//   GET  /doc/<abs path>       the page for the iframe (bridge injected), or a sibling asset
//
// Serving: a brief is the operator's own page, written by Claude, and it runs its comment
// layer as script. The response is fenced the same way the presentHtml preview is (a CSP
// sandbox, no network), with two deliberate differences: `allow-same-origin`, because the
// layer keeps its draft in localStorage and an opaque origin has none, and the page is
// therefore loaded from the OTHER loopback host name (the view picks localhost when the app
// is on 127.0.0.1 and vice versa) so that "same origin" is a real origin that is still not
// the app's — the page cannot reach the app's DOM, cookies or /api. `connect-src 'none'`
// keeps it from fetching anything at all; the one way out is postMessage to the reader.
// What the hostname trick does NOT give: a second origin the app itself refuses to answer
// on. The app serves on either name, so the sandbox must also deny popups and nested
// frames (default-src 'none' covers frames) — otherwise the page would open the app as a
// same-origin document without this CSP. A listener on its own port would make the origin
// claim real; until then, the flags below are the boundary.
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { realContainedWithin } from "../files/pathContainment.js";
import { respondFileError } from "../files/errorDoc.js";
import { statFileOr404 } from "../backends/statFileOr404.js";
import { streamFileToResponse } from "../backends/streamFile.js";
import { isWithin } from "../infra/path-within.js";
import { messageOf } from "../errors.js";
import { assetContentType, injectReaderBridge, isBrief, replaceAnnotationsJson, validAnnotationsJson } from "./reader-doc.js";
import type { ReaderRegistry } from "./reader-registry.js";
import { READER_OPEN_CHANNEL, type ReaderIndex, type ReaderOpenEvent, type ReaderPane } from "../../common/readerApi.js";

export interface ReaderRouteDeps {
  registry: ReaderRegistry;
  /** Every live session this process holds a PTY for. */
  panes: () => ReaderPane[];
  /** Type text into a session's input box and submit it (remoteHost/terminalInput.ts). */
  sendToSession: (sessionId: string, text: string) => Promise<{ sent: boolean }>;
  /** Deliver to exactly ONE subscriber; false when nobody got it. */
  publishToOne: (channel: string, data: unknown) => boolean;
}

const ALLOWED_CDNS = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://cdn.plot.ly",
].join(" ");

export const READER_DOC_CSP = [
  // No allow-popups (review of 16fcc53c): the app answers on BOTH loopback names, so a popup
  // opened by the page at http://localhost:<port>/ would be the app, same-origin with the
  // page, scriptable by it and free of this CSP — a way to /api/*. A brief needs no popups.
  "sandbox allow-scripts allow-same-origin allow-modals",
  "default-src 'none'",
  `script-src 'unsafe-inline' ${ALLOWED_CDNS}`,
  `style-src 'unsafe-inline' ${ALLOWED_CDNS}`,
  `font-src ${ALLOWED_CDNS} data:`,
  `img-src 'self' ${ALLOWED_CDNS} data: blob: https:`,
  "media-src 'self' https: data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  // No `[::1]` here: Chrome rejects a bracketed IPv6 host expression in frame-ancestors
  // (a console error), and the server binds 127.0.0.1 anyway.
  "frame-ancestors http://localhost:* http://127.0.0.1:*",
].join("; ");

export const NO_READER_TAB_ERROR = "no reader tab is open";
const MAX_SEND_TEXT = 10_000;

const pathOf = (body: unknown): string | null => {
  const p = body && typeof body === "object" ? (body as { path?: unknown }).path : undefined;
  return typeof p === "string" && p ? p : null;
};

function mountIndexRoutes(app: Express, deps: ReaderRouteDeps): void {
  app.get("/api/reader/docs", (_req, res) => {
    const body: ReaderIndex = { docs: deps.registry.list(), roots: deps.registry.roots.map((r) => r.dir) };
    res.json(body);
  });

  app.post("/api/reader/register", (req, res) => {
    const p = pathOf(req.body);
    if (!p) return void res.status(400).json({ error: "path is required" });
    const result = deps.registry.register(p);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true, doc: result.doc, added: result.added });
  });

  app.post("/api/reader/open", (req, res) => {
    const p = pathOf(req.body);
    if (!p) return void res.status(400).json({ error: "path is required" });
    const result = deps.registry.register(p);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    const event: ReaderOpenEvent = { path: result.doc.path };
    if (!deps.publishToOne(READER_OPEN_CHANNEL, event)) return void res.status(409).json({ error: NO_READER_TAB_ERROR, doc: result.doc });
    res.json({ ok: true, doc: result.doc });
  });

  app.post("/api/reader/read", (req, res) => {
    const p = pathOf(req.body);
    if (!p) return void res.status(400).json({ error: "path is required" });
    const result = deps.registry.markRead(p);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true, doc: result.doc });
  });

  app.post("/api/reader/rescan", async (_req, res) => {
    try {
      res.json(await deps.registry.rescan());
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });
}

function mountSaveRoute(app: Express, deps: ReaderRouteDeps): void {
  app.put("/api/reader/annotations", (req, res) => {
    const p = pathOf(req.body);
    const json = req.body && typeof req.body === "object" ? (req.body as { json?: unknown }).json : undefined;
    if (!p) return void res.status(400).json({ error: "path is required" });
    if (typeof json !== "string" || !validAnnotationsJson(json)) return void res.status(400).json({ error: "json must be an object with an items array" });
    // Registered first: the write is only ever to a brief the reader lists, under the roots.
    const known = deps.registry.register(p);
    if (!known.ok) return void res.status(known.status).json({ error: known.error });
    const abs = known.doc.path;
    let html: string;
    try {
      html = fs.readFileSync(abs, "utf8");
    } catch (err) {
      return void res.status(500).json({ error: messageOf(err) });
    }
    const updated = replaceAnnotationsJson(html, json);
    if (updated === null) return void res.status(409).json({ error: "the page has no annotations-data block" });
    try {
      // Atomic: the page is never on disk half-written, since the operator's other panes
      // may read it (Claude applying comments) at any moment.
      const tmp = `${abs}.${process.pid}.reader-tmp`;
      fs.writeFileSync(tmp, updated);
      fs.renameSync(tmp, abs);
    } catch (err) {
      return void res.status(500).json({ error: messageOf(err) });
    }
    deps.registry.invalidate(abs);
    const after = deps.registry.register(abs);
    res.json({ ok: true, doc: after.ok ? after.doc : known.doc });
  });
}

function mountPaneRoutes(app: Express, deps: ReaderRouteDeps): void {
  app.get("/api/reader/panes", (_req, res) => {
    res.json({ panes: deps.panes() });
  });

  app.post("/api/reader/send", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? (req.body as { sessionId?: unknown; text?: unknown }) : {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!sessionId) return void res.status(400).json({ error: "sessionId is required" });
    if (!text) return void res.status(400).json({ error: "text is required (non-empty string)" });
    if (text.length > MAX_SEND_TEXT) return void res.status(400).json({ error: `text is too long (max ${MAX_SEND_TEXT} characters)` });
    const pane = deps.panes().find((p) => p.id === sessionId);
    if (!pane) return void res.status(404).json({ error: "no live session with that id" });
    // The same rule as a broadcast: typing into a mid-turn session corrupts the prompt being
    // composed there, and an unknown state is not idle.
    if (pane.working !== false) return void res.status(409).json({ error: "session is working; try again when it is idle" });
    try {
      res.json(await deps.sendToSession(sessionId, text));
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });
}

/** Resolve `<abs path>` from the URL to a real file inside one of the roots, or null. */
function containedDocPath(rel: string, deps: ReaderRouteDeps): string | null {
  const lexical = path.resolve("/", rel);
  for (const { dir } of deps.registry.roots) {
    if (!isWithin(dir, lexical)) continue;
    return realContainedWithin(dir, lexical);
  }
  return null;
}

function mountDocRoute(app: Express, deps: ReaderRouteDeps): void {
  app.get(/^\/api\/reader\/doc\/(.+)/, (req: Request, res: Response) => {
    let rel: string;
    try {
      rel = decodeURIComponent(req.params[0] ?? "");
    } catch {
      return void respondFileError(req, res, 400, "malformed path");
    }
    const abs = containedDocPath(rel, deps);
    if (!abs) return void respondFileError(req, res, 403, "path is outside the reader roots", rel);
    const stat = statFileOr404(req, res, abs);
    if (!stat) return;
    res.setHeader("X-Content-Type-Options", "nosniff");
    const ext = path.extname(abs).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      let html: string;
      try {
        html = fs.readFileSync(abs, "utf8");
      } catch (err) {
        return void respondFileError(req, res, 500, messageOf(err), rel);
      }
      // Only a brief is served as a page: the reader is not a way to run arbitrary HTML.
      if (!isBrief(html)) return void respondFileError(req, res, 404, "not a brief (no annotations-data block)", rel);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", READER_DOC_CSP);
      res.setHeader("Cache-Control", "no-store");
      res.send(injectReaderBridge(html));
      return;
    }
    const type = assetContentType(ext);
    if (!type) return void respondFileError(req, res, 404, "not a brief asset", rel);
    // An asset is served only beside a registered brief (its folder or below): the reader
    // is not a file server for the roots, and the registry is what says where briefs are.
    if (!deps.registry.isBesideBrief(abs)) return void respondFileError(req, res, 404, "not beside a registered brief", rel);
    res.setHeader("Content-Type", type);
    // An SVG/JS with script must not run in any origin that matters; media is sandboxed too.
    res.setHeader("Content-Security-Policy", "sandbox");
    streamFileToResponse(abs, res);
  });
}

export function mountReaderRoutes(app: Express, deps: ReaderRouteDeps): void {
  mountIndexRoutes(app, deps);
  mountSaveRoute(app, deps);
  mountPaneRoutes(app, deps);
  mountDocRoute(app, deps);
}
