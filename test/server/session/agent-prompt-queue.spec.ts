import { describe, it, expect, beforeEach } from "vitest";
import {
  AGENT_PROMPT_TTL_MS,
  clearAgentPrompts,
  dropAgentPrompt,
  queueAgentPrompt,
  queuedAgentPromptCount,
  takeAgentPrompt,
} from "../../../server/session/agent-prompt-queue.js";

const PROJECT = "/home/u/project";
const OTHER = "/home/u/other";
const T0 = 1_000_000;

beforeEach(clearAgentPrompts);

describe("agent prompt queue", () => {
  it("hands a parked prompt to the next session in that directory, once", () => {
    queueAgentPrompt(PROJECT, "start on the parser", T0);

    expect(takeAgentPrompt(PROJECT, T0 + 500)).toBe("start on the parser");
    expect(takeAgentPrompt(PROJECT, T0 + 500)).toBeUndefined();
  });

  it("keeps directories apart", () => {
    queueAgentPrompt(PROJECT, "parser", T0);

    expect(takeAgentPrompt(OTHER, T0)).toBeUndefined();
    expect(takeAgentPrompt(PROJECT, T0)).toBe("parser");
  });

  it("serves two requests for the same directory in order", () => {
    queueAgentPrompt(PROJECT, "first", T0);
    queueAgentPrompt(PROJECT, "second", T0);

    expect(takeAgentPrompt(PROJECT, T0)).toBe("first");
    expect(takeAgentPrompt(PROJECT, T0)).toBe("second");
    expect(queuedAgentPromptCount()).toBe(0);
  });

  it("expires a prompt no column ever claimed", () => {
    queueAgentPrompt(PROJECT, "stale", T0);

    expect(takeAgentPrompt(PROJECT, T0 + AGENT_PROMPT_TTL_MS + 1)).toBeUndefined();
    expect(queuedAgentPromptCount()).toBe(0);
  });

  it("passes an expired prompt to reach a fresh one behind it", () => {
    queueAgentPrompt(PROJECT, "stale", T0);
    queueAgentPrompt(PROJECT, "fresh", T0 + AGENT_PROMPT_TTL_MS);

    expect(takeAgentPrompt(PROJECT, T0 + AGENT_PROMPT_TTL_MS + 1)).toBe("fresh");
  });

  it("gives back a prompt whose request was never delivered", () => {
    queueAgentPrompt(PROJECT, "undelivered", T0);
    dropAgentPrompt(PROJECT, "undelivered");

    expect(takeAgentPrompt(PROJECT, T0)).toBeUndefined();
    expect(queuedAgentPromptCount(PROJECT)).toBe(0);
  });

  it("drops only the prompt named, not a sibling waiting in the same directory", () => {
    queueAgentPrompt(PROJECT, "keep", T0);
    queueAgentPrompt(PROJECT, "undelivered", T0);
    dropAgentPrompt(PROJECT, "undelivered");

    expect(takeAgentPrompt(PROJECT, T0)).toBe("keep");
  });
});
