<script setup lang="ts">
// The cell's next-instruction queue (operator request 2026-08-26): park what to say next and
// have it typed when the pane is waiting for input, instead of interrupting the running turn.
//
// The list of hand-offs comes FIRST in the popover and the badge turns accent while any is
// unread: an automatic send pushes the previous reply off the screen, and the operator's
// stated failure mode is coming back to the desk and seeing only the last reply. So the
// superseded reply is shown here, highlighted, until it is marked read.
//
// The panel is teleported to <body>, unlike CellPageMenu's in-place popover, for two reasons
// that both come from where the trigger lives: the cell root is overflow-hidden, and a
// 380px reading pane inside a ~200px column would be cut off; and the header is the column's
// drag handle (draggable="true"), inside which a drag-select to copy the buried reply — the
// panel's whole point — would move the column instead. Outside the header, both go away.
// Positioned from the trigger's rect on open; a resize or scroll closes it rather than
// chasing the anchor.
import { computed, ref, toRef, watch, onUnmounted, useTemplateRef, nextTick } from "vue";
import { unreadHandoffCount } from "../../common/nextQueue";
import { useNextQueue } from "../composables/useNextQueue";

// `floating`: the trigger sits over the terminal canvas (bottom-right of the cell, beside
// the agent's input line) rather than in a chrome row, so it carries its own backdrop and
// the panel opens UPWARD from it.
const props = defineProps<{ sessionId: string | null; floating?: boolean }>();
const { state, error, add, remove, setAuto, sendNow, markRead } = useNextQueue(toRef(props, "sessionId"));

const open = ref(false);
const draft = ref("");
const busy = ref(false);
const trigger = useTemplateRef<HTMLElement>("trigger");
const panel = useTemplateRef<HTMLElement>("panel");
const input = useTemplateRef<HTMLTextAreaElement>("input");
const panelStyle = ref<Record<string, string>>({});

const PANEL_WIDTH = 380;
const MARGIN = 8;

const queued = computed(() => state.value.items.length);
const unread = computed(() => unreadHandoffCount(state.value));
const handoffs = computed(() => [...state.value.handoffs].reverse()); // newest first
const title = computed(() => {
  const parts = [`次の指示キュー（${queued.value} 件）`];
  if (unread.value) parts.push(`未読の報告 ${unread.value} 件`);
  return parts.join(" / ");
});

function place() {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const width = Math.min(PANEL_WIDTH, window.innerWidth - MARGIN * 2);
  // Right-aligned to the trigger, pulled back inside the viewport when the column is at
  // the left edge of the screen.
  const right = Math.max(MARGIN, Math.min(window.innerWidth - rect.right, window.innerWidth - width - MARGIN));
  // Open away from the nearer screen edge: a trigger in the lower half (the floating
  // placement beside the input line) gets the panel above it.
  const above = rect.top > window.innerHeight / 2;
  const base = { position: "fixed", right: `${right}px`, width: `${width}px` };
  panelStyle.value = above
    ? { ...base, bottom: `${window.innerHeight - rect.top + 4}px`, maxHeight: `${Math.max(120, rect.top - 4 - MARGIN)}px` }
    : { ...base, top: `${rect.bottom + 4}px`, maxHeight: `${Math.max(120, window.innerHeight - rect.bottom - 4 - MARGIN)}px` };
}

function onOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (trigger.value?.contains(t) || panel.value?.contains(t)) return;
  open.value = false;
}
const closeOnMove = () => {
  open.value = false;
};
watch(open, (o) => {
  if (o) {
    place();
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("resize", closeOnMove);
    window.addEventListener("scroll", closeOnMove, true);
    void nextTick(() => input.value?.focus());
  } else {
    document.removeEventListener("mousedown", onOutside);
    window.removeEventListener("resize", closeOnMove);
    window.removeEventListener("scroll", closeOnMove, true);
  }
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onOutside);
  window.removeEventListener("resize", closeOnMove);
  window.removeEventListener("scroll", closeOnMove, true);
});

async function submit() {
  const text = draft.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  if (await add(text)) draft.value = "";
  busy.value = false;
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
  }
}
async function run(fn: () => Promise<boolean>) {
  if (busy.value) return;
  busy.value = true;
  await fn();
  busy.value = false;
}

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <span class="relative inline-flex flex-none">
    <button
      ref="trigger"
      type="button"
      data-testid="cell-next-queue"
      class="cell-btn relative inline-flex flex-none cursor-pointer items-center justify-center rounded border-0 hover:bg-hover"
      :class="[
        floating
          ? 'h-9 w-9 border border-border bg-panel/90 text-secondary shadow-[0_2px_8px_rgba(0,0,0,0.35)] hover:text-fg'
          : 'h-5 w-5 bg-transparent text-inherit',
        { 'bg-hover': open },
      ]"
      :title="title"
      aria-label="Next instructions queue"
      aria-haspopup="true"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <span class="material-symbols-outlined" :class="floating ? 'text-[22px]' : 'text-[14px]'" aria-hidden="true">pending_actions</span>
      <span
        v-if="queued || unread"
        data-testid="cell-next-queue-badge"
        class="absolute -right-1 -top-1 rounded-full text-center font-mono text-white"
        :class="[
          unread ? 'bg-accent' : 'bg-[var(--text-secondary)]',
          floating ? 'min-w-[18px] px-1 text-[11px] leading-[18px]' : 'min-w-[14px] px-[3px] text-[9px] leading-[14px]',
        ]"
        >{{ unread || queued }}</span
      >
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        data-testid="cell-next-queue-menu"
        class="z-50 flex flex-col gap-2 overflow-y-auto rounded-md border border-border bg-panel p-2 text-[12px] text-fg shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
        :style="panelStyle"
        @keydown.escape="open = false"
      >
        <!-- Hand-offs: the replies an automatic send pushed off the screen. -->
        <section v-if="handoffs.length" data-testid="cell-next-queue-handoffs" class="flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <span class="font-medium" :class="unread ? 'text-accent' : 'text-secondary'">自動投入で流れた報告{{ unread ? `（未読 ${unread} 件）` : "" }}</span>
            <button
              v-if="unread"
              type="button"
              class="cursor-pointer rounded border-0 bg-transparent px-1 py-0.5 text-[11px] text-secondary hover:bg-hover hover:text-fg"
              @click="run(markRead)"
            >
              既読にする
            </button>
          </div>
          <div class="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
            <article
              v-for="h in handoffs"
              :key="h.id"
              data-testid="cell-next-queue-handoff"
              class="rounded border p-1.5"
              :class="h.read ? 'border-border opacity-60' : 'border-accent bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'"
            >
              <div class="mb-1 text-[10px] text-secondary">
                {{ timeOf(h.sentAt) }}<span v-if="h.prevPrompt"> · 依頼: {{ h.prevPrompt.slice(0, 80) }}</span>
              </div>
              <pre class="m-0 max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-snug">{{
                h.prevReply ?? "（返答を読み取れませんでした）"
              }}</pre>
              <div class="mt-1 border-t border-border pt-1 text-[11px] text-secondary">
                この報告のあとに投入: <span class="text-fg">{{ h.text }}</span>
              </div>
            </article>
          </div>
        </section>

        <!-- The queue itself. -->
        <section class="flex flex-col gap-1">
          <span class="font-medium text-secondary">次の指示（入力待ちになったら順に投入）</span>
          <ol v-if="state.items.length" data-testid="cell-next-queue-items" class="m-0 flex list-none flex-col gap-1 p-0">
            <li v-for="(item, i) in state.items" :key="item.id" class="flex items-start gap-1 rounded border border-border px-1.5 py-1">
              <span class="flex-none font-mono text-[10px] text-secondary">{{ i + 1 }}.</span>
              <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ item.text }}</span>
              <button
                type="button"
                class="inline-flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-secondary hover:bg-hover hover:text-fg"
                title="このキューを削除"
                aria-label="Remove this queued instruction"
                @click="run(() => remove(item.id))"
              >
                <span class="material-symbols-outlined text-[14px]" aria-hidden="true">close</span>
              </button>
            </li>
          </ol>
          <textarea
            ref="input"
            v-model="draft"
            data-testid="cell-next-queue-input"
            rows="3"
            class="w-full resize-y rounded border border-border bg-[var(--bg-base)] p-1.5 font-sans text-[12px] text-fg outline-none focus:border-accent"
            placeholder="次にやってほしいこと（Cmd/Ctrl+Enter で追加・複数行可）"
            @keydown="onKeydown"
          ></textarea>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-testid="cell-next-queue-add"
              class="cursor-pointer rounded border border-border bg-transparent px-2 py-1 text-[11px] hover:bg-hover disabled:opacity-50"
              :disabled="!draft.trim() || busy"
              @click="submit"
            >
              追加
            </button>
            <button
              type="button"
              data-testid="cell-next-queue-send"
              class="cursor-pointer rounded border border-border bg-transparent px-2 py-1 text-[11px] hover:bg-hover disabled:opacity-50"
              :disabled="!queued || busy"
              title="先頭の 1 件を今すぐ送る（入力待ちを待たない）"
              @click="run(sendNow)"
            >
              今すぐ送る
            </button>
            <label class="ml-auto flex cursor-pointer items-center gap-1 text-[11px] text-secondary">
              <input
                type="checkbox"
                data-testid="cell-next-queue-auto"
                :checked="state.auto"
                :disabled="busy"
                @change="run(() => setAuto(($event.target as HTMLInputElement).checked))"
              />
              入力待ちで自動投入
            </label>
          </div>
          <div v-if="error" class="text-[11px] text-err-text">{{ error }}</div>
        </section>
      </div>
    </Teleport>
  </span>
</template>
