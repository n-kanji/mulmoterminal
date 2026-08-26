// @vitest-environment node
//
// The queue's HTTP contract, mounted against a fake Express (agent-routes.spec.ts style). The
// store runs for real with persistence off (VITEST); what is pinned is what a curl can get
// wrong: a bad id, a wrong-typed body, a blank text, a missing item — and that every accepted
// write is published so open grids re-render.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { mountNextQueueRoutes, type NextQueueRouteDeps } from "../../../server/routes/next-queue-routes.js";
import { clearNextQueues, enqueueNext, nextQueueOf } from "../../../server/session/next-queue.js";

const ID = "11111111-1111-1111-1111-111111111111";

interface FakeRes {
  statusCode: number;
  payload: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}
const makeRes = (): FakeRes => ({
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
});

type Handler = (req: Request, res: Response) => unknown;

function mount(over: Partial<NextQueueRouteDeps> = {}) {
  const handlers = new Map<string, Handler>();
  const reg = (method: string) => (p: string, h: Handler) => handlers.set(`${method} ${p}`, h);
  const app = { get: reg("GET"), post: reg("POST"), put: reg("PUT"), delete: reg("DELETE") } as unknown as Express;
  const deps: NextQueueRouteDeps = {
    sendToSession: vi.fn(async () => ({ sent: true })),
    lastTurn: vi.fn(async () => ({ prompt: null, reply: "done" })),
    publish: vi.fn(),
    ...over,
  };
  mountNextQueueRoutes(app, deps);
  const call = async (key: string, params: Record<string, string>, body?: unknown) => {
    const res = makeRes();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`no route ${key}`);
    await handler({ params, body } as unknown as Request, res as unknown as Response);
    return res;
  };
  return { call, deps };
}

beforeEach(clearNextQueues);

describe("next-queue routes", () => {
  it("refuses a malformed session id", async () => {
    const { call } = mount();
    expect((await call("GET /api/session/:id/queue", { id: "nope" })).statusCode).toBe(400);
  });

  it("GET answers the state", async () => {
    enqueueNext(ID, "a");
    const { call } = mount();
    const res = await call("GET /api/session/:id/queue", { id: ID });
    expect(res.payload).toMatchObject({ id: ID, state: { items: [{ text: "a" }] } });
  });

  it("POST enqueues, refuses wrong types and blank, and publishes", async () => {
    const { call, deps } = mount();
    expect((await call("POST /api/session/:id/queue", { id: ID }, { text: 1 })).statusCode).toBe(400);
    expect((await call("POST /api/session/:id/queue", { id: ID }, { text: "  " })).statusCode).toBe(400);
    const ok = await call("POST /api/session/:id/queue", { id: ID }, { text: " do it " });
    expect(ok.statusCode).toBe(200);
    expect(ok.payload).toMatchObject({ item: { text: "do it" }, state: { items: [{ text: "do it" }] } });
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it("DELETE drops one and 404s a miss", async () => {
    const { item } = enqueueNext(ID, "a");
    const { call } = mount();
    expect((await call("DELETE /api/session/:id/queue/:itemId", { id: ID, itemId: "x" })).statusCode).toBe(404);
    expect((await call("DELETE /api/session/:id/queue/:itemId", { id: ID, itemId: item.id })).statusCode).toBe(200);
    expect(nextQueueOf(ID).items).toEqual([]);
  });

  it("PUT auto wants a boolean", async () => {
    const { call } = mount();
    expect((await call("PUT /api/session/:id/queue/auto", { id: ID }, { enabled: "yes" })).statusCode).toBe(400);
    expect((await call("PUT /api/session/:id/queue/auto", { id: ID }, { enabled: false })).statusCode).toBe(200);
    expect(nextQueueOf(ID).auto).toBe(false);
  });

  it("send-next types the head even with auto off, 404s an empty queue, 502s a failed send", async () => {
    const { call, deps } = mount();
    expect((await call("POST /api/session/:id/queue/send-next", { id: ID })).statusCode).toBe(404);
    enqueueNext(ID, "now");
    await call("PUT /api/session/:id/queue/auto", { id: ID }, { enabled: false });
    const ok = await call("POST /api/session/:id/queue/send-next", { id: ID });
    expect(ok.statusCode).toBe(200);
    expect(deps.sendToSession).toHaveBeenCalledWith(ID, "now");

    const failing = mount({ sendToSession: vi.fn(async () => Promise.reject(new Error("gone"))) });
    enqueueNext(ID, "again");
    const bad = await failing.call("POST /api/session/:id/queue/send-next", { id: ID });
    expect(bad.statusCode).toBe(502);
    expect(nextQueueOf(ID).items.map((i) => i.text)).toEqual(["again"]);
  });

  it("read marks every hand-off read", async () => {
    const { call, deps } = mount();
    enqueueNext(ID, "x");
    await call("POST /api/session/:id/queue/send-next", { id: ID });
    expect(nextQueueOf(ID).handoffs[0].read).toBe(false);
    const res = await call("POST /api/session/:id/queue/read", { id: ID });
    expect(res.statusCode).toBe(200);
    expect(nextQueueOf(ID).handoffs[0].read).toBe(true);
    expect(deps.publish).toHaveBeenCalled();
  });
});
