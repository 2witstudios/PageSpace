"use client";

import React from 'react';

interface SheetErrorBoundaryProps {
  children: React.ReactNode;
}

interface SheetErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class SheetErrorBoundary extends React.Component<
  SheetErrorBoundaryProps,
  SheetErrorBoundaryState
> {
  constructor(props: SheetErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): SheetErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Sheet error boundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center p-8 text-center">
          <div className="mb-4">
            <svg
              className="w-16 h-16 text-muted-foreground mx-auto"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.502 0L4.732 18.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">
            Sheet Failed to Load
          </h3>
          <p className="text-muted-foreground mb-4 max-w-md">
            There was an error loading the sheet interface. This might be due to a
            temporary issue with the data format or grid component.
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false });
              window.location.reload();
            }}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default SheetErrorBoundary;