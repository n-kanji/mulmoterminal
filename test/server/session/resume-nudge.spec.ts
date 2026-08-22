// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";

import { queueResumeNudge, takeResumeNudge, clearResumeNudges, RESUME_NUDGE_TTL_MS } from "../../../server/session/resume-nudge.js";

describe("resume-nudge", () => {
  beforeEach(clearResumeNudges);

  it("is single use, keyed by session id", () => {
    queueResumeNudge("s1", "carry on", 1000);
    expect(takeResumeNudge("s2", 1000)).toBeUndefined();
    expect(takeResumeNudge("s1", 1000)).toBe("carry on");
    expect(takeResumeNudge("s1", 1000)).toBeUndefined();
  });

  it("expires instead of ambushing a session resumed by hand later", () => {
    queueResumeNudge("s1", "carry on", 1000);
    expect(takeResumeNudge("s1", 1000 + RESUME_NUDGE_TTL_MS + 1)).toBeUndefined();
  });

  it("replaces an earlier nudge for the same session and tolerates null ids", () => {
    queueResumeNudge("s1", "old", 1000);
    queueResumeNudge("s1", "new", 2000);
    expect(takeResumeNudge(null)).toBeUndefined();
    expect(takeResumeNudge(undefined)).toBeUndefined();
    expect(takeResumeNudge("s1", 2000)).toBe("new");
  });
});
