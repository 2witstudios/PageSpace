import { render } from '@react-email/components';
import type { ReactElement } from 'react';

/**
 * Render a React Email element to its final HTML string.
 *
 * Thin wrapper over `@react-email/components`' `render` so callers outside this
 * package (e.g. the broadcast scripts at the repo root) can produce email HTML
 * without depending on `@react-email/components` directly — that dependency only
 * resolves from within this package.
 */
export function renderEmailToHtml(element: ReactElement): Promise<string> {
  return render(element);
}
