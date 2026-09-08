import { describe, it, expect } from "vitest";
import { agentColumnEventOf } from "../../common/agentApi.js";

describe("agentColumnEventOf", () => {
  it("reads a directory and an optional label", () => {
    expect(agentColumnEventOf({ cwd: "/home/u/project", label: "parser" })).toEqual({ cwd: "/home/u/project", label: "parser", parent: null });
    expect(agentColumnEventOf({ cwd: "/home/u/project" })).toEqual({ cwd: "/home/u/project", label: null, parent: null });
    expect(agentColumnEventOf({ cwd: "/home/u/project", label: "" })).toEqual({ cwd: "/home/u/project", label: null, parent: null });
    expect(agentColumnEventOf({ cwd: "/home/u/project", label: 7 })).toEqual({ cwd: "/home/u/project", label: null, parent: null });
  });

  it("carries the parent pane's session id, null when absent or not a string", () => {
    expect(agentColumnEventOf({ cwd: "/p", parent: "abc" })).toEqual({ cwd: "/p", label: null, parent: "abc" });
    expect(agentColumnEventOf({ cwd: "/p" })?.parent).toBeNull();
    expect(agentColumnEventOf({ cwd: "/p", parent: 7 })?.parent).toBeNull();
  });

  it("rejects anything without a directory", () => {
    expect(agentColumnEventOf({ label: "parser" })).toBeNull();
    expect(agentColumnEventOf({ cwd: "" })).toBeNull();
    expect(agentColumnEventOf({ cwd: 7 })).toBeNull();
    expect(agentColumnEventOf(null)).toBeNull();
    expect(agentColumnEventOf(["/home/u/project"])).toBeNull();
  });
});
