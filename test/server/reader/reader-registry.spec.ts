// @vitest-environment node
// The registry over a real temp directory: registration rules, grouping, state, the
// mtime-keyed facts cache, and the rescan walk.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReaderRegistry, defaultReaderRoots, placeOf } from "../../../server/reader/reader-registry.js";

const briefHtml = (title: string, items: unknown[] = []) =>
  `<html><head><title>${title}</title></head><body><script type="application/json" id="annotations-data">${JSON.stringify({ items })}</script></body></html>`;

let tmp: string;
let root: string;
let registry: ReaderRegistry;

const write = (rel: string, html: string): string => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html);
  return abs;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reader-"));
  root = path.join(tmp, "Projects");
  fs.mkdirSync(root);
  registry = new ReaderRegistry(path.join(tmp, "home", "reader.json"), [{ dir: root }]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("placeOf", () => {
  it("splits root / project / folder", () => {
    const roots = [{ dir: "/r/Projects" }];
    expect(placeOf("/r/Projects/orosy-v2/marketing/a.html", roots)).toEqual({ root: "/r/Projects", project: "orosy-v2", folder: "marketing" });
    expect(placeOf("/r/Projects/orosy-v2/a.html", roots)).toEqual({ root: "/r/Projects", project: "orosy-v2", folder: "" });
    expect(placeOf("/r/Projects/orosy-v2/x/y/a.html", roots)).toEqual({ root: "/r/Projects", project: "orosy-v2", folder: "x/y" });
    expect(placeOf("/r/Projects/a.html", roots)).toEqual({ root: "/r/Projects", project: "", folder: "" });
    expect(placeOf("/r/Elsewhere/a.html", roots)).toBeNull();
    expect(placeOf("/r/Projects2/a.html", roots)).toBeNull();
  });
});

describe("defaultReaderRoots", () => {
  it("keeps only the roots that exist", () => {
    const roots = defaultReaderRoots("/home/u", (p) => p === "/home/u/Projects");
    expect(roots).toEqual([{ dir: "/home/u/Projects" }]);
  });
});

describe("ReaderRegistry.register", () => {
  it("refuses relative, non-html, out-of-root, missing and non-brief paths", () => {
    expect(registry.register("rel/a.html")).toMatchObject({ ok: false, status: 400 });
    expect(registry.register(path.join(root, "p", "a.md"))).toMatchObject({ ok: false, status: 400 });
    expect(registry.register(path.join(tmp, "a.html"))).toMatchObject({ ok: false, status: 403 });
    expect(registry.register(path.join(root, "p", "missing.html"))).toMatchObject({ ok: false, status: 404 });
    const plain = write("p/plain.html", "<html><body>no block</body></html>");
    expect(registry.register(plain)).toMatchObject({ ok: false, status: 404 });
  });

  it("registers a brief once, persists it, and lists it grouped", () => {
    const abs = write("orosy-v2/marketing/brief.html", briefHtml("Brief A", [{ id: 1, comment: "x" }]));
    const first = registry.register(abs);
    expect(first).toMatchObject({ ok: true, added: true });
    expect(registry.register(abs)).toMatchObject({ ok: true, added: false });
    const again = new ReaderRegistry(path.join(tmp, "home", "reader.json"), [{ dir: root }]);
    const docs = again.list();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      path: abs,
      title: "Brief A",
      project: "orosy-v2",
      folder: "marketing",
      comments: 1,
      open: 1,
      readAt: null,
      state: "commented",
    });
    expect(docs[0].createdAt).toBeGreaterThan(0);
    expect(docs[0].createdAt).toBeLessThanOrEqual(docs[0].mtime + 1);
  });
});

describe("ReaderRegistry.list", () => {
  it("sorts newest first, drops a file that disappeared, and re-reads a changed file", () => {
    const a = write("p/a.html", briefHtml("A"));
    const b = write("p/b.html", briefHtml("B"));
    fs.utimesSync(a, new Date(1000), new Date(1000));
    fs.utimesSync(b, new Date(2000), new Date(2000));
    registry.register(a);
    registry.register(b);
    expect(registry.list().map((d) => d.title)).toEqual(["B", "A"]);

    fs.writeFileSync(a, briefHtml("A2", [{ id: 1, comment: "done _(反映済み)_" }]));
    fs.utimesSync(a, new Date(3000), new Date(3000));
    const docs = registry.list();
    expect(docs.map((d) => d.title)).toEqual(["A2", "B"]);
    expect(docs[0]).toMatchObject({ comments: 1, open: 0, state: "done" });

    fs.rmSync(b);
    expect(registry.list().map((d) => d.title)).toEqual(["A2"]);
    const reloaded = new ReaderRegistry(path.join(tmp, "home", "reader.json"), [{ dir: root }]);
    expect(reloaded.list().map((d) => d.title)).toEqual(["A2"]);
  });
});

describe("ReaderRegistry.markRead", () => {
  it("records the open and flips unread to read", () => {
    const abs = write("p/a.html", briefHtml("A"));
    expect(registry.list()).toEqual([]);
    const result = registry.markRead(abs);
    expect(result.ok && result.doc.state).toBe("read");
    expect(result.ok && result.doc.readAt).toBeTypeOf("number");
    expect(registry.list()[0].state).toBe("read");
  });
});

describe("ReaderRegistry.rescan", () => {
  it("finds briefs under the roots, skipping hidden and dependency dirs", async () => {
    write("p/a.html", briefHtml("A"));
    write("p/sub/deep/b.html", briefHtml("B"));
    write("p/plain.html", "<html>no</html>");
    write("p/node_modules/x/c.html", briefHtml("C"));
    write("p/.hidden/d.html", briefHtml("D"));
    const result = await registry.rescan();
    expect(result).toEqual({ found: 2, added: 2 });
    expect(
      registry
        .list()
        .map((d) => d.title)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(await registry.rescan()).toEqual({ found: 2, added: 0 });
  });
});
