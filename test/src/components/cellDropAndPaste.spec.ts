import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import TerminalCell from "../../../src/components/TerminalCell.vue";
import { CELL_DRAG_MIME } from "../../../src/components/gridTabs";
import { PASTE_IMAGE_ROUTE } from "../../../common/pasteImage";
import { ATTACH_FILE_ROUTE } from "../../../common/attachFile";

// R10 — the WHOLE pane takes a file drop, and Cmd+V over it uploads a clipboard image and
// inserts the saved path. Both end in the same place: text typed into this cell's terminal.

// Partially mocked: only `insertText` is replaced (it is the observable end of both features).
// The rest of the connection manager stays real, because other modules the cell pulls in read
// exports from it that a bare stub would not have.
const inserted: Array<{ key: string; text: string }> = [];
vi.mock("../../../src/composables/useTerminalConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/composables/useTerminalConnections")>()),
  insertText: (key: string, text: string) => inserted.push({ key, text }),
}));
vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({ subscribe: () => () => {}, onReconnect: () => () => {} }),
}));
vi.mock("../../../src/components/Terminal.vue", () => ({
  default: {
    name: "TerminalView",
    props: ["sessionId", "connectKey", "cwd", "hideHeader"],
    emits: ["session", "cwd"],
    template: '<div class="stub-term" />',
    methods: {
      terminate() {},
    },
  },
}));

const SESSION = "11111111-1111-1111-1111-111111111111";
const UID = 4;
const SLOT = `cell-${UID}`;

// jsdom has no DataTransfer constructor, so the drag payload is a stand-in with the things
// the handlers read: the uri-list (browsers that share paths) and the File objects (browsers
// that don't — Chrome — where the bytes are uploaded instead).
const fileDrag = (uriList: string, files: File[] = []) => ({
  types: ["Files"],
  dropEffect: "",
  files,
  getData: (type: string) => (type === "text/uri-list" ? uriList : ""),
});
const columnDrag = () => ({ types: [CELL_DRAG_MIME], dropEffect: "", getData: () => String(UID) });

let posted: unknown[] = [];
beforeEach(() => {
  inserted.length = 0;
  posted = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === PASTE_IMAGE_ROUTE) {
      posted.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ ok: true, path: "/w/data/attachments/2026/08/a.png" }) };
    }
    if (u === ATTACH_FILE_ROUTE) {
      posted.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ ok: true, path: "/w/data/attachments/2026/08/notes-abc.md" }) };
    }
    if (u.includes("/api/session/")) return { ok: true, json: async () => ({ working: false, waiting: false }) };
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const mountCell = async (props: Record<string, unknown> = {}) => {
  const w = mount(TerminalCell, {
    props: {
      uid: UID,
      expanded: false,
      zoomed: false,
      initialSessionId: SESSION,
      initialCwd: "/w/proj",
      defaultCwd: "/w/proj",
      presets: [],
      home: "/w",
      openSessionIds: [],
      openCwds: [],
      ...props,
    },
  });
  await flushPromises();
  return w;
};

const stripText = (w: Awaited<ReturnType<typeof mountCell>>) => w.find('[data-testid="cell-strip-summary"]').text();

describe("dropping a file anywhere on the pane", () => {
  // The canvas is the smaller half of a column once the header, the strip and the terminal's
  // own toolbar are counted; a drop a few pixels high silently did nothing.
  it("inserts the path when the drop lands on the cell, not just the terminal canvas", async () => {
    const w = await mountCell();
    await w.find(".cell").trigger("drop", { dataTransfer: fileDrag("file:///w/notes.md") });
    expect(inserted).toEqual([{ key: SLOT, text: "/w/notes.md" }]);
  });

  // The canvas handles its own drops and preventDefaults them on the way up. Without this the
  // path would be typed twice for every drop that DID land on the terminal.
  it("stays out of the way of a drop the terminal canvas already handled", async () => {
    const w = await mountCell();
    const term = w.find(".stub-term").element;
    // Stands in for Terminal.vue's own drop handler, which preventDefaults a file drop on the
    // canvas and inserts the path itself. The event then bubbles to the cell.
    term.addEventListener("drop", (e) => e.preventDefault());
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: fileDrag("file:///w/notes.md") });
    term.dispatchEvent(event);
    await nextTick();
    expect(inserted).toEqual([]);
  });

  // The column-reorder drag carries a custom MIME with no "Files" entry — it must reach
  // TerminalGrid's own drop handler untouched.
  it("ignores a column-reorder drag", async () => {
    const w = await mountCell();
    await w.find(".cell").trigger("dragover", { dataTransfer: columnDrag() });
    await w.find(".cell").trigger("drop", { dataTransfer: columnDrag() });
    expect(inserted).toEqual([]);
    expect(w.find(".cell").classes()).not.toContain("cell-file-drop");
  });

  it("marks the whole cell while a file drag is over it, and clears it on the drop", async () => {
    const w = await mountCell();
    await w.find(".cell").trigger("dragover", { dataTransfer: fileDrag("file:///w/a.txt") });
    expect(w.find(".cell").classes()).toContain("cell-file-drop");
    await w.find(".cell").trigger("drop", { dataTransfer: fileDrag("file:///w/a.txt") });
    expect(w.find(".cell").classes()).not.toContain("cell-file-drop");
  });

  // Chrome withholds a dropped file's path — but hands over the File itself, so the bytes ride
  // the attach route and the saved copy's path is inserted. This is the .md-onto-a-pane case
  // the route exists for.
  it("uploads a pathless drop's file and inserts the path the host saved it at", async () => {
    const w = await mountCell();
    const md = new File([new Uint8Array([35])], "notes.md", { type: "" }); // type "" — how Chrome reports a .md
    await w.find(".cell").trigger("drop", { dataTransfer: fileDrag("", [md]) });
    await flushPromises();
    expect(posted).toEqual([{ fileName: "notes.md", dataBase64: expect.any(String) }]);
    expect(inserted).toEqual([{ key: SLOT, text: "/w/data/attachments/2026/08/notes-abc.md" }]);
    expect(stripText(w)).toContain("挿入");
  });

  // A drag that said "Files" but delivered neither a path nor any File objects: nothing can be
  // done, and a drop that inserts nothing otherwise reads as the feature being broken.
  it("says so when the browser handed over nothing at all", async () => {
    const w = await mountCell();
    await w.find(".cell").trigger("drop", { dataTransfer: fileDrag("") });
    expect(inserted).toEqual([]);
    expect(stripText(w)).toContain("ファイル");
  });

  it("does nothing on a cell that has not launched yet (there is no terminal to type into)", async () => {
    const w = await mountCell({ initialSessionId: null });
    await w.find(".cell").trigger("drop", { dataTransfer: fileDrag("file:///w/notes.md") });
    expect(inserted).toEqual([]);
  });
});

describe("the header attach button", () => {
  // R14, generalised: the picker takes ANY file (the accept attribute is gone), and a picked
  // .md rides the same upload as a drop.
  it("uploads a picked file of any type and inserts the saved path", async () => {
    const w = await mountCell();
    expect(w.find('[data-testid="cell-attach-btn"]').exists()).toBe(true);
    const input = w.find('input[type="file"]');
    expect(input.attributes("accept")).toBeUndefined();
    const md = new File([new Uint8Array([35])], "notes.md", { type: "" });
    Object.defineProperty(input.element, "files", { value: [md] });
    await input.trigger("change");
    await flushPromises();
    expect(posted).toEqual([{ fileName: "notes.md", dataBase64: expect.any(String) }]);
    expect(inserted).toEqual([{ key: SLOT, text: "/w/data/attachments/2026/08/notes-abc.md" }]);
  });
});

describe("pasting an image over the pane", () => {
  const clipboardWith = (file: File | null) => ({
    items: file ? [{ kind: "file", type: file.type, getAsFile: () => file }] : [{ kind: "string", type: "text/plain", getAsFile: () => null }],
    files: [],
  });

  it("uploads the bytes and inserts the path the host saved them at", async () => {
    const w = await mountCell();
    const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    await w.find(".cell").trigger("paste", { clipboardData: clipboardWith(png) });
    await flushPromises();
    expect(posted).toHaveLength(1);
    expect(inserted).toEqual([{ key: SLOT, text: "/w/data/attachments/2026/08/a.png" }]);
    expect(stripText(w)).toContain("挿入");
  });

  // xterm's own paste handling is what types text into a terminal; claiming the event would
  // break the ordinary Cmd+V.
  it("leaves a plain text paste to the terminal", async () => {
    const w = await mountCell();
    await w.find(".cell").trigger("paste", { clipboardData: clipboardWith(null) });
    await flushPromises();
    expect(posted).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("reports a failed upload on the strip instead of inserting nothing silently", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u === PASTE_IMAGE_ROUTE) return { ok: false, json: async () => ({ error: "nope" }) };
      return { ok: true, json: async () => ({ working: false, waiting: false }) };
    }) as unknown as typeof fetch;
    const w = await mountCell();
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    await w.find(".cell").trigger("paste", { clipboardData: clipboardWith(png) });
    await flushPromises();
    expect(inserted).toEqual([]);
    expect(stripText(w)).toContain("失敗");
  });
});
