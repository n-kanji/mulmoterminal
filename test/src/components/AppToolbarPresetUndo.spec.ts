import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import AppToolbar from "../../../src/components/AppToolbar.vue";
import { router } from "../../../src/router/index";
import type { CwdPreset } from "../../../src/components/presets";

// R10 — the removed chip's slot offers an Undo for a few seconds. The toolbar only DRAWS it:
// the pending entry, the timer and the restore all live in GridView, next to the preset writers.

const PRESETS: CwdPreset[] = [
  { label: "orosy", path: "/w/orosy" },
  { label: "mulmo", path: "/w/mulmo" },
  { label: "docs", path: "/w/docs" },
];

const mountToolbar = async (props: Record<string, unknown> = {}) => {
  await router.push("/terminals");
  await flushPromises();
  const w = mount(AppToolbar, {
    props: { presets: PRESETS, ...props },
    global: { plugins: [router], stubs: { NotificationBell: true, RemoteHostControl: true } },
  });
  await flushPromises();
  return w;
};

const orderOf = (el: { attributes(name: string): string | undefined }) => Number((el.attributes("style") ?? "").replace(/\D+/g, ""));

beforeEach(async () => {
  await router.push({ name: "chat" });
  await flushPromises();
});

describe("the preset chip's undo", () => {
  it("is absent until a chip has been removed", async () => {
    expect((await mountToolbar()).find('[data-testid="preset-undo"]').exists()).toBe(false);
  });

  it("names the chip it would bring back, and asks the grid to do it", async () => {
    const w = await mountToolbar({ presets: PRESETS.filter((p) => p.path !== "/w/mulmo"), undoChip: { label: "mulmo", index: 1 } });
    const undo = w.find('[data-testid="preset-undo"]');
    expect(undo.attributes("aria-label")).toContain("mulmo");
    await undo.trigger("click");
    expect(w.emitted("undo-remove-preset")).toHaveLength(1);
  });

  // In the slot the chip LEFT, not at the end of the row: the operator's eye is already there,
  // and a notice anywhere else would be a second thing to find.
  it("sits between the chips that closed the gap", async () => {
    // "mulmo" was at index 1; the row now holds orosy and docs. The chips are rendered by the
    // v-for in list order and placed by flex `order`, so that is what the assertion reads.
    const w = await mountToolbar({ presets: [PRESETS[0], PRESETS[2]], undoChip: { label: "mulmo", index: 1 } });
    const chips = w.findAll(".group");
    const undoOrder = orderOf(w.find('[data-testid="preset-undo"]'));
    expect(orderOf(chips[0])).toBeLessThan(undoOrder); // orosy
    expect(orderOf(chips[1])).toBeGreaterThan(undoOrder); // docs, which closed the gap
  });

  // Removing the ONLY preset empties the list; without this the row would disappear and take
  // the undo with it, which is the exact case a mis-click is most costly.
  it("keeps the chip row alive when the last preset was the one removed", async () => {
    const w = await mountToolbar({ presets: [], undoChip: { label: "orosy", index: 0 } });
    expect(w.find('[aria-label="Quick launch presets"]').exists()).toBe(true);
    expect(w.find('[data-testid="preset-undo"]').exists()).toBe(true);
  });

  it("leaves the real chips as draggable directories — the undo is not one of them", async () => {
    const w = await mountToolbar({ presets: [PRESETS[0]], undoChip: { label: "mulmo", index: 1 } });
    expect(w.findAll(".group")).toHaveLength(1);
    expect(w.find('[data-testid="preset-undo"]').attributes("draggable")).toBeUndefined();
  });
});
