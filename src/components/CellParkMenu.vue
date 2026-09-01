<script setup lang="ts">
// "Park this pane" (operator request 2026-08-26): the header button that shelves a column into
// the dock, asking first what the operator is waiting for — the note is the point, a parked
// pane with no note is a pane the operator will not remember why it is there.
//
// Same open/close mechanics as CellPageMenu: outside mousedown or Escape closes; `.stop` keeps
// the trigger from also firing the header's click-to-zoom. The box is short (one sentence),
// so it stays in place rather than teleporting like NextQueueMenu.
import { ref, watch, onUnmounted, useTemplateRef, nextTick } from "vue";
import { MAX_PARK_NOTE } from "./gridTabs";
import { imeSafeKey } from "../composables/imeSafeKey";

const emit = defineEmits<{ (e: "park", note: string): void }>();

const open = ref(false);
const note = ref("");
const wrap = useTemplateRef<HTMLElement>("wrap");
const input = useTemplateRef<HTMLTextAreaElement>("input");
function onOutside(e: MouseEvent) {
  if (wrap.value && !wrap.value.contains(e.target as Node)) open.value = false;
}
watch(open, (o) => {
  if (o) {
    document.addEventListener("mousedown", onOutside);
    void nextTick(() => input.value?.focus());
  } else document.removeEventListener("mousedown", onOutside);
});
onUnmounted(() => document.removeEventListener("mousedown", onOutside));
function park() {
  open.value = false;
  emit("park", note.value);
  note.value = "";
}
// IME-confirm Enter must not park with a stale (usually empty) note, and composition-cancel
// Esc must not close the menu — the same trap the rename inputs fell into (see imeSafeKey):
// v-model has not received the composed text at that keydown, so the operator's note was
// silently dropped and the card shelved as "（再開条件なし）" (operator report 2026-09-01).
const confirmPark = imeSafeKey(park);
const closeMenu = imeSafeKey(() => (open.value = false));
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) confirmPark(e);
}
</script>

<template>
  <span ref="wrap" class="relative inline-flex flex-none">
    <button
      type="button"
      data-testid="cell-park"
      class="cell-btn inline-flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-inherit hover:bg-hover"
      :class="{ 'bg-hover': open }"
      title="保留にする（閉じずに小さく格納・再開条件をメモ）"
      aria-label="Park this pane"
      aria-haspopup="true"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <span class="material-symbols-outlined text-[14px]" aria-hidden="true">move_to_inbox</span>
    </button>
    <div
      v-if="open"
      data-testid="cell-park-menu"
      class="absolute right-0 top-full z-20 mt-1 flex w-[260px] flex-col gap-1 rounded-md border border-border bg-panel p-2 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      @keydown.escape="closeMenu"
      @mousedown.stop
      @click.stop
    >
      <span class="text-[11px] font-medium text-secondary">何が来たら再開しますか？</span>
      <textarea
        ref="input"
        v-model="note"
        data-testid="cell-park-note"
        rows="2"
        :maxlength="MAX_PARK_NOTE"
        class="w-full resize-none rounded border border-border bg-[var(--bg-base)] p-1.5 font-sans text-[12px] text-fg outline-none focus:border-accent"
        placeholder="例: 川上さんの返信が来たら / 価格が決まったら"
        @keydown="onKeydown"
      ></textarea>
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded border-0 bg-transparent px-2 py-1 text-[11px] text-secondary hover:bg-hover hover:text-fg"
          @click="open = false"
        >
          やめる
        </button>
        <button
          type="button"
          data-testid="cell-park-confirm"
          class="cursor-pointer rounded border border-accent bg-transparent px-2 py-1 text-[11px] text-accent hover:bg-hover"
          @click="park"
        >
          保留にする
        </button>
      </div>
    </div>
  </span>
</template>
