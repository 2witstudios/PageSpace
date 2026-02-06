import { MentionType } from '@/types/mentions';
import { createClientLogger } from '@/lib/logging/client-logger';

export type MentionFormatType = 'label' | 'markdown' | 'markdown-typed';

export interface MentionFormatConfig {
  format: MentionFormatType;
  template: (label: string, id: string, type?: MentionType) => string;
  displayName: string;
  description: string;
}

export const MENTION_FORMATS: Record<MentionFormatType, MentionFormatConfig> = {
  label: {
    format: 'label',
    template: (label: string) => `@${label}`,
    displayName: 'Simple Label',
    description: 'Just @username format'
  },
  markdown: {
    format: 'markdown',
    template: (label: string, id: string) => `@[${label}](${id})`,
    displayName: 'Markdown Link',
    description: 'Markdown link format with ID reference'
  },
  'markdown-typed': {
    format: 'markdown-typed',
    template: (label: string, id: string, type: MentionType = 'page') => `@[${label}](${id}:${type})`,
    displayName: 'Typed Markdown Link',
    description: 'Markdown link with ID and type reference'
  }
};

export interface InputTypeConfig {
  inputType: 'textarea' | 'richline';
  defaultFormat: MentionFormatType;
  supportedFormats: MentionFormatType[];
  defaultAllowedTypes: MentionType[];
  defaultTrigger: string;
}

export const INPUT_TYPE_CONFIGS: Record<string, InputTypeConfig> = {
  textarea: {
    inputType: 'textarea',
    defaultFormat: 'markdown-typed',
    supportedFormats: ['label', 'markdown', 'markdown-typed'],
    defaultAllowedTypes: ['page', 'user'],
    defaultTrigger: '@'
  },
  richline: {
    inputType: 'richline',
    defaultFormat: 'markdown-typed',
    supportedFormats: ['markdown', 'markdown-typed', 'label'],
    defaultAllowedTypes: ['page', 'user'],
    defaultTrigger: '@'
  }
};

export class MentionFormatter {
  static format(
    label: string,
    id: string,
    type: MentionType,
    formatType: MentionFormatType = 'label'
  ): string {
    const formatConfig = MENTION_FORMATS[formatType];
    if (!formatConfig) {
      mentionLogger.warn('Unknown mention format requested, falling back to label', {
        formatType,
      });
      return MENTION_FORMATS.label.template(label, id, type);
    }
    return formatConfig.template(label, id, type);
  }

  static getConfigForInputType(inputType: 'textarea' | 'richline'): InputTypeConfig {
    const config = INPUT_TYPE_CONFIGS[inputType];
    if (!config) {
      mentionLogger.warn('Unknown input type requested, using textarea defaults', {
        inputType,
      });
      return INPUT_TYPE_CONFIGS.textarea;
    }
    return config;
  }

  static validateFormat(
    formatType: MentionFormatType, 
    inputType: 'textarea' | 'richline'
  ): boolean {
    const config = this.getConfigForInputType(inputType);
    return config.supportedFormats.includes(formatType);
  }

  static getRecommendedFormat(inputType: 'textarea' | 'richline'): MentionFormatType {
    const config = this.getConfigForInputType(inputType);
    return config.defaultFormat;
  }
}

const mentionLogger = createClientLogger({ namespace: 'mentions', component: 'mention-config' });
