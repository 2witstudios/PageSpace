/**
 * Content reports — the pure half: what a report may say, which URLs we accept
 * reports about, and how a report changes its case's category.
 *
 * The intake that resolves, checks and files a report is `report-intake.ts`;
 * the database edge is `report-store.ts`.
 */

import { z } from 'zod';
import type { ContentBlockCategory, ContentReportCategory } from '@pagespace/db/schema/content-safety';

export const REPORT_CATEGORIES = ['csam', 'illegal_other', 'malware', 'copyright', 'harassment', 'other'] as const satisfies readonly ContentReportCategory[];

const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid ID');
const MAX_URL_LENGTH = 2048;
const url = z.string().trim().min(1).max(MAX_URL_LENGTH);
const category = z.enum(REPORT_CATEGORIES);
// Optional for every category: a CSAM reporter must never be asked to describe the material.
const description = z.string().trim().max(2000).optional();

export const reportTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), pageId: id }),
  z.object({ type: z.literal('file'), fileId: id }),
  z.object({ type: z.literal('user'), userId: id }),
  z.object({ type: z.literal('published_url'), url }),
]);

export type ReportTargetInput = z.infer<typeof reportTargetSchema>;

/** A signed-in user's report. */
export const signedInReportSchema = z.object({ target: reportTargetSchema, category, description });

/** A visitor's report from the public report page. Only published URLs; the contact email is optional. */
export const publicReportSchema = z.object({
  url,
  category,
  description,
  contactEmail: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(254).pipe(z.email()).optional(),
  ),
});

export type ClassifiedReportUrl = {
  /** `publish_subdomain`: `<sub>.<publish host>`. `custom_domain_candidate`: any other hostname — confirm it is ours. */
  kind: 'publish_subdomain' | 'custom_domain_candidate';
  host: string;
  url: string;
};

// Paths a published site never serves: the app's own routes at the root, and raw storage keys ANYWHERE in the
// path (the target resolver matches storage-key shapes anywhere). `api` or `dashboard` deeper in a path is an
// ordinary page name (`/docs/api`); a crafted `/x/api/avatar/<id>/` is stopped by the intake instead, which only
// accepts a target that belongs to the site's own drive, and a user or avatar never does.
const APP_PATH = /^\/+(?:dashboard|api)(?:\/|$)/i;
const STORAGE_KEY_PATH = /(?:^|\/)(?:files|chat-attachments)\/[0-9a-f]{64}(?:\/|$)/i;
// `cache/<hash>` is only ours under the root `/assets/cache/`.
const BARE_CACHE_PATH = /(?:^|\/)cache\/[0-9a-f]{64}(?:\/|$)/i;
const ASSET_CACHE_PATH = /^\/assets\/cache\/[0-9a-f]{64}(?:\/|$)/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Is this a URL a report may be about? Only http(s), no credentials, a real
 * hostname (no IP literal, no single label), and no app path or storage key
 * anywhere in the path. Returns null for anything else. Passing this is not
 * enough: the caller must confirm the host serves a visible published site, and
 * that what the URL resolves to belongs to that site's drive.
 */
export function classifyReportUrl(raw: string, publishHost: string): ClassifiedReportUrl | null {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || IPV4.test(host) || !host.includes('.')) return null;
  const path = parsed.pathname;
  if (APP_PATH.test(path) || STORAGE_KEY_PATH.test(path)) return null;
  if (BARE_CACHE_PATH.test(path) && !ASSET_CACHE_PATH.test(path)) return null;

  const base = publishHost.toLowerCase();
  if (host === base) return null;
  if (host.endsWith(`.${base}`)) {
    const label = host.slice(0, -(base.length + 1));
    if (!label || label.includes('.')) return null;
    return { kind: 'publish_subdomain', host, url: parsed.toString() };
  }
  return { kind: 'custom_domain_candidate', host, url: parsed.toString() };
}

const BLOCK_CATEGORY: Partial<Record<ContentReportCategory, ContentBlockCategory>> = {
  csam: 'csam',
  malware: 'malware',
  illegal_other: 'illegal_other',
};

/**
 * The case's category once this report is on it. A report of illegal content
 * gives an uncategorised case its category; the first category otherwise
 * stands. CSAM always wins and is never replaced — the same rule the takedown
 * case store applies.
 */
export function caseCategoryAfterReport(current: ContentBlockCategory | null, report: ContentReportCategory): ContentBlockCategory | null {
  if (current === 'csam' || report === 'csam') return 'csam';
  return current ?? BLOCK_CATEGORY[report] ?? null;
}

/** Shown to anyone who reports CSAM, on the form and in the API response. */
export const CSAM_REPORT_GUIDANCE = {
  cyberTiplineUrl: 'https://report.cybertip.org/',
  message:
    'Thank you. You can also report this directly to the National Center for Missing & Exploited Children (NCMEC) ' +
    'through its CyberTipline. Please do not download, screenshot, save or forward the material, even to report it: ' +
    'we have what we need to act.',
} as const;

export type CsamReportGuidance = typeof CSAM_REPORT_GUIDANCE;

/** One answer for every report we cannot take, so a refusal says nothing about what exists. */
export const REPORT_REFUSAL_MESSAGES = {
  not_pagespace_url: 'We can only take reports about sites published on PageSpace. Check the address and try again.',
  not_found: "We couldn't find that content, or you don't have access to it.",
  self_report: 'You cannot report yourself.',
} as const;
