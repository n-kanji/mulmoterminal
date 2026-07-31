import { computed, ref, type ComputedRef } from "vue";
import { keymapWithDefaults, sanitizeKeymap, type Keymap } from "../../common/keymap";

// The active keyboard shortcut map, hydrated from /api/config and read by the grid's key
// handler at keydown time.
//
// Starts EMPTY and only fills in once /api/config has answered. Fork-local (R3): a config with
// no `keymap` then lands on DEFAULT_KEYMAP, but not before — hydration is async, and claiming
// the default Alt chords during it would take keys away from a user whose config replaces them.
//
// A ref rather than a plain module value (unlike terminalSubmitMode, which nothing displays):
// hydration is ASYNC, and the settings screen renders this map. Opening settings before
// /api/config resolves would otherwise freeze that screen on "Not set" for its whole lifetime,
// telling the user they have no shortcuts when they do.
const current = ref<Keymap>({});

/** For reactive consumers — anything that RENDERS the keymap. */
export const activeKeymap: ComputedRef<Keymap> = computed(() => current.value);

/** For the keydown handler, which reads imperatively and wants no ref ceremony. */
export const getActiveKeymap = (): Keymap => current.value;

export const setActiveKeymap = (keymap: unknown): void => {
  current.value = keymapWithDefaults(sanitizeKeymap(keymap));
};
