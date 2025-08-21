import { format } from 'prettier/standalone';
import * as prettierPluginHtml from 'prettier/plugins/html';

export const formatHtml = async (html: string): Promise<string> => {
  try {
    return await format(html, {
      parser: 'html',
      plugins: [prettierPluginHtml],
      printWidth: 120,
    });
  } catch (error) {
    console.error('Error formatting HTML:', error);
    return html;
  }
};