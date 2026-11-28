import { useRef, useCallback } from 'react';

export function useMentionOverlay(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  hasMentions: boolean
) {
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [textareaRef]);

  return { overlayRef, hasMentions, handleScroll };
}
