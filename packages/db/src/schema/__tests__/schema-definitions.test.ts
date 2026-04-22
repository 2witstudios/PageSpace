/**
 * Schema Definitions Tests
 *
 * Verifies that all individual schema files export the expected tables,
 * relations, and enums. These files are pure Drizzle ORM declarations -
 * importing them is sufficient to get coverage.
 */
import { describe, it, expect } from 'vitest';

// Auth schema
import * as auth from '../auth';
// Sessions schema
import * as sessions from '../sessions';
// Core schema
import * as core from '../core';
// Permissions schema
import * as permissions from '../permissions';
// Members schema
import * as members from '../members';
// Chat schema
import * as chat from '../chat';
// AI schema
import * as ai from '../ai';
// Dashboard schema
import * as dashboard from '../dashboard';
// Conversations schema
import * as conversations from '../conversations';
// Notifications schema
import * as notifications from '../notifications';
// Email notifications schema
import * as emailNotifications from '../email-notifications';
// Display preferences schema
import * as displayPreferences from '../display-preferences';
// Monitoring schema
import * as monitoring from '../monitoring';
// Versioning schema
import * as versioning from '../versioning';
// Social schema
import * as social from '../social';
// Subscriptions schema
import * as subscriptions from '../subscriptions';
// Contact schema
import * as contact from '../contact';
// Feedback schema
import * as feedback from '../feedback';
// Storage schema
import * as storage from '../storage';
// Tasks schema
import * as tasks from '../tasks';
// Security audit schema
import * as securityAudit from '../security-audit';
// Page views schema
import * as pageViews from '../page-views';
// Hotkeys schema
import * as hotkeys from '../hotkeys';
// Push notifications schema
import * as pushNotifications from '../push-notifications';
// Integrations schema
import * as integrations from '../integrations';
// Personalization schema
import * as personalization from '../personalization';
// Calendar schema
import * as calendar from '../calendar';
// Workflows schema
import * as workflows from '../workflows';

describe('Schema definitions', () => {
  describe('auth schema', () => {
    it('exports enums', () => {
      expect(auth.userRole).toBeDefined();
      expect(auth.authProvider).toBeDefined();
      expect(auth.platformType).toBeDefined();
    });

    it('exports tables', () => {
      expect(auth.users).toBeDefined();
      expect(auth.deviceTokens).toBeDefined();
      expect(auth.mcpTokens).toBeDefined();
      expect(auth.mcpTokenDrives).toBeDefined();
      expect(auth.verificationTokens).toBeDefined();
      expect(auth.socketTokens).toBeDefined();
      expect(auth.passkeys).toBeDefined();
      expect(auth.emailUnsubscribeTokens).toBeDefined();
    });

    it('exports relations', () => {
      expect(auth.usersRelations).toBeDefined();
      expect(auth.deviceTokensRelations).toBeDefined();
      expect(auth.mcpTokensRelations).toBeDefined();
      expect(auth.mcpTokenDrivesRelations).toBeDefined();
      expect(auth.verificationTokensRelations).toBeDefined();
      expect(auth.socketTokensRelations).toBeDefined();
      expect(auth.passkeysRelations).toBeDefined();
      expect(auth.emailUnsubscribeTokensRelations).toBeDefined();
    });
  });

  describe('sessions schema', () => {
    it('exports tables', () => {
      expect(sessions.sessions).toBeDefined();
    });

    it('exports relations', () => {
      expect(sessions.sessionsRelations).toBeDefined();
    });
  });

  describe('core schema', () => {
    it('exports enums', () => {
      expect(core.pageType).toBeDefined();
      expect(core.pageType.enumValues).toContain('DOCUMENT');
      expect(core.pageType.enumValues).toContain('FOLDER');
    });

    it('exports tables', () => {
      expect(core.drives).toBeDefined();
      expect(core.pages).toBeDefined();
      expect(core.chatMessages).toBeDefined();
      expect(core.tags).toBeDefined();
      expect(core.pageTags).toBeDefined();
      expect(core.storageEvents).toBeDefined();
      expect(core.favorites).toBeDefined();
      expect(core.mentions).toBeDefined();
      expect(core.userMentions).toBeDefined();
    });

    it('exports relations', () => {
      expect(core.drivesRelations).toBeDefined();
      expect(core.pagesRelations).toBeDefined();
      expect(core.chatMessagesRelations).toBeDefined();
      expect(core.tagsRelations).toBeDefined();
      expect(core.pageTagsRelations).toBeDefined();
      expect(core.favoritesRelations).toBeDefined();
      expect(core.mentionsRelations).toBeDefined();
      expect(core.userMentionsRelations).toBeDefined();
    });
  });

  describe('permissions schema', () => {
    it('exports enums', () => {
      expect(permissions.permissionAction).toBeDefined();
      expect(permissions.subjectType).toBeDefined();
    });

    it('exports tables', () => {
      expect(permissions.permissions).toBeDefined();
    });

    it('exports relations', () => {
      expect(permissions.permissionsRelations).toBeDefined();
    });
  });

  describe('members schema', () => {
    it('exports enums', () => {
      expect(members.memberRole).toBeDefined();
    });

    it('exports tables', () => {
      expect(members.driveRoles).toBeDefined();
      expect(members.userProfiles).toBeDefined();
      expect(members.driveMembers).toBeDefined();
      expect(members.pagePermissions).toBeDefined();
    });
  });

  describe('chat schema', () => {
    it('exports tables', () => {
      expect(chat.channelMessages).toBeDefined();
      expect(chat.channelMessageReactions).toBeDefined();
      expect(chat.channelReadStatus).toBeDefined();
    });

    it('exports relations', () => {
      expect(chat.channelMessagesRelations).toBeDefined();
      expect(chat.channelMessageReactionsRelations).toBeDefined();
    });
  });

  describe('ai schema', () => {
    it('exports tables', () => {
      expect(ai.userAiSettings).toBeDefined();
    });

    it('exports relations', () => {
      expect(ai.userAiSettingsRelations).toBeDefined();
    });
  });

  describe('dashboard schema', () => {
    it('exports enums', () => {
      expect(dashboard.pulseSummaryTypeEnum).toBeDefined();
    });

    it('exports tables', () => {
      expect(dashboard.userDashboards).toBeDefined();
      expect(dashboard.pulseSummaries).toBeDefined();
    });

    it('exports relations', () => {
      expect(dashboard.userDashboardsRelations).toBeDefined();
      expect(dashboard.pulseSummariesRelations).toBeDefined();
    });
  });

  describe('conversations schema', () => {
    it('exports tables', () => {
      expect(conversations.conversations).toBeDefined();
      expect(conversations.messages).toBeDefined();
    });

    it('exports relations', () => {
      expect(conversations.conversationsRelations).toBeDefined();
      expect(conversations.messagesRelations).toBeDefined();
    });
  });

  describe('notifications schema', () => {
    it('exports enums', () => {
      expect(notifications.notificationType).toBeDefined();
    });

    it('exports tables', () => {
      expect(notifications.notifications).toBeDefined();
    });

    it('exports relations', () => {
      expect(notifications.notificationsRelations).toBeDefined();
    });
  });

  describe('email-notifications schema', () => {
    it('exports tables', () => {
      expect(emailNotifications.emailNotificationPreferences).toBeDefined();
      expect(emailNotifications.emailNotificationLog).toBeDefined();
    });

    it('exports relations', () => {
      expect(emailNotifications.emailNotificationPreferencesRelations).toBeDefined();
      expect(emailNotifications.emailNotificationLogRelations).toBeDefined();
    });
  });

  describe('display-preferences schema', () => {
    it('exports enums', () => {
      expect(displayPreferences.displayPreferenceType).toBeDefined();
    });

    it('exports tables', () => {
      expect(displayPreferences.displayPreferences).toBeDefined();
    });

    it('exports relations', () => {
      expect(displayPreferences.displayPreferencesRelations).toBeDefined();
    });
  });

  describe('monitoring schema', () => {
    it('exports enums', () => {
      expect(monitoring.logLevelEnum).toBeDefined();
      expect(monitoring.httpMethodEnum).toBeDefined();
      expect(monitoring.activityResourceEnum).toBeDefined();
      expect(monitoring.contentFormatEnum).toBeDefined();
      expect(monitoring.activityChangeGroupTypeEnum).toBeDefined();
    });

    it('exports tables', () => {
      expect(monitoring.systemLogs).toBeDefined();
      expect(monitoring.apiMetrics).toBeDefined();
      expect(monitoring.userActivities).toBeDefined();
      expect(monitoring.aiUsageLogs).toBeDefined();
      expect(monitoring.errorLogs).toBeDefined();
      expect(monitoring.activityLogs).toBeDefined();
    });

    it('exports relations', () => {
      expect(monitoring.activityLogsRelations).toBeDefined();
    });
  });

  describe('versioning schema', () => {
    it('exports enums', () => {
      expect(versioning.pageVersionSourceEnum).toBeDefined();
      expect(versioning.driveBackupSourceEnum).toBeDefined();
      expect(versioning.driveBackupStatusEnum).toBeDefined();
    });

    it('exports constants', () => {
      expect(versioning.DEFAULT_VERSION_RETENTION_DAYS).toBe(30);
    });

    it('exports tables', () => {
      expect(versioning.pageVersions).toBeDefined();
      expect(versioning.driveBackups).toBeDefined();
      expect(versioning.driveBackupPages).toBeDefined();
      expect(versioning.driveBackupPermissions).toBeDefined();
      expect(versioning.driveBackupMembers).toBeDefined();
      expect(versioning.driveBackupRoles).toBeDefined();
      expect(versioning.driveBackupFiles).toBeDefined();
    });

    it('exports relations', () => {
      expect(versioning.pageVersionsRelations).toBeDefined();
      expect(versioning.driveBackupsRelations).toBeDefined();
    });

    it('calculateVersionExpiresAt returns date 30 days in future by default', () => {
      const before = Date.now();
      const result = versioning.calculateVersionExpiresAt();
      const after = Date.now();

      expect(result).toBeInstanceOf(Date);
      const diffMs = result.getTime() - before;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(diffMs).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
      expect(diffMs).toBeLessThanOrEqual(thirtyDaysMs + (after - before) + 1000);
    });

    it('calculateVersionExpiresAt respects custom createdAt date', () => {
      const createdAt = new Date('2024-01-01T00:00:00.000Z');
      const result = versioning.calculateVersionExpiresAt(createdAt);
      // Use day-level difference to avoid timezone sensitivity - setDate uses local time
      const diffMs = result.getTime() - createdAt.getTime();
      const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
      expect(diffDays).toBe(30);
    });

    it('calculateVersionExpiresAt respects custom retentionDays', () => {
      const createdAt = new Date('2024-01-01T00:00:00.000Z');
      const result = versioning.calculateVersionExpiresAt(createdAt, 90);
      // Use day-level difference to avoid timezone sensitivity - setDate uses local time
      const diffMs = result.getTime() - createdAt.getTime();
      const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
      expect(diffDays).toBe(90);
    });
  });

  describe('social schema', () => {
    it('exports enums', () => {
      expect(social.connectionStatus).toBeDefined();
    });

    it('exports tables', () => {
      expect(social.connections).toBeDefined();
      expect(social.dmConversations).toBeDefined();
      expect(social.directMessages).toBeDefined();
    });

    it('exports relations', () => {
      expect(social.connectionsRelations).toBeDefined();
    });
  });

  describe('subscriptions schema', () => {
    it('exports tables', () => {
      expect(subscriptions.subscriptions).toBeDefined();
      expect(subscriptions.stripeEvents).toBeDefined();
    });

    it('exports relations', () => {
      expect(subscriptions.subscriptionsRelations).toBeDefined();
    });
  });

  describe('contact schema', () => {
    it('exports tables', () => {
      expect(contact.contactSubmissions).toBeDefined();
    });
  });

  describe('feedback schema', () => {
    it('exports tables', () => {
      expect(feedback.feedbackSubmissions).toBeDefined();
    });

    it('exports relations', () => {
      expect(feedback.feedbackSubmissionsRelations).toBeDefined();
    });
  });

  describe('storage schema', () => {
    it('exports tables', () => {
      expect(storage.files).toBeDefined();
      expect(storage.filePages).toBeDefined();
    });

    it('exports relations', () => {
      expect(storage.filesRelations).toBeDefined();
      expect(storage.filePagesRelations).toBeDefined();
    });
  });

  describe('tasks schema', () => {
    it('exports tables', () => {
      expect(tasks.taskLists).toBeDefined();
      expect(tasks.taskStatusConfigs).toBeDefined();
      expect(tasks.taskItems).toBeDefined();
      expect(tasks.taskAssignees).toBeDefined();
    });

    it('exports relations', () => {
      expect(tasks.taskListsRelations).toBeDefined();
    });
  });

  describe('security-audit schema', () => {
    it('exports tables', () => {
      expect(securityAudit.securityAuditLog).toBeDefined();
    });

    it('exports relations', () => {
      expect(securityAudit.securityAuditLogRelations).toBeDefined();
    });
  });

  describe('page-views schema', () => {
    it('exports tables', () => {
      expect(pageViews.userPageViews).toBeDefined();
    });

    it('exports relations', () => {
      expect(pageViews.userPageViewsRelations).toBeDefined();
    });
  });

  describe('hotkeys schema', () => {
    it('exports tables', () => {
      expect(hotkeys.userHotkeyPreferences).toBeDefined();
    });

    it('exports relations', () => {
      expect(hotkeys.userHotkeyPreferencesRelations).toBeDefined();
    });
  });

  describe('push-notifications schema', () => {
    it('exports enums', () => {
      expect(pushNotifications.pushPlatformType).toBeDefined();
    });

    it('exports tables', () => {
      expect(pushNotifications.pushNotificationTokens).toBeDefined();
    });

    it('exports relations', () => {
      expect(pushNotifications.pushNotificationTokensRelations).toBeDefined();
    });
  });

  describe('integrations schema', () => {
    it('exports enums', () => {
      expect(integrations.integrationProviderTypeEnum).toBeDefined();
      expect(integrations.integrationConnectionStatusEnum).toBeDefined();
      expect(integrations.integrationVisibilityEnum).toBeDefined();
    });

    it('exports tables', () => {
      expect(integrations.integrationProviders).toBeDefined();
      expect(integrations.integrationConnections).toBeDefined();
      expect(integrations.integrationToolGrants).toBeDefined();
      expect(integrations.globalAssistantConfig).toBeDefined();
      expect(integrations.integrationAuditLog).toBeDefined();
    });

    it('exports relations', () => {
      expect(integrations.integrationProvidersRelations).toBeDefined();
      expect(integrations.integrationConnectionsRelations).toBeDefined();
      expect(integrations.integrationToolGrantsRelations).toBeDefined();
      expect(integrations.globalAssistantConfigRelations).toBeDefined();
      expect(integrations.integrationAuditLogRelations).toBeDefined();
    });
  });

  describe('personalization schema', () => {
    it('exports tables', () => {
      expect(personalization.userPersonalization).toBeDefined();
    });

    it('exports relations', () => {
      expect(personalization.userPersonalizationRelations).toBeDefined();
    });
  });

  describe('calendar schema', () => {
    it('exports enums', () => {
      expect(calendar.googleCalendarConnectionStatus).toBeDefined();
      expect(calendar.eventVisibility).toBeDefined();
      expect(calendar.attendeeStatus).toBeDefined();
      expect(calendar.recurrenceFrequency).toBeDefined();
    });

    it('exports tables', () => {
      expect(calendar.calendarEvents).toBeDefined();
    });
  });

  describe('workflows schema', () => {
    it('exports enums', () => {
      expect(workflows.workflowRunStatus).toBeDefined();
      expect(workflows.workflowTriggerType).toBeDefined();
    });

    it('exports tables', () => {
      expect(workflows.workflows).toBeDefined();
    });

    it('exports relations', () => {
      expect(workflows.workflowsRelations).toBeDefined();
    });
  });
});
