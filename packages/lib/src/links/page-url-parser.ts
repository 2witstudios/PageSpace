export interface ParsedPageUrl {
  pageId: string;
  driveId?: string;
}

const DASHBOARD_RE = /\/dashboard\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/;
const DEEP_LINK_RE = /\/p\/([a-zA-Z0-9_-]+)/;
const SHARE_LINK_RE = /\/s\/[a-zA-Z0-9_-]+/;

function isPrivateClass172(hostname: string): boolean {
  if (!hostname.startsWith('172.')) return false;
  const dot = hostname.indexOf('.', 4);
  if (dot === -1) return false;
  const oct = parseInt(hostname.slice(4, dot), 10);
  return oct >= 16 && oct <= 31;
}

function isPageSpaceHost(hostname: string): boolean {
  return hostname === 'pagespace.ai'
    || hostname.endsWith('.pagespace.ai')
    || hostname === 'localhost'
    || hostname.startsWith('127.')
    || hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || isPrivateClass172(hostname);
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

// Two separate regexes — no optional groups, no polynomial backtracking risk.
// ABS_URL_RE captures absolute URLs starting with http(s); greedy [^\s<>"']+ is safe
// because it is not followed by any constraint that requires backtracking.
const ABS_URL_RE = /https?:\/\/[^\s<>"']+/g;
// REL_PATH_RE captures relative PageSpace paths; fixed alternation with no ambiguity.
const REL_PATH_RE = /\/(?:dashboard\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+|p\/[a-zA-Z0-9_-]+)(?=[^a-zA-Z0-9_-]|$)/g;

export function extractPageUrls(text: string): ParsedPageUrl[] {
  if (!text) return [];

  const seen = new Set<string>();
  const results: ParsedPageUrl[] = [];

  for (const match of (text.match(ABS_URL_RE) ?? [])) {
    const parsed = parsePageUrl(match);
    if (parsed && !seen.has(parsed.pageId)) {
      seen.add(parsed.pageId);
      results.push(parsed);
    }
  }

  for (const match of (text.match(REL_PATH_RE) ?? [])) {
    const parsed = parsePageUrl(match);
    if (parsed && !seen.has(parsed.pageId)) {
      seen.add(parsed.pageId);
      results.push(parsed);
    }
  }

  return results;
}
