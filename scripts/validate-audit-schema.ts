/**
 * Validation script for audit trail schema
 *
 * This script performs static analysis of the audit trail schema
 * to ensure it meets all requirements.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

function validateAuditSchema(): ValidationResult {
  const result: ValidationResult = {
    passed: true,
    errors: [],
    warnings: [],
  };

  try {
    // Read the audit schema file
    const schemaPath = join(
      __dirname,
      '../packages/db/src/schema/audit.ts'
    );
    const schemaContent = readFileSync(schemaPath, 'utf-8');

    // Check for required tables
    const requiredTables = [
      'auditEvents',
      'pageVersions',
      'aiOperations',
    ];

    for (const table of requiredTables) {
      if (!schemaContent.includes(`export const ${table}`)) {
        result.errors.push(`Missing table export: ${table}`);
        result.passed = false;
      }
    }

    // Check for required enums
    const requiredEnums = [
      'auditActionType',
      'auditEntityType',
      'aiAgentType',
    ];

    for (const enumName of requiredEnums) {
      if (!schemaContent.includes(`export const ${enumName}`)) {
        result.errors.push(`Missing enum export: ${enumName}`);
        result.passed = false;
      }
    }

    // Check for required imports
    const requiredImports = [
      'drizzle-orm/pg-core',
      'drizzle-orm',
      '@paralleldrive/cuid2',
      './auth',
      './core',
    ];

    for (const importPath of requiredImports) {
      if (!schemaContent.includes(`from '${importPath}'`)) {
        result.errors.push(`Missing import: ${importPath}`);
        result.passed = false;
      }
    }

    // Check for relations
    const requiredRelations = [
      'auditEventsRelations',
      'pageVersionsRelations',
      'aiOperationsRelations',
    ];

    for (const relation of requiredRelations) {
      if (!schemaContent.includes(`export const ${relation}`)) {
        result.errors.push(`Missing relation export: ${relation}`);
        result.passed = false;
      }
    }

    // Check for critical indexes
    const criticalIndexes = [
      'driveCreatedIdx',
      'userCreatedIdx',
      'entityIdx',
      'pageVersionIdx',
      'pageCreatedIdx',
    ];

    for (const index of criticalIndexes) {
      if (!schemaContent.includes(index)) {
        result.warnings.push(
          `Index not found (might be named differently): ${index}`
        );
      }
    }

    // Check for JSONB fields
    const jsonbFields = [
      'beforeState',
      'afterState',
      'changes',
      'metadata',
      'content',
    ];

    for (const field of jsonbFields) {
      if (!schemaContent.includes(`${field}:`)) {
        result.warnings.push(`JSONB field not found: ${field}`);
      }
    }

    // Check schema is exported in main schema file
    const schemaIndexPath = join(
      __dirname,
      '../packages/db/src/schema.ts'
    );
    const schemaIndexContent = readFileSync(schemaIndexPath, 'utf-8');

    if (!schemaIndexContent.includes("from './schema/audit'")) {
      result.errors.push(
        'Audit schema not exported from packages/db/src/schema.ts'
      );
      result.passed = false;
    }

    // Check lib utilities exist
    const auditIndexPath = join(
      __dirname,
      '../packages/lib/src/audit/index.ts'
    );
    try {
      const auditIndexContent = readFileSync(auditIndexPath, 'utf-8');

      const requiredExports = [
        'createAuditEvent',
        'createPageVersion',
        'trackAiOperation',
        'getDriveActivityFeed',
      ];

      for (const exportName of requiredExports) {
        if (!auditIndexContent.includes(exportName)) {
          result.errors.push(
            `Missing utility export: ${exportName}`
          );
          result.passed = false;
        }
      }
    } catch (err) {
      result.errors.push(
        'Audit utilities not found at packages/lib/src/audit/index.ts'
      );
      result.passed = false;
    }

    // Check documentation exists
    const docPath = join(
      __dirname,
      '../docs/3.0-guides-and-tools/audit-trail-and-versioning.md'
    );
    try {
      readFileSync(docPath, 'utf-8');
    } catch (err) {
      result.warnings.push(
        'Main documentation file not found at docs/3.0-guides-and-tools/audit-trail-and-versioning.md'
      );
    }
  } catch (error: any) {
    result.errors.push(`Validation failed: ${error.message}`);
    result.passed = false;
  }

  return result;
}

// Run validation
const result = validateAuditSchema();

console.log('\n=== Audit Trail Schema Validation ===\n');

if (result.passed) {
  console.log('✅ PASSED - All required components present\n');
} else {
  console.log('❌ FAILED - Missing required components\n');
}

if (result.errors.length > 0) {
  console.log('Errors:');
  result.errors.forEach((error) => console.log(`  ❌ ${error}`));
  console.log('');
}

if (result.warnings.length > 0) {
  console.log('Warnings:');
  result.warnings.forEach((warning) =>
    console.log(`  ⚠️  ${warning}`)
  );
  console.log('');
}

console.log('=== Validation Complete ===\n');

// Exit with error code if validation failed
process.exit(result.passed ? 0 : 1);
