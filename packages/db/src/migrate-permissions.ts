import { db, sql } from './index';
import { permissions, pagePermissions, driveMembers } from './schema';
import { eq, and } from 'drizzle-orm';

async function migratePermissions() {
  console.log('Starting permissions migration...');
  
  try {
    // 1. Fetch all existing permissions
    const existingPermissions = await db.select().from(permissions);
    console.log(`Found ${existingPermissions.length} existing permissions to migrate`);
    
    // 2. Convert and insert into new page_permissions table
    for (const perm of existingPermissions) {
      // Check if permission already exists in new table
      const existing = await db.select()
        .from(pagePermissions)
        .where(and(
          eq(pagePermissions.pageId, perm.pageId),
          eq(pagePermissions.userId, perm.subjectId)
        ))
        .limit(1);
      
      if (existing.length > 0) {
        // Update existing permission
        await db.update(pagePermissions)
          .set({
            canView: existing[0].canView || perm.action === 'VIEW' || perm.action === 'EDIT' || perm.action === 'SHARE' || perm.action === 'DELETE',
            canEdit: existing[0].canEdit || perm.action === 'EDIT' || perm.action === 'SHARE' || perm.action === 'DELETE',
            canShare: existing[0].canShare || perm.action === 'SHARE' || perm.action === 'DELETE',
            canDelete: existing[0].canDelete || perm.action === 'DELETE',
          })
          .where(eq(pagePermissions.id, existing[0].id));
      } else if (perm.subjectType === 'USER') {
        // Insert new permission (only for USER type)
        await db.insert(pagePermissions).values({
          pageId: perm.pageId,
          userId: perm.subjectId,
          canView: perm.action === 'VIEW' || perm.action === 'EDIT' || perm.action === 'SHARE' || perm.action === 'DELETE',
          canEdit: perm.action === 'EDIT' || perm.action === 'SHARE' || perm.action === 'DELETE',
          canShare: perm.action === 'SHARE' || perm.action === 'DELETE',
          canDelete: perm.action === 'DELETE',
          grantedAt: perm.createdAt,
        });
      }
    }
    
    // 3. Create drive_members entries from existing permissions
    const driveUsersMap = new Map<string, Set<string>>();
    
    // Get all pages with their drive IDs
    const { rows: pagesWithDrives } = await db.execute(sql`
      SELECT DISTINCT p.id, p."driveId", perm."subjectId"
      FROM pages p
      JOIN permissions perm ON perm."pageId" = p.id
      WHERE perm."subjectType" = 'USER'
    `);
    
    // Build map of drives to users
    for (const row of pagesWithDrives as any[]) {
      if (!driveUsersMap.has(row.driveId)) {
        driveUsersMap.set(row.driveId, new Set());
      }
      driveUsersMap.get(row.driveId)!.add(row.subjectId);
    }
    
    // Create drive members
    for (const [driveId, userIds] of driveUsersMap) {
      for (const userId of userIds) {
        // Check if member already exists
        const existingMember = await db.select()
          .from(driveMembers)
          .where(and(
            eq(driveMembers.driveId, driveId),
            eq(driveMembers.userId, userId)
          ))
          .limit(1);
        
        if (existingMember.length === 0) {
          // Get drive owner to set as inviter
          const { rows: driveOwner } = await db.execute(sql`
            SELECT "ownerId" FROM drives WHERE id = ${driveId}
          `);
          
          await db.insert(driveMembers).values({
            driveId,
            userId,
            role: 'MEMBER',
            invitedBy: (driveOwner[0] as any)?.ownerId || null,
            acceptedAt: new Date(),
          });
        }
      }
    }
    
    // 4. Also add drive owners as drive members
    const { rows: drives } = await db.execute(sql`
      SELECT id, "ownerId" FROM drives
    `);
    
    for (const drive of drives as any[]) {
      const existingOwner = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, drive.id),
          eq(driveMembers.userId, drive.ownerId)
        ))
        .limit(1);
      
      if (existingOwner.length === 0) {
        await db.insert(driveMembers).values({
          driveId: drive.id,
          userId: drive.ownerId,
          role: 'OWNER',
          acceptedAt: new Date(),
        });
      }
    }
    
    console.log('Migration completed successfully!');
    console.log(`Migrated ${existingPermissions.length} permissions`);
    console.log(`Created ${driveUsersMap.size} drive member relationships`);
    
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migratePermissions()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { migratePermissions };