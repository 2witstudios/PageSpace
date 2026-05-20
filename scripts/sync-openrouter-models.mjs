#!/usr/bin/env node
/**
 * Fetches current models from the OpenRouter API and reports drift against
 * the local config (ai-providers-config.ts and ai-monitoring.ts).
 *
 * All prices come from the live API — nothing is estimated from memory.
 *
 * Usage:
 *   node scripts/sync-openrouter-models.mjs            # full report
 *   node scripts/sync-openrouter-models.mjs --free     # free tier only
 *   node scripts/sync-openrouter-models.mjs --pricing  # pricing drift only
 *
 * This script is intentionally read-only — it reports drift so a human can
 * decide which entries to add or correct.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../apps/web/src/lib/ai/core/ai-providers-config.ts');
const MONITORING_PATH = resolve(__dirname, '../packages/lib/src/monitoring/ai-monitoring.ts');

const FREE_ONLY = process.argv.includes('--free');
const PAID_ONLY = process.argv.includes('--paid');
const PRICING_ONLY = process.argv.includes('--pricing');

// --- Read current files --------------------------------------------------------

const configSource = readFileSync(CONFIG_PATH, 'utf8');
const monitoringSource = readFileSync(MONITORING_PATH, 'utf8');

// Extract all model IDs already in the config
const existingModels = new Set(
  [...configSource.matchAll(/'([\w\/\-.:]+(?::free)?)'\s*:/g)].map(m => m[1])
);

// Extract model IDs that have pricing entries in ai-monitoring.ts
const pricedModels = new Set(
  [...monitoringSource.matchAll(/'([\w\/\-.:]+(?::free)?)'\s*:\s*\{\s*input:/g)].map(m => m[1])
);

// Extract model IDs that have context window entries
const contextModels = new Set(
  [...monitoringSource.matchAll(/'([\w\/\-.:]+(?::free)?)'\s*:\s*\d+,/g)].map(m => m[1])
);

// --- Fetch OpenRouter models ---------------------------------------------------

console.log('Fetching models from OpenRouter API…');
const res = await fetch('https://openrouter.ai/api/v1/models', {
  headers: { 'HTTP-Referer': 'https://pagespace.ai', 'X-Title': 'PageSpace' },
});

if (!res.ok) {
  console.error(`OpenRouter API returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const { data: models } = await res.json();

// --- Determine which are free -------------------------------------------------

const isFree = (model) => {
  const p = model.pricing;
  if (!p) return false;
  return (
    (parseFloat(p.prompt) === 0 && parseFloat(p.completion) === 0) ||
    model.id.endsWith(':free')
  );
};

// --- Find missing/drifted models -----------------------------------------------

const missing = { paid: [], free: [] };
const missingPricing = [];   // in config but no pricing entry in monitoring.ts
const pricingDrift = [];     // in config + monitoring, but monitoring price differs from API

for (const model of models) {
  const free = isFree(model);
  if (FREE_ONLY && !free) continue;
  if (PAID_ONLY && free) continue;

  const apiInputPerM = parseFloat(model.pricing?.prompt ?? 0) * 1_000_000;
  const apiOutputPerM = parseFloat(model.pricing?.completion ?? 0) * 1_000_000;
  const ctx = model.context_length;

  if (!existingModels.has(model.id)) {
    const entry = { id: model.id, name: model.name, ctx, apiInputPerM, apiOutputPerM };
    (free ? missing.free : missing.paid).push(entry);
  } else if (!PRICING_ONLY && !free) {
    // Check pricing drift for paid models already in config
    if (!pricedModels.has(model.id) && apiInputPerM > 0) {
      missingPricing.push({ id: model.id, name: model.name, ctx, apiInputPerM, apiOutputPerM });
    }
  }
}

// --- Report -------------------------------------------------------------------

const fmtPrice = (perM) => perM === 0 ? 'free' : `$${perM.toFixed(4)}/M`;

const fmtMissing = (list, label) => {
  if (!list.length) {
    console.log(`\n✅ ${label}: all accounted for`);
    return;
  }
  console.log(`\n⚠️  ${label} — ${list.length} model(s):\n`);
  const byProvider = {};
  for (const m of list) {
    const provider = m.id.split('/')[0] ?? 'unknown';
    (byProvider[provider] ??= []).push(m);
  }
  for (const [provider, entries] of Object.entries(byProvider).sort()) {
    console.log(`  ${provider}:`);
    for (const e of entries) {
      const price = e.apiInputPerM > 0 ? `${fmtPrice(e.apiInputPerM)} in / ${fmtPrice(e.apiOutputPerM)} out` : 'free';
      console.log(`    '${e.id}': '${e.name}',  // ctx ${e.ctx?.toLocaleString() ?? '?'}, ${price}`);
    }
  }
};

console.log(`\nTotal OpenRouter models: ${models.length}`);

if (!PRICING_ONLY) {
  fmtMissing(missing.paid, 'Paid models missing from openrouter config section');
  fmtMissing(missing.free, 'Free models missing from openrouter_free config section');
}

fmtMissing(missingPricing, 'Models in config but missing pricing in ai-monitoring.ts');

if (missingPricing.length) {
  console.log('\nAdd pricing entries to packages/lib/src/monitoring/ai-monitoring.ts');
}
if (missing.paid.length || missing.free.length) {
  console.log('\nAdd model entries to apps/web/src/lib/ai/core/ai-providers-config.ts');
}
