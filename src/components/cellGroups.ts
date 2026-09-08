// Parent / child panes (operator request 2026-09-08): a pane that was opened FROM another —
// the Fork button, or an agent asking POST /api/workspace/column with a `parent` — carries
// that pane's uid (Cell.parent). This turns the links into what the grid draws: every pane
// in a family wears the family's colour as a band along its top edge, and a child names its
// parent in its header. The colour is the ROOT's, so a worker's worker is still visibly part
// of the same set, and it is picked from the root's uid so it stays put across reloads.
import type { Cell } from "./gridTabs";
import { isHole } from "./gridTabs";

export interface CellGroup {
  color: string;
  /** What the child's header calls its parent, or null on the root itself. */
  parent: string | null;
}

// Six hues far enough apart to tell neighbouring families apart on a dark ground.
export const GROUP_COLORS = ["#e5a13b", "#4fb3d9", "#8fc46a", "#d97fc9", "#e0645a", "#6f8cf2"] as const;

// The pane's name, or its directory's last segment — the same fallback the header uses.
const labelOf = (c: Cell, home: string | null): string => {
  if (c.name) return c.name;
  if (!c.cwd) return "pane";
  const path = home && c.cwd.startsWith(home) ? `~${c.cwd.slice(home.length)}` : c.cwd;
  return path.split("/").filter(Boolean).pop() ?? path;
};

// The family of every linked cell, keyed by uid. Cells with no parent and no children are
// absent — they are not in a set and must not be painted as one.
export function cellGroups(cells: readonly Cell[], home: string | null): Record<number, CellGroup> {
  const byUid = new Map(cells.filter((c) => !isHole(c)).map((c) => [c.uid, c]));
  const rootOf = (c: Cell): Cell => {
    let cur = c;
    const seen = new Set<number>([c.uid]);
    while (cur.parent !== undefined) {
      const up = byUid.get(cur.parent);
      // A link to a missing cell, or a cycle from a hand-edited blob, ends the walk here.
      if (!up || seen.has(up.uid)) break;
      seen.add(up.uid);
      cur = up;
    }
    return cur;
  };
  const out: Record<number, CellGroup> = {};
  for (const c of byUid.values()) {
    const parent = c.parent !== undefined ? byUid.get(c.parent) : undefined;
    const hasChild = [...byUid.values()].some((o) => o.parent === c.uid);
    if (!parent && !hasChild) continue;
    const root = rootOf(c);
    out[c.uid] = { color: GROUP_COLORS[root.uid % GROUP_COLORS.length], parent: parent ? labelOf(parent, home) : null };
  }
  return out;
}
