import { useRef, useCallback } from 'react';

const MENTION_PATTERN = /@\[[^\]]+\]\([^:]+:[^)]+\)/;

export function useMentionOverlay(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string
) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const hasMentions = MENTION_PATTERN.test(value);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [textareaRef]);

  return { overlayRef, hasMentions, handleScroll };
}
