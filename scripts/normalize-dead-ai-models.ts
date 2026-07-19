#!/usr/bin/env bun
/**
 * Audit + migration: rewrite any stored AI-model selection that is no longer a
 * real, current catalog model onto the product default.
 *
 * Why: AI routing moved off the virtual `pagespace` provider and its tier aliases
 * (`standard`/`pro`/`business`, GLM-backed) to route every cloud model through
 * OpenRouter under its real vendor id (#1530/#1531). Selections stored before that
 * cutover can now point at models that no longer exist. `createAIProvider()` already
 * substitutes the default at request time, so nothing is broken — but the stored
 * value lies (the picker shows a dead model). This normalizes the stored values.
 *
 * Validity is checked against the SAME catalog the app uses (`isValidModel`), so this
 * is authoritative — strictly more thorough than the token-heuristic in
 * `migrate-ai-models-to-openrouter.ts` (which misses retired but vendor-prefixed ids).
 *
 * Two user-selectable surfaces:
 *   - users.currentAiProvider / currentAiModel  (account-level selector)
 *   - pages.aiProvider / aiModel for type='AI_CHAT'  (per-agent override; null=inherit)
 *
 * Dynamic/local providers (ollama/lmstudio/azure_openai) are exempt — their catalogs
 * are discovered at runtime and aren't in the static AI_PROVIDERS map.
 *
 * Dry-run by default (audit only). Pass --apply to write.
 *   bun run scripts/normalize-dead-ai-models.ts            # audit
 *   bun run scripts/normalize-dead-ai-models.ts --apply    # apply
 */

import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { eq, inArray } from '@pagespace/db/operators';
import {
  isValidModel,
  isDynamicModelProvider,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
} from '../apps/web/src/lib/ai/core/ai-providers-config';

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db).
const db = getMigrationDb();

const APPLY = process.argv.includes('--apply');

/**
 * A stored (provider, model) pair is "dead" when a cloud provider is set but the pair
 * isn't a real current catalog model. Dynamic/local providers are exempt (runtime
 * catalogs). An empty/missing model under a real cloud provider is also dead — the
 * provider is set but resolves to nothing concrete.
 */
function isDeadSelection(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!provider) return false; // nothing selected → inherits default, fine
  if (isDynamicModelProvider(provider)) return false; // ollama/lmstudio/azure: runtime-discovered
  if (!model) return true; // cloud provider set with no concrete model → dead
  return !isValidModel(provider, model);
}

/** Print a "(provider, model) → count" breakdown of the rows that will change. */
function reportBreakdown(
  label: string,
  rows: Array<{ provider: string | null; model: string | null }>,
): void {
  console.log(`\n${label}: ${rows.length} dead row(s)`);
  if (rows.length === 0) return;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.provider ?? '∅'}  /  ${r.model ?? '∅'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of sorted) {
    console.log(`   ${String(count).padStart(6)}  ${key}`);
  }
}

async function run(): Promise<void> {
  console.log(
    `🔎 ${APPLY ? 'APPLYING' : 'AUDIT (dry-run)'} — normalizing dead AI-model selections`,
  );
  console.log(`   default → ${DEFAULT_PROVIDER} / ${DEFAULT_MODEL}\n`);

  // --- users.currentAiProvider / currentAiModel ---
  const allUsers = await db
    .select({
      id: users.id,
      provider: users.currentAiProvider,
      model: users.currentAiModel,
    })
    .from(users);
  const deadUsers = allUsers.filter((u) => isDeadSelection(u.provider, u.model));
  reportBreakdown('users.currentAiModel', deadUsers);

  // --- pages (AI_CHAT) aiProvider / aiModel ---
  const allAgentPages = await db
    .select({
      id: pages.id,
      provider: pages.aiProvider,
      model: pages.aiModel,
    })
    .from(pages)
    .where(eq(pages.type, 'AI_CHAT'));
  const deadPages = allAgentPages.filter((p) => isDeadSelection(p.provider, p.model));
  reportBreakdown("pages.aiModel (type='AI_CHAT')", deadPages);

  if (!APPLY) {
    console.log(
      `\n📋 Dry-run only. ${deadUsers.length} user(s) + ${deadPages.length} agent page(s) would be reset.`,
    );
    console.log('   Re-run with --apply to write the changes.');
    return;
  }

  // --- apply ---
  if (deadUsers.length > 0) {
    await db
      .update(users)
      .set({ currentAiProvider: DEFAULT_PROVIDER, currentAiModel: DEFAULT_MODEL })
      .where(inArray(users.id, deadUsers.map((u) => u.id)));
  }
  console.log(`✅ users reset: ${deadUsers.length}`);

  if (deadPages.length > 0) {
    await db
      .update(pages)
      .set({ aiProvider: DEFAULT_PROVIDER, aiModel: DEFAULT_MODEL })
      .where(inArray(pages.id, deadPages.map((p) => p.id)));
  }
  console.log(`✅ agent pages reset: ${deadPages.length}`);

  // --- verify nothing dead remains ---
  const usersAfter = await db
    .select({ id: users.id, provider: users.currentAiProvider, model: users.currentAiModel })
    .from(users);
  const pagesAfter = await db
    .select({ id: pages.id, provider: pages.aiProvider, model: pages.aiModel })
    .from(pages)
    .where(eq(pages.type, 'AI_CHAT'));
  const usersStillDead = usersAfter.filter((u) => isDeadSelection(u.provider, u.model)).length;
  const pagesStillDead = pagesAfter.filter((p) => isDeadSelection(p.provider, p.model)).length;

  if (usersStillDead > 0 || pagesStillDead > 0) {
    console.warn(
      `⚠️  Dead rows remain after apply — users: ${usersStillDead}, pages: ${pagesStillDead}. Inspect.`,
    );
  } else {
    console.log('✅ Verified: 0 dead selections remain in either table.');
  }
  console.log('🎉 Done.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Failed:', err);
    process.exit(1);
  });
