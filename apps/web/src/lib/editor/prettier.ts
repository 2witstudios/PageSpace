import { format } from 'prettier/standalone';
import * as prettierPluginHtml from 'prettier/plugins/html';

export const formatHtml = async (html: string): Promise<string> => {
  try {
    // CRITICAL FIX: Strip leading whitespace from lines starting with HTML tags
    // to prevent Markdown code block interpretation.
    // In Markdown (used by Tiptap), indenting by 4 spaces or a tab creates a code block.
    // This causes AI-generated indented HTML like "    <p>text</p>" to render as code.
    //
    // We only strip leading whitespace from lines that start with HTML tags (< character),
    // preserving meaningful indentation inside <pre>, <code>, <textarea>, etc.
    const normalizedHtml = html
      .split('\n')
      .map(line => {
        // Only strip leading whitespace if the line starts with an HTML tag
        const trimmed = line.trimStart();
        if (trimmed.startsWith('<')) {
          return trimmed;
        }
        // Preserve original indentation for non-tag lines (e.g., code inside <pre>)
        return line;
      })
      .join('\n')
      .trim();

    // Detect trailing spaces in text content before closing tags
    // Pattern matches: " </p>", " </h1>", " </li>", etc.
    const trailingSpacePattern = /( )(<\/(?:p|h1|h2|h3|h4|h5|h6|li|td|th|blockquote)>)/g;
    const trailingSpaces: Array<{ tag: string; position: number }> = [];

    let match;
    while ((match = trailingSpacePattern.exec(normalizedHtml)) !== null) {
      trailingSpaces.push({
        tag: match[2], // The closing tag like "</p>"
        position: match.index
      });
    }

    // Format with Prettier (may remove trailing spaces)
    let formatted = await format(normalizedHtml, {
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
        const escapedTag = closingTag.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        const noSpacePattern = new RegExp(`([^\\s>])(${escapedTag})`, 'g');
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