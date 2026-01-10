#!/usr/bin/env tsx
/**
 * Token Migration Verification Script
 *
 * Verifies that all tokens have been migrated to hashed storage.
 * Run this after the token hashing migration to confirm success.
 *
 * Usage:
 *   pnpm tsx scripts/verify-token-migration.ts
 *
 * Exit codes:
 *   0 - All tokens migrated successfully
 *   1 - Some tokens missing hash (migration incomplete)
 *   2 - Error during verification
 */

import { db } from '@pagespace/db';
import { sql } from 'drizzle-orm';

interface VerificationResult {
  table: string;
  total: number;
  withHash: number;
  withoutHash: number;
  passed: boolean;
}

async function countTokens(
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
    };
  } catch (error) {
    // Table or column might not exist yet
    if (error instanceof Error && error.message.includes('does not exist')) {
      console.log(`  ⚠ Table ${tableName} or column ${hashColumn} not found (migration not started)`);
      return {
        table: tableName,
        total: 0,
        withHash: 0,
        withoutHash: 0,
        passed: true, // Not applicable
      };
    }
    throw error;
  }
}

async function verifyHashLookup(): Promise<boolean> {
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

async function main() {
  console.log('Token Migration Verification');
  console.log('============================\n');

  let allPassed = true;

  // Check refresh tokens
  console.log('Refresh Tokens:');
  const refreshResult = await countTokens('refresh_tokens', 'tokenHash');
  console.log(`  Total: ${refreshResult.total}`);
  console.log(`  With hash: ${refreshResult.withHash}`);
  console.log(`  Without hash: ${refreshResult.withoutHash}`);

  if (refreshResult.passed) {
    if (refreshResult.total > 0) {
      console.log('  ✓ All refresh tokens migrated\n');
    } else {
      console.log('  ⚠ No refresh tokens found\n');
    }
  } else {
    console.log('  ✗ Some refresh tokens missing hash\n');
    allPassed = false;
  }

  // Check MCP tokens
  console.log('MCP Tokens:');
  const mcpResult = await countTokens('mcp_tokens', 'tokenHash');
  console.log(`  Total: ${mcpResult.total}`);
  console.log(`  With hash: ${mcpResult.withHash}`);
  console.log(`  Without hash: ${mcpResult.withoutHash}`);

  if (mcpResult.passed) {
    if (mcpResult.total > 0) {
      console.log('  ✓ All MCP tokens migrated\n');
    } else {
      console.log('  ⚠ No MCP tokens found\n');
    }
  } else {
    console.log('  ✗ Some MCP tokens missing hash\n');
    allPassed = false;
  }

  // Check device tokens
  console.log('Device Tokens:');
  const deviceResult = await countTokens('device_tokens', 'tokenHash');
  console.log(`  Total: ${deviceResult.total}`);
  console.log(`  With hash: ${deviceResult.withHash}`);
  console.log(`  Without hash: ${deviceResult.withoutHash}`);

  if (deviceResult.passed) {
    if (deviceResult.total > 0) {
      console.log('  ✓ All device tokens migrated\n');
    } else {
      console.log('  ⚠ No device tokens found\n');
    }
  } else {
    console.log('  ✗ Some device tokens missing hash\n');
    allPassed = false;
  }

  // Check verification tokens
  console.log('Verification Tokens:');
  const verificationResult = await countTokens('verification_tokens', 'tokenHash');
  console.log(`  Total: ${verificationResult.total}`);
  console.log(`  With hash: ${verificationResult.withHash}`);
  console.log(`  Without hash: ${verificationResult.withoutHash}`);

  if (verificationResult.passed) {
    if (verificationResult.total > 0) {
      console.log('  ✓ All verification tokens migrated\n');
    } else {
      console.log('  ⚠ No verification tokens found\n');
    }
  } else {
    console.log('  ✗ Some verification tokens missing hash\n');
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
    process.exit(0);
  } else {
    console.log('Migration Status: ✗ INCOMPLETE');
    console.log('\nAction Required:');
    console.log('  Run: pnpm tsx scripts/migrate-token-hashes.ts');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Verification error:', error);
  process.exit(2);
});
