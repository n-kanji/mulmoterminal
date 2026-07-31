import { describe, it, expect, vi } from "vitest";
import type { Express } from "express";
import { mountPasteImageRoute, type PasteImageDeps } from "../../../server/files/paste-image.js";
import { PASTE_IMAGE_ROUTE } from "../../../common/pasteImage.js";

// Mounted against a fake Express and driven by hand — the pattern agent-routes.spec /
// tmux-routes.spec use, so no HTTP server or port is needed.
interface FakeRes {
  statusCode: number;
  payload: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

type Handler = (req: { body: unknown; headers: Record<string, string>; socket?: { remoteAddress?: string } }, res: FakeRes) => unknown;

function mountAndCapture(deps: PasteImageDeps): Handler {
  const handlers = new Map<string, Handler>();
  const app = { post: (p: string, h: Handler) => handlers.set(p, h) } as unknown as Express;
  mountPasteImageRoute(app, deps);
  const handler = handlers.get(PASTE_IMAGE_ROUTE);
  if (!handler) throw new Error("the route was not mounted");
  return handler;
}

const WORKSPACE = "/home/u/workspace";
const PNG = btoa("fake png bytes");

function baseDeps(over: Partial<PasteImageDeps> = {}): PasteImageDeps {
  return {
    workspace: WORKSPACE,
    isAllowedOrigin: () => true,
    saveAttachment: async () => ({ relativePath: "data/attachments/2026/08/abc.png", mimeType: "image/png" }),
    ...over,
  };
}

const post = (handler: Handler, body: unknown) => {
  const res = makeRes();
  const done = handler({ body, headers: {} }, res);
  return Promise.resolve(done).then(() => res);
};

describe("POST /api/paste-image", () => {
  it("saves the bytes and answers with an ABSOLUTE path plus the workspace-relative one", async () => {
    const saveAttachment = vi.fn(async () => ({ relativePath: "data/attachments/2026/08/abc.png", mimeType: "image/png" }));
    const res = await post(mountAndCapture(baseDeps({ saveAttachment })), { mimeType: "image/png", dataBase64: PNG });
    expect(saveAttachment).toHaveBeenCalledWith(PNG, "image/png");
    // Absolute, because a pane can be running in any directory — a workspace-relative path
    // would be wrong in every pane whose cwd is not the workspace.
    expect(res.payload).toEqual({ ok: true, path: `${WORKSPACE}/data/attachments/2026/08/abc.png`, relativePath: "data/attachments/2026/08/abc.png" });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a foreign origin before reading the body", async () => {
    const saveAttachment = vi.fn(async () => ({ relativePath: "x.png", mimeType: "image/png" }));
    const res = await post(mountAndCapture(baseDeps({ isAllowedOrigin: () => false, saveAttachment })), { mimeType: "image/png", dataBase64: PNG });
    expect(res.statusCode).toBe(403);
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("passes the shared validation's status through, and never writes a rejected paste", async () => {
    const saveAttachment = vi.fn(async () => ({ relativePath: "x.png", mimeType: "image/png" }));
    const handler = mountAndCapture(baseDeps({ saveAttachment }));
    expect((await post(handler, { mimeType: "image/svg+xml", dataBase64: PNG })).statusCode).toBe(415);
    expect((await post(handler, { mimeType: "image/png", dataBase64: "" })).statusCode).toBe(400);
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  // The paste is lost either way; saying so is what stops the cell showing "saving…" forever.
  it("500s when the store cannot write, rather than answering ok", async () => {
    const res = await post(
      mountAndCapture(
        baseDeps({
          saveAttachment: async () => {
            throw new Error("disk full");
          },
        }),
      ),
      { mimeType: "image/png", dataBase64: PNG },
    );
    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({ error: expect.stringContaining("couldn't save") });
  });
});
