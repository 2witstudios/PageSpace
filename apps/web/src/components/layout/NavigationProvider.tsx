'use client';

import React, { createContext, useContext, useEffect, useMemo, ReactNode } from 'react';
import Link from 'next/link';
import { useLayoutStore } from '@/stores/useLayoutStore';
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
  const layoutStore = useLayoutStore();
  useUnsavedChanges();

  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.log('🔧 NavigationProvider mounted');
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (process.env.NODE_ENV === 'development') {
        console.log('🧹 NavigationProvider cleaning up...');
      }

      // Get current state for cleanup
      const currentState = useLayoutStore.getState();

      // Save current view before unmounting
      if (currentState.activePageId) {
        currentState.saveCurrentView();
      }

      // Note: Document saves are now handled by individual page views (DocumentView, SheetView)
      // on their own unmount, blur, and keyboard shortcut events
    };
  }, []); // No dependencies to prevent loops

  // Memoize context value to prevent unnecessary re-renders
  // This empty object is stable and doesn't need to change
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
          
          // Clear potentially corrupted navigation state
          layoutStore.clearCache();
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

/**
 * Higher-order component to inject navigation capabilities
 */
export function withNavigation<P extends object>(
  Component: React.ComponentType<P & NavigationContextType>
) {
  const WrappedComponent = (props: P) => {
    const navigation = useNavigation();
    return <Component {...props} {...navigation} />;
  };

  WrappedComponent.displayName = `withNavigation(${Component.displayName || Component.name})`;
  
  return WrappedComponent;
}

/**
 * Component for navigation links with automatic interception
 */
interface NavigationLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
}

export function NavigationLink({
  href,
  children,
  className,
  onClick,
  disabled = false
}: NavigationLinkProps) {
  const style: React.CSSProperties = {
    opacity: disabled ? 0.5 : 1,
    pointerEvents: disabled ? 'none' : 'auto',
  };

  if (disabled) {
    return (
      <span className={className} style={style} onClick={(e) => e.preventDefault()}>
        {children}
      </span>
    );
  }

  return (
    <Link href={href} className={className} onClick={onClick} style={style}>
      {children}
    </Link>
  );
}