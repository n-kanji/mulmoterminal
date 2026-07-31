import { describe, it, expect } from "vitest";
import { agentColumnEventOf } from "../../common/agentApi.js";

describe("agentColumnEventOf", () => {
  it("reads a directory and an optional label", () => {
    expect(agentColumnEventOf({ cwd: "/home/u/project", label: "parser" })).toEqual({ cwd: "/home/u/project", label: "parser" });
    expect(agentColumnEventOf({ cwd: "/home/u/project" })).toEqual({ cwd: "/home/u/project", label: null });
    expect(agentColumnEventOf({ cwd: "/home/u/project", label: "" })).toEqual({ cwd: "/home/u/project", label: null });
    expect(agentColumnEventOf({ cwd: "/home/u/project", label: 7 })).toEqual({ cwd: "/home/u/project", label: null });
  });

  it("rejects anything without a directory", () => {
    expect(agentColumnEventOf({ label: "parser" })).toBeNull();
    expect(agentColumnEventOf({ cwd: "" })).toBeNull();
    expect(agentColumnEventOf({ cwd: 7 })).toBeNull();
    expect(agentColumnEventOf(null)).toBeNull();
    expect(agentColumnEventOf(["/home/u/project"])).toBeNull();
  });
});
