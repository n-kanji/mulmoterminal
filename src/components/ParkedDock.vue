<script setup lang="ts">
// The parked panes (operator request 2026-08-26): columns the operator is waiting on, shelved
// as small cards so they stop costing a column's width, sessions intact. Each card leads with
// the operator's own "resume when X" note — the one line that says why the pane is still here —
// and lights up when the pane needs attention (a reply came back, a question is blocking).
// Click a card to put the pane back into the grid.
//
// The cards stand in the order the state holds them — newest park on top, and the operator can
// drag one anywhere in the list (operator request 2026-09-13). Before this the dock sorted
// itself by when each pane was parked, so "the three I am actually waiting on" could not be
// kept together at the top.
import { computed, ref } from "vue";
import { PARK_DRAG_MIME } from "./gridTabs";
import { DOCK_WIDTH_KEY, MIN_DOCK, MAX_DOCK, readDockWidth, clampDockWidth, dockKeyWidth } from "./columnWidth";
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
  (e: "reorder", uid: number, targetUid: number): void;
}>();

// The state's own order (parkCell puts a fresh one on top); dragging rewrites it.
const cards = computed(() => props.items);

// Drag to reorder. Gated on PARK_DRAG_MIME at every step so a file dragged over the dock — or
// a column dragged off the grid — falls through instead of shuffling the cards. `dropUid` is
// the card the pointer is over, drawn as the landing line.
const dragUid = ref<number | null>(null);
const dropUid = ref<number | null>(null);
function onDragStart(e: DragEvent, uid: number) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(PARK_DRAG_MIME, String(uid));
  e.dataTransfer.effectAllowed = "move";
  dragUid.value = uid;
}
function onDragOver(e: DragEvent, uid: number) {
  if (!e.dataTransfer?.types.includes(PARK_DRAG_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  dropUid.value = uid;
}
function onDrop(e: DragEvent, uid: number) {
  const raw = e.dataTransfer?.getData(PARK_DRAG_MIME);
  endDrag();
  if (!raw) return;
  e.preventDefault();
  const src = Number(raw);
  if (!Number.isFinite(src) || src === uid) return;
  emit("reorder", src, uid);
}
function endDrag() {
  dragUid.value = null;
  dropUid.value = null;
}
// The keyboard has to be able to do it too — the cards are focusable buttons, and a dock ten
// cards deep is exactly where a pointer-only reorder strands someone. Alt+Up/Down, which no
// browser claims inside a list.
function onCardKey(e: KeyboardEvent, uid: number) {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const i = cards.value.findIndex((c) => c.uid === uid);
  const target = cards.value[i + (e.key === "ArrowUp" ? -1 : 1)];
  if (!target) return;
  e.preventDefault();
  emit("reorder", uid, target.uid);
  // The moved card keeps the focus: the element is reused by key, so re-focusing after the
  // list re-renders would fight Vue. Nothing to do — noted so it is not "fixed" later.
}
const attention = (s: PaneState) => s === "approval" || s === "question" || s === "unread";
const since = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 60) return `${m} 分前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 時間前`;
  return `${Math.round(m / (60 * 24))} 日前`;
};
// The dock's width (operator request 2026-09-08): dragged on its right edge, kept per browser.
// 232px was the guess; next to ten narrow columns the operator wanted it smaller.
const width = ref(readDockWidth(localStorage.getItem(DOCK_WIDTH_KEY)));
const persistWidth = () => localStorage.setItem(DOCK_WIDTH_KEY, String(width.value));
let stopDrag: (() => void) | null = null;
function startDrag(e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  stopDrag?.();
  const startX = e.clientX;
  const startW = width.value;
  const onMove = (ev: MouseEvent) => (width.value = clampDockWidth(startW + (ev.clientX - startX)));
  const onUp = () => {
    persistWidth();
    stopDrag?.();
  };
  stopDrag = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    stopDrag = null;
  };
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function onSplitterKey(e: KeyboardEvent) {
  const next = dockKeyWidth(e.key, width.value);
  if (next === null) return;
  e.preventDefault();
  width.value = next;
  persistWidth();
}
function editNote(uid: number, current: string) {
  const next = window.prompt("何が来たら再開しますか？", current);
  if (next !== null) emit("note", uid, next);
}
</script>

<template>
  <aside
    v-if="cards.length"
    data-testid="parked-dock"
    class="relative flex min-w-0 flex-none border-r border-border bg-deep"
    :style="{ width: `${width}px` }"
    aria-label="Parked panes"
  >
    <!-- The scroll box is inside the aside so the splitter can pin to the aside's full height. -->
    <div class="flex min-w-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
      <div
        data-testid="parked-dock-splitter"
        class="absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize the parked dock"
        :aria-valuenow="width"
        :aria-valuemin="MIN_DOCK"
        :aria-valuemax="MAX_DOCK"
        title="ドラッグで保留欄の幅を変更"
        @mousedown="startDrag"
        @keydown="onSplitterKey"
      />
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
        draggable="true"
        class="flex cursor-pointer flex-col gap-1 rounded-lg border border-l-[3px] bg-panel px-2 py-1.5 text-left text-fg hover:brightness-[1.15] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        :class="[
          attention(c.status) ? 'border-accent border-l-accent' : 'border-border border-l-transparent',
          dragUid === c.uid ? 'opacity-40' : '',
          dropUid === c.uid && dragUid !== c.uid ? 'outline outline-2 outline-accent' : '',
        ]"
        :title="`クリックでグリッドに戻す · ドラッグで並べ替え（Alt+↑↓） · ${c.cwd ?? ''}`"
        @click="emit('restore', c.uid)"
        @keydown.enter.prevent="emit('restore', c.uid)"
        @keydown="onCardKey($event, c.uid)"
        @dragstart="onDragStart($event, c.uid)"
        @dragover="onDragOver($event, c.uid)"
        @dragend="endDrag"
        @drop="onDrop($event, c.uid)"
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
    </div>
  </aside>
</template>
