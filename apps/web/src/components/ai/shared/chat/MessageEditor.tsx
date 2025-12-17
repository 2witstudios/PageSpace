import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Check, X } from 'lucide-react';

interface MessageEditorProps {
  initialContent: string;
  onSave: (newContent: string) => Promise<void>;
  onCancel: () => void;
  placeholder?: string;
}

export const MessageEditor: React.FC<MessageEditorProps> = ({
  initialContent,
  onSave,
  onCancel,
  placeholder = 'Edit message...',
}) => {
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus and select all text when component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [content]);

  const handleSave = async () => {
    if (!content.trim()) {
      return; // Don't save empty messages
    }

    if (content === initialContent) {
      onCancel(); // No changes, just cancel
      return;
    }

    setIsSaving(true);
    try {
      await onSave(content);
    } catch (error) {
      console.error('Failed to save message:', error);
      // Keep editor open on error
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Save on Cmd+Enter or Ctrl+Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }

    // Cancel on Escape
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={isSaving}
        className="min-h-[80px] resize-none"
      />
      <div className="flex items-center space-x-2">
        <Button
          onClick={handleSave}
          disabled={isSaving || !content.trim() || content === initialContent}
          size="sm"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="h-3 w-3 mr-1" />
              Save
            </>
          )}
        </Button>
        <Button
          onClick={onCancel}
          disabled={isSaving}
          variant="ghost"
          size="sm"
        >
          <X className="h-3 w-3 mr-1" />
          Cancel
        </Button>
        <span className="text-xs text-muted-foreground ml-auto">
          {isSaving ? null : 'Press Cmd+Enter to save, Esc to cancel'}
        </span>
      </div>
    </div>
  );
};
