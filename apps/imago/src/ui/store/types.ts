/** `A | B` to `A & B`: merges the records each slice contributes. */
export type UnionToIntersection<U> = (U extends unknown ? (union: U) => void : never) extends (
  intersection: infer I,
) => void
  ? I
  : never;
