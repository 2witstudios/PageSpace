#!/usr/bin/env tsx
/**
 * Token Migration Verification Script
 *
 * Verifies that all tokens have been migrated to hashed storage.
 * Run this after the token hashing migration to confirm success.
 *
 * Usage:
 *   pnpm tsx scripts/verify-token-migration.ts [--allow-missing]
 *
 * Options:
 *   --allow-missing   Allow missing tables (useful during partial migrations)
 *
 * Exit codes:
 *   0 - All tokens migrated successfully
 *   1 - Some tokens missing hash or required tables missing (migration incomplete)
 *   2 - Error during verification
 */

import { db } from '@pagespace/db';
import { sql } from 'drizzle-orm';

export interface VerificationResult {
  table: string;
  total: number;
  withHash: number;
  withoutHash: number;
  passed: boolean;
  tableExists: boolean;
}

export async function countTokens(
  tableName: string,
  hashColumn: string
): Promise<VerificationResult> {
  try {
    // Count total tokens
    const totalResult = await db.execute(
      sql.raw(`SELECT COUNT(*) as count FROM ${tableName}`)
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    // Count tokens with hash (use quoted column name for camelCase)
    const withHashResult = await db.execute(
      sql.raw(`SELECT COUNT(*) as count FROM ${tableName} WHERE "${hashColumn}" IS NOT NULL`)
    );
    const withHash = Number(withHashResult.rows[0]?.count ?? 0);

    // Count tokens without hash
    const withoutHash = total - withHash;

    return {
      table: tableName,
      total,
      withHash,
      withoutHash,
      passed: withoutHash === 0,
      tableExists: true,
    };
  } catch (error) {
    // Table or column might not exist yet
    if (error instanceof Error && error.message.includes('does not exist')) {
      console.log(`  ⚠ Table ${tableName} or column ${hashColumn} not found (schema not migrated)`);
      return {
        table: tableName,
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: false, // Fail when table missing unless explicitly allowed
        tableExists: false,
      };
    }
    throw error;
  }
}

export function reportTableStatus(
  result: VerificationResult,
  allowMissing: boolean,
  missingTables: string[]
): boolean {
  console.log(`  Total: ${result.total}`);
  console.log(`  With hash: ${result.withHash}`);
  console.log(`  Without hash: ${result.withoutHash}`);

  if (!result.tableExists) {
    missingTables.push(result.table);
    if (allowMissing) {
      console.log('  ⚠ Table not found (skipped with --allow-missing)\n');
      return true;
    } else {
      console.log('  ✗ Table not found (run migrations first)\n');
      return false;
    }
  }

  if (result.passed) {
    if (result.total > 0) {
      console.log('  ✓ All tokens migrated\n');
    } else {
      console.log('  ⚠ No tokens found\n');
    }
    return true;
  } else {
    console.log('  ✗ Some tokens missing hash\n');
    return false;
  }
}

export async function verifyHashLookup(): Promise<boolean> {
  console.log('Hash Lookup Test:');

  try {
    // Try to select a token with hash (use quoted column names for camelCase)
    const result = await db.execute(
      sql.raw(`
        SELECT id, "tokenHash", "tokenPrefix"
        FROM refresh_tokens
        WHERE "tokenHash" IS NOT NULL
        LIMIT 1
      `)
    );

    if (result.rows.length === 0) {
      console.log('  ⚠ No tokens with hash to verify');
      return true;
    }

    const token = result.rows[0] as { tokenHash?: string; tokenPrefix?: string };
    if (token.tokenHash && token.tokenPrefix) {
      console.log('  ✓ Sample token has valid hash and prefix');
      return true;
    } else {
      console.log('  ✗ Sample token missing hash or prefix');
      return false;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not exist')) {
      console.log('  ⚠ Hash columns not yet added to schema');
      return true; // Not applicable yet
    }
    throw error;
  }
}

export async function main() {
  console.log('Token Migration Verification');
  console.log('============================\n');

  // Parse command line args
  const args = process.argv.slice(2);
  const allowMissing = args.includes('--allow-missing');

  if (allowMissing) {
    console.log('Mode: Allow missing tables\n');
  }

  let allPassed = true;
  const missingTables: string[] = [];

  // Check refresh tokens
  console.log('Refresh Tokens:');
  const refreshResult = await countTokens('refresh_tokens', 'tokenHash');
  if (!reportTableStatus(refreshResult, allowMissing, missingTables)) {
    allPassed = false;
  }

  // Check MCP tokens
  console.log('MCP Tokens:');
  const mcpResult = await countTokens('mcp_tokens', 'tokenHash');
  if (!reportTableStatus(mcpResult, allowMissing, missingTables)) {
    allPassed = false;
  }

  // Check device tokens
  console.log('Device Tokens:');
  const deviceResult = await countTokens('device_tokens', 'tokenHash');
  if (!reportTableStatus(deviceResult, allowMissing, missingTables)) {
    allPassed = false;
  }

  // Check verification tokens
  console.log('Verification Tokens:');
  const verificationResult = await countTokens('verification_tokens', 'tokenHash');
  if (!reportTableStatus(verificationResult, allowMissing, missingTables)) {
    allPassed = false;
  }

  // Verify hash lookup works
  const lookupPassed = await verifyHashLookup();
  if (!lookupPassed) {
    allPassed = false;
  }

  console.log('\n============================');
  if (allPassed) {
    console.log('Migration Status: ✓ COMPLETE');
    if (missingTables.length > 0) {
      console.log('\nNote: The following tables were not found (allowed with --allow-missing):');
      missingTables.forEach((table) => console.log(`  - ${table}`));
    }
    process.exit(0);
  } else {
    console.log('Migration Status: ✗ INCOMPLETE');
    console.log('\nAction Required:');
    if (missingTables.length > 0 && !allowMissing) {
      console.log('  Missing tables detected. Run database migrations first:');
      console.log('    pnpm db:migrate');
      console.log('\n  Or use --allow-missing to skip missing table checks:');
      console.log('    pnpm tsx scripts/verify-token-migration.ts --allow-missing');
    } else {
      console.log('  Some tokens are missing hash values. Run migration:');
      console.log('    pnpm tsx scripts/migrate-token-hashes.ts');
    }
    process.exit(1);
  }
}

// Only run if executed directly (not imported by tests)
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('verify-token-migration.ts')) {
  main().catch((error) => {
    console.error('Verification error:', error);
    process.exit(2);
  });
}
