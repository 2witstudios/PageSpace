import type { Extensions } from '@tiptap/core';
import { clientExtensions } from '@/lib/editor/client-schema';

export interface RichEditorExtensionOptions {
  readOnly: boolean;
  isPaginated: boolean;
}

/**
 * Thin compatibility wrapper over `clientExtensions()` (`client-schema.ts`),
 * kept for callers that predate the schema freeze: the collab content census
 * (`apps/web/scripts/collab-content-census.ts`) and the mention round-trip
 * test. `RichEditor.tsx` itself calls `clientExtensions()` directly — the
 * schema-drift guard's structural scan requires that, so a future revert to
 * an inlined `extensions: [` array in `RichEditor` fails CI.
 */
export function buildRichEditorExtensions({
  readOnly,
  isPaginated,
}: RichEditorExtensionOptions): Extensions {
  return clientExtensions({ readOnly, isPaginated });
}
