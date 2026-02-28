import type { ResponseValidationConfig } from '../types';
import { extractPath } from './transform-output';

export interface ResponseValidationResult {
  valid: boolean;
  error?: string;
}

const getErrorMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const validateResponse = (
  responseBody: unknown,
  validation?: ResponseValidationConfig
): ResponseValidationResult => {
  if (!validation) {
    return { valid: true };
  }

  const actual = extractPath(responseBody, validation.success.path);

  if (actual === validation.success.equals) {
    return { valid: true };
  }

  const providerError = validation.errorPath
    ? getErrorMessage(extractPath(responseBody, validation.errorPath))
    : undefined;

  return {
    valid: false,
    error: providerError ?? 'Provider response indicated failure',
  };
};
