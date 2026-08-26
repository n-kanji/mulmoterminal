<script setup lang="ts">
// The cell's next-instruction queue (operator request 2026-08-26): park what to say next and
// have it typed when the pane is waiting for input, instead of interrupting the running turn.
//
// The list of hand-offs comes FIRST in the popover and the badge turns accent while any is
// unread: an automatic send pushes the previous reply off the screen, and the operator's
// stated failure mode is coming back to the desk and seeing only the last reply. So the
// superseded reply is shown here, highlighted, until it is marked read.
//
// Same open/close mechanics as CellPageMenu: outside mousedown or Escape closes; `.stop` keeps
// the trigger from also firing the header's click-to-zoom.
import { computed, ref, toRef, watch, onUnmounted, useTemplateRef } from "vue";
import { unreadHandoffCount } from "../../common/nextQueue";
import { useNextQueue } from "../composables/useNextQueue";

const props = defineProps<{ sessionId: string | null }>();
const { state, error, add, remove, setAuto, sendNow, markRead } = useNextQueue(toRef(props, "sessionId"));

const open = ref(false);
const draft = ref("");
const busy = ref(false);
const wrap = useTemplateRef<HTMLElement>("wrap");
const input = useTemplateRef<HTMLTextAreaElement>("input");

const queued = computed(() => state.value.items.length);
const unread = computed(() => unreadHandoffCount(state.value));
const handoffs = computed(() => [...state.value.handoffs].reverse()); // newest first
const title = computed(() => {
  const parts = [`次の指示キュー（${queued.value} 件）`];
  if (unread.value) parts.push(`未読の報告 ${unread.value} 件`);
  return parts.join(" / ");
});

function onOutside(e: MouseEvent) {
  if (wrap.value && !wrap.value.contains(e.target as Node)) open.value = false;
}
watch(open, (o) => {
  if (o) {
    document.addEventListener("mousedown", onOutside);
    requestAnimationFrame(() => input.value?.focus());
  } else document.removeEventListener("mousedown", onOutside);
});
onUnmounted(() => document.removeEventListener("mousedown", onOutside));

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
  <span ref="wrap" class="relative inline-flex flex-none">
    <button
      type="button"
      data-testid="cell-next-queue"
      class="cell-btn relative inline-flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded border-0 bg-transparent text-inherit hover:bg-hover"
      :class="{ 'bg-hover': open }"
      :title="title"
      aria-label="Next instructions queue"
      aria-haspopup="true"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <span class="material-symbols-outlined text-[14px]" aria-hidden="true">pending_actions</span>
      <span
        v-if="queued || unread"
        data-testid="cell-next-queue-badge"
        class="absolute -right-1 -top-1 min-w-[14px] rounded-full px-[3px] text-center font-mono text-[9px] leading-[14px] text-white"
        :class="unread ? 'bg-accent' : 'bg-[var(--text-secondary)]'"
        >{{ unread || queued }}</span
      >
    </button>
    <div
      v-if="open"
      data-testid="cell-next-queue-menu"
      class="absolute right-0 top-full z-20 mt-1 flex w-[min(380px,85vw)] flex-col gap-2 rounded-md border border-border bg-panel p-2 text-[12px] text-fg shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      @keydown.escape="open = false"
      @mousedown.stop
      @click.stop
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
            <pre class="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-snug">{{
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
          placeholder="次にやってほしいこと（Cmd/Ctrl+Enter で追加）"
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
  </span>
</template>
