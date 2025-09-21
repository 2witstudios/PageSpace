import { db, users, eq } from '@pagespace/db';

async function migrateNormalToFree() {
  console.log('Starting migration: "normal" tier to "free"...');

  try {
    const updatedUsers = await db
      .update(users)
      .set({ subscriptionTier: 'free' })
      .where(eq(users.subscriptionTier, 'normal'))
      .returning({
        id: users.id,
        email: users.email,
      });

    if (updatedUsers.length > 0) {
      console.log(`Successfully migrated ${updatedUsers.length} users:`);
      updatedUsers.forEach(user => {
        console.log(`  - User ID: ${user.id}, Email: ${user.email}`);
      });
    } else {
      console.log('No users with "normal" tier found. No migration needed.');
    }

    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
}

migrateNormalToFree();