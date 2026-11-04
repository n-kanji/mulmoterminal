// The bridge is script TEXT the server injects into a brief (reader-doc.ts); reader-doc.spec
// checks where it lands. This one RUNS it: in a vm context whose `window` is a view over
// this file's jsdom window with a fake parent standing in for the reader, on a page that
// carries the html-summary skill's revision-diff layer — and checks the two sides'
// conversation about that layer's buttons.
//
// tsconfig.test-server.json types test/server as node (no DOM lib — adding one breaks the
// server's own fetch typing), so the jsdom globals this spec drives are typed here, as
// much of them as it touches.
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { READER_BRIDGE_SCRIPT } from "../../../server/reader/reader-doc";

interface DomElement {
  textContent: string | null;
  className: string;
  innerHTML: string;
  style: { display: string };
  classList: { toggle(name: string): void; contains(name: string): boolean };
  addEventListener(type: string, listener: () => void): void;
  querySelectorAll(selector: string): { length: number };
}
interface DomGlobals {
  document: { head: DomElement; body: DomElement; getElementById(id: string): DomElement | null };
  window: object;
  localStorage: unknown;
  sessionStorage: unknown;
  MessageEvent: new (type: string, init: { data: unknown }) => Event;
}
const { document, window, localStorage, sessionStorage, MessageEvent } = globalThis as unknown as DomGlobals;

/** The layer's markup, as revision-diff-template.html writes it (ids are the contract). */
const LAYER = `
<div id="rev-fab">
  <button id="rev-list-btn">変更点 <span id="rev-count"></span>件</button>
  <button id="rev-only-btn">変更箇所だけ読む</button>
</div>
<div id="rev-panel"><h4>前の版からの変更点</h4></div>`;

const byId = (id: string): DomElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  return el;
};

interface Harness {
  /** Every message the bridge posted to its "parent" (the reader), in order. */
  posted: Record<string, unknown>[];
  /** Deliver a message from the reader to the page. */
  receive(data: unknown): void;
  /** The page has parsed, its inline scripts (the layer's among them) have run. */
  ready(): void;
}

function run({ layer = true } = {}): Harness {
  document.head.innerHTML = "";
  document.body.className = "";
  document.body.innerHTML = `<h1>Title</h1><p>body</p>${layer ? LAYER : ""}<span id="ann-save-label">保存</span>`;
  if (layer) {
    // What the layer's own script does on its buttons (revision-diff-template.html).
    byId("rev-count").textContent = "2";
    byId("rev-list-btn").addEventListener("click", () => byId("rev-panel").classList.toggle("open"));
    byId("rev-only-btn").addEventListener("click", () => document.body.classList.toggle("rev-only"));
  }
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: (data: Record<string, unknown>) => void posted.push(data) };
  // The bridge registers its listeners on `window` and also REPLACES window.addEventListener;
  // both land on this per-run bus (and its override map), never on the shared jsdom window,
  // so one run cannot answer another's messages. Everything else reads through to the real
  // window, methods bound to it (a webidl method called on a proxy `this` throws).
  const bus = new EventTarget();
  const overrides = new Map<PropertyKey, unknown>();
  const windowView = new Proxy(window, {
    get(target, key) {
      if (overrides.has(key)) return overrides.get(key);
      if (key === "parent") return parent;
      if (key === "addEventListener" || key === "removeEventListener" || key === "dispatchEvent") return bus[key].bind(bus);
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
    set(_target, key, value) {
      overrides.set(key, value);
      return true;
    },
  });
  const source = READER_BRIDGE_SCRIPT.replace(/^<script id="reader-bridge">/, "").replace(/<\/script>$/, "");
  // eslint-disable-next-line sonarjs/code-eval -- runs the bridge, a constant this repo ships, in a sandboxed context
  runInNewContext(source, {
    window: windowView,
    Window: { prototype: {} },
    document,
    // The reader serves a brief at /api/reader/doc + its path, one segment at a time (readerDocUrl).
    location: { pathname: "/api/reader/doc/Users/me/brief.html" },
    URL: { createObjectURL: () => "blob:x" },
    HTMLAnchorElement: { prototype: { click() {} } },
    navigator: {},
    localStorage,
    sessionStorage,
  });
  return {
    posted,
    receive: (data) => bus.dispatchEvent(new MessageEvent("message", { data })),
    ready: () => bus.dispatchEvent(new Event("DOMContentLoaded")),
  };
}

const revisionsPosted = (h: Harness) => h.posted.filter((m) => m.type === "reader:revisions");

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("the reader bridge and the revision layer", () => {
  it("hides the layer's own buttons as soon as it runs, and reports the state once the page has parsed", () => {
    const h = run();
    // Before the page has even parsed: the rule is in place (not on load — the buttons would
    // sit over the heading until every image and font arrived), the reader has only the hello.
    expect(document.head.textContent).toContain("#rev-fab { display: none !important; }");
    // The panel hung under the buttons; it moves up to where they were.
    expect(document.head.textContent).toContain("#rev-panel { top: 14px !important; }");
    expect(h.posted).toEqual([{ type: "reader:ready" }]);
    h.ready();
    expect(byId("rev-fab").querySelectorAll("button")).toHaveLength(2); // hidden, not removed: the layer's listeners live on them
    expect(revisionsPosted(h)).toEqual([{ type: "reader:revisions", count: 2, active: false, open: false }]);
  });

  it("a toggle from the reader presses the page's own button and answers with the new state", () => {
    const h = run();
    h.ready();
    h.receive({ type: "reader:revisions-toggle", which: "only" });
    expect(document.body.classList.contains("rev-only")).toBe(true);
    expect(revisionsPosted(h).at(-1)).toEqual({ type: "reader:revisions", count: 2, active: true, open: false });
    h.receive({ type: "reader:revisions-toggle", which: "list" });
    expect(byId("rev-panel").classList.contains("open")).toBe(true);
    expect(revisionsPosted(h).at(-1)).toEqual({ type: "reader:revisions", count: 2, active: true, open: true });
    h.receive({ type: "reader:revisions-toggle", which: "only" });
    expect(document.body.classList.contains("rev-only")).toBe(false);
    expect(revisionsPosted(h).at(-1)).toEqual({ type: "reader:revisions", count: 2, active: false, open: true });
  });

  it("stays quiet on a brief without the layer", () => {
    const h = run({ layer: false });
    h.ready();
    h.receive({ type: "reader:revisions-toggle", which: "only" });
    h.receive({ type: "reader:revisions-toggle", which: "nonsense" });
    expect(revisionsPosted(h)).toEqual([]);
    expect(document.body.classList.contains("rev-only")).toBe(false);
  });

  it("still takes the save ack, for this page only", () => {
    const h = run();
    const label = byId("ann-save-label");
    h.receive({ type: "reader:saved", path: "/Users/me/other.html" });
    expect(label.textContent).toBe("保存");
    h.receive({ type: "reader:saved", path: "/Users/me/brief.html" });
    expect(label.textContent).toBe("保存しました");
  });
});
