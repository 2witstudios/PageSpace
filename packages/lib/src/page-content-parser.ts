import type { Page } from './types';
import { PageType } from './enums';
import { evaluateSheet, parseSheetContent, encodeCellAddress } from './sheet';

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
        case PageType.SHEET: {
            try {
                const sheetData = parseSheetContent(page.content);
                const evaluation = evaluateSheet(sheetData);
                const maxRows = Math.min(sheetData.rowCount, 50);
                const maxCols = Math.min(sheetData.columnCount, 26);
                contentString += `Sheet size: ${sheetData.rowCount} rows x ${sheetData.columnCount} columns.\n`;
                if (sheetData.rowCount > maxRows || sheetData.columnCount > maxCols) {
                    contentString += `Showing first ${maxRows} rows and ${maxCols} columns for brevity.\n`;
                }

                const columnHeaders = Array.from({ length: maxCols }, (_, index) =>
                    encodeCellAddress(0, index).replace(/\d+/g, '')
                );
                const headerLine = `    | ${columnHeaders.join(' | ')}`;
                contentString += `${headerLine}\n`;
                contentString += `${'-'.repeat(headerLine.length)}\n`;

                for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
                    const rowLabel = String(rowIndex + 1).padStart(3, ' ');
                    const rowValues = columnHeaders.map((_, columnIndex) => {
                        const displayValue = evaluation.display[rowIndex]?.[columnIndex] ?? '';
                        return displayValue === '' ? ' ' : displayValue;
                    });
                    contentString += `${rowLabel} | ${rowValues.join(' | ')}\n`;
                }

                if (sheetData.rowCount > maxRows || sheetData.columnCount > maxCols) {
                    contentString += '... (grid truncated)\n';
                }

                const cellEntries = Object.entries(sheetData.cells).sort(([a], [b]) => a.localeCompare(b));
                if (cellEntries.length > 0) {
                    contentString += '\nCell inputs (raw values including formulas):\n';
                    cellEntries.forEach(([address, raw]) => {
                        const evaluated = evaluation.byAddress[address];
                        const displayValue = evaluated?.error ? '#ERROR' : evaluated?.display ?? '';
                        const errorNote = evaluated?.error ? ` (error: ${evaluated.error})` : '';
                        contentString += `${address}: ${raw} => ${displayValue || ' '}${errorNote}\n`;
                    });
                } else {
                    contentString += '\nAll cells are currently empty.\n';
                }
            } catch (error) {
                contentString += `Failed to parse sheet content: ${error instanceof Error ? error.message : String(error)}\n`;
            }
            break;
        }
        default:
            contentString += `Content extraction not implemented for page type: ${page.type}.\n`;
    }

    contentString += `\n--- End of Context from Page: "${page.title}" ---\n`;
    return contentString;
}