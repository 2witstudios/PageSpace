/**
 * @module @pagespace/lib/monitoring
 * @description AI monitoring, analytics, and activity tracking
 */

export * from './activity-tracker';
export * from './activity-logger';
export * from './change-group';

// Hash chain utilities for tamper-evident audit logging
export {
  computeLogHash,
  computeHashChainData,
  generateChainSeed,
  getLatestLogHash,
  getLatestLogHashWithTx,
  verifyLogHash,
  type HashChainData,
  type HashableLogData,
} from './hash-chain';

// Export ai-context-calculator (has the primary estimateTokens)
export * from './ai-context-calculator';

// Export ai-monitoring but exclude estimateTokens (duplicate)
export {
  AI_PRICING,
  MODEL_CONTEXT_WINDOWS,
  getContextWindow,
  calculateCost,
  trackAIUsage,
  trackAIToolUsage,
  getUserAIStats,
  getPopularAIFeatures,
  detectAIErrorPatterns,
  getTokenEfficiencyMetrics,
  AIMonitoring,
  type AIUsageData,
  type AIToolUsage,
} from './ai-monitoring';

// Re-export getContextWindowSize from ai-context-calculator for direct access
export { getContextWindowSize } from './ai-context-calculator';
