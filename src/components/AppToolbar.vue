<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import { useRoute } from "vue-router";
import { router } from "../router";
import NotificationBell from "./NotificationBell.vue";
import RemoteHostControl from "./RemoteHostControl.vue";
import LauncherButton from "./LauncherButton.vue";
import { useShortcuts } from "../composables/useShortcuts";
import { viewIsGrid } from "../composables/overlayOrigin";
import { useCollectionBrowse, browseGotoIndex, browseGotoDetail } from "../composables/useCollectionBrowse";
import { useAccountingView, accountingViewOpen } from "../composables/useAccountingView";
import { useWikiBrowse, wikiGotoIndex, wikiGotoTag } from "../composables/useWikiBrowse";
import { usePrsView, prsGotoIndex } from "../composables/usePrsView";
import { useSoundEnabled } from "../composables/useSoundEnabled";
import { useUpdateStatus } from "../composables/useUpdateStatus";
import { useDropdownMenu } from "../composables/useDropdownMenu";
import { parseTagQuery } from "./wikiTagFilter";
import type { Shortcut } from "../../common/shortcuts";
import type { StatusCounts } from "./gridTabs";
import { gridStatusSummary } from "./gridTabs";
import type { CwdPreset } from "./presets";

// The standard header, shared by the single (App.vue) and grid (GridView.vue) views so
// both show one identical toolbar. Every launcher button now just pushes a route — the
// surface (single shell vs grid, which overlay) is derived from the URL — so navigating
// to a single-view surface (collections / accounting) inherently leaves the grid. The
// active states re-derive from route.name (via the route-backed browse/accounting
// stores). Grid-only state (`addTerminalActive`, `autoSort`) is still passed in, and
// the grid-only actions (add-terminal / toggle-sort) and settings stay emits.
const props = defineProps<{
  addTerminalActive?: boolean;
  autoSort?: boolean;
  statusCounts?: StatusCounts;
  // Grid zoom state, so the header can host the roster / strip toggle (shown only while zoomed).
  showViewToggle?: boolean;
  listMode?: boolean;
  // Fork-local (iTerm2 mode): the preset chips live IN the toolbar — one merged 32px row
  // instead of toolbar + strip. GridView passes the data and owns every handler.
  presets?: CwdPreset[];
  // blocked ("needs you") cell count per directory path, across ALL pages — so an
  // off-screen pane waiting for approval still shows up as an amber badge on its chip.
  presetAlerts?: Record<string, number>;
  // Fork-local (iTerm2 mode, R10): a chip was just removed and can still be taken back. The
  // strip shows an Undo in the SLOT IT LEFT — the grid owns the entry and the timer; this is
  // only what to draw and where.
  undoChip?: { label: string; index: number } | null;
}>();
const emit = defineEmits<{
  (e: "add-terminal" | "toggle-sort" | "toggle-view" | "settings" | "pick-launch" | "undo-remove-preset"): void;
  (e: "quick-launch" | "remove-preset", path: string): void;
  (e: "reorder-preset", fromPath: string, toPath: string): void;
}>();

// The undo takes the removed chip's SLOT without being spliced into the preset list: it is
// placed by flex `order` instead, so nothing downstream (the drag reorder, the alert badges,
// the v-for keys) can mistake a placeholder for a directory. Chips take the even orders and
// the undo the odd one just before the chip that closed the gap; the trailing "+" is pinned
// past every possible chip.
const chipOrder = (index: number): number => index * 2;
const UNDO_ORDER_OFFSET = -1;
const ADD_BUTTON_ORDER = 9999;
// The row still has to exist when the LAST chip was the one removed — otherwise removing the
// only preset would take the undo away with it.
const showChipRow = computed(() => !!props.presets?.length || !!props.undoChip);

// Fork-local (iTerm2 mode): chip drag & drop reorder, same custom-MIME gating as the
// grid's cell drag (see gridTabs.CELL_DRAG_MIME rationale).
const PRESET_DRAG_MIME = "text/x-mulmo-preset-path";
function onPresetDragStart(e: DragEvent, path: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(PRESET_DRAG_MIME, path);
  e.dataTransfer.effectAllowed = "move";
}
function onPresetDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes(PRESET_DRAG_MIME)) e.preventDefault();
}
function onPresetDrop(e: DragEvent, targetPath: string) {
  const src = e.dataTransfer?.getData(PRESET_DRAG_MIME);
  if (!src || src === targetPath) return;
  e.preventDefault();
  emit("reorder-preset", src, targetPath);
}

const route = useRoute();
// Grid-wide, at-a-glance tally: how many cells are blocked (need input) / done
// (review) / working, across every page. Shown only when something is running.
const summary = computed(() => gridStatusSummary(props.statusCounts));
const summaryTitle = computed(() => summary.value.title);
const hasSummary = computed(() => summary.value.show);
// One "stuck on me" number, not two dots: approval and question are different asks of the
// operator but the same answer to "should I go look" — the pane's own strip names which.
const blockedCount = computed(() => (props.statusCounts?.approval ?? 0) + (props.statusCounts?.question ?? 0));
const { shortcuts } = useShortcuts();
const { view: browseView } = useCollectionBrowse();
const { isOpen: accountingOpen } = useAccountingView();
const { isOpen: wikiOpen } = useWikiBrowse();
const { isOpen: prsOpen } = usePrsView();
const { enabled: soundEnabled, toggle: toggleSound } = useSoundEnabled();
const { badge: updateBadge } = useUpdateStatus();

// Clicking the badge opens a popover that spells out what to run — a silent clipboard copy
// gave no hint of what happened or which command it even was.
const updateRoot = useTemplateRef<HTMLElement>("updateRoot");
const { open: updateOpen, toggle: toggleUpdate } = useDropdownMenu(updateRoot);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

// Copy the command shown in the popover; a brief "Copied" confirms it. Clipboard can be
// unavailable (older browser, insecure context) — then it's a no-op and the command stays on
// screen to copy by hand.
async function copyUpdateCommand(): Promise<void> {
  const command = updateBadge.value?.command;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    // best-effort — the command is on screen to copy by hand
  }
}

// TWO different questions, and answering both with one flag is what broke #892.
//   - which buttons the header OFFERS: the view underneath, so an overlay opened from the
//     grid keeps the grid's buttons instead of hiding the one just clicked
//   - which button is HIGHLIGHTED, and whether the grid is the screen: the route itself,
//     because an open overlay is not the grid even when the grid is underneath
// Fork-local (iTerm2 mode): the operator supervises many agents in the grid and
// never uses the single view, the worklog, or the phone companion — those buttons
// are hidden (not removed, so upstream rebases stay small and this can be flipped).
const IT2_MODE = true;
const inGrid = viewIsGrid;
const onGridRoute = computed(() => route.name === "terminals");
const inSingle = computed(() => !onGridRoute.value);
const chatActive = computed(() => inSingle.value && browseView.value.mode === "closed" && !accountingOpen.value && !wikiOpen.value && !prsOpen.value);
const collectionsActive = computed(() => browseView.value.mode === "index" && browseView.value.kind === "collection");
const accountingActive = computed(() => accountingOpen.value);
const wikiActive = computed(() => wikiOpen.value);
const prsActive = computed(() => prsOpen.value);
function favActive(s: Shortcut): boolean {
  return browseView.value.mode === "detail" && browseView.value.kind === s.kind && browseView.value.slug === s.slug;
}

function showChat(): void {
  router.push({ name: "chat" });
}
function showGrid(): void {
  router.push("/terminals");
}
function showCollections(): void {
  browseGotoIndex("collection");
}
function showFavorite(s: Shortcut): void {
  browseGotoDetail(s.kind, s.slug);
}
function showAccounting(): void {
  accountingViewOpen();
}
function showWiki(): void {
  wikiGotoIndex();
}
// Grid-only shortcut to the dev worklog: the wiki filtered to the #worklog tag (the weekly
// dev-log pages the scheduled worklog task writes).
const WORKLOG_TAG = "worklog";
const worklogActive = computed(() => wikiOpen.value && parseTagQuery(route.query.tag).has(WORKLOG_TAG));
function showWorklog(): void {
  wikiGotoTag(WORKLOG_TAG);
}
function showPrs(): void {
  prsGotoIndex();
}
</script>

<template>
  <!-- h-7 (R14): every chrome row is paid for out of the panes' reading area. -->
  <header class="flex h-7 flex-none items-center gap-2 border-b border-border bg-panel px-2">
    <!-- Fork-local (iTerm2 mode): mark only — the app-mode window makes the name obvious,
         and the freed width goes to the preset chips (the row's real protagonist). -->
    <span class="flex-none font-sans text-[12px] font-semibold tracking-[0.02em] text-muted" title="MulmoTerminal">MT</span>
    <!-- Fork-local (iTerm2 mode): the preset chips, merged from the old second row.
         The ONLY flex-1 in the header — chips get every spare pixel. -->
    <div v-if="inGrid && showChipRow" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" aria-label="Quick launch presets">
      <!-- The undo stands in the removed chip's own slot (flex order, see chipOrder): the eye
           is already there, and a notice anywhere else would be a second thing to find. It
           disappears on its own after a few seconds. -->
      <button
        v-if="undoChip"
        type="button"
        data-testid="preset-undo"
        class="inline-flex h-[22px] flex-none cursor-pointer items-center gap-1 rounded-full border border-accent bg-base px-2 font-mono text-[11px] leading-none text-accent hover:bg-hover"
        :style="{ order: chipOrder(undoChip.index) + UNDO_ORDER_OFFSET }"
        :title="`${undoChip.label} をプリセットに戻す`"
        :aria-label="`Undo removing ${undoChip.label}`"
        @click="emit('undo-remove-preset')"
      >
        <span class="material-symbols-outlined text-[13px]" aria-hidden="true">undo</span>Undo
      </button>
      <span
        v-for="(p, i) in presets"
        :key="p.path"
        draggable="true"
        class="group relative inline-flex h-[22px] flex-none cursor-grab items-center rounded-full border border-border bg-base leading-none text-muted hover:bg-hover hover:text-fg"
        :style="{ order: chipOrder(i) }"
        @dragstart="onPresetDragStart($event, p.path)"
        @dragover="onPresetDragOver"
        @drop="onPresetDrop($event, p.path)"
      >
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent py-[3px] pl-2 pr-[20px] font-mono text-[11px] leading-none text-inherit"
          :title="`Open a new column in ${p.path} — drag to reorder`"
          :aria-label="`Quick launch ${p.label}`"
          @click="emit('quick-launch', p.path)"
        >
          <span class="material-symbols-outlined text-[13px]" aria-hidden="true">play_arrow</span>{{ p.label }}
          <!-- Off-screen "needs you": a pane of this directory is blocked on ANY page.
               Answers the recorded pain "15+ panes — which one is waiting on me". -->
          <span
            v-if="presetAlerts?.[p.path]"
            class="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--amber,#f59e0b)] px-1 font-mono text-[9px] leading-none text-black"
            :title="`${presetAlerts[p.path]} pane(s) need you here`"
            >{{ presetAlerts[p.path] }}</span
          >
        </button>
        <!-- Remove: space reserved always (pr-[20px] above) so revealing it never shifts
             the label; revealed only after a 250ms hover-intent delay so sweeping the
             mouse across ten chips doesn't light ten x's. -->
        <button
          type="button"
          class="absolute right-[3px] top-1/2 grid h-4 w-4 -translate-y-1/2 cursor-pointer place-items-center rounded border-0 bg-transparent text-muted opacity-0 transition-opacity delay-0 hover:bg-hover hover:text-[var(--err,#e5484d)] group-hover:opacity-100 group-hover:delay-[250ms]"
          :title="`Remove ${p.label} from the presets`"
          :aria-label="`Remove preset ${p.label}`"
          @click.stop="emit('remove-preset', p.path)"
        >
          <span class="material-symbols-outlined text-[11px]" aria-hidden="true">close</span>
        </button>
      </span>
      <button
        type="button"
        class="inline-flex h-[22px] flex-none cursor-pointer items-center rounded-full border border-border bg-base px-1.5 text-muted hover:bg-hover hover:text-fg"
        :style="{ order: ADD_BUTTON_ORDER }"
        title="Pick a folder and open a new column there"
        aria-label="Pick a folder and open a new column there"
        @click="emit('pick-launch')"
      >
        <span class="material-symbols-outlined text-[13px]" aria-hidden="true">add</span>
      </button>
    </div>
    <nav class="flex min-w-0 items-center gap-[3px] overflow-x-auto" aria-label="Views">
      <!-- Both views: the pair that switches between them. -->
      <LauncherButton v-if="!IT2_MODE" icon="chat" title="Chat" label="Chat" :active="chatActive" @click="showChat" />
      <LauncherButton
        v-if="!IT2_MODE || !inGrid"
        icon="grid_view"
        title="Grid (multiple terminals)"
        label="Grid view"
        :active="onGridRoute"
        @click="showGrid"
      />
      <!-- Single view only (#886): the content surfaces. The grid is for supervising agents,
           and every one of these replaces the whole screen anyway. -->
      <LauncherButton v-if="!inGrid" icon="apps" title="Collections" label="Collections" :active="collectionsActive" @click="showCollections" />
      <LauncherButton v-if="!inGrid" icon="account_balance" title="Accounting" label="Accounting" :active="accountingActive" @click="showAccounting" />
      <LauncherButton v-if="!inGrid" icon="menu_book" title="Wiki" label="Wiki" :active="wikiActive" @click="showWiki" />
      <!-- `template` wrapper rather than v-if on the v-for: the two directives on one element
           is a Vue anti-pattern (v-if wins and is evaluated per item). -->
      <template v-if="!inGrid">
        <LauncherButton
          v-for="s in shortcuts"
          :key="`${s.kind}:${s.slug}`"
          :icon="s.icon || 'bookmark'"
          :title="s.title"
          :label="s.title"
          :active="favActive(s)"
          @click="showFavorite(s)"
        />
      </template>
      <!-- Grid only (#886): branches under supervision are a grid concern. -->
      <LauncherButton v-if="inGrid" icon="call_merge" title="Pull requests" label="Pull requests" :active="prsActive" @click="showPrs" />
      <LauncherButton
        v-if="inGrid && !IT2_MODE"
        icon="history_edu"
        title="Worklog — the dev work log in the wiki (#worklog)"
        label="Worklog"
        :active="worklogActive"
        @click="showWorklog"
      />
      <LauncherButton
        v-if="inGrid"
        icon="add"
        :title="addTerminalActive ? 'Cancel adding a terminal' : 'New terminal (overflows to a new tab when full)'"
        label="New terminal"
        :active="addTerminalActive"
        @click="emit('add-terminal')"
      />
      <LauncherButton
        v-if="inGrid"
        :icon="autoSort ? 'sort' : 'swap_horiz'"
        :title="
          autoSort
            ? 'Auto order: attention-first — needs-attention cells float up (click for manual arrow ordering)'
            : 'Manual order: reorder cells with the arrow buttons (click for auto attention-sort)'
        "
        label="Toggle grid cell ordering"
        :active="autoSort"
        :aria-pressed="autoSort"
        @click="emit('toggle-sort')"
      />
      <span
        v-if="inGrid && hasSummary && statusCounts"
        class="ml-1.5 inline-flex flex-none items-center gap-2 border-l border-border pl-2.5"
        role="img"
        :aria-label="`Grid status — ${summaryTitle}`"
        :title="summaryTitle"
      >
        <!-- Blocked = approval + question. The toolbar answers "how many are stuck on me",
             one number; WHICH kind is a per-pane question and the pane's own strip says it. -->
        <span v-if="blockedCount" class="inline-flex items-center gap-1 font-mono text-[12px] leading-none text-amber" aria-hidden="true">
          <span class="h-2 w-2 rounded-full bg-current" />{{ blockedCount }}
        </span>
        <span v-if="statusCounts.disconnected" class="inline-flex items-center gap-1 font-mono text-[12px] leading-none text-err" aria-hidden="true">
          <span class="h-2 w-2 rounded-full bg-current" />{{ statusCounts.disconnected }}
        </span>
        <span v-if="statusCounts.unread" class="inline-flex items-center gap-1 font-mono text-[12px] leading-none text-accent" aria-hidden="true">
          <span class="h-2 w-2 rounded-full bg-current" />{{ statusCounts.unread }}
        </span>
        <span v-if="statusCounts.working" class="inline-flex items-center gap-1 font-mono text-[12px] leading-none text-muted" aria-hidden="true">
          <span class="h-2 w-2 rounded-full bg-current" />{{ statusCounts.working }}
        </span>
      </span>
    </nav>
    <NotificationBell class="ml-auto" />
    <RemoteHostControl v-if="!IT2_MODE" />
    <div v-if="updateBadge" ref="updateRoot" class="relative mr-1 flex-none">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-accent px-2 py-0.5 text-[12px] leading-none text-accent hover:bg-selected"
        :class="{ 'bg-selected': updateOpen }"
        :title="updateBadge.text"
        :aria-label="updateBadge.text"
        :aria-expanded="updateOpen"
        aria-haspopup="true"
        @click="toggleUpdate"
      >
        <span class="material-symbols-outlined text-[15px] leading-none" aria-hidden="true">upgrade</span>
        Update
      </button>
      <div
        v-if="updateOpen"
        class="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-panel p-3 text-[13px] text-fg shadow-lg"
        role="group"
        aria-label="Update available"
      >
        <p class="mb-2 font-semibold">A newer version is available</p>
        <template v-if="updateBadge.command">
          <p class="mb-1 text-muted">Run this to update:</p>
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 overflow-x-auto rounded bg-selected px-2 py-1 font-mono text-[12px] whitespace-nowrap">{{ updateBadge.command }}</code>
            <button type="button" class="flex-none rounded border border-border px-2 py-1 text-[12px] hover:bg-selected" @click="copyUpdateCommand">
              {{ copied ? "Copied" : "Copy" }}
            </button>
          </div>
        </template>
        <p v-else class="text-muted">{{ updateBadge.text }}</p>
      </div>
    </div>
    <LauncherButton
      :icon="soundEnabled ? 'notifications_active' : 'notifications_off'"
      :title="soundEnabled ? 'Attention sound on' : 'Attention sound off'"
      :label="soundEnabled ? 'Attention sound on' : 'Attention sound off'"
      :active="soundEnabled"
      :aria-pressed="soundEnabled"
      @click="toggleSound"
    />
    <!-- Zoomed-grid only: switch the expanded terminal's side panel between the cockpit roster and
         the thumbnail strip. Sits at the right end (next to Settings) and hides when nothing is expanded. -->
    <LauncherButton
      v-if="showViewToggle"
      :icon="listMode ? 'view_carousel' : 'view_agenda'"
      :title="listMode ? 'Show thumbnail strip' : 'Show list roster'"
      :label="listMode ? 'Show thumbnail strip' : 'Show list roster'"
      @click="emit('toggle-view')"
    />
    <LauncherButton icon="settings" title="Settings" label="Settings" @click="emit('settings')" />
  </header>
</template>
