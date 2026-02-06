/**
 * Client-side Activity Tracker
 * Lightweight, zero-dependency tracking for browser events
 */

import { post } from '../auth/auth-fetch';

interface TrackingEvent {
  event: string;
  userId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

class ClientTracker {
  private static instance: ClientTracker;
  private queue: TrackingEvent[] = [];
  private isOnline: boolean = true;

  private constructor() {
    // Listen for online/offline events
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.flushQueue();
      });
      
      window.addEventListener('offline', () => {
        this.isOnline = false;
      });

      // Flush queue before page unload
      window.addEventListener('beforeunload', () => {
        this.flushQueue();
      });
    }
  }

  static getInstance(): ClientTracker {
    if (!ClientTracker.instance) {
      ClientTracker.instance = new ClientTracker();
    }
    return ClientTracker.instance;
  }

  /**
   * Track an event - fire and forget
   */
  track(event: string, data?: Record<string, unknown>): void {
    const trackingEvent: TrackingEvent = {
      event,
      data,
      timestamp: new Date().toISOString()
    };

    // Use sendBeacon if available (survives page navigation)
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      this.sendBeacon(trackingEvent);
    } else {
      // Fallback to fetch
      this.sendFetch(trackingEvent);
    }
  }

  /**
   * Track page view
   */
  trackPageView(path: string, title?: string): void {
    this.track('page_view', {
      path,
      title: title || document.title,
      referrer: document.referrer,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height
    });
  }

  /**
   * Track feature usage
   */
  trackFeature(feature: string, metadata?: Record<string, unknown>): void {
    this.track('feature_used', {
      feature,
      ...metadata
    });
  }

  /**
   * Track user action
   */
  trackAction(action: string, resource?: string, resourceId?: string, metadata?: Record<string, unknown>): void {
    this.track('user_action', {
      action,
      resource,
      resourceId,
      ...metadata
    });
  }

  /**
   * Track click events
   */
  trackClick(element: string, metadata?: Record<string, unknown>): void {
    this.track('click', {
      element,
      ...metadata
    });
  }

  /**
   * Track search
   */
  trackSearch(query: string, resultCount?: number, searchType?: string): void {
    this.track('search', {
      query: query.substring(0, 100), // Limit query length
      resultCount,
      type: searchType
    });
  }

  /**
   * Track errors
   */
  trackError(errorMessage: string, errorType?: string, context?: Record<string, unknown>): void {
    this.track('client_error', {
      message: errorMessage.substring(0, 200),
      type: errorType,
      context,
      url: window.location.href,
      userAgent: navigator.userAgent
    });
  }

  /**
   * Track timing (e.g., how long something took)
   */
  trackTiming(category: string, variable: string, duration: number): void {
    // Only track slow operations (> 3 seconds)
    if (duration > 3000) {
      this.track('timing', {
        category,
        variable,
        duration,
        slow: true
      });
    }
  }

  /**
   * Send via beacon API
   */
  private sendBeacon(event: TrackingEvent): void {
    try {
      const data = JSON.stringify(event);
      navigator.sendBeacon('/api/track', data);
    } catch {
      // Silent fail - never impact user experience
    }
  }

  /**
   * Send via fetch (fallback)
   */
  private async sendFetch(event: TrackingEvent): Promise<void> {
    if (!this.isOnline) {
      this.queue.push(event);
      return;
    }

    try {
      await post('/api/track', event);
    } catch {
      // Silent fail - add to queue for retry
      this.queue.push(event);
    }
  }

  /**
   * Flush queued events
   */
  private flushQueue(): void {
    if (this.queue.length === 0) return;

    const events = [...this.queue];
    this.queue = [];

    // Try to send all queued events
    events.forEach(event => {
      if ('sendBeacon' in navigator) {
        this.sendBeacon(event);
      } else {
        this.sendFetch(event);
      }
    });
  }
}

// Export singleton instance
const tracker = ClientTracker.getInstance();

// Export convenience functions
export const trackPageView = (path: string, title?: string) =>
  tracker.trackPageView(path, title);

// Auto-track page views on route changes (for Next.js)
if (typeof window !== 'undefined') {
  // Track initial page view
  setTimeout(() => {
    trackPageView(window.location.pathname);
  }, 0);
  
  // Track route changes
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    setTimeout(() => {
      trackPageView(window.location.pathname);
    }, 0);
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    setTimeout(() => {
      trackPageView(window.location.pathname);
    }, 0);
  };
  
  // Track back/forward navigation
  window.addEventListener('popstate', () => {
    trackPageView(window.location.pathname);
  });
}

export default tracker;