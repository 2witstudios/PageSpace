#!/usr/bin/env bun
/**
 * Migration Script: Move AI model selections onto OpenRouter-backed model IDs.
 *
 * The PageSpace/GLM provider and the OpenRouter-free provider were removed; every
 * model is now served through OpenRouter under its real vendor (openai/…, anthropic/…).
 * This resets any stored selection that referenced a removed provider/model (the
 * `pagespace`/`glm`/`openrouter_free` providers, the `standard`/`pro` aliases, the
 * `glm-*` and `z-ai/*` model ids, or any `:free` model) to the product default. It
 * also sweeps any non-local cloud row whose model id is a bare, non-vendor-prefixed
 * name (e.g. a raw API caller that set provider `google`, model `gemini-2.5-flash`),
 * since every valid cloud model id is now `vendor/model`.
 *
 * Idempotent: rows already on the new default are not matched.
 *
 * Data-hygiene only: `createAIProvider()` already substitutes the default at
 * generation time for any stale/off-catalog selection, so un-migrated rows keep
 * working (they just resolve to the default). Run this to normalize the stored
 * values so the DB reflects reality and the picker shows the right selection.
 *
 * Run with: bun run scripts/migrate-ai-models-to-openrouter.ts
 */

import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { and, or, eq, inArray, like, sql } from '@pagespace/db/operators';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'openai/gpt-5.3-chat';

// Providers that no longer exist after the refactor.
const REMOVED_PROVIDERS = ['pagespace', 'openrouter', 'openrouter_free', 'glm'];
// Model ids/aliases that no longer exist (GLM family + tier aliases).
const REMOVED_MODELS = ['standard', 'pro', 'glm-4.5-air', 'glm-4.7', 'glm-5', 'glm-4.6'];

// Belt-and-suspenders: any cloud (non-local) selection whose model id is a bare,
// non-OpenRouter-prefixed name (e.g. a raw API caller that set provider 'google',
// model 'gemini-2.5-flash'). Every valid cloud model id is now vendor-prefixed
// ('vendor/model'), so a non-local provider with a slash-less model is stale.
// Inlined per table because the column refs differ (users vs pages).

async function migrate() {
  console.log('🚀 Migrating AI model selections onto OpenRouter…');

  // --- users.currentAiProvider / currentAiModel ---
  const userResult = await db
    .update(users)
    .set({ currentAiProvider: DEFAULT_PROVIDER, currentAiModel: DEFAULT_MODEL })
    .where(
      or(
        inArray(users.currentAiProvider, REMOVED_PROVIDERS),
        inArray(users.currentAiModel, REMOVED_MODELS),
        like(users.currentAiModel, 'glm-%'),
        like(users.currentAiModel, 'z-ai/%'),
        like(users.currentAiModel, '%:free'),
        sql`${users.currentAiProvider} not in ('ollama','lmstudio','azure_openai') and ${users.currentAiModel} not like '%/%'`,
      )
    )
    .returning({ id: users.id });
  console.log(`✅ users updated: ${userResult.length}`);

  // --- pages (AI_CHAT agents) aiProvider / aiModel ---
  const pageResult = await db
    .update(pages)
    .set({ aiProvider: DEFAULT_PROVIDER, aiModel: DEFAULT_MODEL })
    .where(
      and(
        eq(pages.type, 'AI_CHAT'),
        or(
          inArray(pages.aiProvider, REMOVED_PROVIDERS),
          inArray(pages.aiModel, REMOVED_MODELS),
          like(pages.aiModel, 'glm-%'),
          like(pages.aiModel, 'z-ai/%'),
          like(pages.aiModel, '%:free'),
          sql`${pages.aiProvider} not in ('ollama','lmstudio','azure_openai') and ${pages.aiModel} is not null and ${pages.aiModel} not like '%/%'`,
        )
      )
    )
    .returning({ id: pages.id });
  console.log(`✅ agent pages updated: ${pageResult.length}`);

  // --- verify nothing left on a removed provider ---
  const [{ count: remaining }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(inArray(users.currentAiProvider, REMOVED_PROVIDERS));
  if (remaining > 0) {
    console.warn(`⚠️  ${remaining} users still reference a removed provider — re-run or inspect.`);
  } else {
    console.log('✅ No users remain on a removed provider.');
  }

  console.log('🎉 Migration complete.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  });
