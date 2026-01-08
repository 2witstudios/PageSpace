#!/usr/bin/env tsx
import { db, refreshTokens, mcpTokens } from '@pagespace/db';
import { eq, isNull, sql } from 'drizzle-orm';
import { createHash } from 'crypto';

interface CliOptions {
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='))?.split('=')[1];
  const parsedBatchSize = parseInt(batchSizeArg ?? '1000', 10);

  // Validate batch size to prevent NaN or invalid values
  if (isNaN(parsedBatchSize) || parsedBatchSize <= 0) {
    console.error('Error: --batch-size must be a positive integer');
    process.exit(1);
  }

  return {
    dryRun: args.includes('--dry-run'),
    batchSize: parsedBatchSize
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getTokenPrefix(token: string): string {
  return token.substring(0, 12);
}

type TokenTable = typeof refreshTokens | typeof mcpTokens;

async function migrateTokenTable<TTable extends TokenTable>(
  tableName: string,
  table: TTable,
  batchSize: number,
  dryRun: boolean
): Promise<number> {
  console.log(`\nMigrating ${tableName} (batch size: ${batchSize})...`);

  const counts = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(isNull(table.tokenHash));
  const unmigrated = Number(counts[0]?.count ?? 0);

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
        .select({ id: table.id, token: table.token })
        .from(table)
        .where(isNull(table.tokenHash))
        .limit(batchSize);

      if (tokens.length === 0) return 0;

      const updates = tokens.map(t => ({
        id: t.id,
        tokenHash: hashToken(t.token),
        tokenPrefix: getTokenPrefix(t.token),
      }));

      for (const update of updates) {
        await tx
          .update(table)
          .set({ tokenHash: update.tokenHash, tokenPrefix: update.tokenPrefix })
          .where(eq(table.id, update.id));
      }

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
    const refreshCount = await migrateTokenTable(
      'refresh_tokens',
      refreshTokens,
      options.batchSize,
      options.dryRun
    );
    const mcpCount = await migrateTokenTable(
      'mcp_tokens',
      mcpTokens,
      options.batchSize,
      options.dryRun
    );

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
