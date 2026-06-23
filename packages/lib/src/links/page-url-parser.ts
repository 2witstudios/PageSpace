export interface ParsedPageUrl {
  pageId: string;
  driveId?: string;
}

const DASHBOARD_RE = /\/dashboard\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/;
const DEEP_LINK_RE = /\/p\/([a-zA-Z0-9_-]+)/;
const SHARE_LINK_RE = /\/s\/[a-zA-Z0-9_-]+/;

function isPageSpaceHost(hostname: string): boolean {
  return hostname === 'pagespace.ai'
    || hostname.endsWith('.pagespace.ai')
    || hostname === 'localhost'
    || hostname.startsWith('127.')
    || hostname.startsWith('192.168.');
}

export function parsePageUrl(url: string): ParsedPageUrl | null {
  if (!url) return null;

  let path: string;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      if (!isPageSpaceHost(parsed.hostname)) return null;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    path = url;
  }

  if (SHARE_LINK_RE.test(path)) return null;

  const dashboardMatch = DASHBOARD_RE.exec(path);
  if (dashboardMatch) {
    return { driveId: dashboardMatch[1], pageId: dashboardMatch[2] };
  }

  const deepLinkMatch = DEEP_LINK_RE.exec(path);
  if (deepLinkMatch) {
    return { pageId: deepLinkMatch[1], driveId: undefined };
  }

  return null;
}

// URL regex that matches both absolute and relative PageSpace URLs in free text
const URL_RE = /(?:https?:\/\/[^\s<>"']+?)?(?:\/dashboard\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+|\/p\/[a-zA-Z0-9_-]+)(?=[^a-zA-Z0-9_-]|$)/g;

export function extractPageUrls(text: string): ParsedPageUrl[] {
  if (!text) return [];

  const seen = new Set<string>();
  const results: ParsedPageUrl[] = [];

  const matches = text.match(URL_RE) ?? [];
  for (const match of matches) {
    const parsed = parsePageUrl(match);
    if (parsed && !seen.has(parsed.pageId)) {
      seen.add(parsed.pageId);
      results.push(parsed);
    }
  }

  return results;
}
