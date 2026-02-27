/**
 * User-friendly error messages for AI chat errors
 */

/**
 * Get user-friendly error message based on error content
 */
export function getAIErrorMessage(errorMessage: string | undefined): string {
  if (!errorMessage) return 'Something went wrong. Please try again.';

  const msg = errorMessage.toLowerCase();

  // Authentication errors
  if (errorMessage.includes('Unauthorized') || errorMessage.includes('401')) {
    return 'Authentication failed. Please refresh the page and try again.';
  }

  // Request size errors (distinct from context-window limits)
  if (
    msg.includes('request body too large') ||
    msg.includes('payload too large') ||
    msg.includes('entity too large')
  ) {
    return 'Your request is too large. Try sending a shorter message or fewer/lower-size attachments.';
  }

  // Context length errors
  if (isContextLengthError(errorMessage)) {
    // Preserve server-provided guidance when present (e.g. "even after trimming", "latest message too large")
    if (
      msg.includes('latest message is too large') ||
      msg.includes('even after trimming') ||
      msg.includes('too long for this model')
    ) {
      return errorMessage;
    }
    return 'The conversation is too long for this model\'s context window. Please start a new conversation or use a model with a larger context window.';
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

  // Explicitly exclude non-context 413 payload errors
  if (
    msg.includes('request body too large') ||
    msg.includes('payload too large') ||
    msg.includes('entity too large')
  ) {
    return false;
  }

  return (
    msg.includes('context_length') ||     // API error key: context_length_exceeded
    msg.includes('context length') ||     // Human-readable variant
    msg.includes('context window') ||
    msg.includes('maximum context') ||
    msg.includes('token limit') ||
    msg.includes('tokens exceeds') ||
    msg.includes('too many tokens') ||
    errorMessage.includes('413') ||
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
