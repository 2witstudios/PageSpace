import { useEffect, useRef } from 'react';

/**
 * Shell hook for the sheet's global keyboard shortcuts (Ctrl/Cmd + S / Z / Y).
 * The handlers are held in refs and the listener has empty deps, so it is
 * attached exactly once and never re-subscribes as the callbacks change.
 */
export interface UseSheetKeyboardShortcutsParams {
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

export const useSheetKeyboardShortcuts = ({ onSave, onUndo, onRedo }: UseSheetKeyboardShortcutsParams) => {
  const onSaveRef = useRef(onSave);
  const onUndoRef = useRef(onUndo);
  const onRedoRef = useRef(onRedo);
  useEffect(() => {
    onSaveRef.current = onSave;
    onUndoRef.current = onUndo;
    onRedoRef.current = onRedo;
  }, [onSave, onUndo, onRedo]);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.addEventListener) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSaveRef.current();
        return;
      }

      // Ctrl+Z / Cmd+Z to undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        onUndoRef.current();
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y / Cmd+Y to redo
      if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        onRedoRef.current();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, []); // ✅ Empty deps — uses refs for latest handlers
};
