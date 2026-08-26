<script setup lang="ts">
// The parked panes (operator request 2026-08-26): columns the operator is waiting on, shelved
// as small cards so they stop costing a column's width, sessions intact. Each card leads with
// the operator's own "resume when X" note — the one line that says why the pane is still here —
// and lights up when the pane needs attention (a reply came back, a question is blocking).
// Click a card to put the pane back into the grid.
import { computed } from "vue";
import DirBadge from "./DirBadge.vue";
import { paneStateWord, type PaneState } from "../../common/paneState";

// The directory's last segment, the way the cell header names it when the pane has no name.
const dirLabel = (cwd: string | null, home: string | null): string | null => {
  if (!cwd) return null;
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return path.split("/").filter(Boolean).pop() ?? path;
};

export interface ParkedCard {
  uid: number;
  cwd: string | null;
  name: string | null;
  note: string;
  at: number;
  status: PaneState;
  headerColor: string | null;
}

const props = defineProps<{ items: ParkedCard[]; home: string | null }>();
const emit = defineEmits<{
  (e: "restore" | "close", uid: number): void;
  (e: "note", uid: number, note: string): void;
}>();

// Newest parked first: the thing shelved a minute ago is the one most likely to come back.
const cards = computed(() => [...props.items].sort((a, b) => b.at - a.at));
const attention = (s: PaneState) => s === "approval" || s === "question" || s === "unread";
const since = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 60) return `${m} 分前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 時間前`;
  return `${Math.round(m / (60 * 24))} 日前`;
};
function editNote(uid: number, current: string) {
  const next = window.prompt("何が来たら再開しますか？", current);
  if (next !== null) emit("note", uid, next);
}
</script>

<template>
  <aside
    v-if="cards.length"
    data-testid="parked-dock"
    class="flex w-[232px] min-w-0 flex-none flex-col gap-1.5 overflow-y-auto border-l border-border bg-deep p-1.5"
    aria-label="Parked panes"
  >
    <div class="flex items-center justify-between px-1 text-[11px] font-semibold text-secondary">
      <span>保留中（{{ cards.length }}）</span>
      <span class="material-symbols-outlined text-[14px]" aria-hidden="true">inventory_2</span>
    </div>
    <article
      v-for="c in cards"
      :key="c.uid"
      data-testid="parked-card"
      role="button"
      tabindex="0"
      class="flex cursor-pointer flex-col gap-1 rounded-lg border border-l-[3px] bg-panel px-2 py-1.5 text-left text-fg hover:brightness-[1.15] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      :class="attention(c.status) ? 'border-accent border-l-accent' : 'border-border border-l-transparent'"
      :title="`クリックでグリッドに戻す · ${c.cwd ?? ''}`"
      @click="emit('restore', c.uid)"
      @keydown.enter.prevent="emit('restore', c.uid)"
    >
      <div class="flex min-w-0 items-center gap-1">
        <DirBadge :name="c.name ?? dirLabel(c.cwd, home)" :color="c.headerColor" />
        <span
          v-if="paneStateWord(c.status)"
          class="ml-auto flex-none text-[10px] font-semibold"
          :class="attention(c.status) ? 'text-accent' : 'text-secondary'"
          >{{ paneStateWord(c.status) }}</span
        >
      </div>
      <p data-testid="parked-note" class="m-0 whitespace-pre-wrap break-words text-[12px] leading-snug" :class="c.note ? '' : 'italic text-secondary'">
        {{ c.note || "（再開条件なし）" }}
      </p>
      <div class="flex items-center gap-1 text-[10px] text-secondary">
        <span>{{ since(c.at) }}</span>
        <button
          type="button"
          class="ml-auto cursor-pointer rounded border-0 bg-transparent px-1 py-0.5 hover:bg-hover hover:text-fg"
          title="再開条件を書き直す"
          aria-label="Edit the resume note"
          @click.stop="editNote(c.uid, c.note)"
        >
          <span class="material-symbols-outlined text-[13px]" aria-hidden="true">edit</span>
        </button>
        <button
          type="button"
          data-testid="parked-close"
          class="cursor-pointer rounded border-0 bg-transparent px-1 py-0.5 hover:bg-[var(--err-hover-bg)] hover:text-err-text"
          title="このセッションを終了して捨てる"
          aria-label="Close this parked session"
          @click.stop="emit('close', c.uid)"
        >
          <span class="material-symbols-outlined text-[13px]" aria-hidden="true">close</span>
        </button>
      </div>
    </article>
  </aside>
</template>
