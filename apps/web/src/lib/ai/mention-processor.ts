/**
 * Mention Processor for AI Chat System
 * 
 * This module processes @mentions in user messages to extract document IDs
 * that the AI should read before responding. It parses the markdown-typed
 * mention format: @[Label](id:type) and returns the IDs for processing.
 */

import { loggers } from '@pagespace/lib/server';

export interface ProcessedMention {
  id: string;
  label: string;
  type: string;
}

export interface ProcessedMessage {
  /** Original message content with @mentions intact */
  originalContent: string;
  /** Array of page IDs that were mentioned */
  pageIds: string[];
  /** Detailed mention information */
  mentions: ProcessedMention[];
}

/**
 * Process @mentions in a user message to extract document IDs
 * 
 * @param content - The raw message content containing @mentions
 * @returns Object containing page IDs and processed content
 */
export function processMentionsInMessage(content: string): ProcessedMessage {
  // Regex to match @[Label](id:type) format
  const mentionRegex = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;
  
  const pageIds: string[] = [];
  const mentions: ProcessedMention[] = [];
  
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const [, label, id, type] = match;
    
    // Only process page mentions (includes all page types: DOCUMENT, FOLDER, AI_CHAT, CHANNEL)
    // Exclude user mentions as they don't need to be read as documents
    if (type === 'page') {
      pageIds.push(id);
      mentions.push({
        id,
        label,
        type
      });
      
      loggers.ai.debug('Mention Processor: Found document mention', {
        label,
        id,
        type
      });
    }
  }
  
  loggers.ai.debug('Mention Processor: Processed message', {
    originalLength: content.length,
    mentionsFound: mentions.length,
    pageIds
  });
  
  return {
    originalContent: content,
    pageIds,
    mentions
  };
}

/**
 * Build a system prompt instruction for processing mentioned documents
 * 
 * @param mentions - Array of processed mentions
 * @returns System prompt text instructing the AI to read mentioned documents
 */
export function buildMentionSystemPrompt(mentions: ProcessedMention[]): string {
  if (mentions.length === 0) {
    return '';
  }
  
  const mentionList = mentions
    .map(m => `- "${m.label}" (${m.id})`)
    .join('\n');
  
  return `
IMPORTANT: The user has @mentioned the following documents in their message:
${mentionList}

You MUST:
1. Use the read_page tool to read each mentioned document BEFORE formulating your response
2. Let the content of these documents inform and enrich your answer
3. Reference relevant information from the mentioned documents in your response when appropriate
4. If you cannot access a mentioned document, acknowledge this in your response

The mentioned documents provide critical context for answering the user's question effectively.
`;
}

/**
 * Create tool calls for reading mentioned pages
 * This helps the AI automatically read mentioned documents
 * 
 * @param pageIds - Array of page IDs to read
 * @param mentions - Array of processed mentions for context
 * @returns Instructions for the AI to execute read_page tools
 */
export function createMentionToolInstructions(pageIds: string[], mentions: ProcessedMention[]): string {
  if (pageIds.length === 0) {
    return '';
  }
  
  const mentionMap = new Map(mentions.map(m => [m.id, m]));
  
  const instructions = pageIds
    .map(id => {
      const mention = mentionMap.get(id);
      if (!mention) return null;
      
      // Build a path hint for the AI (it may not be accurate but helps with context)
      const pathHint = `/${mention.label}`;
      
      return `read_page(path: "${pathHint}", pageId: "${id}")`;
    })
    .filter(Boolean)
    .join('\n');
  
  return `
Before responding, execute these tool calls to read the mentioned documents:
${instructions}
`;
}

/**
 * Check if a message contains any @mentions
 * 
 * @param content - The message content to check
 * @returns True if the message contains @mentions
 */
export function hasMentions(content: string): boolean {
  const mentionRegex = /@\[([^\]]+)\]\(([^:]+):([^)]+)\)/;
  return mentionRegex.test(content);
}

/**
 * Extract just the page IDs from a message without full processing
 * Useful for quick checks or permission validation
 * 
 * @param content - The message content
 * @returns Array of page IDs
 */
export function extractPageIds(content: string): string[] {
  const mentionRegex = /@\[([^\]]+)\]\(([^:]+):page\)/g;
  const pageIds: string[] = [];
  
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const [, , id] = match;
    pageIds.push(id);
  }
  
  return pageIds;
}