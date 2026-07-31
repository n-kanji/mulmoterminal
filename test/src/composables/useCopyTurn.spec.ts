import { describe, it, expect, vi } from "vitest";
import { copyLastTurnPart, copyOutcomeLabel, type CopyTurnDeps } from "../../../src/composables/useCopyTurn";
import type { FetchedTurn, HandoffSource } from "../../../src/composables/useHandoff";

const source: HandoffSource = { sessionId: "11111111-1111-1111-1111-111111111111", cwd: "/w/proj", agent: "claude" };

const turn = (over: Partial<FetchedTurn> = {}): FetchedTurn => ({ prompt: "what did you change?", reply: "renamed the parser", text: "framed", ...over });

const deps = (over: Partial<CopyTurnDeps> = {}): CopyTurnDeps => ({
  fetchTurn: async () => turn(),
  write: async () => true,
  ...over,
});

describe("copyLastTurnPart", () => {
  it("puts the RAW reply on the clipboard — not the framed handoff text", async () => {
    const written: string[] = [];
    const outcome = await copyLastTurnPart(source, "reply", deps({ write: async (t) => (written.push(t), true) }));
    expect(outcome).toBe("copied");
    expect(written).toEqual(["renamed the parser"]);
  });

  it("copies the prompt when that is the part asked for", async () => {
    const written: string[] = [];
    await copyLastTurnPart(source, "prompt", deps({ write: async (t) => (written.push(t), true) }));
    expect(written).toEqual(["what did you change?"]);
  });

  it("reads the turn for the session it was given", async () => {
    const read: HandoffSource[] = [];
    await copyLastTurnPart(source, "reply", deps({ fetchTurn: async (s) => (read.push(s), turn()) }));
    expect(read).toEqual([source]);
  });

  // A multi-line reply is the normal case, and the reason this comes from the transcript:
  // the newlines are the agent's own, not the terminal's wrap points.
  it("keeps a multi-line reply whole", async () => {
    const body = "line one\n\n- a bullet\n- another\n\nおしまい";
    const written: string[] = [];
    await copyLastTurnPart(source, "reply", deps({ fetchTurn: async () => turn({ reply: body }), write: async (t) => (written.push(t), true) }));
    expect(written).toEqual([body]);
  });

  it("reports an empty turn instead of copying nothing", async () => {
    const write = vi.fn(async () => true);
    expect(await copyLastTurnPart(source, "reply", deps({ fetchTurn: async () => turn({ reply: null }), write }))).toBe("empty");
    expect(await copyLastTurnPart(source, "reply", deps({ fetchTurn: async () => turn({ reply: "  \n " }), write }))).toBe("empty");
    expect(await copyLastTurnPart(source, "prompt", deps({ fetchTurn: async () => turn({ prompt: null }), write }))).toBe("empty");
    expect(write).not.toHaveBeenCalled();
  });

  it("reports a failed read rather than throwing at the button", async () => {
    const outcome = await copyLastTurnPart(
      source,
      "reply",
      deps({
        fetchTurn: async () => {
          throw new Error("500");
        },
      }),
    );
    expect(outcome).toBe("read-failed");
  });

  // navigator.clipboard rejects on an unfocused document / denied permission / insecure
  // origin. That must not read as a successful copy — the operator would paste stale text.
  it("reports a blocked clipboard separately from a successful copy", async () => {
    expect(await copyLastTurnPart(source, "reply", deps({ write: async () => false }))).toBe("clipboard-blocked");
  });
});

describe("copyOutcomeLabel", () => {
  it("says Copied on success, and names which part was missing", () => {
    expect(copyOutcomeLabel("copied", "reply")).toBe("Copied");
    expect(copyOutcomeLabel("empty", "reply")).toBe("No reply");
    expect(copyOutcomeLabel("empty", "prompt")).toBe("No prompt");
  });

  it("keeps every label short enough to replace an icon", () => {
    const labels = (["copied", "empty", "read-failed", "clipboard-blocked"] as const).flatMap((o) => [
      copyOutcomeLabel(o, "reply"),
      copyOutcomeLabel(o, "prompt"),
    ]);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(12);
  });
});
