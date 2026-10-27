import type { Attrs } from 'prosemirror-model';

/**
 * ProseMirror types `Attrs` as `{ readonly [attr: string]: any }`, so every
 * attribute read in a projector needs narrowing before it can be interpolated
 * into output. Without it, `no any` is satisfied by a cast that quietly lets a
 * `null` default reach a template and render the literal word `null` into a
 * document projection — `alt`, `fileId`, `href` and `language` all default to
 * `null` in the frozen schema.
 *
 * These two functions are that narrowing, named once. They were five
 * hand-written `typeof x === 'string' ? x : …` ternaries across three modules
 * before, which is exactly the shape that drifts.
 */

/** The attribute as a string, or `''` when it is unset or not a string. */
export function stringAttr(attrs: Attrs, name: string): string {
  const value = attrs[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The attribute as a NON-EMPTY string, or `null`.
 *
 * Distinct from `stringAttr` because for identity-bearing attributes the empty
 * string is not a value: a `blockId` of `''` is unaddressable, and returning it
 * as a string would let a caller treat "no id" as an id.
 */
export function nonEmptyStringAttr(attrs: Attrs, name: string): string | null {
  const value = attrs[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
