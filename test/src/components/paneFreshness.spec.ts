import { describe, it, expect } from "vitest";
import { AGING_AFTER_MS, freshnessOf, STALE_AFTER_MS } from "../../../src/components/paneFreshness";

const NOW = 1_700_000_000_000;
const agedBy = (ms: number) => NOW - ms;

describe("freshnessOf", () => {
  it("is fresh under five minutes, aging after that, stale past thirty", () => {
    expect(freshnessOf("unread", agedBy(0), NOW)).toBe("fresh");
    expect(freshnessOf("unread", agedBy(AGING_AFTER_MS - 1), NOW)).toBe("fresh");
    expect(freshnessOf("unread", agedBy(AGING_AFTER_MS), NOW)).toBe("aging");
    expect(freshnessOf("unread", agedBy(STALE_AFTER_MS - 1), NOW)).toBe("aging");
    expect(freshnessOf("unread", agedBy(STALE_AFTER_MS), NOW)).toBe("stale");
  });

  // A pane mid-turn is not neglected however long the turn runs, and ageing it would paint a
  // long build red for doing its job.
  it("never ages a working pane", () => {
    expect(freshnessOf("working", agedBy(STALE_AFTER_MS * 10), NOW)).toBe("fresh");
  });

  // Everything else ages, including the states with nothing to say: an idle pane untouched for
  // an hour is a candidate to close, and that is exactly what the operator wants surfaced.
  it.each(["approval", "question", "unread", "disconnected", "shell", "idle"] as const)("ages a %s pane", (state) => {
    expect(freshnessOf(state, agedBy(STALE_AFTER_MS), NOW)).toBe("stale");
  });

  // Unknown age is not evidence of neglect. A session that has never reported (or one restored
  // from a file written before the timestamp existed) must not paint itself red on sight.
  it("reads an unknown timestamp as fresh", () => {
    expect(freshnessOf("idle", null, NOW)).toBe("fresh");
    expect(freshnessOf("idle", undefined, NOW)).toBe("fresh");
  });

  // A restored file from a machine whose clock moved would otherwise produce a negative age.
  it("reads a future timestamp as fresh rather than wrapping round", () => {
    expect(freshnessOf("idle", NOW + STALE_AFTER_MS, NOW)).toBe("fresh");
  });
});
