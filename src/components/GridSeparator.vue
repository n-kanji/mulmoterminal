<script setup lang="ts">
// A named vertical line between two columns (operator request 2026-08-26): "from here on is
// the waiting-on-reply block". It is a 14px grid track of its own (TerminalGrid lays the
// tracks), so it never steals a pane's width. The label reads sideways along the line; the
// controls (walk left / right, rename, remove) show on hover so the line stays a line.
import { ref, watch, nextTick, useTemplateRef } from "vue";
import { MAX_SEPARATOR_LABEL } from "./gridTabs";

const props = defineProps<{ id: number; label: string | null | undefined; canLeft: boolean; canRight: boolean }>();
const emit = defineEmits<{
  (e: "move", id: number, dir: -1 | 1): void;
  (e: "rename", id: number, label: string): void;
  (e: "remove", id: number): void;
}>();

const renaming = ref(false);
const draft = ref("");
const input = useTemplateRef<HTMLInputElement>("input");
function startRename() {
  draft.value = props.label ?? "";
  renaming.value = true;
}
function commit() {
  if (!renaming.value) return;
  renaming.value = false;
  emit("rename", props.id, draft.value);
}
function cancel() {
  renaming.value = false;
}
watch(renaming, (on) => {
  if (on) void nextTick(() => input.value?.select());
});
</script>

<template>
  <div
    class="grid-separator group relative flex h-full min-h-0 w-[18px] flex-col items-center"
    :data-separator="id"
    data-testid="grid-separator"
    :title="label ? `区切り: ${label}` : '区切り（クリックで名前）'"
  >
    <!-- The line. -->
    <div class="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded bg-accent/80" aria-hidden="true"></div>
    <!-- The label, read top-down along the line. -->
    <button
      type="button"
      data-testid="grid-separator-label"
      class="relative z-[1] mt-2 max-h-[60%] cursor-text overflow-hidden rounded-sm border-0 bg-[var(--bg-deep)] px-px py-1 font-sans text-[11px] font-semibold leading-none [writing-mode:vertical-rl]"
      :class="label ? 'text-accent' : 'text-secondary opacity-70 hover:opacity-100'"
      :aria-label="label ? `Separator: ${label}` : 'Name this separator'"
      @click.stop="startRename"
    >
      {{ label || "名前" }}
    </button>
    <!-- Rename: a normal (horizontal) box floated beside the line. -->
    <div
      v-if="renaming"
      class="absolute left-4 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-panel p-1 shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      @mousedown.stop
    >
      <input
        ref="input"
        v-model="draft"
        data-testid="grid-separator-input"
        class="w-[140px] rounded border border-accent bg-[var(--bg-base)] px-1.5 py-[3px] font-sans text-[12px] text-fg outline-none"
        :maxlength="MAX_SEPARATOR_LABEL"
        placeholder="この区切りの名前"
        aria-label="Separator name"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      />
    </div>
    <!-- Controls, at the foot of the line. Always shown (operator 2026-08-26: hover-only
         on an 18px line was never found) — dim until hovered. -->
    <div
      class="absolute bottom-2 z-[1] flex flex-col items-center gap-0.5 rounded bg-[var(--bg-deep)] py-0.5 opacity-70 hover:opacity-100 focus-within:opacity-100"
    >
      <button
        type="button"
        data-testid="grid-separator-left"
        class="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-secondary hover:bg-hover hover:text-fg disabled:opacity-30"
        :disabled="!canLeft"
        title="1 列左へ"
        aria-label="Move separator one column left"
        @click.stop="emit('move', id, -1)"
      >
        <span class="material-symbols-outlined text-[14px]" aria-hidden="true">chevron_left</span>
      </button>
      <button
        type="button"
        data-testid="grid-separator-right"
        class="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-secondary hover:bg-hover hover:text-fg disabled:opacity-30"
        :disabled="!canRight"
        title="1 列右へ"
        aria-label="Move separator one column right"
        @click.stop="emit('move', id, 1)"
      >
        <span class="material-symbols-outlined text-[14px]" aria-hidden="true">chevron_right</span>
      </button>
      <button
        type="button"
        data-testid="grid-separator-remove"
        class="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-secondary hover:bg-[var(--err-hover-bg)] hover:text-err-text"
        title="この区切りを消す"
        aria-label="Remove separator"
        @click.stop="emit('remove', id)"
      >
        <span class="material-symbols-outlined text-[14px]" aria-hidden="true">close</span>
      </button>
    </div>
  </div>
</template>
