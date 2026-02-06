/**
 * Type definitions for monitoring dashboard
 */

export interface SystemHealthData {
  logsByLevel: Array<{
    level: string;
    count: number;
  }>;
  recentErrors: Array<{
    id: string;
    timestamp: Date;
    message: string;
    errorName: string | null;
    errorMessage: string | null;
    endpoint: string | null;
    userId: string | null;
  }>;
  activeUserCount: number;
}

export interface UserActivityData {
  heatmapData: Array<{
    day_of_week: string;
    hour_of_day: string;
    activity_count: string;
  }>;
  mostActiveUsers: Array<{
    userId: string;
    userName: string;
    actionCount: number;
  }>;
  featureUsage: Array<{
    action: string;
    count: number;
  }>;
}

export interface AiUsageData {
  costsByProvider: Array<{
    provider: string;
    totalCost: number;
    requestCount: number;
  }>;
  tokenUsageOverTime: Array<{
    day: string;
    total_tokens: string;
    total_cost: string;
  }>;
  modelPopularity: Array<{
    model: string;
    usageCount: number;
    totalTokens: number;
  }>;
  successRate: number;
  topSpenders: Array<{
    userId: string;
    userName: string;
    totalCost: number;
    requestCount: number;
  }>;
}

export interface ErrorAnalyticsData {
  errorTrends: Array<{
    hour: string;
    category: string;
    count: string;
  }>;
  errorPatterns: Array<{
    name: string;
    category: string;
    count: number;
  }>;
  failedLogins: Array<{
    timestamp: Date;
    ip: string | null;
    metadata: {
      email?: string;
      reason?: string;
      [key: string]: unknown;
    } | null;
  }>;
}

export interface MonitoringWidgetProps<T> {
  data: T | null;
  isLoading: boolean;
}

export interface DetailedWidgetProps<T> extends MonitoringWidgetProps<T> {
  detailed?: boolean;
}