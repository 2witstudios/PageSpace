/**
 * Processor service configuration.
 * Centralized to avoid repeating the URL constant across API routes.
 */
export const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
