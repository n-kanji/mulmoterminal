<script setup lang="ts">
// The toolbar's Claude account chip (ported from the operator's ClaudeBar menu app): shows
// which claude.ai account new panes will log in as, and the dropdown swaps to any other
// account whose login has been snapshotted — the one-click escape when a usage limit hits.
// Modeled on the update badge's popover; state comes from useClaudeAccount.
import { computed, ref, useTemplateRef } from "vue";
import { useDropdownMenu } from "../composables/useDropdownMenu";
import { useClaudeAccount } from "../composables/useClaudeAccount";

const { current, accounts, busy, error, notice, refresh, switchTo, restartAllPanes, logoutForNewLogin } = useClaudeAccount();

// Default ON: the whole point of switching (a usage limit hit) is moving the EXISTING
// panes — each restarts and resumes its own conversation on the new account. The
// auto-continue is selective server-side (working / limit-stuck panes only), so parked or
// finished panes come back quiet. Off = the conservative v1 behaviour, new panes only.
const restartPanes = ref(true);

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
// The chip stays readable in the h-7 row: local part only, full email in the tooltip.
const chipText = computed(() => (current.value ? current.value.split("@")[0] : "no login"));
const chipTitle = computed(() => (current.value ? `Claude account: ${current.value} — click to switch` : "No Claude login — click to manage accounts"));

async function pick(email: string): Promise<void> {
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
      class="inline-flex h-[22px] max-w-[180px] cursor-pointer items-center gap-1 rounded-full border border-border bg-base px-2 font-mono text-[11px] leading-none text-muted hover:bg-hover hover:text-fg"
      :class="{ 'bg-selected': open }"
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
      class="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-panel p-2 text-[13px] text-fg shadow-lg"
      role="menu"
      aria-label="Claude accounts"
    >
      <p class="mb-1 px-1 text-[11px] text-muted">Claude account</p>
      <!-- The restart choice sits ABOVE the account list: it changes what clicking an
           account does, so it has to be read first. Restarting includes the pane you are
           talking in — each pane resumes its own conversation on the new account. -->
      <label class="mb-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] text-muted hover:bg-hover">
        <input v-model="restartPanes" type="checkbox" class="accent-[var(--accent)]" :disabled="busy" />
        Restart existing panes — auto-continue only the working / limit-stuck ones (off: new panes only)
      </label>
      <button
        v-for="email in listed"
        :key="email"
        type="button"
        role="menuitem"
        class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[12px]"
        :class="email === current ? 'text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
        :disabled="busy"
        :title="email === current ? `${email} (current)` : `Switch new panes to ${email}`"
        @click="pick(email)"
      >
        <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">{{ email === current ? "check" : "" }}</span>
        <span class="min-w-0 truncate">{{ email }}</span>
      </button>
      <div class="my-1 border-t border-border" />
      <!-- Recovery path for a switch done elsewhere (claude /logout in a pane, or the box
           above unticked): move every existing pane onto the CURRENT credentials. -->
      <button
        type="button"
        role="menuitem"
        class="flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
        :disabled="busy"
        title="Restart every claude pane so it resumes its conversation on the current account"
        @click="restartAllPanes()"
      >
        <span class="material-symbols-outlined w-[16px] text-[15px]" aria-hidden="true">restart_alt</span>
        Restart all panes on this account
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
      <p v-if="notice" class="mt-1 px-1 text-[11px] text-accent">{{ notice }}</p>
      <p v-if="error" class="mt-1 px-1 text-[11px] text-err">{{ error }}</p>
    </div>
  </div>
</template>
