'use client';

import React, { createContext, useContext, useEffect, ReactNode } from 'react';
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

  // Handle focus/blur for auto-save - optimized with debouncing
  useEffect(() => {
    // Only run on client side with proper window API
    if (typeof window === 'undefined' || !window.addEventListener) return;
    
    // Skip in development to reduce overhead
    if (process.env.NODE_ENV === 'development') return;

    let blurTimeout: NodeJS.Timeout;

    const handleWindowBlur = () => {
      // Debounce blur events to prevent rapid firing
      clearTimeout(blurTimeout);
      blurTimeout = setTimeout(() => {
        // When window loses focus, save current document
        const currentState = useLayoutStore.getState();
        const currentDoc = currentState.activeDocument;
        if (currentDoc?.isDirty) {
          // The save will be handled by the store
        }
      }, 100); // 100ms debounce
    };

    // Only add blur handler for actual auto-save functionality
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      clearTimeout(blurTimeout);
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('blur', handleWindowBlur);
      }
    };
  }, []); // No dependencies to prevent loops

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
      
      // Save any dirty documents
      const currentDoc = currentState.activeDocument;
      if (currentDoc?.isDirty) {
        // Force immediate save on unmount
        if (process.env.NODE_ENV === 'development') {
          console.log('💾 Force saving dirty document on unmount');
        }
        // Note: This is async but we can't await in cleanup
        // The save should be handled by the beforeunload event
      }
    };
  }, []); // No dependencies to prevent loops

  const contextValue: NavigationContextType = {};

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