/**
 * WCAG 2.x contrast, over the opaque sRGB colours `index.css` defines.
 *
 * It exists for the palette test that keeps small text at AA (D131). The
 * application never computes a contrast ratio at runtime: the tokens are fixed,
 * so the check belongs to the suite rather than to the render.
 */

const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/i;

/** One sRGB channel, 0-255, linearised as WCAG 2.x defines it. */
function linearise(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a six-digit hex colour: 0 for black, 1 for white. */
export function relativeLuminance(hex: string): number {
  if (!SIX_DIGIT_HEX.test(hex)) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const packed = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => linearise((packed >> shift) & 0xff);
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** Contrast ratio between two opaque colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
