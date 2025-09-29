import type { Page } from './types';
/**
 * Formats the content of a given page for AI consumption.
 * @param page The page object to format content from.
 * @returns A formatted string of the page's content.
 */
export declare function getPageContentForAI(page: Page & {
    channelMessages?: any[];
    children?: any[];
}): string;
//# sourceMappingURL=page-content-parser.d.ts.map