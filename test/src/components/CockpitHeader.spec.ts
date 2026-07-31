import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import CockpitHeader from "../../../src/components/CockpitHeader.vue";
import type { CellStatus } from "../../../src/components/gridTabs";
import type { PrPhase, WorkPhase } from "../../../src/components/rosterPhase";

type Props = {
  status: CellStatus;
  agent: string;
  cwd: string | null;
  home: string | null;
  headerColor: string | null;
  headerTextColor: string | null;
  workPhase?: WorkPhase | null;
  phase?: PrPhase;
  dirLength?: number;
};
const base: Props = { status: "idle", agent: "claude", cwd: "/home/me/proj", home: "/home/me", headerColor: null, headerTextColor: null };
const mountH = (over: Partial<Props> = {}, slot?: string) => mount(CockpitHeader, { props: { ...base, ...over }, slots: slot ? { default: slot } : {} });
const bar = (w: ReturnType<typeof mountH>) => w.get('[data-testid="cockpit-header"]');
const badge = (w: ReturnType<typeof mountH>) => w.get('[data-testid="cockpit-badge"]').text();

describe("CockpitHeader", () => {
  it("tints the bar with the configured header colour, and leaves it untinted when there is none", () => {
    expect(bar(mountH({ headerColor: "#123456" })).attributes("style")).toContain("--cell-header-bg: #123456");
    expect(bar(mountH({ headerColor: null })).attributes("style") ?? "").not.toContain("--cell-header-bg");
  });

  // The roster reads the SAME six words as the pane strip (common/paneState). Two names for
  // one state is how an operator ends up unsure whether they are looking at the same thing.
  it("shows the shared status word for each status", () => {
    expect(badge(mountH({ status: "working" }))).toBe("実行中");
    expect(badge(mountH({ status: "approval" }))).toBe("承認待ち");
    expect(badge(mountH({ status: "question" }))).toBe("質問");
    expect(badge(mountH({ status: "unread" }))).toBe("完了・未読");
    expect(badge(mountH({ status: "disconnected" }))).toBe("切断");
    expect(badge(mountH({ status: "shell" }))).toBe("シェル");
  });

  // `idle` has no word at all, so the badge is dropped rather than filled with a placeholder —
  // a row that says nothing is the point (see common/paneState).
  it("drops the badge entirely for an idle pane", () => {
    expect(mountH({ status: "idle" }).find('[data-testid="cockpit-badge"]').exists()).toBe(false);
  });

  it("shows the work phase word while working when it is known", () => {
    expect(badge(mountH({ status: "working", workPhase: "implementing" }))).toBe("editing");
    expect(badge(mountH({ status: "working", workPhase: "planning" }))).toBe("planning");
  });

  it("shows the PR phase pill only when there is a phase", () => {
    expect(mountH({ phase: "none" }).find('[data-testid="cockpit-phase"]').exists()).toBe(false);
    expect(mountH({ phase: "ready" }).find('[data-testid="cockpit-phase"]').exists()).toBe(true);
  });

  it("tags codex cells and not claude ones", () => {
    expect(mountH({ agent: "codex" }).text()).toContain("codex");
    expect(mountH({ agent: "claude" }).text()).not.toContain("codex");
  });

  it("renders the directory and the trailing slot", () => {
    const w = mountH({ cwd: "/home/me/proj", home: "/home/me" }, '<button data-testid="slotted">x</button>');
    expect(w.text()).toContain("proj");
    expect(w.find('[data-testid="slotted"]').exists()).toBe(true);
  });
});
