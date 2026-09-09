/**
 * Makes `value` safe to paste into a shell as one word.
 *
 * Key names are close to free-form — `resolveNewKeyName` refuses only the
 * reserved `"default"` and names that cannot be looked up (blank, or padded
 * with whitespace) — so `--name "lead gen"` is legal and printing it bare
 * gave `--key lead gen`, where the shell hands `--key` the word `lead` and
 * drops `gen` into the command as a stray positional. A hint that cannot be
 * pasted is worse than no hint, since the reader has no way to tell it apart
 * from one that can.
 *
 * Single quotes rather than double: they suppress every expansion, so a name
 * containing `$`, backticks or `!` is inert. The `'\''` dance is the standard
 * way to carry a literal single quote through a single-quoted word.
 *
 * Quoting alone is NOT enough, which is why the caller emits the equals-joined
 * `--key=<quoted>` form. A name beginning with `-` (`--name -prod` is legal and
 * mints fine) survives quote-stripping as the argv word `-prod`, and
 * `argv/parse.ts` rejects a space-separated flag value that starts with `-`
 * — so `--key '-prod'` is a usage error no amount of quoting can rescue.
 * `--key=-prod` is exactly the ambiguity the equals form exists to resolve
 * (see `parse.ts`, which documents it for `--host=-looks-like-a-flag`).
 *
 * Four callers across two command families now: the post-mint hint, and the
 * three "a credential already exists" messages that suggest a `logout`. Living
 * in its own leaf keeps `commands/login.ts` from importing out of
 * `commands/keys/`.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._@%+=:,/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
