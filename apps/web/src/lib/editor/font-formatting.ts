import { Extension } from '@tiptap/core';

const normalizeStyleValue = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const FontFormatting = Extension.create({
  name: 'fontFormatting',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) => normalizeStyleValue(element.style.fontFamily),
            renderHTML: (attributes) => {
              if (!attributes.fontFamily) {
                return {};
              }

              return { style: `font-family: ${attributes.fontFamily}` };
            },
          },
          fontSize: {
            default: null,
            parseHTML: (element) => normalizeStyleValue(element.style.fontSize),
            renderHTML: (attributes) => {
              if (!attributes.fontSize) {
                return {};
              }

              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
});
