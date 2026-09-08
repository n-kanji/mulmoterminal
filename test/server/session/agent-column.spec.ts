import { describe, it, expect } from "vitest";
import { decideAgentColumn, NO_GRID_ERROR, type AgentColumnInput } from "../../../server/session/agent-column.js";

const PROJECT = "/home/u/project";

const input = (over: Partial<AgentColumnInput> = {}): AgentColumnInput => ({
  body: { cwd: PROJECT },
  resolveDir: (cwd) => (cwd === PROJECT ? cwd : null),
  listenerCount: 1,
  ...over,
});

describe("decideAgentColumn", () => {
  it("accepts a directory the host can resolve", () => {
    expect(decideAgentColumn(input())).toEqual({ ok: true, request: { cwd: PROJECT, prompt: null, label: null, parent: null } });
  });

  it("trims the prompt and the label", () => {
    const decision = decideAgentColumn(input({ body: { cwd: PROJECT, prompt: " do the thing ", label: " parser " } }));

    expect(decision).toEqual({ ok: true, request: { cwd: PROJECT, prompt: "do the thing", label: "parser", parent: null } });
  });

  it("requires a cwd", () => {
    expect(decideAgentColumn(input({ body: {} }))).toMatchObject({ ok: false, status: 400 });
    expect(decideAgentColumn(input({ body: null }))).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a path that is not an existing directory instead of falling back", () => {
    const decision = decideAgentColumn(input({ body: { cwd: "/home/u/gone" } }));

    expect(decision).toEqual({ ok: false, status: 400, error: expect.stringContaining("/home/u/gone") });
  });

  it("refuses a non-string prompt and an over-long one", () => {
    expect(decideAgentColumn(input({ body: { cwd: PROJECT, prompt: 42 } }))).toMatchObject({ ok: false, status: 400 });
    expect(decideAgentColumn(input({ body: { cwd: PROJECT, prompt: "x".repeat(100_001) } }))).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses with 409 when no browser is listening", () => {
    expect(decideAgentColumn(input({ listenerCount: 0 }))).toEqual({ ok: false, status: 409, error: NO_GRID_ERROR });
  });

  it("reports the malformed request before the missing browser", () => {
    // Told what is wrong with the request it sent, not about a browser it cannot open.
    expect(decideAgentColumn(input({ body: {}, listenerCount: 0 }))).toMatchObject({ ok: false, status: 400 });
  });
});

describe("decideAgentColumn: parent (the pane that asked)", () => {
  const PROJECT = "/home/u/project";
  const input = (body: Record<string, unknown>) => ({ body: { cwd: PROJECT, ...body }, resolveDir: () => PROJECT, listenerCount: 1 });
  const parentOf = (body: Record<string, unknown>) => {
    const d = decideAgentColumn(input(body));
    return d.ok ? d.request.parent : d;
  };
  it("takes the session id as-is, or strips the tmux `mt-` prefix a pane prints for itself", () => {
    expect(parentOf({ parent: "3fcc05dd-bd51-4514-a147-0b506e761af0" })).toBe("3fcc05dd-bd51-4514-a147-0b506e761af0");
    expect(parentOf({ parent: " mt-3fcc05dd-bd51-4514-a147-0b506e761af0 " })).toBe("3fcc05dd-bd51-4514-a147-0b506e761af0");
    expect(parentOf({ parent: "mt-" })).toBeNull();
    expect(parentOf({})).toBeNull();
    expect(parentOf({ parent: "" })).toBeNull();
  });
  it("refuses a non-string parent", () => {
    expect(parentOf({ parent: 7 })).toMatchObject({ ok: false, status: 400 });
  });
});
