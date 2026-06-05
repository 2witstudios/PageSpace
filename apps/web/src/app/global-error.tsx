'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          backgroundColor: '#0a0a0a',
          color: '#ededed',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '512px',
            padding: '24px',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            backgroundColor: 'rgba(255,255,255,0.03)',
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                backgroundColor: 'rgba(239,68,68,0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}
            >
              <AlertTriangle style={{ width: '24px', height: '24px', color: '#ef4444' }} />
            </div>
            <h1 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 8px' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)', margin: 0 }}>
              An unexpected error occurred. Please try again or contact support.
            </p>
          </div>

          {error.digest && (
            <div
              style={{
                backgroundColor: 'rgba(255,255,255,0.05)',
                padding: '12px',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'rgba(255,255,255,0.5)',
                marginBottom: '16px',
              }}
            >
              Error ID: {error.digest}
            </div>
          )}

          {process.env.NODE_ENV === 'development' && (
            <div
              style={{
                backgroundColor: 'rgba(255,255,255,0.05)',
                padding: '12px',
                borderRadius: '6px',
                fontSize: '13px',
                marginBottom: '16px',
              }}
            >
              <div style={{ fontWeight: 500, marginBottom: '4px' }}>Error Details:</div>
              <div style={{ color: 'rgba(255,255,255,0.5)', wordBreak: 'break-word' }}>
                {error.message || 'An unexpected error occurred'}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button
              onClick={reset}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px 16px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: '#ededed',
                color: '#0a0a0a',
                fontWeight: 500,
                fontSize: '14px',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              <RefreshCw style={{ width: '16px', height: '16px' }} />
              Try Again
            </button>

            <button
              onClick={() => (window.location.href = '/dashboard')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px 16px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.15)',
                backgroundColor: 'transparent',
                color: '#ededed',
                fontWeight: 500,
                fontSize: '14px',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              <Home style={{ width: '16px', height: '16px' }} />
              Go Home
            </button>
          </div>

          {process.env.NODE_ENV === 'development' && error.stack && (
            <details style={{ marginTop: '16px' }}>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'rgba(255,255,255,0.5)',
                }}
              >
                Development Details
              </summary>
              <div
                style={{
                  marginTop: '8px',
                  padding: '12px',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  borderRadius: '6px',
                  fontSize: '11px',
                }}
              >
                <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>
                  {error.stack}
                </pre>
              </div>
            </details>
          )}
        </div>
      </body>
    </html>
  );
}
