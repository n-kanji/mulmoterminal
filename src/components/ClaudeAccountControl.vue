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
// misdescribed here.
import { computed, ref, useTemplateRef } from "vue";
import { useDropdownMenu } from "../composables/useDropdownMenu";
import { useClaudeAccount } from "../composables/useClaudeAccount";
import { applyPageAccount, usePageAccount } from "../composables/usePageAccount";

const { current, accounts, busy, error, notice, refresh, switchTo, restartAllPanes, logoutForNewLogin } = useClaudeAccount();
// Null when no grid is mounted (a full-screen overlay): there is no page to assign, so the
// menu shows the default login only.
const { pageAccount } = usePageAccount();

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
const { open, toggle } = useDropdownMenu(root, () => void refresh());

// The current account always appears in the list even before its first snapshot (it enters
// the index only when switched AWAY from), so the dropdown never looks emptier than reality.
const listed = computed(() => {
  const emails = accounts.value.map((a) => a.email);
  if (current.value && !emails.includes(current.value)) return [current.value, ...emails];
  return emails;
});

// What panes started HERE run as: the page's own account, else the default login.
const effective = computed(() => pageAccount.value?.account ?? current.value);
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
  applyPageAccount(email);
  const target = email ?? `既定のログイン（${current.value ?? "未ログイン"}）`;
  notice.value = `${pageAccount.value?.pageName ?? "このページ"}の新しいペインは ${target} で起動します。起動済みのペインはそのままです。`;
}

async function pickDefault(email: string): Promise<void> {
  if (busy.value || email === current.value) return;
  await switchTo(email, restartPanes.value);
  // Keep the menu open: the confirmation line ("restarted N panes as ...") is the feedback.
}
</script>

<template>
  <div ref="root" class="relative flex-none">
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
        <div class="my-1 border-t border-border" />
      </template>
      <!-- Recovery path for a switch done elsewhere (claude /logout in a pane, or the box
           below unticked): move every existing pane onto the CURRENT default credentials. -->
      <button
        type="button"
        role="menuitem"
        class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
        :disabled="busy"
        title="Restart every claude pane so it resumes its conversation on the current default account"
        @click="restartAllPanes()"
      >
        <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">restart_alt</span>
        Restart all panes on the default account
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
          Restart existing panes — auto-continue only the working / limit-stuck ones (off: new panes only)
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
