import type { Attribute } from '@tiptap/core';

/**
 * The common "single `data-*` (or plain HTML) attribute, string or null"
 * shape used across `block-id.ts`, `collab-marks.ts`, and `image-node.ts`:
 * default `null`, parsed from one HTML attribute, rendered back only when
 * set.
 *
 * `element.getAttribute(name)` returns `''` for a PRESENT-but-empty
 * attribute (e.g. `data-thread-id=""`), which is not the same as absent —
 * without normalizing it, a document round-trip could turn "no id" into a
 * non-null empty-string "id" that fails every real comparison against it
 * silently. `|| null` folds both `null` (attribute absent) and `''`
 * (attribute empty) to the same `null` default.
 */
export function simpleDataAttr(jsAttrName: string, htmlAttrName: string): Partial<Attribute> {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(htmlAttrName) || null,
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[jsAttrName];
      if (!value) return {};
      return { [htmlAttrName]: value };
    },
  };
}
