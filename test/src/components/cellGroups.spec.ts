import { describe, it, expect } from "vitest";
import { cellGroups, GROUP_COLORS } from "../../../src/components/cellGroups";
import type { Cell } from "../../../src/components/gridTabs";

const cell = (uid: number, over: Partial<Cell> = {}): Cell => ({ uid, session: null, cwd: "/home/u/proj", ...over });

describe("cellGroups (parent / child panes)", () => {
  it("paints parent and children in the root's colour and names the parent on the child", () => {
    const cells = [cell(0, { name: "layer1" }), cell(1, { parent: 0 }), cell(2, { parent: 1, name: "grandchild" }), cell(3)];
    const g = cellGroups(cells, "/home/u");
    expect(g[0]).toEqual({ color: GROUP_COLORS[0], parent: null });
    expect(g[1]).toEqual({ color: GROUP_COLORS[0], parent: "layer1" });
    // A worker's worker is still the same family (root colour), named after its own parent.
    expect(g[2]).toEqual({ color: GROUP_COLORS[0], parent: "proj" });
    // A lone pane is not in a set at all.
    expect(g[3]).toBeUndefined();
  });
  it("uses the directory's last segment when the parent has no name", () => {
    const g = cellGroups([cell(0, { cwd: "/home/u/orosy-v2" }), cell(1, { parent: 0 })], "/home/u");
    expect(g[1]?.parent).toBe("orosy-v2");
  });
  it("ignores a link to a missing cell and survives a cycle", () => {
    expect(cellGroups([cell(0), cell(1, { parent: 9 })], null)).toEqual({});
    const g = cellGroups([cell(0, { parent: 1 }), cell(1, { parent: 0 })], null);
    expect(g[0]?.color).toBeDefined();
    expect(g[1]?.color).toBeDefined();
  });
  it("keys the colour off the root's uid so two families differ", () => {
    const g = cellGroups([cell(0), cell(1, { parent: 0 }), cell(2), cell(3, { parent: 2 })], null);
    expect(g[1]?.color).toBe(GROUP_COLORS[0]);
    expect(g[3]?.color).toBe(GROUP_COLORS[2]);
  });
});
