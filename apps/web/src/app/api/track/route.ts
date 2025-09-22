/**
 * Simple tracking endpoint for client-side events
 * Fire-and-forget, always returns success
 */

import { NextResponse } from 'next/server';
import { trackActivity, trackFeature, trackError } from '@pagespace/lib/activity-tracker';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    // Try to get user ID but don't block if auth fails
    let userId: string | undefined;
    const auth = await authenticateWebRequest(request);
    if (!isAuthError(auth)) {
      userId = auth.userId;
    }
    
    // Get client IP and user agent
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 
               request.headers.get('x-real-ip') || 
               'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    
    // Parse tracking data
    const body = await request.json().catch(() => null);
    if (!body || !body.event) {
      // Still return success - don't break client
      return NextResponse.json({ ok: true });
    }

    const { event, data = {} } = body;
    
    // Add request context to data
    const enrichedData = {
      ...data,
      ip,
      userAgent,
      timestamp: new Date().toISOString()
    };

    // Route different event types
    switch (event) {
      case 'page_view':
        trackActivity(userId, 'page_view', {
          metadata: enrichedData,
          ip,
          userAgent
        });
        break;
        
      case 'feature_used':
        trackFeature(userId, data.feature, enrichedData);
        break;
        
      case 'user_action':
        trackActivity(userId, data.action || event, {
          resource: data.resource,
          resourceId: data.resourceId,
          metadata: enrichedData,
          ip,
          userAgent
        });
        break;
        
      case 'search':
        trackActivity(userId, 'search', {
          metadata: enrichedData,
          ip,
          userAgent
        });
        break;
        
      case 'click':
        trackActivity(userId, 'ui_click', {
          metadata: enrichedData,
          ip,
          userAgent
        });
        break;
        
      case 'client_error':
        trackError(userId, data.type || 'client', data.message, enrichedData);
        break;
        
      case 'timing':
        // Only track slow operations
        if (data.duration > 3000) {
          trackActivity(userId, 'slow_operation', {
            metadata: enrichedData,
            ip,
            userAgent
          });
        }
        break;
        
      default:
        // Generic event tracking
        trackActivity(userId, event, {
          metadata: enrichedData,
          ip,
          userAgent
        });
    }
    
    // Always return success quickly
    return NextResponse.json({ ok: true });
    
  } catch {
    // Never fail - tracking should not impact user experience
    return NextResponse.json({ ok: true });
  }
}

// Support beacon API (sends as text/plain)
export async function PUT(request: Request) {
  try {
    const text = await request.text();
    const body = JSON.parse(text);
    
    // Reuse POST logic
    const newRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(body)
    });
    
    return POST(newRequest);
  } catch {
    return NextResponse.json({ ok: true });
  }
}