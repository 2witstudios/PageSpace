import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, pages, driveMembers, userProfiles, users, eq, and } from '@pagespace/db';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/server';

/**
 * Unified assignee type for task assignment
 * Includes both human users (members) and AI agents
 */
interface Assignee {
  id: string;
  type: 'user' | 'agent';
  name: string;
  image: string | null;
  // For agents only
  agentTitle?: string;
}

/**
 * GET /api/drives/{driveId}/assignees
 * Returns both drive members (users) and AI agents for task assignment
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['jwt'] as const });
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;

    // Verify drive access
    const hasDriveAccess = await getUserDriveAccess(userId, driveId);
    if (!hasDriveAccess) {
      return NextResponse.json(
        { error: 'You don\'t have access to this drive' },
        { status: 403 }
      );
    }

    // Fetch members with their profiles
    const members = await db
      .select({
        userId: driveMembers.userId,
        role: driveMembers.role,
        user: {
          id: users.id,
          email: users.email,
          name: users.name,
          image: users.image,
        },
        profile: {
          displayName: userProfiles.displayName,
          avatarUrl: userProfiles.avatarUrl,
        },
      })
      .from(driveMembers)
      .leftJoin(users, eq(driveMembers.userId, users.id))
      .leftJoin(userProfiles, eq(driveMembers.userId, userProfiles.userId))
      .where(eq(driveMembers.driveId, driveId));

    // Fetch AI agents in the drive
    const allAgents = await db
      .select({
        id: pages.id,
        title: pages.title,
      })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      ))
      .orderBy(pages.position);

    // Filter agents by view permissions (parallel checks for performance)
    const agentAccessResults = await Promise.all(
      allAgents.map(async (agent) => ({
        agent,
        canView: await canUserViewPage(userId, agent.id),
      }))
    );
    const accessibleAgents = agentAccessResults
      .filter((r) => r.canView)
      .map((r) => r.agent);

    // Build unified assignee list
    const assignees: Assignee[] = [];

    // Add members (filter out those with null user)
    const validMembers = members.filter((m) => m.user);
    for (const member of validMembers) {
      assignees.push({
        id: member.userId,
        type: 'user',
        name: member.profile?.displayName || member.user!.name || member.user!.email,
        image: member.profile?.avatarUrl || member.user!.image || null,
      });
    }

    // Add agents
    for (const agent of accessibleAgents) {
      assignees.push({
        id: agent.id,
        type: 'agent',
        name: agent.title || 'Unnamed Agent',
        image: null, // Agents don't have avatars (yet)
        agentTitle: agent.title || undefined,
      });
    }

    return NextResponse.json({
      assignees,
      counts: {
        members: validMembers.length,
        agents: accessibleAgents.length,
        total: assignees.length,
      },
    });

  } catch (error) {
    console.error('Error fetching assignees:', error);
    return NextResponse.json(
      { error: `Failed to fetch assignees: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
