/**
 * @module @pagespace/lib/monitoring
 * @description AI monitoring, analytics, and activity tracking
 */

export * from './activity-tracker';

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
