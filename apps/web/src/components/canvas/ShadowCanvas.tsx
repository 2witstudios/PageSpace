'use client';

import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { sanitizeCSS } from '@/lib/canvas/css-sanitizer';

interface ShadowCanvasProps {
  html: string;
  onNavigate?: (url: string, isExternal: boolean) => void;
}

export function ShadowCanvas({ html, onNavigate }: ShadowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  // Extract styles from HTML
  const extractStylesFromHTML = (htmlContent: string): { html: string; css: string } => {
    // Create a temporary container to parse HTML
    const temp = document.createElement('div');
    temp.innerHTML = htmlContent;

    // Find all style tags
    const styleTags = temp.querySelectorAll('style');
    let extractedCSS = '';

    // Extract CSS content and remove style tags from HTML
    styleTags.forEach(styleTag => {
      extractedCSS += styleTag.textContent || '';
      styleTag.remove();
    });

    return {
      html: temp.innerHTML,
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

    // Sanitize CSS - remove JavaScript execution
    const sanitizedCSS = sanitizeCSS(extractedCSS);

    // Build shadow DOM content with extracted styles
    shadow.innerHTML = `
      <style>
        /* Reset styles for shadow DOM */
        :host {
          display: block;
          width: 100%;
          height: 100%;
        }
        * {
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