/**
 * `?embed=1` — how the iOS app opens the legal pages (Terms, Privacy, Cookies, Subprocessors):
 * the same text, without the site navigation and footer, so nothing in the app leads to web
 * prices or sign-up (App Store Guideline 3.1.1). Links between legal pages keep the flag.
 */
export const EMBED_PARAM = "embed";

export type LegalSearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function isEmbedded(searchParams: LegalSearchParams): Promise<boolean> {
  return (await searchParams)[EMBED_PARAM] === "1";
}

export const legalHref = (path: string, embed: boolean): string => (embed ? `${path}?${EMBED_PARAM}=1` : path);
