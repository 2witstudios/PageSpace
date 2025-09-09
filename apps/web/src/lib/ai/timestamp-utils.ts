/**
 * Timestamp utilities for AI system prompts
 * Provides current date/time context to AI models for temporal awareness
 */

/**
 * Build timestamp system prompt section
 * Provides current date and time context to AI models
 */
export function buildTimestampSystemPrompt(): string {
  const currentTime = new Date().toLocaleString('en-US', { 
    timeZone: 'UTC',
    dateStyle: 'full',
    timeStyle: 'long'
  });

  return `

CURRENT TIMESTAMP CONTEXT:
• Current date and time: ${currentTime}
• When discussing schedules, deadlines, or time-sensitive matters, use this as your reference point
• For relative time references (e.g., "today", "tomorrow", "this week"), calculate from the current timestamp above`;
}