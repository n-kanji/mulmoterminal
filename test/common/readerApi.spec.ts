import { describe, expect, it } from "vitest";
import { readerBridgeMessageOf } from "../../common/readerApi";

describe("readerBridgeMessageOf", () => {
  it("accepts each message the bridge posts, with its payload", () => {
    expect(readerBridgeMessageOf({ type: "reader:ready" })).toEqual({ type: "reader:ready" });
    expect(readerBridgeMessageOf({ type: "reader:save", html: "<p>" })).toEqual({ type: "reader:save", html: "<p>" });
    expect(readerBridgeMessageOf({ type: "reader:copy", text: "t" })).toEqual({ type: "reader:copy", text: "t" });
    expect(readerBridgeMessageOf({ type: "reader:revisions", count: 9, active: true, open: false })).toEqual({
      type: "reader:revisions",
      count: 9,
      active: true,
      open: false,
    });
  });

  it("refuses anything else — the frame is another origin, and a malformed state must not reach the header", () => {
    expect(readerBridgeMessageOf(null)).toBeNull();
    expect(readerBridgeMessageOf("reader:ready")).toBeNull();
    expect(readerBridgeMessageOf({ type: "reader:save" })).toBeNull();
    expect(readerBridgeMessageOf({ type: "reader:revisions", count: "9", active: true, open: false })).toBeNull();
    expect(readerBridgeMessageOf({ type: "reader:revisions", count: 9, active: true })).toBeNull();
    expect(readerBridgeMessageOf({ type: "reader:revisions-toggle", which: "only" })).toBeNull();
  });
});
