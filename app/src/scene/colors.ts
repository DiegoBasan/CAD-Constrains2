// A palette of distinct, muted hues for telling imported parts apart at a glance.
const PALETTE = [
  0x5b8dee, 0xe0a355, 0x6bbf7b, 0xd66b8f, 0x7fc8c0,
  0xc19be0, 0xe0c14f, 0x8fa8d6, 0xe08a6b, 0x7ad6c0,
];

export function partColor(index: number): number {
  return PALETTE[index % PALETTE.length];
}

/** The whole body of the selected part switches to this neutral gray, so it's
 * obvious which part is selected regardless of its normal palette color. */
export const SELECTED_PART_COLOR = 0x8a8a8a;
/** Every part's color in the "gray" visualization mode — rgb(173,173,177). */
export const UNIFORM_GRAY_COLOR = 0xadadb1;
/** Picked face/edge overlay — stays blue on top of the gray selected part. */
export const PICK_COLOR = 0x4fa3ff;
export const EDGE_COLOR = 0x151515;
export const EDGE_HIGHLIGHT_COLOR = 0x4fa3ff;
/** Hover preview while Ctrl/Cmd is held, before the click that actually picks — a warm
 * amber so it reads as "about to pick this" and is never confused with PICK_COLOR's
 * blue "already picked," even when both are visible on the same part at once (e.g.
 * hovering a second candidate face while a first is already picked). */
export const HOVER_COLOR = 0xffb454;
export const EDGE_HOVER_COLOR = 0xffb454;
