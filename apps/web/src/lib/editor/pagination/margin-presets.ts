export interface MarginPreset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Margin presets in pixels at 96 DPI
export const MARGIN_PRESETS: Record<string, MarginPreset> = {
  normal: {
    top: 96,
    bottom: 96,
    left: 96,
    right: 96,
  }, // 1 inch
  narrow: {
    top: 48,
    bottom: 48,
    left: 48,
    right: 48,
  }, // 0.5 inch
  wide: {
    top: 192,
    bottom: 192,
    left: 192,
    right: 192,
  }, // 2 inches
};

export function getMarginPreset(preset: string): MarginPreset {
  return MARGIN_PRESETS[preset] || MARGIN_PRESETS.normal;
}
