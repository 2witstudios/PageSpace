#!/usr/bin/env tsx
import { db, refreshTokens, mcpTokens } from '@pagespace/db';
import { isNull, sql } from 'drizzle-orm';
import { createHash } from 'crypto';

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    batchSize: parseInt(
      args.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] ?? '1000'
    )
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getTokenPrefix(token: string): string {
  return token.substring(0, 12);
}

async function migrateRefreshTokens(batchSize: number, dryRun: boolean): Promise<number> {
  console.log(`\nMigrating refresh_tokens (batch size: ${batchSize})...`);

  const counts = await db.execute(
    sql.raw(`SELECT COUNT(*) as count FROM refresh_tokens WHERE token_hash IS NULL`)
  );
  const unmigrated = Number(counts.rows[0]?.count ?? 0);

  if (unmigrated === 0) {
    console.log('  ✓ All tokens already migrated');
    return 0;
  }

  console.log(`  Unmigrated: ${unmigrated}`);

  if (dryRun) {
    console.log('  [DRY RUN] Would migrate tokens...');
    return 0;
  }

  let processedTotal = 0;
  while (true) {
    const batchResult = await db.transaction(async (tx) => {
      const tokens = await tx
        .select({ id: refreshTokens.id, token: refreshTokens.token })
        .from(refreshTokens)
        .where(isNull(refreshTokens.tokenHash))
        .limit(batchSize);

      if (tokens.length === 0) return 0;

      const updates = tokens.map(t => ({
        id: t.id,
        tokenHash: hashToken(t.token),
        tokenPrefix: getTokenPrefix(t.token),
      }));

      const values = updates
        .map(u => `('${u.id}', '${u.tokenHash}', '${u.tokenPrefix}')`)
        .join(',');

      await tx.execute(sql.raw(`
        UPDATE refresh_tokens AS rt
        SET token_hash = v.hash, token_prefix = v.prefix
        FROM (VALUES ${values}) AS v(id, hash, prefix)
        WHERE rt.id = v.id
      `));

      return tokens.length;
    });

    if (batchResult === 0) break;

    processedTotal += batchResult;
    const progress = ((processedTotal / unmigrated) * 100).toFixed(1);
    process.stdout.write(`\r  Progress: ${processedTotal}/${unmigrated} (${progress}%)`);
  }

  console.log('\n  ✓ Migration complete');
  return processedTotal;
}

async function migrateMcpTokens(batchSize: number, dryRun: boolean): Promise<number> {
  console.log(`\nMigrating mcp_tokens (batch size: ${batchSize})...`);

  const counts = await db.execute(
    sql.raw(`SELECT COUNT(*) as count FROM mcp_tokens WHERE token_hash IS NULL`)
  );
  const unmigrated = Number(counts.rows[0]?.count ?? 0);

  if (unmigrated === 0) {
    console.log('  ✓ All tokens already migrated');
    return 0;
  }

  console.log(`  Unmigrated: ${unmigrated}`);

  if (dryRun) {
    console.log('  [DRY RUN] Would migrate tokens...');
    return 0;
  }

  let processedTotal = 0;
  while (true) {
    const batchResult = await db.transaction(async (tx) => {
      const tokens = await tx
        .select({ id: mcpTokens.id, token: mcpTokens.token })
        .from(mcpTokens)
        .where(isNull(mcpTokens.tokenHash))
        .limit(batchSize);

      if (tokens.length === 0) return 0;

      const updates = tokens.map(t => ({
        id: t.id,
        tokenHash: hashToken(t.token),
        tokenPrefix: getTokenPrefix(t.token),
      }));

      const values = updates
        .map(u => `('${u.id}', '${u.tokenHash}', '${u.tokenPrefix}')`)
        .join(',');

      await tx.execute(sql.raw(`
        UPDATE mcp_tokens AS mt
        SET token_hash = v.hash, token_prefix = v.prefix
        FROM (VALUES ${values}) AS v(id, hash, prefix)
        WHERE mt.id = v.id
      `));

      return tokens.length;
    });

    if (batchResult === 0) break;

    processedTotal += batchResult;
    const progress = ((processedTotal / unmigrated) * 100).toFixed(1);
    process.stdout.write(`\r  Progress: ${processedTotal}/${unmigrated} (${progress}%)`);
  }

  console.log('\n  ✓ Migration complete');
  return processedTotal;
}

async function main() {
  const options = parseArgs();

  console.log('Token Hash Migration');
  console.log('===================');
  if (options.dryRun) console.log('MODE: DRY RUN\n');

  try {
    const refreshCount = await migrateRefreshTokens(options.batchSize, options.dryRun);
    const mcpCount = await migrateMcpTokens(options.batchSize, options.dryRun);

    console.log('\n===================');
    console.log('Migration Summary');
    console.log('===================');
    console.log(`Refresh tokens migrated: ${refreshCount}`);
    console.log(`MCP tokens migrated: ${mcpCount}`);

    if (!options.dryRun) {
      console.log('\nNext steps:');
      console.log('  1. Run verification: pnpm tsx scripts/verify-token-migration.ts');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n✗ Migration failed:', error);
    process.exit(1);
  }
}

main();
