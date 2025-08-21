import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';

interface SafePreviewProps {
  html: string;
  css?: string;
}

const SafePreview = ({ html, css = '' }: SafePreviewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Sanitize HTML to prevent XSS
    const sanitizedHTML = DOMPurify.sanitize(html, {
      // Allow common HTML elements and attributes
      ALLOWED_TAGS: [
        'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'a', 'img', 'strong', 'em', 'code', 'pre',
        'blockquote', 'section', 'article', 'header', 'footer', 'nav',
        'main', 'aside', 'figure', 'figcaption', 'table', 'thead',
        'tbody', 'tr', 'td', 'th', 'form', 'input', 'button', 'label',
        'select', 'option', 'textarea', 'br', 'hr'
      ],
      ALLOWED_ATTR: [
        'class', 'id', 'style', 'src', 'alt', 'href', 'title',
        'data-*', 'aria-*', 'role', 'type', 'value', 'placeholder',
        'name', 'for', 'target', 'rel'
      ],
      // Keep relative URLs for local assets
      ALLOW_DATA_ATTR: true,
      // Allow safe styles
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
    });

    // Sanitize CSS to prevent malicious styles
    const sanitizedCSS = css ? DOMPurify.sanitize(`<style>${css}</style>`, {
      ALLOWED_TAGS: ['style'],
      ALLOWED_ATTR: []
    }).replace(/<\/?style>/g, '') : '';

    // Create a safe style element if CSS is provided
    let styleElement: HTMLStyleElement | null = null;
    if (sanitizedCSS) {
      styleElement = document.createElement('style');
      styleElement.textContent = sanitizedCSS;
      containerRef.current.appendChild(styleElement);
    }

    // Set the sanitized HTML
    containerRef.current.innerHTML = sanitizedHTML;

    // Cleanup function
    const container = containerRef.current;
    return () => {
      if (container) {
        container.innerHTML = '';
      }
      if (styleElement && styleElement.parentNode) {
        styleElement.parentNode.removeChild(styleElement);
      }
    };
  }, [html, css]);

  return (
    <div
      ref={containerRef}
      className="safe-preview"
      style={{
        // CSS containment for performance and isolation
        contain: 'style layout',
        // Ensure proper inheritance of parent styles
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        color: 'inherit',
        // Allow scrolling if content overflows
        overflow: 'auto',
        // Full size container
        width: '100%',
        height: '100%',
        // Reset some properties that might interfere
        margin: 0,
        padding: '1rem',
        // Prevent layout shifts
        wordWrap: 'break-word',
        overflowWrap: 'break-word'
      }}
    />
  );
};

export default SafePreview;