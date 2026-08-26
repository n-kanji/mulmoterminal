// @vitest-environment node
//
// Delivering the head of the queue. The order is the operator's requirement and is pinned:
// the exchange about to be pushed off the screen is recorded (and published) BEFORE the text
// is typed, and a failed send puts the item back (and the hand-off away) rather than losing
// it. The settle / re-read exists because the Stop hook can beat the transcript write
// (measured ~40ms apart); the per-session serialisation because an automatic drain and a
// "send now" click can overlap.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearNextQueues, dequeueNext, enqueueNext, nextQueueOf, setNextAuto } from "../../../server/session/next-queue.js";
import {
  DRAIN_AFTER_SEND_MS,
  DRAIN_READ_RETRIES,
  DRAIN_SETTLE_MS,
  drainNextQueue,
  turnIsCurrent,
  type DrainDeps,
} from "../../../server/session/next-queue-drain.js";
import type { LastTurn } from "../../../server/session/last-turn.js";

const ID = "11111111-1111-1111-1111-111111111111";
const FRESH: LastTurn = { prompt: "what I asked", reply: "the report you must still read" };

function deps(over: Partial<DrainDeps> = {}) {
  const calls: string[] = [];
  const d: DrainDeps = {
    sendToSession: vi.fn(async (_id: string, text: string) => {
      calls.push(`send:${text}`);
      return { sent: true };
    }),
    lastTurn: vi.fn(async () => {
      calls.push("lastTurn");
      return FRESH;
    }),
    publish: vi.fn((_id: string, state) => {
      calls.push(`publish:${state.handoffs.length}h/${state.items.length}i`);
    }),
    sleep: vi.fn(async (ms: number) => {
      calls.push(`sleep:${ms}`);
    }),
    ...over,
  };
  return { d, calls };
}

beforeEach(clearNextQueues);

describe("turnIsCurrent", () => {
  it("needs a reply, and a matching prompt when one is expected", () => {
    expect(turnIsCurrent({ prompt: "a", reply: null }, "a")).toBe(false);
    expect(turnIsCurrent({ prompt: "a", reply: "r" }, undefined)).toBe(true);
    expect(turnIsCurrent({ prompt: "old question", reply: "r" }, "new question")).toBe(false);
  });
  // The hook stores the prompt one-line and truncated; the transcript has the full text.
  it("compares a whitespace-squashed prefix", () => {
    expect(turnIsCurrent({ prompt: "please  do\nthis long thing and that", reply: "r" }, "please do this long thing")).toBe(true);
  });
});

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

  it("settles, records the superseded exchange and publishes BEFORE typing, then holds a beat", async () => {
    enqueueNext(ID, "next thing");
    const { d, calls } = deps();
    const result = await drainNextQueue(ID, d);
    expect(result.sent).toBe(true);
    expect(calls).toEqual([`sleep:${DRAIN_SETTLE_MS}`, "lastTurn", "publish:1h/0i", "send:next thing", `sleep:${DRAIN_AFTER_SEND_MS}`]);
    expect(d.sendToSession).toHaveBeenCalledWith(ID, "next thing", { multiline: true });
    const [h] = nextQueueOf(ID).handoffs;
    expect(h).toMatchObject({ text: "next thing", prevPrompt: FRESH.prompt, prevReply: FRESH.reply, read: false });
  });

  it("skips the settle and the idle check when forced (the operator clicked send now)", async () => {
    enqueueNext(ID, "go");
    const { d, calls } = deps({ isIdle: () => false });
    expect(await drainNextQueue(ID, d, { force: true })).toMatchObject({ sent: true });
    expect(calls[0]).toBe("lastTurn");
  });

  // The gates are re-read after the settle: what the operator did during it wins.
  it("takes the item after the settle, so a deletion meanwhile wins", async () => {
    const { item } = enqueueNext(ID, "changed my mind");
    const { d } = deps({
      sleep: vi.fn(async () => {
        dequeueNext(ID, item.id);
      }),
    });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "empty" });
    expect(d.sendToSession).not.toHaveBeenCalled();
  });

  it("honours auto switched off during the settle", async () => {
    enqueueNext(ID, "later");
    const { d } = deps({
      sleep: vi.fn(async () => {
        setNextAuto(ID, false);
      }),
    });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "auto-off" });
    expect(nextQueueOf(ID).items).toHaveLength(1);
  });

  it("holds the item when the pane went back to work during the settle (typed by hand)", async () => {
    enqueueNext(ID, "later");
    let idle = true;
    const { d } = deps({
      isIdle: () => idle,
      sleep: vi.fn(async () => {
        idle = false;
      }),
    });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "busy" });
    expect(nextQueueOf(ID).items).toHaveLength(1);
    expect(nextQueueOf(ID).handoffs).toHaveLength(0);
  });

  it("re-reads the transcript until it shows the turn that just ended", async () => {
    enqueueNext(ID, "next");
    const reads: LastTurn[] = [
      { prompt: "older question", reply: "older reply" }, // stale: the write has not landed
      { prompt: "current question", reply: null }, // prompt landed, reply not yet
      { prompt: "current question", reply: "fresh reply" },
    ];
    const lastTurn = vi.fn(async () => reads.shift() ?? FRESH);
    const { d } = deps({ lastTurn, currentPrompt: () => "current question" });
    await drainNextQueue(ID, d);
    expect(lastTurn).toHaveBeenCalledTimes(3);
    expect(nextQueueOf(ID).handoffs[0]).toMatchObject({ prevPrompt: "current question", prevReply: "fresh reply" });
  });

  it("gives up after the retries and still sends with what it has", async () => {
    enqueueNext(ID, "go");
    const lastTurn = vi.fn(async () => ({ prompt: "stale", reply: "stale reply" }));
    const { d } = deps({ lastTurn, currentPrompt: () => "current" });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: true });
    expect(lastTurn).toHaveBeenCalledTimes(DRAIN_READ_RETRIES + 1);
    expect(nextQueueOf(ID).handoffs[0]).toMatchObject({ prevReply: "stale reply" });
  });

  it("still sends when the transcript cannot be read", async () => {
    enqueueNext(ID, "go");
    const { d } = deps({ lastTurn: vi.fn(async () => Promise.reject(new Error("no transcript"))) });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: true });
    expect(nextQueueOf(ID).handoffs[0]).toMatchObject({ prevPrompt: null, prevReply: null });
  });

  it("restores the item at the head AND takes the hand-off back when the send fails", async () => {
    enqueueNext(ID, "first");
    enqueueNext(ID, "second");
    const { d } = deps({ sendToSession: vi.fn(async () => Promise.reject(new Error("no live terminal"))) });
    expect(await drainNextQueue(ID, d)).toMatchObject({ sent: false, reason: "send-failed" });
    expect(nextQueueOf(ID).items.map((i) => i.text)).toEqual(["first", "second"]);
    expect(nextQueueOf(ID).handoffs).toHaveLength(0); // no phantom "sent after this report" card
  });

  // An automatic drain mid-settle and a "send now" click: the click waits its turn, so the
  // items go out in queue order, one send fully after the other.
  it("serialises overlapping drains per session, in call order", async () => {
    enqueueNext(ID, "one");
    enqueueNext(ID, "two");
    const order: string[] = [];
    const gate = { release: () => {} };
    const d: DrainDeps = {
      sendToSession: vi.fn(async (_id: string, text: string) => {
        order.push(text);
        return { sent: true };
      }),
      lastTurn: vi.fn(async () => FRESH),
      publish: vi.fn(),
      sleep: vi.fn((ms: number) => (ms === DRAIN_SETTLE_MS ? new Promise<void>((resolve) => (gate.release = resolve)) : Promise.resolve())),
    };
    const auto = drainNextQueue(ID, d); // parked on the settle
    const clicked = drainNextQueue(ID, d, { force: true }); // must not overtake
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.release();
    const [a, b] = await Promise.all([auto, clicked]);
    expect(order).toEqual(["one", "two"]);
    expect(a).toMatchObject({ sent: true, text: "one" });
    expect(b).toMatchObject({ sent: true, text: "two" });
  });
});
