'use client';

import { createContext, useContext, useEffect, useMemo, ReactNode } from 'react';
import { LayoutErrorBoundary } from './LayoutErrorBoundary';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';

interface NavigationContextType {
  // The context is now primarily for providing an error boundary
  // and handling global layout concerns, not navigation interception.
  placeholder?: never;
}

const NavigationContext = createContext<NavigationContextType | null>({});

interface NavigationProviderProps {
  children: ReactNode;
  enableErrorBoundary?: boolean;
}

export function NavigationProvider({
  children,
  enableErrorBoundary = true
}: NavigationProviderProps) {
  useUnsavedChanges();

  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.log('NavigationProvider mounted');
    }
  }, []);

  // Memoize context value to prevent unnecessary re-renders
  const contextValue: NavigationContextType = useMemo(() => ({}), []);

  const content = (
    <NavigationContext.Provider value={contextValue}>
      {children}
    </NavigationContext.Provider>
  );

  // Wrap with error boundary if enabled
  if (enableErrorBoundary) {
    return (
      <LayoutErrorBoundary
        onError={(error, errorInfo) => {
          if (process.env.NODE_ENV === 'development') {
            console.error('NavigationProvider error:', error, errorInfo);
          }
        }}
      >
        {content}
      </LayoutErrorBoundary>
    );
  }

  return content;
}

/**
 * Hook to access navigation context
 */
export function useNavigation(): NavigationContextType {
  const context = useContext(NavigationContext);
  
  if (!context) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  
  return context;
}

