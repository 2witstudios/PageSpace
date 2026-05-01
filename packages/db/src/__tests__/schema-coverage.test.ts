/**
 * Schema Coverage Tests
 *
 * Verifies that schema.ts correctly re-exports all schema modules
 * and assembles the combined schema object. These are pure declaration
 * files - importing them provides coverage.
 */
import { describe, it, expect } from 'vitest';
import * as schemaModule from '../schema';

describe('schema.ts exports', () => {
  it('exports a schema object', () => {
    expect(schemaModule.schema).toBeDefined();
    expect(typeof schemaModule.schema).toBe('object');
  });

  it('schema object contains auth tables', () => {
    expect(schemaModule.schema.users).toBeDefined();
    expect(schemaModule.schema.deviceTokens).toBeDefined();
    expect(schemaModule.schema.mcpTokens).toBeDefined();
    expect(schemaModule.schema.mcpTokenDrives).toBeDefined();
    expect(schemaModule.schema.verificationTokens).toBeDefined();
    expect(schemaModule.schema.socketTokens).toBeDefined();
    expect(schemaModule.schema.passkeys).toBeDefined();
    expect(schemaModule.schema.emailUnsubscribeTokens).toBeDefined();
  });

  it('schema object contains sessions tables', () => {
    expect(schemaModule.schema.sessions).toBeDefined();
  });

  it('schema object contains core tables', () => {
    expect(schemaModule.schema.drives).toBeDefined();
    expect(schemaModule.schema.pages).toBeDefined();
    expect(schemaModule.schema.chatMessages).toBeDefined();
    expect(schemaModule.schema.tags).toBeDefined();
    expect(schemaModule.schema.pageTags).toBeDefined();
    expect(schemaModule.schema.favorites).toBeDefined();
    expect(schemaModule.schema.mentions).toBeDefined();
    expect(schemaModule.schema.userMentions).toBeDefined();
  });

  it('schema object contains permissions tables', () => {
    expect(schemaModule.schema.permissions).toBeDefined();
  });

  it('schema object contains members tables', () => {
    expect(schemaModule.schema.driveRoles).toBeDefined();
    expect(schemaModule.schema.driveMembers).toBeDefined();
    expect(schemaModule.schema.pagePermissions).toBeDefined();
  });

  it('schema object contains chat tables', () => {
    expect(schemaModule.schema.channelMessages).toBeDefined();
    expect(schemaModule.schema.channelMessageReactions).toBeDefined();
    expect(schemaModule.schema.channelReadStatus).toBeDefined();
  });

  it('schema object contains dashboard tables', () => {
    expect(schemaModule.schema.userDashboards).toBeDefined();
    expect(schemaModule.schema.pulseSummaries).toBeDefined();
  });

  it('schema object contains conversations tables', () => {
    expect(schemaModule.schema.conversations).toBeDefined();
    expect(schemaModule.schema.messages).toBeDefined();
  });

  it('schema object contains notifications tables', () => {
    expect(schemaModule.schema.notifications).toBeDefined();
  });

  it('schema object contains email-notifications tables', () => {
    expect(schemaModule.schema.emailNotificationPreferences).toBeDefined();
    expect(schemaModule.schema.emailNotificationLog).toBeDefined();
  });

  it('schema object contains display-preferences tables', () => {
    expect(schemaModule.schema.displayPreferences).toBeDefined();
  });

  it('schema object contains monitoring tables', () => {
    expect(schemaModule.schema.systemLogs).toBeDefined();
    expect(schemaModule.schema.apiMetrics).toBeDefined();
    expect(schemaModule.schema.userActivities).toBeDefined();
    expect(schemaModule.schema.aiUsageLogs).toBeDefined();
    expect(schemaModule.schema.errorLogs).toBeDefined();
    expect(schemaModule.schema.activityLogs).toBeDefined();
  });

  it('schema object contains versioning tables', () => {
    expect(schemaModule.schema.pageVersions).toBeDefined();
    expect(schemaModule.schema.driveBackups).toBeDefined();
  });

  it('schema object contains social tables', () => {
    expect(schemaModule.schema.connections).toBeDefined();
    expect(schemaModule.schema.dmConversations).toBeDefined();
    expect(schemaModule.schema.directMessages).toBeDefined();
  });

  it('schema object contains subscriptions tables', () => {
    expect(schemaModule.schema.subscriptions).toBeDefined();
    expect(schemaModule.schema.stripeEvents).toBeDefined();
  });

  it('schema object contains contact tables', () => {
    expect(schemaModule.schema.contactSubmissions).toBeDefined();
  });

  it('schema object contains feedback tables', () => {
    expect(schemaModule.schema.feedbackSubmissions).toBeDefined();
  });

  it('schema object contains storage tables', () => {
    expect(schemaModule.schema.files).toBeDefined();
    expect(schemaModule.schema.filePages).toBeDefined();
  });

  it('schema object contains tasks tables', () => {
    expect(schemaModule.schema.taskLists).toBeDefined();
    expect(schemaModule.schema.taskItems).toBeDefined();
    expect(schemaModule.schema.taskAssignees).toBeDefined();
  });

  it('schema object contains security-audit tables', () => {
    expect(schemaModule.schema.securityAuditLog).toBeDefined();
  });

  it('schema object contains page-views tables', () => {
    expect(schemaModule.schema.userPageViews).toBeDefined();
  });

  it('schema object contains hotkeys tables', () => {
    expect(schemaModule.schema.userHotkeyPreferences).toBeDefined();
  });

  it('schema object contains push-notifications tables', () => {
    expect(schemaModule.schema.pushNotificationTokens).toBeDefined();
  });

  it('schema object contains integrations tables', () => {
    expect(schemaModule.schema.integrationProviders).toBeDefined();
    expect(schemaModule.schema.integrationConnections).toBeDefined();
  });

  it('schema object contains personalization tables', () => {
    expect(schemaModule.schema.userPersonalization).toBeDefined();
  });

  it('schema object contains calendar tables', () => {
    expect(schemaModule.schema.calendarEvents).toBeDefined();
  });

  it('schema object contains workflows tables', () => {
    expect(schemaModule.schema.workflows).toBeDefined();
  });

  it('re-exports auth enums', () => {
    expect(schemaModule.userRole).toBeDefined();
    expect(schemaModule.authProvider).toBeDefined();
    expect(schemaModule.platformType).toBeDefined();
  });

  it('re-exports core enums', () => {
    expect(schemaModule.pageType).toBeDefined();
  });

  it('re-exports relations', () => {
    expect(schemaModule.usersRelations).toBeDefined();
    expect(schemaModule.sessionsRelations).toBeDefined();
    expect(schemaModule.drivesRelations).toBeDefined();
    expect(schemaModule.pagesRelations).toBeDefined();
  });
});
