#!/usr/bin/env tsx
/**
 * Migration script to convert old permissions table to new pagePermissions table
 * Run with: npx tsx src/scripts/migrate-permissions.ts
 */

import { db, permissions, pagePermissions, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

async function migratePermissions() {
  console.log('Starting permission migration...');
  
  try {
    // Fetch all existing permissions
    const oldPermissions = await db.query.permissions.findMany({
      where: eq(permissions.subjectType, 'USER'), // Only migrate user permissions for now
    });
    
    console.log(`Found ${oldPermissions.length} permissions to migrate`);
    
    let migrated = 0;
    let skipped = 0;
    
    for (const perm of oldPermissions) {
      // Check if permission already exists in new table
      const existing = await db.query.pagePermissions.findFirst({
        where: eq(pagePermissions.pageId, perm.pageId) && eq(pagePermissions.userId, perm.subjectId),
      });
      
      if (existing) {
        console.log(`Skipping existing permission for page ${perm.pageId} and user ${perm.subjectId}`);
        skipped++;
        continue;
      }
      
      // Map old action to new boolean permissions
      let canView = false;
      let canEdit = false;
      let canShare = false;
      let canDelete = false;
      
      switch (perm.action) {
        case 'VIEW':
          canView = true;
          break;
        case 'EDIT':
          canView = true;
          canEdit = true;
          break;
        case 'SHARE':
          canView = true;
          canEdit = true;
          canShare = true;
          break;
        case 'DELETE':
          canView = true;
          canEdit = true;
          canShare = true;
          canDelete = true;
          break;
        default:
          console.warn(`Unknown action: ${perm.action}`);
          continue;
      }
      
      // Insert into new table
      await db.insert(pagePermissions).values({
        id: createId(),
        pageId: perm.pageId,
        userId: perm.subjectId,
        canView,
        canEdit,
        canShare,
        canDelete,
        grantedBy: null, // Old permissions table doesn't track who granted
        grantedAt: perm.createdAt || new Date(),
      });
      
      migrated++;
      
      if (migrated % 10 === 0) {
        console.log(`Migrated ${migrated} permissions...`);
      }
    }
    
    console.log(`\nMigration complete!`);
    console.log(`- Migrated: ${migrated} permissions`);
    console.log(`- Skipped: ${skipped} existing permissions`);
    console.log(`\nOld permissions table still exists for rollback if needed.`);
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migratePermissions()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });