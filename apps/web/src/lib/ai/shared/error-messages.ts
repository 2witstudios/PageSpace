/**
 * User-friendly error messages for AI chat errors
 */

/**
 * Check if error is a request payload size error (distinct from context-window limits)
 */
export function isPayloadSizeError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('request body too large') ||
    msg.includes('payload too large') ||
    msg.includes('entity too large')
  );
}

/**
 * Get user-friendly error message based on error content
 */
export function getAIErrorMessage(errorMessage: string | undefined): string {
  if (!errorMessage) return 'Something went wrong. Please try again.';

  const msg = errorMessage.toLowerCase();

  if (isAuthenticationError(errorMessage)) {
    return 'Authentication failed. Please refresh the page and try again.';
  }

  if (isPayloadSizeError(errorMessage)) {
    return 'Your request is too large. Try sending a shorter message or fewer/lower-size attachments.';
  }

  if (isContextLengthError(errorMessage)) {
    // Preserve server-provided guidance when present
    if (
      msg.includes('latest message is too large') ||
      msg.includes('even after trimming') ||
      msg.includes('too long for this model')
    ) {
      return errorMessage;
    }
    return 'The conversation is too long for this model\'s context window. Please start a new conversation or use a model with a larger context window.';
  }

  if (isRateLimitError(errorMessage)) {
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
  if (isPayloadSizeError(errorMessage)) return false;

  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('context_length') ||
    msg.includes('context length') ||
    msg.includes('context window') ||
    msg.includes('maximum context') ||
    msg.includes('token limit exceeded') ||
    msg.includes('tokens exceeds') ||
    msg.includes('too many tokens') ||
    (msg.includes('maximum') && msg.includes('tokens'))
  );
}

/**
 * Check if error is a rate limit error
 */
export function isRateLimitError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (isContextLengthError(errorMessage)) return false;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('rate') ||
    msg.includes('limit') ||
    errorMessage.includes('429') ||
    errorMessage.includes('402') ||
    errorMessage.includes('Failed after') ||
    errorMessage.includes('Provider returned error')
  );
}
