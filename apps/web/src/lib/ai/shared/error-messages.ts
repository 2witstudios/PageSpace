/**
 * User-friendly error messages for AI chat errors
 */

/**
 * Get user-friendly error message based on error content
 */
export function getAIErrorMessage(errorMessage: string | undefined): string {
  if (!errorMessage) return 'Something went wrong. Please try again.';

  // Authentication errors
  if (errorMessage.includes('Unauthorized') || errorMessage.includes('401')) {
    return 'Authentication failed. Please refresh the page and try again.';
  }

  // Rate limit errors
  if (
    errorMessage.toLowerCase().includes('rate') ||
    errorMessage.toLowerCase().includes('limit') ||
    errorMessage.includes('429') ||
    errorMessage.includes('402') ||
    errorMessage.includes('Failed after') ||
    errorMessage.includes('Provider returned error')
  ) {
    return 'Free tier rate limit hit. Please try again in a few seconds or subscribe for premium models and access.';
  }

  return 'Something went wrong. Please try again.';
}

/**
 * Check if error is an authentication error
 */
export function isAuthenticationError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return errorMessage.includes('Unauthorized') || errorMessage.includes('401');
}

/**
 * Check if error is a rate limit error
 */
export function isRateLimitError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return (
    errorMessage.toLowerCase().includes('rate') ||
    errorMessage.toLowerCase().includes('limit') ||
    errorMessage.includes('429') ||
    errorMessage.includes('402') ||
    errorMessage.includes('Failed after') ||
    errorMessage.includes('Provider returned error')
  );
}
