<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import DirBadge from "./DirBadge.vue";
import { useDirConfig } from "../composables/useDirConfig";
import TerminalView from "./Terminal.vue";
import CellChromeButtons from "./CellChromeButtons.vue";
import { formatCwd } from "./cwdDisplay";
import { shouldZoomOnHeaderClick } from "./cellHeaderZoom";
import { isShellLauncher, type CellLauncher, type CellStatus } from "./gridTabs";
import { paneStateWord } from "../../common/paneState";
import type { GridCellEmits, GridCellProps } from "./gridCell";
import { headerStyleFor, cellStyleFor } from "./cellHeaderStyle";
import {
  CELL_STATUS,
  CELL_STRIP,
  CELL_STRIP_DOT,
  CELL_STRIP_MAIN,
  CELL_STRIP_WORD,
  HEADER_STATUS,
  STATUS_CLASS,
  STATUS_LABEL,
  STRIP_DOT,
  STRIP_STATUS,
} from "./cellStatusStyles";
import { CELL_ACTIONS, CELL_BTN, CELL_HEADER_ZOOMABLE, CELL_TERM } from "./cellChromeClasses";

// A grid cell running a configured launch command (a plain shell, codex, any
// interactive program) instead of Claude. Unlike CommandCell this is PERSISTENT: it
// carries a session id and a durable connection (persistKey), so it survives page
// switches and reconnects — but it has no Claude hooks, so its status is only
// running (working) / exited (idle). `launcher.index` is the command's position in the
// configured launcher list (the server's allowlist); it runs in `cwd`.
const props = defineProps<
  GridCellProps & {
    uid: number;
    launcher: CellLauncher;
    session: string | null;
    cwd: string | null;
    // Manual sort mode: show move buttons to swap this cell with its neighbour.
    reorderable?: boolean;
  }
>();
const emit = defineEmits<
  GridCellEmits & {
    // The server-assigned session id, so the parent persists it for reconnect.
    (e: "session", id: string): void;
  }
>();

// Clicking the header background zooms (switches to) this cell, except the already-
// expanded one. Buttons keep their action.
function onHeaderClick(event: MouseEvent) {
  if (shouldZoomOnHeaderClick(event.target, props.expanded)) emit("toggle-expand");
}

// connectKey bump re-launches after the process exits (relaunch button).
const connectKey = ref(0);
const finished = ref(false);

// The name badge is CHROME — this cell's own header, not the terminal canvas (#914). The
// canvas side resolves itself inside Terminal.vue (#911); this is the other half of that line.
const { config: dirConfig } = useDirConfig(toRef(props, "cwd"));

const dirDisplay = computed(() => formatCwd(props.cwd, props.home));
const target = computed(() => (isShellLauncher(props.launcher) ? { shell: true as const } : { index: props.launcher.index }));

// A launcher pane has its own two states in the shared vocabulary and neither is an agent
// state: while the program runs it is a "shell" (a terminal the operator drives — it never
// asks for anyone, so the auto sort keeps it out of the way), and once the program exits the
// PTY is gone, which is the same thing to the operator as a dropped socket: "disconnected",
// with the relaunch button next to it. It is never "working" — that word now means an agent
// is mid-turn — and never "waiting".
const status = computed<CellStatus>(() => (finished.value ? "disconnected" : "shell"));
watch(status, (s) => emit("status", s), { immediate: true });

// Fork-local (iTerm2 mode, R10): the same TWO rows a Claude pane wears — row 1 identity +
// actions, row 2 the status strip. A shell pane used to carry a single 34px row with a dot
// whose two colours were a private code, so scanning thirty columns meant reading two
// different pane languages. The tables come from cellStatusStyles, so the word "シェル" is
// coloured and positioned exactly like "実行中" one column over. Net cost is ~10px per shell
// pane (34px header → 24px + 22px strip minus the row it replaces), and what it buys is one
// vocabulary across the whole grid.
const headerStyle = computed(() => headerStyleFor(dirConfig.value.headerColor, dirConfig.value.headerTextColor));
const cellStyle = computed(() =>
  cellStyleFor(dirConfig.value.cellColor, dirConfig.value.cellBorderColor, dirConfig.value.dotColor, dirConfig.value.buttonColor),
);
// The directory's colour as a full-height left stripe, like the Claude cell's — the two kinds
// of pane must read as the same project from the corner of the eye.
const stripeStyle = computed(() => (dirConfig.value.badgeColor ? { borderLeft: `3px solid ${dirConfig.value.badgeColor}` } : {}));
const statusClass = computed(() => STATUS_CLASS[status.value]);
const cellStatusClass = computed(() => CELL_STATUS[status.value]);
const headerStatusClass = computed(() => HEADER_STATUS[status.value]);
const statusLabel = computed(() => STATUS_LABEL[status.value]);
const stripStatusClass = computed(() => STRIP_STATUS[status.value]);
const stripDotClass = computed(() => STRIP_DOT[status.value]);
const stripLabel = computed(() => paneStateWord(status.value));
// A launcher pane has no summary and no mission — what it RUNS is the whole answer to "what
// is this", so the label takes the row's flexible slot. `cell-cmd` stays on it as the query
// hook the specs use.
const headerTitle = computed(() => [props.cwd, props.launcher.label].filter(Boolean).join(" · "));

function onSession(id: string) {
  emit("session", id);
}
function onExit() {
  finished.value = true;
}
function relaunch() {
  finished.value = false;
  connectKey.value++;
}
</script>

<template>
  <div
    class="cell @container/pane relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-[var(--cell-bg,var(--bg-base))]"
    :class="[statusClass, cellStatusClass]"
    :style="[cellStyle, stripeStyle]"
  >
    <!-- Row 1 — identity: the directory, its badge, and the actions. Same 24px row the Claude
         cell uses, so the two kinds of pane line up across a grid. -->
    <div
      class="cell-header flex h-6 flex-none items-center gap-1.5 border-b px-1.5"
      :class="[statusClass, headerStatusClass, expanded ? '' : `is-zoomable ${CELL_HEADER_ZOOMABLE}`]"
      :style="headerStyle"
      :title="headerTitle"
      @click="onHeaderClick"
    >
      <div data-testid="cell-header-main" class="flex min-w-0 flex-auto items-center gap-1.5 overflow-hidden">
        <DirBadge :name="dirConfig.name" :color="dirConfig.badgeColor" />
        <span class="min-w-0 flex-auto" />
      </div>
      <span class="cell-actions" :class="CELL_ACTIONS">
        <button v-if="reorderable" class="cell-btn" :class="CELL_BTN" title="Move left" aria-label="Move launcher left" @click.stop="emit('move', -1)">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <button v-if="reorderable" class="cell-btn" :class="CELL_BTN" title="Move right" aria-label="Move launcher right" @click.stop="emit('move', 1)">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
        <button v-if="finished" class="cell-btn" :class="CELL_BTN" title="Relaunch" aria-label="Relaunch" @click.stop="relaunch">
          <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
        </button>
        <CellChromeButtons :expanded="expanded" @toggle-expand="emit('toggle-expand')" @close="emit('close')" />
      </span>
    </div>
    <!-- Row 2 — the status strip, the row the operator READS while scanning columns. Same
         geometry and the same colour tables as the Claude cell's; the word is "シェル" (or
         "切断" once the program has exited). -->
    <div data-testid="cell-status-strip" :class="CELL_STRIP">
      <span :class="[CELL_STRIP_DOT, stripDotClass]" aria-hidden="true" />
      <span data-testid="cell-strip-state" :class="[CELL_STRIP_WORD, stripStatusClass]" :title="statusLabel">{{ stripLabel }}</span>
      <span class="cell-cmd" :class="CELL_STRIP_MAIN" :title="launcher.label"
        ><span class="material-symbols-outlined mr-1 text-[12px]" aria-hidden="true">rocket_launch</span>{{ launcher.label }}</span
      >
      <!-- The directory sits at the strip's right edge, front-truncated so the project (the
           tail) survives a narrow column — the one thing this pane's own output may never say. -->
      <span
        v-if="dirDisplay"
        class="cell-dir hidden max-w-[45%] flex-none truncate font-mono text-[11px] text-dim [direction:rtl] @[280px]/pane:inline"
        :title="cwd ?? ''"
        ><span class="[unicode-bidi:plaintext]">{{ dirDisplay }}</span></span
      >
    </div>
    <TerminalView
      class="cell-term"
      :class="CELL_TERM"
      :persist-key="`cell-${uid}`"
      :session-id="session"
      :connect-key="connectKey"
      :cwd="cwd"
      :launcher="target"
      :hide-header="!expanded"
      :expanded="expanded"
      :zoomed="zoomed"
      @session="onSession"
      @exit="onExit"
    />
  </div>
</template>
