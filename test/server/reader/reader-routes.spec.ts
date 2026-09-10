// @vitest-environment node
// Route-level tests over a real temp root. Which failure is an HTTP status matters: viewhtml
// reads a 409 from /open as "no tab, open a browser", and the view reads a non-200 from the
// save as "your comment did not land".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { mountReaderRoutes, NO_READER_TAB_ERROR, type ReaderRouteDeps } from "../../../server/reader/reader-routes.js";
import { ReaderRegistry } from "../../../server/reader/reader-registry.js";
import { READER_OPEN_CHANNEL } from "../../../common/readerApi.js";

const briefHtml = (title: string, items: unknown[] = []) =>
  `<html><head><title>${title}</title></head><body><img src="shot.png"><script type="application/json" id="annotations-data">${JSON.stringify({ items })}</script></body></html>`;

let tmp: string;
let root: string;
let deps: ReaderRouteDeps;

const write = (rel: string, body: string): string => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

const appWith = (over: Partial<ReaderRouteDeps> = {}) => {
  deps = {
    registry: new ReaderRegistry(path.join(tmp, "reader.json"), [{ dir: root }]),
    panes: () => [
      { id: "idle", cwd: path.join(root, "p"), agent: "claude", working: false },
      { id: "busy", cwd: path.join(root, "p"), agent: "claude", working: true },
    ],
    sendToSession: vi.fn(async () => ({ sent: true })),
    publishToOne: vi.fn(() => true),
    ...over,
  };
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  mountReaderRoutes(app, deps);
  return app;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reader-routes-"));
  root = path.join(tmp, "Projects");
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("index routes", () => {
  it("registers, lists, and marks read", async () => {
    const app = appWith();
    const abs = write("p/a.html", briefHtml("A"));
    expect((await request(app).post("/api/reader/register").send({ path: abs })).status).toBe(200);
    expect((await request(app).post("/api/reader/register").send({})).status).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/reader/register")
          .send({ path: path.join(tmp, "x.html") })
      ).status,
    ).toBe(403);
    const list = await request(app).get("/api/reader/docs");
    expect(list.body.roots).toEqual([root]);
    expect(list.body.docs[0]).toMatchObject({ path: abs, title: "A", state: "unread" });
    const read = await request(app).post("/api/reader/read").send({ path: abs });
    expect(read.body.doc.state).toBe("read");
  });

  it("/open hands the doc to the one open tab, or 409s so viewhtml opens a browser", async () => {
    const app = appWith();
    const abs = write("p/a.html", briefHtml("A"));
    const ok = await request(app).post("/api/reader/open").send({ path: abs });
    expect(ok.status).toBe(200);
    expect(deps.publishToOne).toHaveBeenCalledWith(READER_OPEN_CHANNEL, { path: abs });
    const none = appWith({ publishToOne: () => false });
    const res = await request(none).post("/api/reader/open").send({ path: abs });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(NO_READER_TAB_ERROR);
    expect(res.body.doc.path).toBe(abs);
  });
});

describe("PUT /api/reader/annotations", () => {
  it("rewrites only the block, atomically, and answers with the fresh counts", async () => {
    const app = appWith();
    const abs = write("p/a.html", briefHtml("A"));
    const json = JSON.stringify({ items: [{ id: 1, comment: "please $1 fix" }] });
    const res = await request(app).put("/api/reader/annotations").send({ path: abs, json });
    expect(res.status).toBe(200);
    expect(res.body.doc).toMatchObject({ comments: 1, open: 1, state: "commented" });
    const after = fs.readFileSync(abs, "utf8");
    expect(after).toContain(`id="annotations-data">${json}</script>`);
    expect(after).toContain("<title>A</title>");
    expect(fs.readdirSync(path.join(root, "p"))).toEqual(["a.html"]);
  });
  it("refuses a body that would erase the comments", async () => {
    const app = appWith();
    const abs = write("p/a.html", briefHtml("A", [{ id: 1, comment: "keep" }]));
    for (const json of ["", "null", "[]", "{}"]) {
      expect((await request(app).put("/api/reader/annotations").send({ path: abs, json })).status).toBe(400);
    }
    expect(fs.readFileSync(abs, "utf8")).toContain("keep");
  });
});

describe("panes and send", () => {
  it("types into an idle pane only", async () => {
    const app = appWith();
    expect((await request(app).get("/api/reader/panes")).body.panes).toHaveLength(2);
    expect((await request(app).post("/api/reader/send").send({ sessionId: "idle", text: " hi " })).status).toBe(200);
    expect(deps.sendToSession).toHaveBeenCalledWith("idle", "hi");
    expect((await request(app).post("/api/reader/send").send({ sessionId: "busy", text: "hi" })).status).toBe(409);
    expect((await request(app).post("/api/reader/send").send({ sessionId: "nope", text: "hi" })).status).toBe(404);
    expect((await request(app).post("/api/reader/send").send({ sessionId: "idle", text: "" })).status).toBe(400);
  });
});

describe("GET /api/reader/doc/<path>", () => {
  it("serves a brief with the bridge and the sandbox CSP", async () => {
    const app = appWith();
    const abs = write("p/a.html", briefHtml("A"));
    const res = await request(app).get(`/api/reader/doc${abs}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toContain("sandbox allow-scripts allow-same-origin allow-modals;");
    expect(res.headers["content-security-policy"]).not.toContain("allow-popups");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(res.text).toContain('<script id="reader-bridge">');
    expect(res.text.indexOf("reader-bridge")).toBeLessThan(res.text.indexOf("annotations-data"));
  });
  it("serves a sibling asset beside a registered brief, and nothing else", async () => {
    const app = appWith();
    const a = write("p/a.html", briefHtml("A"));
    write("p/shot.png", "png-bytes");
    write("p/secret.txt.exe", "no");
    write("p/plain.html", "<html>not a brief</html>");
    write("elsewhere/other.png", "png-bytes");
    // Not registered yet: nothing beside it is served.
    expect((await request(app).get(`/api/reader/doc${path.join(root, "p", "shot.png")}`)).status).toBe(404);
    deps.registry.register(a);
    expect((await request(app).get(`/api/reader/doc${path.join(root, "elsewhere", "other.png")}`)).status).toBe(404);
    const png = await request(app).get(`/api/reader/doc${path.join(root, "p", "shot.png")}`);
    expect(png.status).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["content-security-policy"]).toBe("sandbox");
    expect((await request(app).get(`/api/reader/doc${path.join(root, "p", "secret.txt.exe")}`)).status).toBe(404);
    expect((await request(app).get(`/api/reader/doc${path.join(root, "p", "plain.html")}`)).status).toBe(404);
  });
  it("refuses a path outside the roots, including a symlink out", async () => {
    const app = appWith();
    const outside = path.join(tmp, "outside.html");
    fs.writeFileSync(outside, briefHtml("Out"));
    expect((await request(app).get(`/api/reader/doc${outside}`)).status).toBe(403);
    fs.symlinkSync(outside, path.join(root, "link.html"));
    expect((await request(app).get(`/api/reader/doc${path.join(root, "link.html")}`)).status).toBe(403);
    expect((await request(app).get(`/api/reader/doc${root}/p/../../outside.html`)).status).toBe(403);
  });
});
