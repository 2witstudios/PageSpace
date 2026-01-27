import { db, users, emailNotificationPreferences, emailNotificationLog, emailUnsubscribeTokens, eq, and } from '@pagespace/db';
import { sendEmail } from './email-service';
import { DriveInvitationEmail } from '../email-templates/DriveInvitationEmail';
import { DirectMessageEmail } from '../email-templates/DirectMessageEmail';
import { ConnectionRequestEmail } from '../email-templates/ConnectionRequestEmail';
import { PageSharedEmail } from '../email-templates/PageSharedEmail';
import { CollaboratorAddedEmail } from '../email-templates/CollaboratorAddedEmail';
import { ConnectionAcceptedEmail } from '../email-templates/ConnectionAcceptedEmail';
import { ConnectionRejectedEmail } from '../email-templates/ConnectionRejectedEmail';
import { PermissionRevokedEmail } from '../email-templates/PermissionRevokedEmail';
import { PermissionUpdatedEmail } from '../email-templates/PermissionUpdatedEmail';
import { DriveJoinedEmail } from '../email-templates/DriveJoinedEmail';
import { DriveRoleChangedEmail } from '../email-templates/DriveRoleChangedEmail';
import { hashToken, getTokenPrefix } from '../auth/token-utils';
import { randomBytes } from 'crypto';
import type { ReactElement } from 'react';

type NotificationType =
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_REVOKED'
  | 'PERMISSION_UPDATED'
  | 'PAGE_SHARED'
  | 'DRIVE_INVITED'
  | 'DRIVE_JOINED'
  | 'DRIVE_ROLE_CHANGED'
  | 'CONNECTION_REQUEST'
  | 'CONNECTION_ACCEPTED'
  | 'CONNECTION_REJECTED'
  | 'NEW_DIRECT_MESSAGE'
  | 'EMAIL_VERIFICATION_REQUIRED'
  | 'TOS_PRIVACY_UPDATED'
  | 'MENTION'
  | 'TASK_ASSIGNED';

interface NotificationEmailData {
  userId: string;
  notificationId?: string;
  type: NotificationType;
  metadata: Record<string, unknown>;
}

// Generate unsubscribe token for a specific user and notification type
// Uses opaque tokens stored in database (replaces JWT for P5-T5 Legacy JWT Deprecation)
async function generateUnsubscribeToken(userId: string, notificationType: NotificationType): Promise<string> {
  // Generate opaque token with prefix for identification
  const token = `ps_unsub_${randomBytes(24).toString('base64url')}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = getTokenPrefix(token);

  // Store in database with 365-day expiry
  await db.insert(emailUnsubscribeTokens).values({
    tokenHash,
    tokenPrefix,
    userId,
    notificationType,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 365 days
  });

  return token;
}

// Check if user has email notifications enabled for this type
async function isEmailNotificationEnabled(userId: string, notificationType: NotificationType): Promise<boolean> {
  try {
    const preference = await db.query.emailNotificationPreferences.findFirst({
      where: and(
        eq(emailNotificationPreferences.userId, userId),
        eq(emailNotificationPreferences.notificationType, notificationType)
      ),
    });

    // Default to enabled if no preference set
    return preference ? preference.emailEnabled : true;
  } catch (error) {
    console.error('Error checking email notification preference:', error);
    // Default to enabled on error
    return true;
  }
}

// Log email notification attempt
async function logEmailNotification(
  userId: string,
  notificationId: string | undefined,
  notificationType: NotificationType,
  recipientEmail: string,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  try {
    await db.insert(emailNotificationLog).values({
      userId,
      notificationId,
      notificationType,
      recipientEmail,
      success,
      errorMessage,
    });
  } catch (error) {
    console.error('Failed to log email notification:', error);
  }
}

// Template registry
interface TemplateData {
  subject: string;
  component: ReactElement;
}

function getEmailTemplate(data: NotificationEmailData, user: { name: string; email: string }, unsubscribeUrl: string): TemplateData | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  switch (data.type) {
    case 'DRIVE_INVITED':
      return {
        subject: `You've been added to ${data.metadata.driveName}`,
        component: DriveInvitationEmail({
          userName: user.name,
          inviterName: (data.metadata.inviterName as string) || 'Someone',
          driveName: (data.metadata.driveName as string) || 'a workspace',
          acceptUrl: `${appUrl}/dashboard/${data.metadata.driveId}`,
          unsubscribeUrl,
        }),
      };

    case 'NEW_DIRECT_MESSAGE':
      return {
        subject: `New message from ${data.metadata.senderName}`,
        component: DirectMessageEmail({
          userName: user.name,
          senderName: (data.metadata.senderName as string) || 'Someone',
          messagePreview: (data.metadata.messagePreview as string) || 'New message received',
          viewUrl: `${appUrl}/dashboard/messages/${data.metadata.conversationId}`,
          unsubscribeUrl,
        }),
      };

    case 'CONNECTION_REQUEST':
      return {
        subject: `${data.metadata.requesterName} wants to connect`,
        component: ConnectionRequestEmail({
          userName: user.name,
          requesterName: (data.metadata.requesterName as string) || 'Someone',
          requestMessage: data.metadata.requestMessage as string | undefined,
          viewUrl: `${appUrl}/dashboard/connections?tab=pending`,
          unsubscribeUrl,
        }),
      };

    case 'PAGE_SHARED':
      return {
        subject: `${data.metadata.sharerName} shared "${data.metadata.pageTitle}" with you`,
        component: PageSharedEmail({
          userName: user.name,
          sharerName: (data.metadata.sharerName as string) || 'Someone',
          pageTitle: (data.metadata.pageTitle as string) || 'a page',
          permissions: (data.metadata.permissionList as string[]) || ['view'],
          viewUrl: `${appUrl}/dashboard/${data.metadata.driveId}/${data.metadata.pageId}`,
          unsubscribeUrl,
        }),
      };

    case 'PERMISSION_GRANTED':
      // Check if it includes edit permission (collaborator added)
      const permissions = data.metadata.permissions as Record<string, boolean> | undefined;
      if (permissions?.canEdit) {
        return {
          subject: `You can now edit "${data.metadata.pageTitle}"`,
          component: CollaboratorAddedEmail({
            userName: user.name,
            adderName: (data.metadata.adderName as string) || 'Someone',
            pageTitle: (data.metadata.pageTitle as string) || 'a page',
            viewUrl: `${appUrl}/dashboard/${data.metadata.driveId}/${data.metadata.pageId}`,
            unsubscribeUrl,
          }),
        };
      }
      // Otherwise treat like PAGE_SHARED
      return {
        subject: `${data.metadata.sharerName} shared "${data.metadata.pageTitle}" with you`,
        component: PageSharedEmail({
          userName: user.name,
          sharerName: (data.metadata.sharerName as string) || 'Someone',
          pageTitle: (data.metadata.pageTitle as string) || 'a page',
          permissions: ['view'],
          viewUrl: `${appUrl}/dashboard/${data.metadata.driveId}/${data.metadata.pageId}`,
          unsubscribeUrl,
        }),
      };

    case 'CONNECTION_ACCEPTED':
      return {
        subject: `${data.metadata.accepterName} accepted your connection request`,
        component: ConnectionAcceptedEmail({
          userName: user.name,
          accepterName: (data.metadata.accepterName as string) || 'Someone',
          viewUrl: `${appUrl}/dashboard/connections`,
          unsubscribeUrl,
        }),
      };

    case 'CONNECTION_REJECTED':
      return {
        subject: 'Connection request declined',
        component: ConnectionRejectedEmail({
          userName: user.name,
          rejecterName: (data.metadata.rejecterName as string) || 'Someone',
          unsubscribeUrl,
        }),
      };

    case 'PERMISSION_REVOKED':
      return {
        subject: `Access removed: ${data.metadata.pageTitle}`,
        component: PermissionRevokedEmail({
          userName: user.name,
          pageTitle: (data.metadata.pageTitle as string) || 'a page',
          driveName: data.metadata.driveName as string | undefined,
          unsubscribeUrl,
        }),
      };

    case 'PERMISSION_UPDATED':
      return {
        subject: `Permissions updated: ${data.metadata.pageTitle}`,
        component: PermissionUpdatedEmail({
          userName: user.name,
          pageTitle: (data.metadata.pageTitle as string) || 'a page',
          permissions: (data.metadata.permissionList as string[]) || ['view'],
          driveName: data.metadata.driveName as string | undefined,
          viewUrl: `${appUrl}/dashboard/${data.metadata.driveId}/${data.metadata.pageId}`,
          unsubscribeUrl,
        }),
      };

    case 'DRIVE_JOINED':
      return {
        subject: `You've joined ${data.metadata.driveName}`,
        component: DriveJoinedEmail({
          userName: user.name,
          driveName: (data.metadata.driveName as string) || 'a workspace',
          role: data.metadata.role as string | undefined,
          viewUrl: `${appUrl}/dashboard/${data.metadata.driveId}`,
          unsubscribeUrl,
        }),
      };

    case 'DRIVE_ROLE_CHANGED':
      return {
        subject: `Your role in ${data.metadata.driveName} has been updated`,
        component: DriveRoleChangedEmail({
          userName: user.name,
          driveName: (data.metadata.driveName as string) || 'a workspace',
          newRole: (data.metadata.role as string) || 'member',
          viewUrl: `${appUrl}/dashboard/${data.metadata.driveId}`,
          unsubscribeUrl,
        }),
      };

    default:
      // No email template for this notification type
      return null;
  }
}

/**
 * Send an email notification to a user
 * Fails gracefully without throwing to avoid breaking the notification creation
 */
export async function sendNotificationEmail(data: NotificationEmailData): Promise<void> {
  try {
    // Check if user has email notifications enabled for this type
    const isEnabled = await isEmailNotificationEnabled(data.userId, data.type);
    if (!isEnabled) {
      return; // User opted out
    }

    // Get user details
    const user = await db.query.users.findFirst({
      where: eq(users.id, data.userId),
      columns: {
        name: true,
        email: true,
      },
    });

    if (!user?.email) {
      console.warn('Cannot send email notification: user %s has no email', String(data.userId).replace(/[\x00-\x1f\x7f-\x9f\n\r]/g, '').slice(0, 100));
      return;
    }

    // Generate unsubscribe URL
    const unsubscribeToken = await generateUnsubscribeToken(data.userId, data.type);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe/${unsubscribeToken}`;

    // Get email template
    const templateData = getEmailTemplate(data, user, unsubscribeUrl);
    if (!templateData) {
      // No email template for this notification type - that's okay
      return;
    }

    // Send email
    await sendEmail({
      to: user.email,
      subject: templateData.subject,
      react: templateData.component,
    });

    // Log success
    await logEmailNotification(
      data.userId,
      data.notificationId,
      data.type,
      user.email,
      true
    );
  } catch (error) {
    // Log failure
    const userEmail = await db.query.users.findFirst({
      where: eq(users.id, data.userId),
      columns: { email: true },
    });

    await logEmailNotification(
      data.userId,
      data.notificationId,
      data.type,
      userEmail?.email || 'unknown',
      false,
      error instanceof Error ? error.message : 'Unknown error'
    );

    // Log to console but don't throw - we don't want to break notification creation
    console.error('Failed to send notification email:', error);
  }
}
