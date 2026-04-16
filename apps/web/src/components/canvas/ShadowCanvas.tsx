'use client';

import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { sanitizeCSS } from '@/lib/canvas/css-sanitizer';
import { remapDocumentSelectors } from '@/lib/canvas/remap-document-selectors';

interface ShadowCanvasProps {
  html: string;
  onNavigate?: (url: string, isExternal: boolean) => void;
}

export function ShadowCanvas({ html, onNavigate }: ShadowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  const extractStylesFromHTML = (htmlContent: string): { html: string; css: string } => {
    const temp = document.createElement('div');
    temp.innerHTML = htmlContent;

    const styleTags = temp.querySelectorAll('style');
    let extractedCSS = '';

    styleTags.forEach(styleTag => {
      extractedCSS += styleTag.textContent || '';
      styleTag.remove();
    });

    const body = temp.querySelector('body');
    const content = body ? body.innerHTML : temp.innerHTML;

    return {
      html: content,
      css: extractedCSS
    };
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // Create or reuse shadow root
    if (!shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: 'open' });
    }

    const shadow = shadowRef.current;

    // Extract embedded styles from HTML
    const { html: htmlWithoutStyles, css: extractedCSS } = extractStylesFromHTML(html);

    // Sanitize HTML - remove scripts but keep style tags for extraction
    const sanitizedHTML = DOMPurify.sanitize(htmlWithoutStyles, {
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout', 'onfocus', 'onblur'],
      KEEP_CONTENT: true,
      ADD_ATTR: ['target', 'data-href', 'data-navigate'], // Allow navigation attributes
    });

    const sanitizedCSS = remapDocumentSelectors(sanitizeCSS(extractedCSS));

    // Build shadow DOM content with extracted styles
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
        }

        .canvas-root {
          background: transparent;
          color: inherit;
          min-height: 100%;
          width: 100%;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          line-height: 1.6;
          isolation: isolate;
        }

        *, *::before, *::after {
          box-sizing: border-box;
        }

        ${sanitizedCSS}
      </style>
      <div class="canvas-root">
        ${sanitizedHTML}
      </div>
    `;

    // Handle all clicks for navigation
    const handleClick = (e: Event) => {
      const mouseEvent = e as MouseEvent;
      const target = mouseEvent.target as HTMLElement;

      // Check for anchor tags
      const link = target.closest('a');
      if (link && link.href) {
        e.preventDefault();
        e.stopPropagation();

        const href = link.getAttribute('href');
        if (!href) return;

        // Determine if external
        const isExternal = href.startsWith('http://') || href.startsWith('https://') ||
                          link.target === '_blank';

        if (onNavigate) {
          onNavigate(href, isExternal);
        }
        return;
      }

      // Check for buttons or elements with data-href
      const navigableElement = target.closest('[data-href], [data-navigate]');
      if (navigableElement) {
        e.preventDefault();
        e.stopPropagation();

        const href = navigableElement.getAttribute('data-href') ||
                    navigableElement.getAttribute('data-navigate');
        if (href && onNavigate) {
          const isExternal = href.startsWith('http://') || href.startsWith('https://');
          onNavigate(href, isExternal);
        }
      }
    };

    // Add event listener to shadow root
    shadow.addEventListener('click', handleClick);

    // Cleanup
    return () => {
      shadow.removeEventListener('click', handleClick);
    };
  }, [html, onNavigate]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ isolation: 'isolate' }} // Extra style isolation
    />
  );
}