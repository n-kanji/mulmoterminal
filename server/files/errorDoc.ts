// A 4xx from a file-serving route that a BROWSER can land on (a terminal file-path
// link, a rendered md/json/csv view, the artifacts HTML preview) used to answer with
// bare JSON — so a click on a stale path filled a whole app window with
// `{"error":"not found"}`, which reads as "the app broke" when nothing is wrong.
//
// respondFileError answers the same status either way, but picks the SHAPE by who is
// asking: a top-level/iframe navigation gets a small self-contained HTML page (the
// shared renderedDoc shell, sandbox CSP like every other rendered document), while a
// programmatic consumer — fetch, <img>, supertest — keeps the exact JSON body it always
// had. Detection is deliberately conservative: Sec-Fetch-Dest document/iframe, or an
// Accept header that EXPLICITLY names text/html. A missing Accept header must stay
// JSON, so `req.accepts("html")` (which matches everything on no header) is not used.
//
// Host-specific behavior: MulmoClaude's raw route answers plain JSON; this divergence
// is deliberate (MulmoTerminal opens these URLs as whole tabs from terminal links).
import type { Request, Response } from "express";
import { htmlDoc, escapeHtml } from "./renderedDoc.js";

/** True when the response will be rendered as a page by a browser, not read by code. */
export function wantsHtmlError(req: Request): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe") return true;
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

/** The error page body — message + the path that failed, and why this is harmless. */
function errorPageHtml(message: string, filePath?: string): string {
  const pathLine = filePath ? `<p><code>${escapeHtml(filePath)}</code></p>` : "";
  return htmlDoc(
    [
      `<h1>Cannot open this file</h1>`,
      pathLine,
      `<p>${escapeHtml(message)}</p>`,
      `<p>This page was likely opened from a file link — the file may have been moved,`,
      ` renamed or deleted since it was printed. The app itself is fine; you can close`,
      ` this window and go back.</p>`,
    ].join(""),
    "Cannot open this file",
  );
}

/** Answer a file-serving 4xx: an HTML page for a browser navigation, JSON otherwise.
 *  The status code and the JSON body are exactly what the routes sent before. */
export function respondFileError(req: Request, res: Response, status: number, message: string, filePath?: string): void {
  if (!wantsHtmlError(req)) {
    res.status(status).json({ error: message });
    return;
  }
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox");
  res.send(errorPageHtml(message, filePath));
}
