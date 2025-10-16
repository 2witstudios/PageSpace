import React, { useState, useEffect } from 'react';
import { fetchWithAuth } from '@/lib/auth-fetch';

interface SandboxProps {
  html: string;
  css?: string;
}

const Sandbox = ({ html, css = '' }: SandboxProps) => {
  const [compiledCSS, setCompiledCSS] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch the compiled Tailwind CSS dynamically
    const fetchCompiledCSS = async () => {
      try {
        const response = await fetchWithAuth('/api/compiled-css');
        if (response.ok) {
          const cssContent = await response.text();
          setCompiledCSS(cssContent);
        } else {
          console.warn('Failed to fetch compiled CSS, using fallback');
          setCompiledCSS('/* Fallback CSS */');
        }
      } catch (error) {
        console.error('Error fetching compiled CSS:', error);
        setCompiledCSS('/* Error loading CSS */');
      } finally {
        setLoading(false);
      }
    };

    fetchCompiledCSS();
  }, []);

  // Show loading state while CSS is being fetched
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading preview...</div>
      </div>
    );
  }

  const srcDoc = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          ${compiledCSS}
          ${css}
        </style>
      </head>
      <body>
        <div class="sandbox-content">
          ${html}
        </div>
      </body>
    </html>
  `;

  return (
    <iframe
      srcDoc={srcDoc}
      title="sandbox"
      sandbox="allow-scripts"
      width="100%"
      height="100%"
      style={{ border: 'none' }}
    />
  );
};

export default Sandbox;