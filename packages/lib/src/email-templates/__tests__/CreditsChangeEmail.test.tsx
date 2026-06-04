import { describe, it, expect } from 'vitest';
import { render } from '@react-email/components';
import { CreditsChangeEmail } from '../CreditsChangeEmail';
import {
  getTierCreditSummary,
  formatCents,
  normalizeTier,
} from '../credits-change-content';
import {
  TIER_MONTHLY_ALLOWANCE_CENTS,
  CREDIT_PACKS,
} from '../../billing/credit-pricing';
import type { SubscriptionTier } from '../../services/subscription-utils';

const TIERS: SubscriptionTier[] = ['free', 'pro', 'founder', 'business'];

describe('formatCents', () => {
  it('renders whole dollars without trailing cents', () => {
    expect(formatCents(500)).toBe('$5');
    expect(formatCents(10000)).toBe('$100');
  });

  it('preserves sub-dollar precision', () => {
    expect(formatCents(1550)).toBe('$15.50');
    expect(formatCents(25)).toBe('$0.25');
  });
});

describe('normalizeTier', () => {
  it('passes through known tiers', () => {
    expect(normalizeTier('pro')).toBe('pro');
    expect(normalizeTier('founder')).toBe('founder');
    expect(normalizeTier('business')).toBe('business');
    expect(normalizeTier('free')).toBe('free');
  });

  it('falls back to free for unknown/empty values', () => {
    expect(normalizeTier('legacy_enterprise')).toBe('free');
    expect(normalizeTier(null)).toBe('free');
    expect(normalizeTier(undefined)).toBe('free');
  });
});

describe('getTierCreditSummary', () => {
  it.each(TIERS)('sources the %s allowance straight from credit-pricing', (tier) => {
    const summary = getTierCreditSummary(tier);
    expect(summary.monthlyAllowanceCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS[tier]);
    expect(summary.monthlyAllowanceLabel).toBe(
      formatCents(TIER_MONTHLY_ALLOWANCE_CENTS[tier]),
    );
  });

  it('exposes every credit pack as a top-up option', () => {
    const summary = getTierCreditSummary('pro');
    const packIds = summary.topupPacks.map((p) => p.id).sort();
    expect(packIds).toEqual(Object.keys(CREDIT_PACKS).sort());
  });
});

describe('CreditsChangeEmail', () => {
  it.each(TIERS)('renders the correct per-tier allowance for %s', async (tier) => {
    const summary = getTierCreditSummary(tier);
    const html = await render(
      CreditsChangeEmail({
        userName: 'Ada',
        summary,
        manageUrl: 'https://app.pagespace.ai/settings/plan',
        unsubscribeUrl: 'https://app.pagespace.ai/api/notifications/unsubscribe/tok',
      }),
    );

    // The per-tier dollar figure must come through verbatim from credit-pricing.
    expect(html).toContain(summary.monthlyAllowanceLabel);
    expect(html).toContain(summary.tierLabel);
    // Top-up packs are listed.
    for (const pack of summary.topupPacks) {
      expect(html).toContain(pack.amountLabel);
    }
  });

  it('greets the recipient and links to plan management', async () => {
    const html = await render(
      CreditsChangeEmail({
        userName: 'Grace',
        summary: getTierCreditSummary('free'),
        manageUrl: 'https://app.pagespace.ai/settings/plan',
      }),
    );
    expect(html).toContain('Grace');
    expect(html).toContain('https://app.pagespace.ai/settings/plan');
    // Reassurance that collaboration is unaffected.
    expect(html.toLowerCase()).toContain('collaboration');
  });

  it('omits the unsubscribe link when no URL is provided', async () => {
    const html = await render(
      CreditsChangeEmail({
        userName: 'Linus',
        summary: getTierCreditSummary('business'),
        manageUrl: 'https://app.pagespace.ai/settings/plan',
      }),
    );
    expect(html).not.toContain('Unsubscribe from product update emails');
  });

  it('shows the custom top-up range from the summary', async () => {
    const summary = getTierCreditSummary('pro');
    const html = await render(
      CreditsChangeEmail({
        userName: 'Ada',
        summary,
        manageUrl: 'https://app.pagespace.ai/settings/plan',
      }),
    );
    expect(html).toContain(summary.topupMinLabel);
    expect(html).toContain(summary.topupMaxLabel);
  });

  it('promotes frontier model choice for paid tiers but not Free', async () => {
    const proHtml = await render(
      CreditsChangeEmail({
        userName: 'Ada',
        summary: getTierCreditSummary('pro'),
        manageUrl: 'https://app.pagespace.ai/settings/plan',
      }),
    );
    expect(proHtml).toContain('Opus');

    const freeHtml = await render(
      CreditsChangeEmail({
        userName: 'Grace',
        summary: getTierCreditSummary('free'),
        manageUrl: 'https://app.pagespace.ai/settings/plan',
      }),
    );
    expect(freeHtml).not.toContain('Opus');
    expect(freeHtml.toLowerCase()).toContain('standard models');
  });

  it('renders the announcement link when a blog URL is provided', async () => {
    const html = await render(
      CreditsChangeEmail({
        userName: 'Ada',
        summary: getTierCreditSummary('founder'),
        manageUrl: 'https://app.pagespace.ai/settings/plan',
        blogUrl: 'https://pagespace.ai/blog/usage-based-pricing-and-built-for-scale',
      }),
    );
    expect(html).toContain('https://pagespace.ai/blog/usage-based-pricing-and-built-for-scale');
    expect(html).toContain('Read the full announcement');
  });
});
