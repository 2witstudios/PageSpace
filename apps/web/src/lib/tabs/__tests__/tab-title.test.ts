/**
 * Tab Title Derivation Tests
 * Derive tab title and icon from path
 */

import { describe, it, expect } from 'vitest';
import {
  parseTabPath,
  getStaticTabMeta,
} from '../tab-title';

describe('tab-title', () => {
  describe('parseTabPath', () => {
    it('given dashboard root, should return dashboard type', () => {
      const result = parseTabPath('/dashboard');

      expect(result.type).toBe('dashboard');
      expect(result.driveId).toBeUndefined();
      expect(result.pageId).toBeUndefined();
    });

    it('given drive root, should return drive type with driveId', () => {
      const result = parseTabPath('/dashboard/drive-123');

      expect(result.type).toBe('drive');
      expect(result.driveId).toBe('drive-123');
      expect(result.pageId).toBeUndefined();
    });

    it('given page path, should return page type with driveId and pageId', () => {
      const result = parseTabPath('/dashboard/drive-123/page-456');

      expect(result.type).toBe('page');
      expect(result.driveId).toBe('drive-123');
      expect(result.pageId).toBe('page-456');
    });

    it('given drive tasks path, should return drive-tasks type', () => {
      const result = parseTabPath('/dashboard/drive-123/tasks');

      expect(result.type).toBe('drive-tasks');
      expect(result.driveId).toBe('drive-123');
    });

    it('given drive activity path, should return drive-activity type', () => {
      const result = parseTabPath('/dashboard/drive-123/activity');

      expect(result.type).toBe('drive-activity');
      expect(result.driveId).toBe('drive-123');
    });

    it('given drive members path, should return drive-members type', () => {
      const result = parseTabPath('/dashboard/drive-123/members');

      expect(result.type).toBe('drive-members');
      expect(result.driveId).toBe('drive-123');
    });

    it('given drive settings path, should return drive-settings type', () => {
      const result = parseTabPath('/dashboard/drive-123/settings');

      expect(result.type).toBe('drive-settings');
      expect(result.driveId).toBe('drive-123');
    });

    it('given drive trash path, should return drive-trash type', () => {
      const result = parseTabPath('/dashboard/drive-123/trash');

      expect(result.type).toBe('drive-trash');
      expect(result.driveId).toBe('drive-123');
    });

    it('given inbox root, should return inbox type', () => {
      const result = parseTabPath('/dashboard/inbox');

      expect(result.type).toBe('inbox');
    });

    it('given inbox dm conversation, should return inbox-dm type', () => {
      const result = parseTabPath('/dashboard/inbox/dm/conv-123');

      expect(result.type).toBe('inbox-dm');
      expect(result.conversationId).toBe('conv-123');
    });

    it('given inbox channel, should return inbox-channel type', () => {
      const result = parseTabPath('/dashboard/inbox/channel/page-123');

      expect(result.type).toBe('inbox-channel');
      expect(result.pageId).toBe('page-123');
    });

    it('given inbox new, should return inbox-new type', () => {
      const result = parseTabPath('/dashboard/inbox/new');

      expect(result.type).toBe('inbox-new');
    });

    it('given settings root, should return settings type', () => {
      const result = parseTabPath('/settings');

      expect(result.type).toBe('settings');
    });

    it('given settings subpage, should return settings type with subpage', () => {
      const result = parseTabPath('/settings/mcp');

      expect(result.type).toBe('settings');
      expect(result.settingsPage).toBe('mcp');
    });

    it('given unknown path, should return unknown type', () => {
      const result = parseTabPath('/random/path');

      expect(result.type).toBe('unknown');
      expect(result.path).toBe('/random/path');
    });

    // Global dashboard routes
    it('given global tasks path, should return dashboard-tasks type', () => {
      const result = parseTabPath('/dashboard/tasks');

      expect(result.type).toBe('dashboard-tasks');
    });

    it('given global activity path, should return dashboard-activity type', () => {
      const result = parseTabPath('/dashboard/activity');

      expect(result.type).toBe('dashboard-activity');
    });

    it('given global storage path, should return dashboard-storage type', () => {
      const result = parseTabPath('/dashboard/storage');

      expect(result.type).toBe('dashboard-storage');
    });

    it('given global trash path, should return dashboard-trash type', () => {
      const result = parseTabPath('/dashboard/trash');

      expect(result.type).toBe('dashboard-trash');
    });

    it('given global connections path, should return dashboard-connections type', () => {
      const result = parseTabPath('/dashboard/connections');

      expect(result.type).toBe('dashboard-connections');
    });

    it('given global calendar path, should return dashboard-calendar type', () => {
      const result = parseTabPath('/dashboard/calendar');

      expect(result.type).toBe('dashboard-calendar');
    });

    // Drive calendar and inbox
    it('given drive calendar path, should return drive-calendar type', () => {
      const result = parseTabPath('/dashboard/drive-123/calendar');

      expect(result.type).toBe('drive-calendar');
      expect(result.driveId).toBe('drive-123');
    });

    it('given drive inbox path, should return drive-inbox type', () => {
      const result = parseTabPath('/dashboard/drive-123/inbox');

      expect(result.type).toBe('drive-inbox');
      expect(result.driveId).toBe('drive-123');
    });

    // Members sub-routes
    it('given drive members invite path, should return drive-members-invite type', () => {
      const result = parseTabPath('/dashboard/drive-123/members/invite');

      expect(result.type).toBe('drive-members-invite');
      expect(result.driveId).toBe('drive-123');
    });

    it('given drive members user path, should return drive-members-user type', () => {
      const result = parseTabPath('/dashboard/drive-123/members/user-456');

      expect(result.type).toBe('drive-members-user');
      expect(result.driveId).toBe('drive-123');
      expect(result.userId).toBe('user-456');
    });

    // Admin routes
    it('given admin root, should return admin type', () => {
      const result = parseTabPath('/admin');

      expect(result.type).toBe('admin');
    });

    it('given admin users path, should return admin-users type', () => {
      const result = parseTabPath('/admin/users');

      expect(result.type).toBe('admin-users');
      expect(result.adminPage).toBe('users');
    });

    it('given admin support path, should return admin-support type', () => {
      const result = parseTabPath('/admin/support');

      expect(result.type).toBe('admin-support');
    });

    it('given admin monitoring path, should return admin-monitoring type', () => {
      const result = parseTabPath('/admin/monitoring');

      expect(result.type).toBe('admin-monitoring');
    });

    it('given admin audit-logs path, should return admin-audit-logs type', () => {
      const result = parseTabPath('/admin/audit-logs');

      expect(result.type).toBe('admin-audit-logs');
    });

    it('given admin global-prompt path, should return admin-global-prompt type', () => {
      const result = parseTabPath('/admin/global-prompt');

      expect(result.type).toBe('admin-global-prompt');
    });

    it('given admin tables path, should return admin-tables type', () => {
      const result = parseTabPath('/admin/tables');

      expect(result.type).toBe('admin-tables');
    });

    // Other standalone routes
    it('given notifications path, should return notifications type', () => {
      const result = parseTabPath('/notifications');

      expect(result.type).toBe('notifications');
    });

    it('given friends path (removed route), should return unknown type', () => {
      const result = parseTabPath('/friends');

      expect(result.type).toBe('unknown');
    });

    // Empty path edge case
    it('given empty path, should return unknown type', () => {
      const result = parseTabPath('/');

      expect(result.type).toBe('unknown');
    });
  });

  describe('getStaticTabMeta', () => {
    it('given dashboard type, should return Dashboard title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard' });

      expect(meta!.title).toBe('Dashboard');
      expect(meta!.iconName).toBe('LayoutDashboard');
    });

    it('given drive-tasks type, should return Tasks title', () => {
      const meta = getStaticTabMeta({ type: 'drive-tasks', driveId: 'drive-123' });

      expect(meta!.title).toBe('Tasks');
      expect(meta!.iconName).toBe('CheckSquare');
    });

    it('given drive-activity type, should return Activity title', () => {
      const meta = getStaticTabMeta({ type: 'drive-activity', driveId: 'drive-123' });

      expect(meta!.title).toBe('Activity');
      expect(meta!.iconName).toBe('Activity');
    });

    it('given drive-members type, should return Members title', () => {
      const meta = getStaticTabMeta({ type: 'drive-members', driveId: 'drive-123' });

      expect(meta!.title).toBe('Members');
      expect(meta!.iconName).toBe('Users');
    });

    it('given drive-settings type, should return Drive Settings title', () => {
      const meta = getStaticTabMeta({ type: 'drive-settings', driveId: 'drive-123' });

      expect(meta!.title).toBe('Drive Settings');
      expect(meta!.iconName).toBe('Settings');
    });

    it('given drive-trash type, should return Trash title', () => {
      const meta = getStaticTabMeta({ type: 'drive-trash', driveId: 'drive-123' });

      expect(meta!.title).toBe('Trash');
      expect(meta!.iconName).toBe('Trash2');
    });

    it('given inbox type, should return Inbox title', () => {
      const meta = getStaticTabMeta({ type: 'inbox' });

      expect(meta!.title).toBe('Inbox');
      expect(meta!.iconName).toBe('Inbox');
    });

    it('given inbox-dm type, should return null (requires async lookup)', () => {
      const meta = getStaticTabMeta({ type: 'inbox-dm', conversationId: 'conv-123' });

      expect(meta).toBeNull();
    });

    it('given inbox-channel type, should return null (requires async lookup)', () => {
      const meta = getStaticTabMeta({ type: 'inbox-channel', pageId: 'page-123' });

      expect(meta).toBeNull();
    });

    it('given inbox-new type, should return New Message title', () => {
      const meta = getStaticTabMeta({ type: 'inbox-new' });

      expect(meta!.title).toBe('New Message');
      expect(meta!.iconName).toBe('PenSquare');
    });

    it('given settings type, should return Settings title', () => {
      const meta = getStaticTabMeta({ type: 'settings' });

      expect(meta!.title).toBe('Settings');
      expect(meta!.iconName).toBe('Settings');
    });

    it('given settings type with subpage, should return formatted title', () => {
      const meta = getStaticTabMeta({ type: 'settings', settingsPage: 'mcp' });

      expect(meta!.title).toBe('MCP');
    });

    it('given page type, should return null (requires async lookup)', () => {
      const meta = getStaticTabMeta({ type: 'page', driveId: 'drive-123', pageId: 'page-456' });

      expect(meta).toBeNull();
    });

    it('given drive type, should return null (requires async lookup)', () => {
      const meta = getStaticTabMeta({ type: 'drive', driveId: 'drive-123' });

      expect(meta).toBeNull();
    });

    it('given unknown type, should return path as fallback title', () => {
      const meta = getStaticTabMeta({ type: 'unknown', path: '/some/path' });

      expect(meta!.title).toBe('/some/path');
      expect(meta!.iconName).toBe('File');
    });

    // Global dashboard routes
    it('given dashboard-tasks type, should return Tasks title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard-tasks' });

      expect(meta!.title).toBe('Tasks');
      expect(meta!.iconName).toBe('CheckSquare');
    });

    it('given dashboard-activity type, should return Activity title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard-activity' });

      expect(meta!.title).toBe('Activity');
      expect(meta!.iconName).toBe('Activity');
    });

    it('given dashboard-storage type, should return Storage title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard-storage' });

      expect(meta!.title).toBe('Storage');
      expect(meta!.iconName).toBe('HardDrive');
    });

    it('given dashboard-trash type, should return Trash title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard-trash' });

      expect(meta!.title).toBe('Trash');
      expect(meta!.iconName).toBe('Trash2');
    });

    it('given dashboard-connections type, should return Connections title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard-connections' });

      expect(meta!.title).toBe('Connections');
      expect(meta!.iconName).toBe('Link');
    });

    it('given dashboard-calendar type, should return Calendar title', () => {
      const meta = getStaticTabMeta({ type: 'dashboard-calendar' });

      expect(meta!.title).toBe('Calendar');
      expect(meta!.iconName).toBe('Calendar');
    });

    // Drive calendar and inbox
    it('given drive-calendar type, should return Calendar title', () => {
      const meta = getStaticTabMeta({ type: 'drive-calendar', driveId: 'drive-123' });

      expect(meta!.title).toBe('Calendar');
      expect(meta!.iconName).toBe('Calendar');
    });

    it('given drive-inbox type, should return Inbox title', () => {
      const meta = getStaticTabMeta({ type: 'drive-inbox', driveId: 'drive-123' });

      expect(meta!.title).toBe('Inbox');
      expect(meta!.iconName).toBe('Inbox');
    });

    // Members sub-routes
    it('given drive-members-invite type, should return Invite Members title', () => {
      const meta = getStaticTabMeta({ type: 'drive-members-invite', driveId: 'drive-123' });

      expect(meta!.title).toBe('Invite Members');
      expect(meta!.iconName).toBe('UserPlus');
    });

    it('given drive-members-user type, should return Member title', () => {
      const meta = getStaticTabMeta({ type: 'drive-members-user', driveId: 'drive-123', userId: 'user-456' });

      expect(meta!.title).toBe('Member');
      expect(meta!.iconName).toBe('User');
    });

    // Admin routes
    it('given admin type, should return Admin title', () => {
      const meta = getStaticTabMeta({ type: 'admin' });

      expect(meta!.title).toBe('Admin');
      expect(meta!.iconName).toBe('Shield');
    });

    it('given admin-users type, should return Admin - Users title', () => {
      const meta = getStaticTabMeta({ type: 'admin-users' });

      expect(meta!.title).toBe('Admin - Users');
      expect(meta!.iconName).toBe('Users');
    });

    it('given admin-support type, should return Admin - Support title', () => {
      const meta = getStaticTabMeta({ type: 'admin-support' });

      expect(meta!.title).toBe('Admin - Support');
      expect(meta!.iconName).toBe('LifeBuoy');
    });

    it('given admin-monitoring type, should return Admin - Monitoring title', () => {
      const meta = getStaticTabMeta({ type: 'admin-monitoring' });

      expect(meta!.title).toBe('Admin - Monitoring');
      expect(meta!.iconName).toBe('Activity');
    });

    it('given admin-audit-logs type, should return Admin - Audit Logs title', () => {
      const meta = getStaticTabMeta({ type: 'admin-audit-logs' });

      expect(meta!.title).toBe('Admin - Audit Logs');
      expect(meta!.iconName).toBe('FileText');
    });

    it('given admin-global-prompt type, should return Admin - Global Prompt title', () => {
      const meta = getStaticTabMeta({ type: 'admin-global-prompt' });

      expect(meta!.title).toBe('Admin - Global Prompt');
      expect(meta!.iconName).toBe('MessageSquare');
    });

    it('given admin-tables type, should return Admin - Tables title', () => {
      const meta = getStaticTabMeta({ type: 'admin-tables' });

      expect(meta!.title).toBe('Admin - Tables');
      expect(meta!.iconName).toBe('Table');
    });

    // Other standalone routes
    it('given notifications type, should return Notifications title', () => {
      const meta = getStaticTabMeta({ type: 'notifications' });

      expect(meta!.title).toBe('Notifications');
      expect(meta!.iconName).toBe('Bell');
    });

    // Settings with hyphenated subpages
    it('given settings type with ai-api subpage, should return correctly formatted title', () => {
      const meta = getStaticTabMeta({ type: 'settings', settingsPage: 'ai-api' });

      expect(meta!.title).toBe('AI API');
    });

    it('given settings type with local-mcp subpage, should return correctly formatted title', () => {
      const meta = getStaticTabMeta({ type: 'settings', settingsPage: 'local-mcp' });

      expect(meta!.title).toBe('Local MCP');
    });

    it('given settings type with personalization subpage, should return correctly formatted title', () => {
      const meta = getStaticTabMeta({ type: 'settings', settingsPage: 'personalization' });

      expect(meta!.title).toBe('Personalization');
    });
  });
});
