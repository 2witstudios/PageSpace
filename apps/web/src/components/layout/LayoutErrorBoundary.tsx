'use client';

import React, { Component, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Home, Bug } from 'lucide-react';
import { useLayoutStore } from '@/stores/useLayoutStore';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  errorId: string | null;
}

export class LayoutErrorBoundary extends Component<Props, State> {
  private retryCount = 0;
  private maxRetries = 3;

  constructor(props: Props) {
    super(props);
    
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Generate a unique error ID for tracking
    const errorId = `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      hasError: true,
      error,
      errorId
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Layout Error Boundary caught an error:', error, errorInfo);
    
    this.setState({
      error,
      errorInfo
    });

    // Clear potentially corrupted cache
    this.clearCorruptedState();

    // Report error
    this.reportError(error, errorInfo);

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);
  }

  private clearCorruptedState = () => {
    try {
      // Clear localStorage that might be corrupted
      localStorage.removeItem('layout-storage');
      sessionStorage.clear();
      
      // Clear layout store cache
      if (typeof window !== 'undefined') {
        const layoutStore = useLayoutStore.getState();
        layoutStore.clearCache();
      }
      
      console.log('Cleared potentially corrupted state');
    } catch (clearError) {
      console.error('Failed to clear corrupted state:', clearError);
    }
  };

  private reportError = (error: Error, errorInfo: React.ErrorInfo) => {
    const errorReport = {
      errorId: this.state.errorId,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: window.location.href,
      retryCount: this.retryCount
    };

    // Log to console for development
    console.group('🚨 Layout Error Report');
    console.error('Error:', error);
    console.error('Component Stack:', errorInfo.componentStack);
    console.error('Full Report:', errorReport);
    console.groupEnd();

    // In production, you would send this to your error tracking service
    if (typeof window !== 'undefined' && (window as { reportError?: (error: unknown) => void }).reportError) {
      (window as { reportError?: (error: unknown) => void }).reportError?.(errorReport);
    }
  };

  private handleRetry = () => {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      
      console.log(`Retrying... (${this.retryCount}/${this.maxRetries})`);
      
      // Clear error state to trigger re-render
      this.setState({
        hasError: false,
        error: null,
        errorInfo: null,
        errorId: null
      });
    } else {
      console.warn('Max retries reached, forcing page reload');
      window.location.reload();
    }
  };

  private handleGoHome = () => {
    // Clear error state and navigate to dashboard
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null
    });
    
    // Navigate to dashboard
    window.location.href = '/dashboard';
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleReportBug = () => {
    const errorReport = {
      errorId: this.state.errorId,
      message: this.state.error?.message,
      stack: this.state.error?.stack,
      componentStack: this.state.errorInfo?.componentStack,
      url: window.location.href,
      timestamp: new Date().toISOString()
    };

    // Create a bug report URL (adjust for your issue tracker)
    const bugReportUrl = `https://github.com/your-org/pagespace/issues/new?` +
      `title=Layout%20Error%3A%20${encodeURIComponent(this.state.error?.message || 'Unknown error')}&` +
      `body=${encodeURIComponent(`
## Error Report

**Error ID:** ${errorReport.errorId}
**URL:** ${errorReport.url}
**Timestamp:** ${errorReport.timestamp}

**Error Message:**
\`\`\`
${errorReport.message}
\`\`\`

**Stack Trace:**
\`\`\`
${errorReport.stack}
\`\`\`

**Component Stack:**
\`\`\`
${errorReport.componentStack}
\`\`\`

## Steps to Reproduce
<!-- Please describe what you were doing when this error occurred -->

## Additional Context
<!-- Any additional information that might help -->
      `.trim())}`;

    window.open(bugReportUrl, '_blank');
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-destructive" />
              </div>
              <CardTitle className="text-xl">Something went wrong</CardTitle>
              <CardDescription>
                We encountered an unexpected error while loading the application.
              </CardDescription>
            </CardHeader>
            
            <CardContent className="space-y-4">
              {/* Error details */}
              <div className="bg-muted p-3 rounded-md text-sm">
                <div className="font-medium mb-1">Error Details:</div>
                <div className="text-muted-foreground break-words">
                  {this.state.error?.message || 'Unknown error occurred'}
                </div>
                {this.state.errorId && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Error ID: {this.state.errorId}
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="grid grid-cols-2 gap-2">
                <Button 
                  variant="default" 
                  onClick={this.handleRetry}
                  disabled={this.retryCount >= this.maxRetries}
                  className="w-full"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {this.retryCount >= this.maxRetries ? 'Max Retries' : 'Try Again'}
                </Button>
                
                <Button 
                  variant="outline" 
                  onClick={this.handleGoHome}
                  className="w-full"
                >
                  <Home className="w-4 h-4 mr-2" />
                  Go Home
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button 
                  variant="outline" 
                  onClick={this.handleReload}
                  className="w-full"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Reload Page
                </Button>
                
                <Button 
                  variant="ghost" 
                  onClick={this.handleReportBug}
                  className="w-full text-xs"
                >
                  <Bug className="w-4 h-4 mr-2" />
                  Report Bug
                </Button>
              </div>

              {/* Development info */}
              {process.env.NODE_ENV === 'development' && this.state.error && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                    Development Details
                  </summary>
                  <div className="mt-2 p-3 bg-muted rounded-md text-xs">
                    <div className="mb-2">
                      <strong>Stack Trace:</strong>
                      <pre className="mt-1 whitespace-pre-wrap text-xs">
                        {this.state.error.stack}
                      </pre>
                    </div>
                    {this.state.errorInfo?.componentStack && (
                      <div>
                        <strong>Component Stack:</strong>
                        <pre className="mt-1 whitespace-pre-wrap text-xs">
                          {this.state.errorInfo.componentStack}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Hook-based error boundary for functional components
 */
export function useErrorHandler() {
  const [error, setError] = React.useState<Error | null>(null);

  const resetError = React.useCallback(() => {
    setError(null);
  }, []);

  const handleError = React.useCallback((error: Error) => {
    console.error('Handled error:', error);
    setError(error);
  }, []);

  React.useEffect(() => {
    if (error) {
      // Report error
      console.error('Error caught by useErrorHandler:', error);
    }
  }, [error]);

  if (error) {
    throw error; // Let the error boundary handle it
  }

  return { handleError, resetError };
}

/**
 * Higher-order component for adding error boundary
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorFallback?: ReactNode
) {
  const WrappedComponent = (props: P) => (
    <LayoutErrorBoundary fallback={errorFallback}>
      <Component {...props} />
    </LayoutErrorBoundary>
  );

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name})`;

  return WrappedComponent;
}