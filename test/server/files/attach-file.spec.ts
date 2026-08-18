// @vitest-environment node
// (the route module imports node:path, which jsdom cannot resolve)
import { describe, it, expect, vi } from "vitest";
import type { Express } from "express";
import { mountAttachFileRoute, type AttachFileDeps } from "../../../server/files/attach-file.js";
import { ATTACH_FILE_ROUTE } from "../../../common/attachFile.js";

// Mounted against a fake Express and driven by hand — the pattern paste-image.spec /
// agent-routes.spec use, so no HTTP server or port is needed.
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

function mountAndCapture(deps: AttachFileDeps): Handler {
  const handlers = new Map<string, Handler>();
  const app = { post: (p: string, h: Handler) => handlers.set(p, h) } as unknown as Express;
  mountAttachFileRoute(app, deps);
  const handler = handlers.get(ATTACH_FILE_ROUTE);
  if (!handler) throw new Error("the route was not mounted");
  return handler;
}

const WORKSPACE = "/home/u/workspace";
const MD = btoa("# a note");

function baseDeps(over: Partial<AttachFileDeps> = {}): AttachFileDeps {
  return {
    workspace: WORKSPACE,
    isAllowedOrigin: () => true,
    saveAttachment: async () => ({ relativePath: "data/attachments/2026/08/notes-abc.md", mimeType: "application/octet-stream" }),
    ...over,
  };
}

const post = (handler: Handler, body: unknown) => {
  const res = makeRes();
  const done = handler({ body, headers: {} }, res);
  return Promise.resolve(done).then(() => res);
};

describe("POST /api/attach-file", () => {
  it("saves the bytes under the client's filename and answers with an ABSOLUTE path plus the relative one", async () => {
    const saveAttachment = vi.fn(async () => ({ relativePath: "data/attachments/2026/08/notes-abc.md", mimeType: "application/octet-stream" }));
    const res = await post(mountAndCapture(baseDeps({ saveAttachment })), { fileName: "notes.md", dataBase64: MD });
    // The MIME is unknowable here (Chrome reports "" for most text files) — the store names
    // by the fileName, and octet-stream is only a fallback label.
    expect(saveAttachment).toHaveBeenCalledWith(MD, "application/octet-stream", "notes.md");
    // Absolute, because a pane can be running in any directory — a workspace-relative path
    // would be wrong in every pane whose cwd is not the workspace.
    expect(res.payload).toEqual({
      ok: true,
      path: `${WORKSPACE}/data/attachments/2026/08/notes-abc.md`,
      relativePath: "data/attachments/2026/08/notes-abc.md",
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a foreign origin before reading the body", async () => {
    const saveAttachment = vi.fn(async () => ({ relativePath: "x.md", mimeType: "application/octet-stream" }));
    const res = await post(mountAndCapture(baseDeps({ isAllowedOrigin: () => false, saveAttachment })), { fileName: "notes.md", dataBase64: MD });
    expect(res.statusCode).toBe(403);
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("passes the shared validation's status through, and never writes a rejected upload", async () => {
    const saveAttachment = vi.fn(async () => ({ relativePath: "x.md", mimeType: "application/octet-stream" }));
    const handler = mountAndCapture(baseDeps({ saveAttachment }));
    expect((await post(handler, { dataBase64: MD })).statusCode).toBe(400);
    expect((await post(handler, { fileName: "a.md", dataBase64: `data:text/markdown;base64,${MD}` })).statusCode).toBe(400);
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  // The file is lost either way; saying so is what stops the cell showing "saving…" forever.
  it("500s when the store cannot write, rather than answering ok", async () => {
    const res = await post(
      mountAndCapture(
        baseDeps({
          saveAttachment: async () => {
            throw new Error("disk full");
          },
        }),
      ),
      { fileName: "notes.md", dataBase64: MD },
    );
    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({ error: expect.stringContaining("couldn't save") });
  });
});
