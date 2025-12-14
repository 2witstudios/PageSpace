/**
 * useDocumentStore Tests
 * Tests for document state management and auto-save functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useDocumentStore } from '../useDocumentStore';

describe('useDocumentStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useDocumentStore.setState({
      pageId: null,
      content: '',
      saveCallback: null,
      activeView: 'rich',
    });
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('given store is created, should have null pageId', () => {
      const { pageId } = useDocumentStore.getState();
      expect(pageId).toBeNull();
    });

    it('given store is created, should have empty content', () => {
      const { content } = useDocumentStore.getState();
      expect(content).toBe('');
    });

    it('given store is created, should have null saveCallback', () => {
      const { saveCallback } = useDocumentStore.getState();
      expect(saveCallback).toBeNull();
    });

    it('given store is created, should have rich as default activeView', () => {
      const { activeView } = useDocumentStore.getState();
      expect(activeView).toBe('rich');
    });
  });

  describe('setDocument', () => {
    it('given page ID and content, should set both values', () => {
      const { setDocument } = useDocumentStore.getState();

      setDocument('page-123', '<p>Hello World</p>');

      const { pageId, content } = useDocumentStore.getState();
      expect(pageId).toBe('page-123');
      expect(content).toBe('<p>Hello World</p>');
    });

    it('given setDocument called, should reset activeView to rich', () => {
      useDocumentStore.setState({ activeView: 'code' });
      const { setDocument } = useDocumentStore.getState();

      setDocument('page-456', 'content');

      expect(useDocumentStore.getState().activeView).toBe('rich');
    });
  });

  describe('setContent', () => {
    it('given new content, should update the content', () => {
      const { setContent } = useDocumentStore.getState();

      setContent('<p>Updated content</p>');

      expect(useDocumentStore.getState().content).toBe('<p>Updated content</p>');
    });

    it('given no pageId, should not trigger save callback', () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      useDocumentStore.setState({ pageId: null, saveCallback: mockSave });
      const { setContent } = useDocumentStore.getState();

      setContent('new content');
      vi.advanceTimersByTime(1500);

      expect(mockSave).not.toHaveBeenCalled();
    });

    it('given no saveCallback, should not throw', () => {
      useDocumentStore.setState({ pageId: 'page-123', saveCallback: null });
      const { setContent } = useDocumentStore.getState();

      expect(() => {
        setContent('new content');
        vi.advanceTimersByTime(1500);
      }).not.toThrow();
    });

    it('given pageId and saveCallback, should call save after 1 second delay', async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      useDocumentStore.setState({
        pageId: 'page-123',
        saveCallback: mockSave,
      });
      const { setContent } = useDocumentStore.getState();

      setContent('auto-save content');

      expect(mockSave).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(mockSave).toHaveBeenCalledWith('page-123', 'auto-save content');
    });

    it('given multiple rapid setContent calls, should debounce and only call save once', async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      useDocumentStore.setState({
        pageId: 'page-123',
        saveCallback: mockSave,
      });
      const { setContent } = useDocumentStore.getState();

      setContent('content 1');
      vi.advanceTimersByTime(500);

      setContent('content 2');
      vi.advanceTimersByTime(500);

      setContent('content 3');
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith('page-123', 'content 3');
    });

    it('given save fails, should log error and not throw', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSave = vi.fn().mockRejectedValue(new Error('Save failed'));
      useDocumentStore.setState({
        pageId: 'page-123',
        saveCallback: mockSave,
      });
      const { setContent } = useDocumentStore.getState();

      setContent('failing content');
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      // Allow promise rejection to be caught
      await vi.advanceTimersByTimeAsync(10);

      expect(consoleError).toHaveBeenCalledWith('Failed to save document:', expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe('setSaveCallback', () => {
    it('given a callback function, should store it', () => {
      const mockSave = vi.fn();
      const { setSaveCallback } = useDocumentStore.getState();

      setSaveCallback(mockSave);

      expect(useDocumentStore.getState().saveCallback).toBe(mockSave);
    });
  });

  describe('setActiveView', () => {
    it('given rich view, should set activeView to rich', () => {
      useDocumentStore.setState({ activeView: 'code' });
      const { setActiveView } = useDocumentStore.getState();

      setActiveView('rich');

      expect(useDocumentStore.getState().activeView).toBe('rich');
    });

    it('given code view, should set activeView to code', () => {
      const { setActiveView } = useDocumentStore.getState();

      setActiveView('code');

      expect(useDocumentStore.getState().activeView).toBe('code');
    });
  });

  describe('document workflow', () => {
    it('given typical editing workflow, should manage state correctly', async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const { setDocument, setSaveCallback, setContent, setActiveView } = useDocumentStore.getState();

      // User opens a document
      setDocument('page-new', '<p>Initial content</p>');
      setSaveCallback(mockSave);

      // User makes edits
      setContent('<p>Initial content</p><p>New paragraph</p>');

      // User switches to code view
      setActiveView('code');

      // Verify state
      const state = useDocumentStore.getState();
      expect(state.pageId).toBe('page-new');
      expect(state.content).toBe('<p>Initial content</p><p>New paragraph</p>');
      expect(state.activeView).toBe('code');

      // Wait for auto-save
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(mockSave).toHaveBeenCalledWith('page-new', '<p>Initial content</p><p>New paragraph</p>');
    });
  });
});
