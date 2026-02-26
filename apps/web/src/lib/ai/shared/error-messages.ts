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

  // Context length errors
  if (isContextLengthError(errorMessage)) {
    return 'The conversation is too long for this model\'s context window. Please start a new conversation or switch to a model with a larger context window.';
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
 * Check if error is a context length / token limit error
 */
export function isContextLengthError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('context_length') ||     // API error key: context_length_exceeded
    msg.includes('context length') ||     // Human-readable variant
    msg.includes('context window') ||
    msg.includes('maximum context') ||
    msg.includes('token limit') ||
    msg.includes('tokens exceeds') ||
    msg.includes('too many tokens') ||
    // Match HTTP 413 only in status-code patterns (e.g. "status 413", "HTTP 413", "code 413")
    /\b(?:status|http|code|error)\s*413\b/i.test(errorMessage) ||
    // OpenRouter / provider-specific phrasing
    (msg.includes('maximum') && msg.includes('tokens'))
  );
}

/**
 * Check if error is a rate limit error
 */
export function isRateLimitError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  // Exclude context-length errors that also contain "limit"
  if (isContextLengthError(errorMessage)) return false;
  return (
    errorMessage.toLowerCase().includes('rate') ||
    errorMessage.toLowerCase().includes('limit') ||
    errorMessage.includes('429') ||
    errorMessage.includes('402') ||
    errorMessage.includes('Failed after') ||
    errorMessage.includes('Provider returned error')
  );
}
