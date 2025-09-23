import { NextResponse } from 'next/server';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
import {
  getSystemHealth,
  getApiMetrics,
  getUserActivity,
  getAiUsageMetrics,
  getErrorAnalytics,
  getPerformanceMetrics,
  getDateRange
} from '@/lib/monitoring-queries';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET /api/monitoring/[metric]
 * Returns monitoring data for the specified metric
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ metric: string }> }
) {
  try {
    const auth = await authenticateWebRequest(request);
    if (isAuthError(auth)) return auth.error;

    const { metric } = await context.params;
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') as '24h' | '7d' | '30d' | 'all' || '24h';
    
    const { startDate, endDate } = getDateRange(range);

    let data;
    
    switch (metric) {
      case 'system-health':
        data = await getSystemHealth(startDate, endDate);
        break;
        
      case 'api-metrics':
        data = await getApiMetrics(startDate, endDate);
        break;
        
      case 'user-activity':
        data = await getUserActivity(startDate, endDate);
        break;
        
      case 'ai-usage':
        data = await getAiUsageMetrics(startDate, endDate);
        break;
        
      case 'error-logs':
        data = await getErrorAnalytics(startDate, endDate);
        break;
        
      case 'performance':
        data = await getPerformanceMetrics(startDate, endDate);
        break;
        
      default:
        return NextResponse.json(
          { error: 'Invalid metric type' },
          { status: 400 }
        );
    }

    return NextResponse.json({ 
      data,
      range,
      startDate,
      endDate 
    });

  } catch (error) {
    loggers.api.error('Error fetching monitoring data:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch monitoring data' },
      { status: 500 }
    );
  }
}