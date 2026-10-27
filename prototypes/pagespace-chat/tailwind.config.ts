import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      typography: {
        invert: {
          css: {
            '--tw-prose-body': '#d1d5db',
            '--tw-prose-headings': '#f9fafb',
            '--tw-prose-bold': '#f9fafb',
            '--tw-prose-code': '#e5e7eb',
            '--tw-prose-pre-bg': '#111827',
            '--tw-prose-links': '#60a5fa',
            '--tw-prose-bullets': '#6b7280',
            '--tw-prose-counters': '#6b7280',
            '--tw-prose-hr': '#374151',
            '--tw-prose-quotes': '#d1d5db',
            '--tw-prose-quote-borders': '#374151',
            '--tw-prose-th-borders': '#374151',
            '--tw-prose-td-borders': '#1f2937',
          },
        },
      },
    },
  },
  plugins: [typography],
};

export default config;
