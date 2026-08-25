<script setup lang="ts">
// Page-move (operator request 2026-08-25): the "send this pane to another page" popover,
// shared by the terminal, launcher and command cells — the grid moves ANY occupied column
// (canMoveCellToPage), so every kind of pane must offer the same menu or the model and the
// UI disagree about what can move. Renders nothing without targets (single-page grid).
//
// Same open/close mechanics as TerminalCell's GitHub menu: outside mousedown or Escape
// closes; `.stop` keeps the trigger from also firing the header's click-to-zoom.
import { ref, watch, onUnmounted, useTemplateRef } from "vue";
import { CELL_BTN } from "./cellChromeClasses";

const props = defineProps<{ targets?: { page: number; label: string }[] | null }>();
const emit = defineEmits<{ (e: "pick", page: number): void }>();

const open = ref(false);
const wrap = useTemplateRef<HTMLElement>("wrap");
function pick(page: number) {
  open.value = false;
  emit("pick", page);
}
function onOutside(e: MouseEvent) {
  if (wrap.value && !wrap.value.contains(e.target as Node)) open.value = false;
}
watch(open, (o) => {
  if (o) document.addEventListener("mousedown", onOutside);
  else document.removeEventListener("mousedown", onOutside);
});
// The grid can shrink to one page while the menu is open (a column elsewhere closed); the
// popover's v-if then removes it, so the state must follow or it reappears un-asked the
// next time a second page exists.
watch(
  () => props.targets?.length ?? 0,
  (n) => {
    if (n === 0) open.value = false;
  },
);
onUnmounted(() => document.removeEventListener("mousedown", onOutside));
</script>

<template>
  <span v-if="targets?.length" ref="wrap" class="relative inline-flex flex-none">
    <button
      type="button"
      data-testid="cell-move-page"
      class="cell-btn"
      :class="CELL_BTN"
      title="このペインを別のページへ移動"
      aria-label="Move this pane to another page"
      aria-haspopup="true"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <span class="material-symbols-outlined" aria-hidden="true">drive_file_move</span>
    </button>
    <div
      v-if="open"
      data-testid="cell-move-page-menu"
      class="absolute right-0 top-full z-20 mt-1 flex min-w-[132px] flex-col rounded-md border border-border bg-panel p-1 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      @keydown.escape="open = false"
    >
      <button
        v-for="t in targets"
        :key="t.page"
        type="button"
        data-testid="cell-move-page-item"
        class="cursor-pointer rounded-[4px] border-none bg-transparent px-2 py-1.5 text-left font-sans text-[12px] text-secondary hover:bg-hover hover:text-fg"
        @click.stop="pick(t.page)"
      >
        {{ t.label }}
      </button>
    </div>
  </span>
</template>
