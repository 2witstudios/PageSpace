import { MentionType } from '@/types/mentions';

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
      console.warn(`Unknown mention format: ${formatType}, falling back to label`);
      return MENTION_FORMATS.label.template(label, id, type);
    }
    return formatConfig.template(label, id, type);
  }

  static getConfigForInputType(inputType: 'textarea' | 'richline'): InputTypeConfig {
    const config = INPUT_TYPE_CONFIGS[inputType];
    if (!config) {
      console.warn(`Unknown input type: ${inputType}, falling back to textarea config`);
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

// Global configuration that can be overridden per component
export interface GlobalMentionConfig {
  defaultFormat: MentionFormatType;
  enforceInputTypeDefaults: boolean;
  allowFormatOverride: boolean;
}

export const DEFAULT_GLOBAL_CONFIG: GlobalMentionConfig = {
  defaultFormat: 'label',
  enforceInputTypeDefaults: true,
  allowFormatOverride: true,
};

let globalConfig = { ...DEFAULT_GLOBAL_CONFIG };

export const MentionConfigManager = {
  setGlobalConfig: (config: Partial<GlobalMentionConfig>) => {
    globalConfig = { ...globalConfig, ...config };
  },

  getGlobalConfig: (): GlobalMentionConfig => globalConfig,

  getEffectiveFormat: (
    inputType: 'textarea' | 'richline',
    requestedFormat?: MentionFormatType
  ): MentionFormatType => {
    const inputConfig = MentionFormatter.getConfigForInputType(inputType);
    
    // If enforcing input type defaults, use the input type's default
    if (globalConfig.enforceInputTypeDefaults) {
      return inputConfig.defaultFormat;
    }

    // If a specific format is requested and overrides are allowed
    if (requestedFormat && globalConfig.allowFormatOverride) {
      // Validate that the format is supported by the input type
      if (MentionFormatter.validateFormat(requestedFormat, inputType)) {
        return requestedFormat;
      } else {
        console.warn(
          `Format ${requestedFormat} not supported for ${inputType}, using default`
        );
        return inputConfig.defaultFormat;
      }
    }

    // Fall back to global default if supported by input type
    if (MentionFormatter.validateFormat(globalConfig.defaultFormat, inputType)) {
      return globalConfig.defaultFormat;
    }

    // Final fallback to input type default
    return inputConfig.defaultFormat;
  }
};