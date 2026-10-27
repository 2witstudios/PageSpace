import { describe, it, expect } from 'vitest';
import {
  getPageTypeLabel,
  buildPreviewHref,
  getPreviewSubtext,
} from '../PageLinkPreview';
import type { LinkPreviewData } from '@/hooks/useLinkPreview';

describe('getPageTypeLabel', () => {
  it('returns human-readable label for DOCUMENT', () => {
    expect(getPageTypeLabel('DOCUMENT')).toBe('Document');
  });

  it('returns human-readable label for CHANNEL', () => {
    expect(getPageTypeLabel('CHANNEL')).toBe('Channel');
  });

  it('returns human-readable label for TASK_LIST', () => {
    expect(getPageTypeLabel('TASK_LIST')).toBe('Task List');
  });

  it('returns human-readable label for AI_CHAT', () => {
    expect(getPageTypeLabel('AI_CHAT')).toBe('AI Chat');
  });

  it('returns human-readable label for FOLDER', () => {
    expect(getPageTypeLabel('FOLDER')).toBe('Folder');
  });

  it('returns human-readable label for CANVAS', () => {
    expect(getPageTypeLabel('CANVAS')).toBe('Canvas');
  });

  it('returns human-readable label for CODE', () => {
    expect(getPageTypeLabel('CODE')).toBe('Code');
  });

  it('returns human-readable label for SHEET', () => {
    expect(getPageTypeLabel('SHEET')).toBe('Sheet');
  });

  it('returns human-readable label for FILE', () => {
    expect(getPageTypeLabel('FILE')).toBe('File');
  });

  it('returns the raw value for unknown types', () => {
    expect(getPageTypeLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('buildPreviewHref', () => {
  it('returns dashboard path for previews with driveId', () => {
    const preview: LinkPreviewData = {
      id: 'page1',
      title: 'My Page',
      type: 'DOCUMENT',
      driveId: 'drive1',
      driveName: 'My Drive',
    };
    expect(buildPreviewHref(preview)).toBe('/dashboard/drive1/page1');
  });
});

describe('getPreviewSubtext', () => {
  it('returns snippet for DOCUMENT type', () => {
    const preview: LinkPreviewData = {
      id: 'p1', title: 'Doc', type: 'DOCUMENT',
      driveId: 'd1', driveName: 'Drive', snippet: 'Hello world',
    };
    expect(getPreviewSubtext(preview)).toBe('Hello world');
  });

  it('returns member count string for CHANNEL type', () => {
    const preview: LinkPreviewData = {
      id: 'p1', title: 'Chan', type: 'CHANNEL',
      driveId: 'd1', driveName: 'Drive', memberCount: 4,
    };
    expect(getPreviewSubtext(preview)).toBe('4 members');
  });

  it('returns task count string for TASK_LIST type', () => {
    const preview: LinkPreviewData = {
      id: 'p1', title: 'Tasks', type: 'TASK_LIST',
      driveId: 'd1', driveName: 'Drive', taskCount: 7,
    };
    expect(getPreviewSubtext(preview)).toBe('7 tasks');
  });

  it('returns undefined for types with no subtext', () => {
    const preview: LinkPreviewData = {
      id: 'p1', title: 'Canvas', type: 'CANVAS',
      driveId: 'd1', driveName: 'Drive',
    };
    expect(getPreviewSubtext(preview)).toBeUndefined();
  });
});
