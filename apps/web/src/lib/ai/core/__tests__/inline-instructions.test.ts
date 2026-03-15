import { describe, it, expect } from 'vitest';

import {
  buildInlineInstructions,
  buildGlobalAssistantInstructions,
} from '../inline-instructions';

describe('inline-instructions', () => {
  describe('buildInlineInstructions', () => {
    it('should build instructions with all provided context', () => {
      const result = buildInlineInstructions({
        pageTitle: 'My Page',
        pageType: 'DOCUMENT',
        isTaskLinked: false,
        driveName: 'My Drive',
        pagePath: '/my-drive/my-page',
        driveSlug: 'my-drive',
        driveId: 'drive-123',
      });

      expect(result).toContain('My Page');
      expect(result).toContain('DOCUMENT');
      expect(result).toContain('My Drive');
      expect(result).toContain('/my-drive/my-page');
      expect(result).toContain('my-drive');
      expect(result).toContain('drive-123');
    });

    it('should include task suffix when isTaskLinked is true', () => {
      const result = buildInlineInstructions({
        pageTitle: 'Task Page',
        pageType: 'DOCUMENT',
        isTaskLinked: true,
      });

      expect(result).toContain('Task-linked page');
      expect(result).toContain('task management tools');
    });

    it('should not include task suffix when isTaskLinked is false', () => {
      const result = buildInlineInstructions({
        pageTitle: 'Regular Page',
        pageType: 'DOCUMENT',
        isTaskLinked: false,
      });

      expect(result).not.toContain('Task-linked page');
      expect(result).not.toContain('task management tools');
    });

    it('should use default values for missing context', () => {
      const result = buildInlineInstructions({});

      expect(result).toContain('"current"');
      expect(result).toContain('[DOCUMENT]');
      expect(result).toContain('current-drive-id');
    });

    it('should include WORKSPACE RULES section', () => {
      const result = buildInlineInstructions({});
      expect(result).toContain('WORKSPACE RULES');
    });

    it('should include PAGE TYPES section', () => {
      const result = buildInlineInstructions({});
      expect(result).toContain('PAGE TYPES');
      expect(result).toContain('FOLDER');
      expect(result).toContain('DOCUMENT');
      expect(result).toContain('SHEET');
      expect(result).toContain('CANVAS');
      expect(result).toContain('TASK_LIST');
      expect(result).toContain('AI_CHAT');
      expect(result).toContain('CHANNEL');
      expect(result).toContain('FILE');
    });

    it('should include AFTER TOOLS section', () => {
      const result = buildInlineInstructions({});
      expect(result).toContain('AFTER TOOLS');
    });

    it('should include MENTIONS section', () => {
      const result = buildInlineInstructions({});
      expect(result).toContain('MENTIONS');
      expect(result).toContain('@mention');
    });

    it('should include driveId and driveSlug in CONTEXT', () => {
      const result = buildInlineInstructions({
        driveSlug: 'test-drive',
        driveId: 'test-drive-id',
      });
      expect(result).toContain('test-drive');
      expect(result).toContain('test-drive-id');
    });
  });

  describe('buildGlobalAssistantInstructions', () => {
    it('should build dashboard context when no drive context provided', () => {
      const result = buildGlobalAssistantInstructions();

      expect(result).toContain('dashboard - cross-workspace tasks');
      expect(result).toContain('list_drives');
    });

    it('should build drive context when drive context provided', () => {
      const result = buildGlobalAssistantInstructions({
        driveName: 'My Drive',
        driveSlug: 'my-drive',
        driveId: 'drive-123',
      });

      expect(result).toContain('My Drive');
      expect(result).toContain('my-drive');
      expect(result).toContain('drive-123');
    });

    it('should include WORKSPACE RULES section', () => {
      const result = buildGlobalAssistantInstructions();
      expect(result).toContain('WORKSPACE RULES');
    });

    it('should include TASK MANAGEMENT section', () => {
      const result = buildGlobalAssistantInstructions();
      expect(result).toContain('TASK MANAGEMENT');
      expect(result).toContain('TASK_LIST');
      expect(result).toContain('update_task');
    });

    it('should include PAGE TYPES section', () => {
      const result = buildGlobalAssistantInstructions();
      expect(result).toContain('PAGE TYPES');
    });

    it('should include AFTER TOOLS section', () => {
      const result = buildGlobalAssistantInstructions();
      expect(result).toContain('AFTER TOOLS');
    });

    it('should include MENTIONS section', () => {
      const result = buildGlobalAssistantInstructions();
      expect(result).toContain('MENTIONS');
    });

    it('should handle undefined locationContext gracefully', () => {
      expect(() => buildGlobalAssistantInstructions(undefined)).not.toThrow();
    });

    it('should handle empty locationContext gracefully', () => {
      expect(() => buildGlobalAssistantInstructions({})).not.toThrow();
    });
  });
});
