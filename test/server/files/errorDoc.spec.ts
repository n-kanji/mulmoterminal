// @vitest-environment node
// Pins the two shapes of a file-serving 4xx (errorDoc.respondFileError), through the
// real raw route: a browser NAVIGATION to a missing file gets a readable HTML page —
// the regression where a whole app window filled with `{"error":"not found"}` — while
// every programmatic consumer keeps the exact JSON body it always had.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { mountFilesRoutes } from "../../../server/backends/files.js";
import { wantsHtmlError } from "../../../server/files/errorDoc.js";
import type { Request } from "express";

let server: Server;
let base: string;

beforeAll(async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "mt-errordoc-"));
  const app = express();
  mountFilesRoutes(app, { workspace: ws, sessionCwds: () => [] });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});

const missing = () => `${base}/api/files/raw?path=gone/nope.png`;

describe("file-serving 4xx content negotiation", () => {
  it("serves a readable HTML page for a top-level navigation (Sec-Fetch-Dest: document)", async () => {
    const res = await fetch(missing(), { headers: { "sec-fetch-dest": "document" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    const body = await res.text();
    expect(body).toContain("Cannot open this file");
    expect(body).toContain("nope.png");
  });

  it("serves the HTML page when Accept explicitly names text/html", async () => {
    const res = await fetch(missing(), { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("keeps the exact JSON body for a programmatic consumer (no HTML in Accept)", async () => {
    const res = await fetch(missing()); // undici sends Accept: */*
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("negotiates the non-404 errors the same way (403 traversal as navigation)", async () => {
    const res = await fetch(`${base}/api/files/raw?path=${encodeURIComponent("../../etc/passwd")}`, {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("HTML-escapes the request-controlled path in the page", async () => {
    const evil = "gone/<img src=x onerror=alert(1)>.png";
    const res = await fetch(`${base}/api/files/raw?path=${encodeURIComponent(evil)}`, {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x");
  });
});

describe("wantsHtmlError", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as Request;
  it("is true for document and iframe destinations", () => {
    expect(wantsHtmlError(req({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(wantsHtmlError(req({ "sec-fetch-dest": "iframe" }))).toBe(true);
  });
  it("is false for fetch/image destinations and for a missing Accept header", () => {
    expect(wantsHtmlError(req({ "sec-fetch-dest": "empty", accept: "*/*" }))).toBe(false);
    expect(wantsHtmlError(req({ "sec-fetch-dest": "image", accept: "image/avif,image/*" }))).toBe(false);
    expect(wantsHtmlError(req({}))).toBe(false);
  });
});
