import { format } from 'prettier/standalone';
import * as prettierPluginHtml from 'prettier/plugins/html';

export const formatHtml = async (html: string): Promise<string> => {
  try {
    // Detect trailing spaces in text content before closing tags
    // Pattern matches: " </p>", " </h1>", " </li>", etc.
    const trailingSpacePattern = /( )(<\/(?:p|h1|h2|h3|h4|h5|h6|li|td|th|blockquote)>)/g;
    const trailingSpaces: Array<{ tag: string; position: number }> = [];

    let match;
    while ((match = trailingSpacePattern.exec(html)) !== null) {
      trailingSpaces.push({
        tag: match[2], // The closing tag like "</p>"
        position: match.index
      });
    }

    // Format with Prettier (may remove trailing spaces)
    let formatted = await format(html, {
      parser: 'html',
      plugins: [prettierPluginHtml],
      printWidth: 120,
    });

    // Restore trailing spaces that Prettier removed
    // We need to be careful here - Prettier may have reformatted the structure
    // So we use a more general approach: add space before closing tags where it's missing
    if (trailingSpaces.length > 0) {
      // For each type of closing tag that had trailing spaces, ensure they're preserved
      const tagTypes = new Set(trailingSpaces.map(ts => ts.tag));

      tagTypes.forEach(closingTag => {
        // Replace cases where text directly touches closing tag with space before tag
        // This regex finds: any non-whitespace character followed immediately by the closing tag
        const noSpacePattern = new RegExp(`([^\\s>])(${closingTag.replace(/[/]/g, '\\/')})`, 'g');
        formatted = formatted.replace(noSpacePattern, (match, char, tag) => {
          // Only add space if the original HTML had trailing spaces for this tag type
          return `${char} ${tag}`;
        });
      });
    }

    return formatted;
  } catch (error) {
    console.error('Error formatting HTML:', error);
    return html;
  }
};