// Fork-local (iTerm2 mode, R10): undoing a preset-chip removal.
//
// The chip's x sits 3px from the chip's own launch button on a 22px row, so a mis-click
// deletes a project the operator has to re-find in a folder dialog. The undo is INLINE, in
// the slot the chip just vacated — not a toast: the toolbar row is the same row the chips
// live on, and a floating notice over a 30-column grid is chrome that costs a reading line
// and points nowhere.
//
// Five seconds, because the only reader is the person who just clicked and is still looking
// at the chip they clicked.
import type { CwdPreset } from "./presets";

export const PRESET_UNDO_MS = 5000;

/** A removal that can still be taken back: the entry and the slot it came out of. */
export interface PendingPresetUndo {
  preset: CwdPreset;
  index: number;
}

/** What a removal of `path` leaves to undo, or null when the list never had it (a stale
 *  click, or a second removal of the same chip). */
export function takePresetUndo(presets: readonly CwdPreset[], path: string): PendingPresetUndo | null {
  const index = presets.findIndex((p) => p.path === path);
  return index < 0 ? null : { preset: presets[index], index };
}

/** Put the entry back where it was. Restoring at the ORIGINAL index rather than the front is
 *  the whole point: the chip strip is hand-ordered (drag to reorder), so re-adding a chip at
 *  the most-recent end would undo the removal and silently re-arrange the row.
 *
 *  A no-op if the path is already present — an undo the operator clicked twice, or a re-launch
 *  that re-recorded the dir before they got to it, must not duplicate the chip. */
export function restorePreset(presets: readonly CwdPreset[], pending: PendingPresetUndo): CwdPreset[] {
  if (presets.some((p) => p.path === pending.preset.path)) return [...presets];
  const at = Math.min(Math.max(0, pending.index), presets.length);
  const next = [...presets];
  next.splice(at, 0, pending.preset);
  return next;
}
