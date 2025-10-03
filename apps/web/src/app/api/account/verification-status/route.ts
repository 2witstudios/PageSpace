import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, users, eq } from '@pagespace/db';

export async function GET(request: Request) {
  try {
    const authUser = await verifyAuth(request);
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch user's email verification status
    const [user] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, authUser.id))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ emailVerified: user.emailVerified });
  } catch (error) {
    console.error('Error fetching verification status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch verification status' },
      { status: 500 }
    );
  }
}
