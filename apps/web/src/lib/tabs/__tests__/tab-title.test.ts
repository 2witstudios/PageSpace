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

    it('given messages root, should return messages type', () => {
      const result = parseTabPath('/dashboard/messages');

      expect(result.type).toBe('messages');
    });

    it('given messages conversation, should return messages-conversation type', () => {
      const result = parseTabPath('/dashboard/messages/conv-123');

      expect(result.type).toBe('messages-conversation');
      expect(result.conversationId).toBe('conv-123');
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

    it('given drive-settings type, should return Settings title', () => {
      const meta = getStaticTabMeta({ type: 'drive-settings', driveId: 'drive-123' });

      expect(meta!.title).toBe('Settings');
      expect(meta!.iconName).toBe('Settings');
    });

    it('given drive-trash type, should return Trash title', () => {
      const meta = getStaticTabMeta({ type: 'drive-trash', driveId: 'drive-123' });

      expect(meta!.title).toBe('Trash');
      expect(meta!.iconName).toBe('Trash2');
    });

    it('given messages type, should return Messages title', () => {
      const meta = getStaticTabMeta({ type: 'messages' });

      expect(meta!.title).toBe('Messages');
      expect(meta!.iconName).toBe('MessageSquare');
    });

    it('given settings type, should return Settings title', () => {
      const meta = getStaticTabMeta({ type: 'settings' });

      expect(meta!.title).toBe('Settings');
      expect(meta!.iconName).toBe('Settings');
    });

    it('given settings type with subpage, should return formatted title', () => {
      const meta = getStaticTabMeta({ type: 'settings', settingsPage: 'mcp' });

      expect(meta!.title).toBe('Settings - MCP');
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
  });
});
