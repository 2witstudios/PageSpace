export interface DashboardFileViewRef {
  driveId: string;
  pageId: string;
}

const DASHBOARD_FILE_VIEW_RE =
  /(?:https?:\/\/[^/'">\s]*)?\/dashboard\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/view(?:\?[^"')\s>]*)?(?=$|[#"')\s>])/g;

const refKey = ({ driveId, pageId }: DashboardFileViewRef): string => `${driveId}:${pageId}`;

export function extractDashboardFileViewRefs(html: string): DashboardFileViewRef[] {
  const refsByKey = new Map<string, DashboardFileViewRef>();
  for (const match of html.matchAll(DASHBOARD_FILE_VIEW_RE)) {
    const ref = { driveId: match[1], pageId: match[2] };
    refsByKey.set(refKey(ref), ref);
  }
  return Array.from(refsByKey.values());
}

export function rewriteDashboardFileViewLinks(
  html: string,
  resolveUrl: (ref: DashboardFileViewRef) => string | null | undefined,
): string {
  return html.replace(DASHBOARD_FILE_VIEW_RE, (match, driveId: string, pageId: string) => {
    return resolveUrl({ driveId, pageId }) ?? match;
  });
}

