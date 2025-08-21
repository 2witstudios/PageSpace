export interface Position {
  top?: number;
  left: number;
  width?: number;
  bottom?: number;
}

export interface TextareaPositionParams {
  element: HTMLTextAreaElement;
  textBeforeCursor: string;
  preferredWidth?: number;
}

export interface RichlinePositionParams {
  element: HTMLElement;
  preferredWidth?: number;
}

export interface InlinePositionParams {
  element: HTMLElement;
  preferredWidth?: number;
}

export const positioningService = {
  calculateTextareaPosition: (
    params: TextareaPositionParams
  ): Position => {
    const { element } = params;
    const rect = element.getBoundingClientRect();
    
    // Anchor to the bottom of the viewport, with a gap above the textarea
    return {
      bottom: window.innerHeight - rect.top + 8,
      left: rect.left,
      width: rect.width,
    };
  },

  calculateRichlinePosition: (
    params: RichlinePositionParams
  ): Position => {
    const { element } = params;
    const rect = element.getBoundingClientRect();
    
    // Position above the richline editor with 8px gap
    const popupHeight = 240; // Max height for ~6 items
    
    return {
      top: rect.top - popupHeight - 8,
      left: rect.left,
      width: rect.width, // Use element width instead of preferredWidth
    };
  },

  calculateInlinePosition: (
    params: InlinePositionParams
  ): Position => {
    // Use browser's selection API for precise cursor positioning
    const selection = window.getSelection();
    
    if (!selection || selection.rangeCount === 0) {
      // Fallback to element positioning if no selection
      const { element } = params;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top + 30,
        left: rect.left + 20,
        width: 240,
      };
    }
    
    // Get exact cursor position from browser
    const range = selection.getRangeAt(0);
    const cursorRect = range.getBoundingClientRect();
    
    // Calculate popup dimensions
    const popupWidth = 240;
    const popupHeight = 240;
    const gap = 6;
    
    // Primary position: Below cursor
    let top = cursorRect.bottom + gap;
    let left = cursorRect.left;
    
    // Handle vertical overflow - position above if not enough space below
    if (top + popupHeight > window.innerHeight - 20) {
      top = cursorRect.top - popupHeight - gap;
    }
    
    // Handle horizontal overflow
    if (left + popupWidth > window.innerWidth - 20) {
      left = window.innerWidth - popupWidth - 20;
    }
    
    // Ensure popup doesn't go off edges
    left = Math.max(20, left);
    top = Math.max(20, top);
    
    return {
      top,
      left,
      width: popupWidth,
    };
  },
};