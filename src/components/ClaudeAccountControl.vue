<script setup lang="ts">
// The toolbar's Claude account chip (ported from the operator's ClaudeBar menu app), now
// per PAGE (operator request 2026-09-14): the chip describes the page you are looking at,
// and picking an account there points THAT page's new panes at it. Two subscriptions can be
// logged in at once — see server/backends/claude-account-store.ts for how.
//
// The DEFAULT login is still a real thing: it is what every unassigned page uses, and what
// the old one-click swap moves. That swap is still here, one disclosure down, because it is
// the answer when nothing is assigned at all.
//
// Both lists only reach NEW panes. A running claude holds its token in-process for life, so
// a pane that is already up keeps the account it started on — which is why a pane whose
// account differs from its page labels itself in the status strip rather than being quietly
// misdescribed here. The one way to move those is the explicit "move the running panes" item
// under the page list (2026-09-28): re-stamp, restart, resume.
import { computed, ref, useTemplateRef, watch } from "vue";
import { useDropdownMenu } from "../composables/useDropdownMenu";
import { useClaudeAccount } from "../composables/useClaudeAccount";
import { applyPageAccount, movePagePanes, usePageAccount } from "../composables/usePageAccount";
import { useLoginHealth } from "../composables/useLoginHealth";
import { describeSlot, daysLeftNote, slotLabel, type LoginSlotState } from "../../common/loginHealth";

const {
  current,
  ambiguous,
  accounts,
  busy,
  error,
  notice,
  refresh,
  switchTo,
  restartAllPanes,
  restartPanes: restartSessions,
  logoutForNewLogin,
  declareDefault,
} = useClaudeAccount();
// Null when no grid is mounted (a full-screen overlay): there is no page to assign, so the
// menu shows the default login only.
const { pageAccount } = usePageAccount();
// The sessions the reload offer would restart — set only by moveRunningPanes finding nothing
// to move, cleared by any other action so the offer never outlives the click it answered.
// The offer names one page's panes, so a page change under an open menu (keyboard) drops it.
const reloadOffer = ref<string[]>([]);
watch(
  () => pageAccount.value?.pageName,
  () => {
    reloadOffer.value = [];
  },
);

// The login-expiry warning (operator request 2026-10-21): a refresh token lapses ~30 days
// after the browser login and every pane on it stops — including the phone's launcher — so
// the warning has to reach the operator while they are at the Mac. It sits BEFORE the chip,
// outside the dropdown, because a warning inside a menu nobody opens is no warning. One line
// per lapsing login in the menu says which pane to run /login in; "re-check" clears it right
// after, without waiting for the hourly scan.
const { report: loginHealth, alerting: loginAlerts, worst: loginWorst, checking: loginChecking, recheck: recheckLogins } = useLoginHealth();
// Red for the two conditions that are already costing something (a dead login, a login that
// is somebody else's), amber for the one that will.
const loginSevere = computed(() => loginWorst.value?.state === "dead" || loginWorst.value?.state === "mismatch");
const loginBorder = computed(() => (loginSevere.value ? "border-err" : "border-warn"));
const loginOkSlots = computed(() => loginHealth.value?.slots.filter((s) => s.state === "ok") ?? []);
const loginWarnText = computed(() => {
  const w = loginWorst.value;
  if (!w) return "";
  if (w.state === "mismatch") return `ログインの名義ちがい: ${slotLabel(w)}`;
  if (w.state === "dead") return `ログイン切れ: ${slotLabel(w)}`;
  return `ログイン期限${daysLeftNote(w.daysLeft)}: ${slotLabel(w)}`;
});
const LOGIN_WARN_ICON: Partial<Record<LoginSlotState, string>> = { mismatch: "person_off", dead: "lock_open" };
const loginWarnIcon = computed(() => LOGIN_WARN_ICON[loginWorst.value?.state ?? "ok"] ?? "schedule");
const loginWarnTitle = computed(() => loginAlerts.value.map(describeSlot).join("\n"));

// Default OFF (operator decision 2026-08-25): a switch must not touch the existing panes
// unless the operator asks. The fleet restart moves ALL claude panes — detached pages
// included — and a pane whose id has no transcript comes back as a new conversation, so
// an everyday switch with it on cost more than it saved. ON is the usage-limit move,
// chosen explicitly: every pane restarts and resumes on the new account, with the
// selective auto-continue nudge (working / limit-stuck panes only).
const restartPanes = ref(false);
// The default-login switch is folded away: with pages assigning their own accounts it is
// maintenance, not the everyday move, and an unfolded second list of the same emails reads
// as two ways to do one thing.
const showDefaultSwitch = ref(false);

const root = useTemplateRef<HTMLElement>("root");
// Re-read on every open: a login typed into any pane changes the answer without telling us.
// The reload offer (below) is per click, so it is dropped on open too.
const { open, toggle } = useDropdownMenu(root, () => {
  reloadOffer.value = [];
  void refresh();
});

// The current account always appears in the list even before its first snapshot (it enters
// the index only when switched AWAY from), so the dropdown never looks emptier than reality.
const listed = computed(() => {
  const emails = accounts.value.map((a) => a.email);
  if (current.value && !emails.includes(current.value)) return [current.value, ...emails];
  return emails;
});

// What panes started HERE run as: the page's own account, else the default login.
const effective = computed(() => pageAccount.value?.account ?? current.value);
// The same, as the menu names it when nothing is assigned.
const effectiveLabel = computed(() => effective.value ?? "既定のログイン");
const assigned = computed(() => !!pageAccount.value?.account);
// The chip stays readable in the h-7 row: local part only, full email in the tooltip.
const chipText = computed(() => (effective.value ? effective.value.split("@")[0] : "no login"));
const chipTitle = computed(() => {
  if (!effective.value) return "No Claude login — click to manage accounts";
  const where = assigned.value ? `${pageAccount.value?.pageName}のアカウント` : "既定のログイン";
  return `${where}: ${effective.value} — クリックで変更（新しいペインから有効）`;
});

// Point this page at an account (or back at the default login). The confirmation stays in the
// menu: what changed is invisible until the next pane starts, so saying it is the feedback.
function pickForPage(email: string | null): void {
  // A reload offer was about the page's PREVIOUS account; a restart now would reconnect
  // with the new one, which is the move item's job, not this offer's.
  reloadOffer.value = [];
  applyPageAccount(email);
  const target = email ?? `既定のログイン（${current.value ?? "未ログイン"}）`;
  notice.value = `${pageAccount.value?.pageName ?? "このページ"}の新しいペインは ${target} で起動します。起動済みのペインはそのままです。`;
}

// Move this page's RUNNING panes onto its account (operator request 2026-09-28): the grid
// re-stamps them, then the server restarts exactly those, and each resumes its conversation on
// the page's login. The one case where an existing pane's account changes — and it changes on
// a click that names the page, never on a page default set later.
async function moveRunningPanes(): Promise<void> {
  if (busy.value) return;
  reloadOffer.value = [];
  const where = effectiveLabel.value;
  const page = pageAccount.value?.pageName ?? "このページ";
  const { moved, staying } = movePagePanes();
  if (moved.length > 0) {
    await restartSessions(moved, where);
    return;
  }
  if (staying.length === 0) {
    notice.value = `${page}に起動済みの claude ペインはありません。`;
    return;
  }
  // Every pane is stamped with the account already — and that was a dead end (operator report
  // 2026-10-24): the login stored under that account had been replaced AFTER the panes started
  // (a /login redone), a running claude keeps the token it started with, and the item that
  // names the account had nothing to offer. The stamps are right; the processes are stale. So
  // say that, and offer the restart that fixes it — one more click, never on the first.
  notice.value = `${page}の起動済みペイン ${staying.length} 個はすべて ${where} で動いています。${where} で /login をやり直した後なら、再起動して新しいログインを掴ませる必要があります。`;
  reloadOffer.value = staying;
}

async function reloadPagePanes(): Promise<void> {
  if (busy.value || reloadOffer.value.length === 0) return;
  const sessions = reloadOffer.value;
  reloadOffer.value = [];
  await restartSessions(sessions, effectiveLabel.value);
}

async function pickDefault(email: string): Promise<void> {
  if (busy.value || email === current.value) return;
  await switchTo(email, restartPanes.value);
  // Keep the menu open: the confirmation line ("restarted N panes as ...") is the feedback.
}
</script>

<template>
  <div ref="root" class="relative flex flex-none items-center gap-1">
    <button
      v-if="loginWorst"
      type="button"
      data-testid="login-health-warning"
      class="inline-flex h-[22px] max-w-[260px] cursor-pointer items-center gap-1 rounded-full border px-2 font-mono text-[11px] leading-none hover:bg-hover"
      :class="loginSevere ? 'border-err text-err' : 'border-warn text-warn'"
      :title="loginWarnTitle"
      :aria-label="loginWarnTitle"
      @click="toggle"
    >
      <span class="material-symbols-outlined text-[14px]" aria-hidden="true">{{ loginWarnIcon }}</span>
      <span class="min-w-0 truncate">{{ loginWarnText }}</span>
    </button>
    <button
      type="button"
      data-testid="claude-account-chip"
      class="inline-flex h-[22px] max-w-[180px] cursor-pointer items-center gap-1 rounded-full border bg-base px-2 font-mono text-[11px] leading-none hover:bg-hover hover:text-fg"
      :class="[assigned ? 'border-accent text-fg' : 'border-border text-muted', { 'bg-selected': open }]"
      :title="chipTitle"
      :aria-label="chipTitle"
      :aria-expanded="open"
      aria-haspopup="true"
      @click="toggle"
    >
      <span class="material-symbols-outlined text-[14px]" aria-hidden="true">account_circle</span>
      <span class="min-w-0 truncate">{{ chipText }}</span>
    </button>
    <div
      v-if="open"
      class="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border border-border bg-panel p-2 text-[13px] text-fg shadow-lg"
      role="menu"
      aria-label="Claude accounts"
    >
      <!-- Nothing can move credentials while this is up: MT's record and ~/.claude.json name
           different accounts for the default slot and only the operator knows which is true.
           Two buttons, because two candidates is the whole of the question. -->
      <div v-if="ambiguous" class="mb-1 rounded border border-err px-2 py-1.5 text-[11px] text-fg">
        <p class="mb-1">既定のログインが確定できません。どちらが既定ですか？</p>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="email in [ambiguous.recorded, ambiguous.onDisk].filter((e): e is string => !!e)"
            :key="`claim-${email}`"
            type="button"
            class="cursor-pointer rounded border border-border bg-elevated px-2 py-1 font-mono text-[11px] text-fg hover:bg-hover"
            :disabled="busy"
            @click="declareDefault(email)"
          >
            {{ email }}
          </button>
        </div>
        <p class="mt-1 text-muted">確定するまで、アカウントの切替とログアウトは実行されません。</p>
      </div>
      <!-- Every login this machine holds and when each lapses (useLoginHealth). Lapsing ones
           say which pane to run /login in; "re-check" is for right after doing so. -->
      <div v-if="loginHealth" class="mb-1 rounded border px-2 py-1.5 text-[11px]" :class="loginWorst ? loginBorder : 'border-border'">
        <p v-for="slot in loginAlerts" :key="`alert-${slot.service}`" class="mb-1 text-fg">{{ describeSlot(slot) }}</p>
        <p v-for="slot in loginOkSlots" :key="`ok-${slot.service}`" class="font-mono text-muted">
          {{ describeSlot(slot) }}
        </p>
        <p v-if="loginHealth.duplicates.length" class="mt-1 text-err">同じ鍵が複数の保存先にあります。片方の更新がもう片方を無効化します。</p>
        <button
          type="button"
          class="mt-1 cursor-pointer rounded border border-border bg-elevated px-2 py-0.5 text-[11px] text-fg hover:bg-hover"
          :disabled="loginChecking"
          @click="recheckLogins()"
        >
          {{ loginChecking ? "確認中…" : "/login した後に再確認" }}
        </button>
      </div>
      <!-- The page's own account: the everyday control now. Absent `pageAccount` means no
           grid is mounted, and then there is no page to point anywhere. -->
      <template v-if="pageAccount">
        <p class="mb-1 px-1 text-[11px] text-muted">{{ pageAccount.pageName }}の新しいペイン</p>
        <button
          type="button"
          role="menuitem"
          data-testid="page-account-default"
          class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[12px]"
          :class="assigned ? 'text-muted hover:bg-hover hover:text-fg' : 'text-fg'"
          :disabled="busy"
          title="このページは既定のログインに従います"
          @click="pickForPage(null)"
        >
          <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">{{ assigned ? "" : "check" }}</span>
          <span class="min-w-0 truncate">既定（{{ current ?? "未ログイン" }}）</span>
        </button>
        <button
          v-for="email in listed"
          :key="`page-${email}`"
          type="button"
          role="menuitem"
          class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[12px]"
          :class="email === pageAccount.account ? 'text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
          :disabled="busy"
          :title="`${pageAccount.pageName}の新しいペインを ${email} で起動する`"
          @click="pickForPage(email)"
        >
          <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">{{ email === pageAccount.account ? "check" : "" }}</span>
          <span class="min-w-0 truncate">{{ email }}</span>
        </button>
        <!-- The running panes' move: the two lists above reach NEW panes only, and a page that
             was assigned after its panes started keeps running them on the old login with no
             way to say "all of this page, on this account, now" short of the global switch. -->
        <button
          type="button"
          role="menuitem"
          data-testid="page-account-move-panes"
          class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
          :disabled="busy"
          :title="`${pageAccount.pageName}の起動済みの claude ペインを ${effective ?? '既定のログイン'} で再起動し、それぞれの会話を復元する。すでにそのアカウントのペインはそのまま。`"
          @click="moveRunningPanes()"
        >
          <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">restart_alt</span>
          <span class="min-w-0 truncate">起動済みのペインも {{ effective ? effective.split("@")[0] : "既定" }} に移す（再起動・会話は復元）</span>
        </button>
        <!-- Shown only after the move above found every pane already on the account: the
             restart that makes them pick up a login redone since they started. -->
        <button
          v-if="reloadOffer.length"
          type="button"
          role="menuitem"
          data-testid="page-account-reload-panes"
          class="flex w-full cursor-pointer items-center gap-2 rounded border border-accent bg-transparent px-2 py-1.5 text-left text-[12px] text-fg hover:bg-hover"
          :disabled="busy"
          :title="`${pageAccount.pageName}の起動済みの claude ペイン ${reloadOffer.length} 個を ${effectiveLabel} のまま再起動し、保存されている今のログインで動かし直す。会話は復元される。`"
          @click="reloadPagePanes()"
        >
          <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">sync_lock</span>
          <span class="min-w-0 truncate">再起動して今のログインを掴み直す（{{ reloadOffer.length }} ペイン・会話は復元）</span>
        </button>
        <div class="my-1 border-t border-border" />
      </template>
      <!-- Recovery path for a switch done elsewhere (claude /logout in a pane, or the box
           below unticked): move every existing pane onto the CURRENT default credentials. -->
      <button
        type="button"
        role="menuitem"
        class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
        :disabled="busy"
        title="Restart every claude pane. A pane on a page with its own account comes back on that account; the rest resume on the default login."
        @click="restartAllPanes()"
      >
        <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">restart_alt</span>
        Restart panes（割り当ての無いペインが既定ログインに戻ります）
      </button>
      <!-- The register-another-account path: snapshot the current login, clear the live
           credentials, and the next pane's claude starts the OAuth login (ClaudeBar's
           `claude /logout && claude`, minus the typing). -->
      <button
        type="button"
        role="menuitem"
        class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
        :disabled="busy"
        title="Snapshot the current login, then log out so a new pane can sign in as another account"
        @click="logoutForNewLogin()"
      >
        <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">person_add</span>
        Log in with another account
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="claude-account-default-toggle"
        class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
        :aria-expanded="showDefaultSwitch"
        title="Change the login every unassigned page uses"
        @click="showDefaultSwitch = !showDefaultSwitch"
      >
        <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">{{ showDefaultSwitch ? "expand_less" : "expand_more" }}</span>
        既定のログインを切り替える
      </button>
      <template v-if="showDefaultSwitch">
        <!-- The restart choice sits ABOVE the account list: it changes what clicking an
             account does, so it has to be read first. Restarting includes the pane you are
             talking in — each pane resumes its own conversation on the new account. -->
        <label class="mb-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] text-muted hover:bg-hover">
          <input v-model="restartPanes" type="checkbox" class="accent-[var(--accent)]" :disabled="busy" />
          Restart existing panes — 割り当ての無いページのペインだけが移ります。auto-continue only the working / limit-stuck ones (off: new panes only)
        </label>
        <button
          v-for="email in listed"
          :key="`default-${email}`"
          type="button"
          role="menuitem"
          class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[12px]"
          :class="email === current ? 'text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
          :disabled="busy"
          :title="email === current ? `${email} (current default)` : `Switch the default login to ${email}`"
          @click="pickDefault(email)"
        >
          <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">{{ email === current ? "check" : "" }}</span>
          <span class="min-w-0 truncate">{{ email }}</span>
        </button>
      </template>
      <p v-if="notice" class="mt-1 px-1 text-[11px] text-accent">{{ notice }}</p>
      <p v-if="error" class="mt-1 px-1 text-[11px] text-err">{{ error }}</p>
    </div>
  </div>
</template>
