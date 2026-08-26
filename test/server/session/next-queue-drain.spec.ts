// @vitest-environment node
//
// Delivering the head of the queue. The order is the operator's requirement and is pinned:
// the exchange about to be pushed off the screen is recorded (and published) BEFORE the text
// is typed, and a failed send puts the item back rather than losing it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearNextQueues, enqueueNext, nextQueueOf, setNextAuto } from "../../../server/session/next-queue.js";
import { drainNextQueue, type DrainDeps } from "../../../server/session/next-queue-drain.js";

const ID = "11111111-1111-1111-1111-111111111111";

function deps(over: Partial<DrainDeps> = {}) {
  const calls: string[] = [];
  const d: DrainDeps = {
    sendToSession: vi.fn(async (_id: string, text: string) => {
      calls.push(`send:${text}`);
      return { sent: true };
    }),
    lastTurn: vi.fn(async () => {
      calls.push("lastTurn");
      return { prompt: "what I asked", reply: "the report you must still read" };
    }),
    publish: vi.fn((_id: string, state) => {
      calls.push(`publish:${state.handoffs.length}h/${state.items.length}i`);
    }),
    ...over,
  };
  return { d, calls };
}

beforeEach(clearNextQueues);

describe("drainNextQueue", () => {
  it("does nothing on an empty queue", async () => {
    const { d } = deps();
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "empty" });
    expect(d.sendToSession).not.toHaveBeenCalled();
  });

  it("holds the item while auto is off, unless forced", async () => {
    enqueueNext(ID, "later");
    setNextAuto(ID, false);
    const { d } = deps();
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "auto-off" });
    expect(nextQueueOf(ID).items).toHaveLength(1);
    expect(await drainNextQueue(ID, d, { force: true })).toMatchObject({ sent: true, text: "later" });
    expect(nextQueueOf(ID).items).toHaveLength(0);
  });

  it("records the superseded exchange and publishes BEFORE typing", async () => {
    enqueueNext(ID, "next thing");
    const { d, calls } = deps();
    const result = await drainNextQueue(ID, d);
    expect(result.sent).toBe(true);
    expect(calls).toEqual(["lastTurn", "publish:1h/0i", "send:next thing"]);
    const [h] = nextQueueOf(ID).handoffs;
    expect(h).toMatchObject({ text: "next thing", prevPrompt: "what I asked", prevReply: "the report you must still read", read: false });
  });

  it("still sends when the transcript cannot be read", async () => {
    enqueueNext(ID, "go");
    const { d } = deps({ lastTurn: vi.fn(async () => Promise.reject(new Error("no transcript"))) });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: true });
    expect(nextQueueOf(ID).handoffs[0]).toMatchObject({ prevPrompt: null, prevReply: null });
  });

  it("restores the item at the head when the send fails", async () => {
    enqueueNext(ID, "first");
    enqueueNext(ID, "second");
    const { d } = deps({ sendToSession: vi.fn(async () => Promise.reject(new Error("no live terminal"))) });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "send-failed" });
    expect(nextQueueOf(ID).items.map((i) => i.text)).toEqual(["first", "second"]);
  });
});
