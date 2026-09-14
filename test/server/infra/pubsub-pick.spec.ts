// @vitest-environment node
// Where an agent's column appears. It used to be whichever socket the room listed first —
// insertion order — so a MulmoTerminal left open in a background window collected the columns
// and the operator saw nothing appear in front of them (operator report 2026-09-14).
import { describe, it, expect } from "vitest";
import { pickOneSubscriber } from "../../../server/infra/pubsub.js";

describe("pickOneSubscriber", () => {
  it("prefers a tab someone is looking at over one that was there first", () => {
    expect(pickOneSubscriber(["background", "front"], new Set(["background"]))).toBe("front");
  });

  it("keeps the first when nothing is hidden — the behaviour before tabs reported themselves", () => {
    expect(pickOneSubscriber(["a", "b"], new Set())).toBe("a");
  });

  // Every window minimized is still better answered than refused: the action was asked for,
  // and the tab will show it when it comes back.
  it("falls back to the first when every tab is hidden", () => {
    expect(pickOneSubscriber(["a", "b"], new Set(["a", "b"]))).toBe("a");
  });

  it("is null when nobody is subscribed at all", () => {
    expect(pickOneSubscriber([], new Set())).toBeNull();
  });
});
