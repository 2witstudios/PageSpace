import { useCallback, useRef } from 'react';
import { MentionSuggestion, MentionType } from '@/types/mentions';
import { useSuggestionCore } from './useSuggestionCore';
import { useSuggestionContext } from '@/components/providers/SuggestionProvider';
import { positioningService, Position } from '@/services/positioningService';
import { MentionFormatter, MentionFormatType } from '@/lib/mentions/mentionConfig';

export interface UseSuggestionProps {
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  onValueChange: (value: string) => void;
  trigger?: string;
  allowedTypes?: MentionType[];
  driveId?: string;
  crossDrive?: boolean;
  mentionFormat?: MentionFormatType;
  variant?: 'chat' | 'document';
  popupPlacement?: 'top' | 'bottom';
  appendSpace?: boolean;
  triggerPattern?: RegExp;
}

export interface UseSuggestionResult {
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleValueChange: (newValue: string) => void;
  isOpen: boolean;
  position: Position | null;
  items: unknown[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  actions: {
    selectSuggestion: (suggestion: MentionSuggestion) => void;
    selectItem: (index: number) => void;
  };
}

export function useSuggestion({
  inputRef,
  onValueChange,
  trigger = '@',
  allowedTypes = ['page', 'user'],
  driveId,
  crossDrive = false,
  mentionFormat = 'label',
  variant = 'chat',
  popupPlacement = 'bottom',
  appendSpace = true,
  triggerPattern,
}: UseSuggestionProps): UseSuggestionResult {
  const context = useSuggestionContext();

  // Default pattern: @ must be at start or preceded by whitespace (existing behavior)
  // Sheet pattern should allow formula operators like: ( = + - * / , < > ! and whitespace
  const defaultTriggerPattern = /^$|^\s$/; // At start of string or preceded by whitespace
  const effectiveTriggerPattern = triggerPattern || defaultTriggerPattern;

  const getValue = useCallback((): string => {
    const element = inputRef.current;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }
    return '';
  }, [inputRef]);


  const getSelectionStart = useCallback((): number => {
    const element = inputRef.current;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.selectionStart ?? 0;
    }
    return 0;
  }, [inputRef]);

  const setSelectionStart = useCallback((position: number) => {
    const element = inputRef.current;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      element.setSelectionRange(position, position);
    }
  }, [inputRef]);

  // Track when we're temporarily disabling mention detection after insertion
  const suppressMentionDetection = useRef(false);

  const suggestion = useSuggestionCore({
    driveId: driveId || null,
    allowedTypes,
    minQueryLength: 0,
    debounceMs: 200,
    crossDrive,
  }, {
    onSelect: (selectedSuggestion) => {
      const element = inputRef.current;
      if (!element) return;

      const currentValue = getValue();
      const cursorPos = getSelectionStart();
      const textBeforeCursor = currentValue.substring(0, cursorPos);
      const textAfterCursor = currentValue.substring(cursorPos);

      const mentionTriggerIndex = textBeforeCursor.lastIndexOf(trigger);
      if (mentionTriggerIndex === -1) return;

      const textBeforeMention = textBeforeCursor.substring(0, mentionTriggerIndex);
      
      const mentionText = MentionFormatter.format(
        selectedSuggestion.label,
        selectedSuggestion.id,
        selectedSuggestion.type,
        mentionFormat
      );

      const insertion = appendSpace ? `${mentionText} ` : mentionText;
      const newValue = `${textBeforeMention}${insertion}${textAfterCursor}`;
      
      // Temporarily suppress mention detection to avoid interference
      suppressMentionDetection.current = true;
      
      onValueChange(newValue);

      // Set cursor position after the mention synchronously
      const newCursorPos =
        textBeforeMention.length + mentionText.length + (appendSpace ? 1 : 0);
      setSelectionStart(newCursorPos);

      // Focus the element
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        element.focus();
      }
      
      // Close both the suggestion core and the context to hide the popup
      suggestion.actions.close();
      context.close();
      
      // Re-enable mention detection after a brief delay
      setTimeout(() => {
        suppressMentionDetection.current = false;
      }, 100);
    },
    onClose: () => {
      context.close();
    }
  });

  const handleValueChange = useCallback((newValue: string) => {
    onValueChange(newValue); // Propagate change immediately

    // Skip mention detection if it's temporarily suppressed
    if (suppressMentionDetection.current) {
      return;
    }

    const element = inputRef.current;
    if (!element) return;

    const cursorPos = getSelectionStart();
    const textBeforeCursor = newValue.substring(0, cursorPos);
    
    // Find the most recent @ that could be a trigger
    const mentionTriggerIndex = textBeforeCursor.lastIndexOf(trigger);

    if (mentionTriggerIndex !== -1 && (mentionTriggerIndex === 0 || effectiveTriggerPattern.test(textBeforeCursor[mentionTriggerIndex - 1]))) {
      const textAfterTrigger = textBeforeCursor.substring(mentionTriggerIndex + 1);
      
      // Check if this @ is part of an existing mention by looking for patterns that indicate a completed mention
      // Patterns to detect: @username (followed by space or end), @[label](id), @[label](id:type)
      const existingMentionPatterns = [
        /^[^\s\[\]]+\s/, // @username followed by space (completed simple mention)
        /^\[[^\]]+\]\([^)]+\)/, // @[label](id) or @[label](id:type) (markdown-style mention)
      ];
      
      const isPartOfExistingMention = existingMentionPatterns.some(pattern => 
        pattern.test(textAfterTrigger)
      );
      
      if (!isPartOfExistingMention) {
        // This is a fresh @ trigger, proceed with suggestion logic
        const query = textAfterTrigger;
        
        if (!context.isOpen) {
          // Calculate position based on variant and input type
          let position: Position | null = null;

          if (variant === 'document') {
            if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
              position = positioningService.calculateTextareaPosition({
                element,
                textBeforeCursor,
                placement: popupPlacement,
              });
            } else {
              position = positioningService.calculateInlinePosition({
                element,
              });
            }
          } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
            position = positioningService.calculateTextareaPosition({
              element,
              textBeforeCursor,
              placement: popupPlacement,
            });
          }

          if (position) {
            context.open(position);
          }
        }
        suggestion.actions.setQuery(query);
      } else {
        // This @ is part of an existing mention, close suggestions if open
        if (context.isOpen) {
          suggestion.actions.close();
        }
      }
    } else {
      if (context.isOpen) {
        suggestion.actions.close();
      }
    }
  }, [
    onValueChange,
    inputRef,
    trigger,
    context,
    suggestion.actions,
    getSelectionStart,
    variant,
    popupPlacement,
    effectiveTriggerPattern
  ]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!context.isOpen || context.items.length === 0) return;

    const { items, selectedIndex } = context;
    const { selectItem, selectSuggestion, close } = suggestion.actions;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (popupPlacement === 'top') {
          selectItem(selectedIndex < items.length - 1 ? selectedIndex + 1 : 0);
        } else {
          selectItem(selectedIndex > 0 ? selectedIndex - 1 : items.length - 1);
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (popupPlacement === 'top') {
          selectItem(selectedIndex > 0 ? selectedIndex - 1 : items.length - 1);
        } else {
          selectItem(selectedIndex < items.length - 1 ? selectedIndex + 1 : 0);
        }
        break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (items[selectedIndex]) {
          selectSuggestion(items[selectedIndex]);
        }
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;

      default:
        break;
    }
  }, [context, suggestion.actions, popupPlacement]);

  return {
    handleKeyDown,
    handleValueChange,
    isOpen: context.isOpen,
    position: context.position,
    items: context.items,
    selectedIndex: context.selectedIndex,
    loading: context.loading,
    error: context.error,
    actions: suggestion.actions,
  };
}
