// Typed client for the reader's REST surface (server/reader/reader-routes.ts). Thin fetch
// wrappers; the shapes live in common/readerApi.ts so the routes and this file cannot drift.
import type { ReaderDoc, ReaderIndex, ReaderPane } from "../common/readerApi";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `${url} → ${res.status}`);
  return body;
}

const post = <T>(url: string, body: unknown, method = "POST"): Promise<T> =>
  json<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const fetchReaderIndex = (): Promise<ReaderIndex> => json<ReaderIndex>("/api/reader/docs");
export const markReaderRead = (path: string): Promise<{ ok: true; doc: ReaderDoc }> => post("/api/reader/read", { path });
export const saveReaderAnnotations = (path: string, annotations: string): Promise<{ ok: true; doc: ReaderDoc }> =>
  post("/api/reader/annotations", { path, json: annotations }, "PUT");
export const rescanReader = (): Promise<{ found: number; added: number }> => post("/api/reader/rescan", {});
export const fetchReaderPanes = (): Promise<{ panes: ReaderPane[] }> => json("/api/reader/panes");
export const sendToReaderPane = (sessionId: string, text: string): Promise<{ sent: boolean }> => post("/api/reader/send", { sessionId, text });
export const revealInFinder = (dir: string): Promise<{ ok: true }> => post("/api/open-dir", { path: dir });

/** The iframe src for a brief. Each path segment is encoded on its own so the slashes
 *  survive and a Japanese file name round-trips. */
export function readerDocUrl(origin: string, path: string): string {
  const encoded = path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `${origin}/api/reader/doc${encoded}`;
}

/** The origin the brief is loaded from: the OTHER loopback name, so the page has a real
 *  origin (its comment layer keeps a draft in localStorage) that is still not the app's.
 *  Off loopback there is no other name; the page then shares the app origin, which the
 *  response CSP still fences (connect-src 'none', no form posts). */
export function readerDocOrigin(loc: { protocol: string; hostname: string; port: string }): string {
  const port = loc.port ? `:${loc.port}` : "";
  if (loc.hostname === "127.0.0.1") return `${loc.protocol}//localhost${port}`;
  if (loc.hostname === "localhost") return `${loc.protocol}//127.0.0.1${port}`;
  return `${loc.protocol}//${loc.hostname}${port}`;
}

/** Pull the annotations-data block out of the page the bridge posted back. Mirrors
 *  findAnnotationsBlock on the server; the server validates the JSON again before writing. */
export function annotationsJsonOf(html: string): string | null {
  const open = '<script type="application/json" id="annotations-data">';
  const start = html.indexOf(open);
  if (start < 0) return null;
  const bodyStart = start + open.length;
  // The body ends at the first close tag after which the text parses: a comment may
  // itself contain "</script>" (the layer's own JSON does not escape it).
  for (let end = html.indexOf("</script>", bodyStart); end >= 0; end = html.indexOf("</script>", end + 9)) {
    const body = html.slice(bodyStart, end);
    try {
      JSON.parse(body);
      return body;
    } catch {
      // keep looking
    }
  }
  return null;
}
