// @vitest-environment node
//
// The next-instruction queue store. Persistence is off under vitest (the module checks
// VITEST), so the map is exercised directly; the pure parse / prune / trim rules are what a
// restart depends on and are pinned here.
import { describe, it, expect, beforeEach } from "vitest";
import {
  NEXT_QUEUE_MAX_HANDOFFS,
  NEXT_QUEUE_MAX_TEXT,
  clearNextQueues,
  dequeueNext,
  enqueueNext,
  markHandoffsRead,
  nextQueueOf,
  normalizeQueueText,
  parseQueues,
  pruneQueues,
  recordHandoff,
  restoreNext,
  setNextAuto,
  takeNext,
  trimHandoffs,
  type NextQueueRecord,
} from "../../../server/session/next-queue.js";
import type { NextQueueHandoff } from "../../../common/nextQueue.js";

const ID = "11111111-1111-1111-1111-111111111111";
const NOW = 1_700_000_000_000;

beforeEach(clearNextQueues);

describe("normalizeQueueText", () => {
  it("trims but keeps the line structure — a multi-line instruction is still one item", () => {
    expect(normalizeQueueText("  first line\r\nsecond  \n")).toBe("first line\nsecond");
  });
  it("refuses blank and non-strings", () => {
    expect(normalizeQueueText("   ")).toBeNull();
    expect(normalizeQueueText(42)).toBeNull();
  });
  it("clips a runaway text", () => {
    expect(normalizeQueueText("x".repeat(NEXT_QUEUE_MAX_TEXT + 5))).toHaveLength(NEXT_QUEUE_MAX_TEXT);
  });
});

describe("queue operations", () => {
  it("starts empty with auto on", () => {
    expect(nextQueueOf(ID)).toEqual({ auto: true, items: [], handoffs: [] });
  });

  it("enqueues in order and takes from the head", () => {
    enqueueNext(ID, "a", NOW);
    enqueueNext(ID, "b", NOW + 1);
    expect(nextQueueOf(ID).items.map((i) => i.text)).toEqual(["a", "b"]);
    expect(takeNext(ID)?.text).toBe("a");
    expect(nextQueueOf(ID).items.map((i) => i.text)).toEqual(["b"]);
    expect(takeNext(ID)?.text).toBe("b");
    expect(takeNext(ID)).toBeUndefined();
  });

  it("dequeues by item id and reports a miss", () => {
    const { item } = enqueueNext(ID, "a");
    expect(dequeueNext(ID, "nope").removed).toBe(false);
    expect(dequeueNext(ID, item.id).removed).toBe(true);
    expect(nextQueueOf(ID).items).toEqual([]);
  });

  // A failed send must not lose the text: it goes back to the FRONT, keeping its turn.
  it("restores a taken item at the head", () => {
    enqueueNext(ID, "a");
    enqueueNext(ID, "b");
    const head = takeNext(ID);
    expect(head).toBeDefined();
    if (head) restoreNext(ID, head);
    expect(nextQueueOf(ID).items.map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("toggles auto", () => {
    expect(setNextAuto(ID, false).auto).toBe(false);
    expect(nextQueueOf(ID).auto).toBe(false);
  });

  it("returns copies — mutating a snapshot does not touch the store", () => {
    enqueueNext(ID, "a");
    const snap = nextQueueOf(ID);
    snap.items.length = 0;
    expect(nextQueueOf(ID).items).toHaveLength(1);
  });
});

describe("hand-offs", () => {
  it("records the superseded exchange unread, then marks all read", () => {
    const state = recordHandoff(ID, { text: "next", prevPrompt: "p", prevReply: "r" }, NOW);
    expect(state.handoffs).toHaveLength(1);
    expect(state.handoffs[0]).toMatchObject({ text: "next", prevPrompt: "p", prevReply: "r", read: false, sentAt: NOW });
    expect(markHandoffsRead(ID).handoffs[0].read).toBe(true);
  });

  const mk = (id: string, read: boolean): NextQueueHandoff => ({ id, text: "t", sentAt: 0, prevPrompt: null, prevReply: null, read });

  // The cap must never drop an UNREAD hand-off: silently losing one is the failure the whole
  // feature exists to prevent. Only read ones are trimmed, oldest first.
  it("trims read hand-offs oldest-first and never an unread one", () => {
    const list = [mk("r1", true), mk("u1", false), mk("r2", true), mk("u2", false), mk("r3", true)];
    expect(trimHandoffs(list, 3).map((h) => h.id)).toEqual(["u1", "u2", "r3"]);
    expect(trimHandoffs(list, 1).map((h) => h.id)).toEqual(["u1", "u2"]);
  });

  it("keeps the store within the cap as hand-offs are read", () => {
    for (let i = 0; i < NEXT_QUEUE_MAX_HANDOFFS + 5; i++) recordHandoff(ID, { text: `t${i}`, prevPrompt: null, prevReply: null });
    expect(nextQueueOf(ID).handoffs).toHaveLength(NEXT_QUEUE_MAX_HANDOFFS + 5); // all unread: nothing dropped
    expect(markHandoffsRead(ID).handoffs).toHaveLength(NEXT_QUEUE_MAX_HANDOFFS);
  });
});

describe("parseQueues / pruneQueues", () => {
  const rec = (over: Partial<NextQueueRecord> = {}): NextQueueRecord => ({ auto: true, items: [], handoffs: [], updatedAt: NOW, ...over });
  const item = { id: "i", text: "x", at: NOW };

  it("drops malformed entries and empty default records", () => {
    const parsed = parseQueues(
      {
        [ID]: { auto: true, items: [item], handoffs: [], updatedAt: NOW },
        "22222222-2222-2222-2222-222222222222": { auto: true, items: [], handoffs: [] }, // nothing to keep
        bad: { items: [item], handoffs: [] },
        "33333333-3333-3333-3333-333333333333": "not a record",
      },
      (id) => id !== "bad",
    );
    expect(parsed.map((p) => p.id)).toEqual([ID]);
    expect(parsed[0].items).toEqual([item]);
  });

  it("keeps a record whose only content is auto=false", () => {
    expect(parseQueues({ [ID]: { auto: false, items: [], handoffs: [] } }, () => true)).toHaveLength(1);
  });

  it("keeps live sessions, ages out dead ones, drops empty ones", () => {
    const old = NOW - 31 * 24 * 60 * 60_000;
    const kept = pruneQueues(
      [
        ["live-old", rec({ items: [item], updatedAt: old })],
        ["dead-old", rec({ items: [item], updatedAt: old })],
        ["dead-new", rec({ items: [item] })],
        ["empty", rec()],
      ],
      { isLive: (id) => id === "live-old", now: NOW },
    );
    expect(Object.keys(kept).sort()).toEqual(["dead-new", "live-old"]);
  });
});
