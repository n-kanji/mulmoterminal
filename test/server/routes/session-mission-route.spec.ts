// @vitest-environment node
//
// PUT /api/session/:id/mission — the route the agent running IN a pane calls with one curl to
// say why its column exists. The STORE is mocked: its rules (normalise, prune, persist) have
// their own spec, and the real one writes into the developer's ~/.mulmoterminal.
//
// What is pinned here is the route's own contract, all of which a curl can get wrong:
// a bad id is refused, a wrong-typed mission is refused rather than silently erasing the line,
// a blank one clears, and every accepted write is published so open grids re-render.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Express } from "express";

const setMission = vi.fn((_id: string, mission: string | null) => mission);

vi.mock("../../../server/session/mission-store.js", () => ({
  setMission,
  missionOf: () => null,
  missionsHydrated: Promise.resolve(),
  // The real normaliser, so "  " still means "clear it" here — that mapping is the reason
  // there is no separate DELETE route, and mocking it away would hide a break in it.
  normalizeMission: (raw: unknown) => {
    if (typeof raw !== "string") return null;
    const text = raw.replace(/\s+/gu, " ").trim();
    return text || null;
  },
}));

const { mountSessionRoutes } = await import("../../../server/routes/session-routes.js");

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

type Handler = (req: { params: { id: string }; body: unknown }, res: FakeRes) => unknown;

const UUID = "01234567-89ab-cdef-0123-456789abcdef";
const publishActivity = vi.fn();

function missionHandler(): Handler {
  const handlers = new Map<string, Handler>();
  const noop = () => {};
  const app = {
    get: noop,
    put: (p: string, h: Handler) => handlers.set(p, h),
  } as unknown as Express;
  mountSessionRoutes(app, { freshenRosterTitle: () => {}, publishActivity });
  const handler = handlers.get("/api/session/:id/mission");
  if (!handler) throw new Error("the mission route was not mounted");
  return handler;
}

async function put(id: string, body: unknown): Promise<FakeRes> {
  const res = makeRes();
  await missionHandler()({ params: { id }, body }, res);
  return res;
}

beforeEach(() => {
  setMission.mockClear();
  publishActivity.mockClear();
});

describe("PUT /api/session/:id/mission", () => {
  it("stores a mission and answers with what is now stored", async () => {
    const res = await put(UUID, { mission: "keep the release branch green" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ id: UUID, mission: "keep the release branch green" });
    expect(setMission).toHaveBeenCalledWith(UUID, "keep the release branch green", expect.any(Function));
  });

  // Every open grid re-renders the strip from the pub/sub row; without this a curl would land
  // in the store and show up only on the next reload.
  it("publishes the session's row so open grids pick it up", async () => {
    await put(UUID, { mission: "ship it" });
    expect(publishActivity).toHaveBeenCalledWith(UUID);
  });

  it("treats a blank mission as clearing the line", async () => {
    const res = await put(UUID, { mission: "   " });
    expect(res.payload).toEqual({ id: UUID, mission: null });
    expect(setMission).toHaveBeenCalledWith(UUID, null, expect.any(Function));
  });

  // A caller sending the wrong type has a bug. Answering 200 to it would hide the bug behind
  // an erased mission, which is indistinguishable from a deliberate clear.
  it("refuses a non-string mission instead of erasing the one that is there", async () => {
    const res = await put(UUID, { mission: 42 });
    expect(res.statusCode).toBe(400);
    expect(setMission).not.toHaveBeenCalled();
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a canonical uuid", async () => {
    const res = await put("../etc/passwd", { mission: "x" });
    expect(res.statusCode).toBe(400);
    expect(setMission).not.toHaveBeenCalled();
  });

  // An omitted field is not a wrong type — it is the same request as an empty string.
  it("treats a missing mission field, and a bodyless request, as a clear", async () => {
    expect((await put(UUID, {})).payload).toEqual({ id: UUID, mission: null });
    expect((await put(UUID, undefined)).payload).toEqual({ id: UUID, mission: null });
  });
});
