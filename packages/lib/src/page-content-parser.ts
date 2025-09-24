import type { Page } from './types';
import { PageType } from './enums';

type ContentFormat = string[] | string | any;

/**
 * Converts various content formats to plain text for AI consumption.
 * Handles: Richline arrays and plain strings.
 */
function convertContentToPlainText(content: ContentFormat): string {
  // Handle Richline format (string array)
  if (Array.isArray(content)) {
    return content.join('\n');
  }
  
  // Handle plain string
  if (typeof content === 'string') {
    return content;
  }
  
  // Fallback for unknown formats
  return JSON.stringify(content, null, 2);
}

/**
 * Formats the content of a given page for AI consumption.
 * @param page The page object to format content from.
 * @returns A formatted string of the page's content.
 */
export function getPageContentForAI(page: Page & { channelMessages?: any[], children?: any[] }): string {
    if (!page) {
        return `[Page not found.]`;
    }

    let contentString = `--- Start of Context from Page: "${page.title}" (Type: ${page.type}) ---\n`;

    switch (page.type) {
        case PageType.DOCUMENT:
            if (page.content) {
                contentString += convertContentToPlainText(page.content);
            } else {
                contentString += "No document content available.\n";
            }
            break;
        case PageType.CHANNEL:
            if (page.channelMessages && page.channelMessages.length > 0) {
                contentString += "Channel Messages:\n";
                page.channelMessages.forEach((msg: any) => {
                    contentString += `- ${msg.user?.name || 'Unknown'}: ${msg.content}\n`;
                });
            } else {
                contentString += "No channel messages available.\n";
            }
            break;
        case PageType.FOLDER:
            if (page.children && page.children.length > 0) {
                contentString += "Folder Contents (Titles):\n";
                page.children.forEach((child: any) => {
                    contentString += `- ${child.title} (Type: ${child.type})\n`;
                });
            } else {
                contentString += "Folder is empty.\n";
            }
            break;
        case PageType.SHEET:
            if (page.content && typeof page.content === 'string' && page.content.trim() !== '') {
                contentString += "Sheet Data (CSV format):\n";
                contentString += `${page.content}\n`;
            } else {
                contentString += "Sheet is empty.\n";
            }
            break;
        default:
            contentString += `Content extraction not implemented for page type: ${page.type}.\n`;
    }

    contentString += `\n--- End of Context from Page: "${page.title}" ---\n`;
    return contentString;
}