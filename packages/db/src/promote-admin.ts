import { db, users, eq } from './index';

const email = process.argv[2];

if (!email) {
  console.error('Usage: pnpm --filter @pagespace/db promote-admin <email>');
  process.exit(1);
}

async function promoteToAdmin() {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      console.error(`User with email ${email} not found`);
      process.exit(1);
    }

    if (user.role === 'admin') {
      console.log(`User ${email} is already an admin`);
      return;
    }

    await db.update(users)
      .set({ role: 'admin' })
      .where(eq(users.email, email));

    console.log(`Successfully promoted ${email} to admin`);
  } catch (error) {
    console.error('Error promoting user to admin:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

promoteToAdmin();