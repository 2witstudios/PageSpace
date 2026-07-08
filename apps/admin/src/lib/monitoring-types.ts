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

export interface GrowthMetricsData {
  summary: {
    totalUsers: number;
    mau: number;
    wau: number;
    dau: number;
    dauMauRatio: number;
    newUsersThisMonth: number;
    newUsersLastMonth: number;
    momGrowthPct: number | null;
    payingUsers: number;
    payingUsersPct: number;
  };
  mauTrend: Array<{ period: string; mau: number; newUsers: number }>;
  dauTrend: Array<{ day: string; dau: number; signups: number }>;
  tierBreakdown: Array<{ tier: string; count: number; pct: number }>;
}