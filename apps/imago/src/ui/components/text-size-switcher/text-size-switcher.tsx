'use client';

import { useTextSize } from '@/lib/text-size/text-size-provider';
import { renderTextSizeSwitcher } from './text-size-switcher.render';

/** The four-step text-size control, bound to the request's text-size provider. */
export function TextSizeSwitcher() {
  return renderTextSizeSwitcher(useTextSize());
}
