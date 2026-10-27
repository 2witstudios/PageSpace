export function getShareUrl(token: string): string {
  const appUrl = process.env.WEB_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
  return `${appUrl}/s/${token}`;
}
