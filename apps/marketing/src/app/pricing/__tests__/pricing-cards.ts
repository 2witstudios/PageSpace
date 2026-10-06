/**
 * Test helpers for the pricing page: render it to static markup and read each plan card's
 * facts by data-testid. No DOM library in this app, so cards are split on their marker.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

/** A "$" with only a figure (or nothing) between it and the word "credits", either side. */
export const DOLLAR_BESIDE_CREDITS = /\$[\s\d,.]*credits\b|\bcredits[\s:]*\$/i;

/** Rendered markup as the visible text a reader sees: tags and React text separators removed. */
export const visibleText = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export const FACT_IDS = [
  'plan-price',
  'plan-period',
  'plan-seats',
  'plan-seat-credits',
  'plan-checkout',
  'plan-included-credits',
  'plan-topup-rate',
] as const;
export type FactId = (typeof FACT_IDS)[number];

export type CardFacts = Partial<Record<FactId, string>>;

function factText(cardHtml: string, id: FactId): string | undefined {
  const match = cardHtml.match(new RegExp(`data-testid="${id}"[^>]*>(.*?)</`, 's'));
  return match ? visibleText(match[1]) : undefined;
}

/** Each plan card's facts, keyed by its data-tier. */
export function renderCards(page: ReactElement): { html: string; text: string; cards: Record<string, CardFacts> } {
  const html = renderToStaticMarkup(page);
  const cards: Record<string, CardFacts> = {};
  for (const chunk of html.split('data-testid="plan-card"').slice(1)) {
    const tier = chunk.match(/data-tier="([a-z]+)"/)?.[1];
    if (!tier) continue;
    const facts: CardFacts = {};
    for (const id of FACT_IDS) {
      const text = factText(chunk.split('data-testid="plan-cta"')[0], id);
      if (text !== undefined) facts[id] = text;
    }
    cards[tier] = facts;
  }
  return { html, text: visibleText(html), cards };
}
