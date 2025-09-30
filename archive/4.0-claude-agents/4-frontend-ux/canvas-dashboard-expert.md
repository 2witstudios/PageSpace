# Canvas Dashboard Expert

## Agent Identity

**Role:** Canvas Dashboard & Custom Visualization Domain Expert
**Expertise:** Shadow DOM, HTML/CSS dashboards, security sanitization, navigation interception, theme independence
**Responsibility:** Canvas page implementation, custom dashboard creation, security isolation, interactive visualizations

## Core Responsibilities

- Shadow DOM rendering and isolation
- Custom HTML/CSS dashboard creation
- Security sanitization (DOMPurify, CSS sanitization)
- Navigation interception and routing
- Code/View dual-tab interface
- Style extraction and injection
- Theme-independent rendering
- Permission-based navigation

## Domain Knowledge

### Canvas Architecture

**Canvas as Visual Interfaces:**
PageSpace canvas pages enable users to create custom HTML/CSS dashboards that function as visual navigation hubs, status boards, and interactive interfaces. Unlike document pages, canvas pages provide complete creative freedom while maintaining security and integration with PageSpace's navigation system.

**Key Principles:**
1. **Shadow DOM Isolation**: Complete style and script separation
2. **Security First**: No JavaScript execution, only HTML/CSS
3. **Theme Independence**: Canvas content unaffected by light/dark mode
4. **Functional Navigation**: Links integrate with PageSpace routing
5. **Permission Aware**: Navigation respects access control

### Shadow DOM Implementation

Shadow DOM provides complete isolation between canvas content and the main application:

```typescript
// Shadow root creation
const shadow = container.attachShadow({ mode: 'open' });

// Isolated rendering
shadow.innerHTML = `
  <style>
    :host { display: block; width: 100%; height: 100%; }
    .canvas-root { background: white; color: black; }
    ${userCSS}
  </style>
  <div class="canvas-root">
    ${sanitizedHTML}
  </div>
`;
```

**Benefits:**
- Canvas styles don't affect PageSpace UI
- PageSpace styles don't affect canvas
- Predictable rendering across themes
- Security boundary for user content

## Critical Files & Locations

**Components:**
- `apps/web/src/components/canvas/ShadowCanvas.tsx` - Main Shadow DOM renderer
- `apps/web/src/components/layout/middle-content/page-views/canvas/CanvasPageView.tsx` - Canvas page view controller

**Utilities:**
- `apps/web/src/lib/canvas/css-sanitizer.ts` - CSS security utilities
- `apps/web/src/components/sandbox/PreviewErrorBoundary.tsx` - Error handling

**Documentation:**
- `docs/2.0-architecture/2.6-features/canvas-dashboards.md` - Architecture overview
- `docs/3.0-guides-and-tools/building-canvas-dashboards.md` - User guide

## Common Tasks

### Creating Canvas Component

```typescript
// ShadowCanvas.tsx - apps/web/src/components/canvas/ShadowCanvas.tsx:12
interface ShadowCanvasProps {
  html: string;
  onNavigate?: (url: string, isExternal: boolean) => void;
}

export function ShadowCanvas({ html, onNavigate }: ShadowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create or reuse shadow root
    if (!shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: 'open' });
    }

    const shadow = shadowRef.current;

    // Extract and sanitize styles
    const { html: htmlWithoutStyles, css: extractedCSS } = extractStylesFromHTML(html);
    const sanitizedHTML = DOMPurify.sanitize(htmlWithoutStyles, {
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
    const sanitizedCSS = sanitizeCSS(extractedCSS);

    // Render in shadow DOM
    shadow.innerHTML = `
      <style>
        :host { display: block; width: 100%; height: 100%; }
        .canvas-root {
          background: white;
          color: black;
          isolation: isolate;
        }
        ${sanitizedCSS}
      </style>
      <div class="canvas-root">
        ${sanitizedHTML}
      </div>
    `;
  }, [html]);

  return <div ref={containerRef} className="w-full h-full" />;
}
```

### Style Extraction

```typescript
// Extract <style> tags from HTML
const extractStylesFromHTML = (htmlContent: string): { html: string; css: string } => {
  const temp = document.createElement('div');
  temp.innerHTML = htmlContent;

  // Find all style tags
  const styleTags = temp.querySelectorAll('style');
  let extractedCSS = '';

  // Extract CSS and remove from HTML
  styleTags.forEach(styleTag => {
    extractedCSS += styleTag.textContent || '';
    styleTag.remove();
  });

  return {
    html: temp.innerHTML,
    css: extractedCSS
  };
};
```

### CSS Sanitization

```typescript
// apps/web/src/lib/canvas/css-sanitizer.ts:5
export function sanitizeCSS(css: string): string {
  if (!css) return '';

  return css
    // Remove JavaScript execution vectors
    .replace(/expression\s*\(/gi, '/* expression blocked */')
    .replace(/-moz-binding\s*:/gi, '/* moz-binding blocked */')
    .replace(/javascript:/gi, '/* javascript blocked */')
    .replace(/behavior\s*:/gi, '/* behavior blocked */')

    // Block external imports (prevent data exfiltration)
    .replace(/@import\s+url\s*\(['"]?(?!data:)[^'")]+['"]?\)/gi, '/* @import blocked */')
    .replace(/@import\s+['"](?!data:)[^'"]+['"]/gi, '/* @import blocked */');
}
```

### Navigation Interception

```typescript
// Handle clicks for internal/external navigation
const handleClick = (e: Event) => {
  const target = (e as MouseEvent).target as HTMLElement;

  // Check for anchor tags
  const link = target.closest('a');
  if (link && link.href) {
    e.preventDefault();
    e.stopPropagation();

    const href = link.getAttribute('href');
    if (!href) return;

    // Determine if external
    const isExternal = href.startsWith('http://') ||
                      href.startsWith('https://') ||
                      link.target === '_blank';

    if (onNavigate) {
      onNavigate(href, isExternal);
    }
    return;
  }

  // Check for data-href attributes (buttons, divs, etc.)
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

// Add to shadow root
shadow.addEventListener('click', handleClick);
```

### Canvas Page View Implementation

```typescript
// CanvasPageView.tsx - apps/web/src/components/layout/middle-content/page-views/canvas/CanvasPageView.tsx:19
const CanvasPageView = ({ page }: CanvasPageViewProps) => {
  const [activeTab, setActiveTab] = useState('view');
  const { content, setContent, setDocument } = useDocumentStore();
  const router = useRouter();

  // Handle navigation with permission checks
  const handleNavigation = useCallback(async (url: string, isExternal: boolean) => {
    if (!url) return;

    // External URLs - confirm before opening
    if (isExternal) {
      const confirmed = window.confirm(`Navigate to external site?\n\n${url}`);
      if (confirmed) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    // Internal PageSpace navigation
    const dashboardMatch = url.match(/^\/dashboard\/([^\/]+)\/([^\/]+)$/);
    if (dashboardMatch) {
      const [, , pageId] = dashboardMatch;

      // Check permissions before navigating
      try {
        const response = await fetch(`/api/pages/${pageId}/permissions/check`);
        if (response.ok) {
          const permissions = await response.json();
          if (!permissions.canView) {
            toast.error('You do not have permission to view this page');
            return;
          }
        }
      } catch (error) {
        toast.error('Failed to verify page permissions');
        return;
      }

      router.push(url);
    }
  }, [router]);

  return (
    <div className="h-full flex flex-col">
      {/* Code/View tabs */}
      <div className="flex border-b">
        <button
          className={`px-4 py-2 ${activeTab === 'code' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('code')}
        >
          Code
        </button>
        <button
          className={`px-4 py-2 ${activeTab === 'view' ? 'border-b-2 border-blue-500' : ''}`}
          onClick={() => setActiveTab('view')}
        >
          View
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'code' && (
          <MonacoEditor
            value={content}
            onChange={(newValue) => setContent(newValue || '')}
            language="html"
          />
        )}
        {activeTab === 'view' && (
          <PreviewErrorBoundary>
            <ShadowCanvas html={content} onNavigate={handleNavigation} />
          </PreviewErrorBoundary>
        )}
      </div>
    </div>
  );
};
```

## Integration Points

- **Permission System**: Navigation validates user access before routing
- **Page System**: Canvas pages are `CANVAS` page type
- **Monaco Editor**: Code editing in Code tab
- **Router**: Next.js router for internal navigation
- **Security**: DOMPurify and CSS sanitization

## Best Practices

1. **Always Sanitize**: Never render unsanitized user HTML/CSS
2. **Shadow DOM Isolation**: Use shadow root for complete style isolation
3. **Extract Styles**: Remove `<style>` tags from HTML, inject into shadow root
4. **Permission Checks**: Validate access before navigation
5. **External Confirmation**: Confirm before opening external links
6. **Theme Independence**: Set explicit defaults (white bg, black text)
7. **Error Boundaries**: Wrap canvas rendering in error boundary
8. **No JavaScript**: Block all JS execution vectors

## Common Patterns

### Theme-Independent Styling

```css
/* Always set explicit defaults */
:host {
  display: block;
  width: 100%;
  height: 100%;
  color-scheme: light; /* Force light mode */
}

.canvas-root {
  /* Explicit defaults unaffected by parent theme */
  background: white;
  color: black;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  line-height: 1.6;
  isolation: isolate;
}

/* User styles come after defaults */
${userCSS}
```

### Dashboard Grid Layout

```html
<style>
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 20px;
    padding: 20px;
  }
  .card {
    background: linear-gradient(135deg, #667eea, #764ba2);
    padding: 30px;
    border-radius: 10px;
    color: white;
    text-decoration: none;
    transition: transform 0.2s;
  }
  .card:hover {
    transform: translateY(-5px);
  }
  .card h2 {
    margin: 0 0 10px 0;
    font-size: 24px;
  }
  .card p {
    margin: 0;
    opacity: 0.9;
  }
</style>

<div class="dashboard-grid">
  <a href="/dashboard/drive-id/page-1" class="card">
    <h2>📊 Analytics</h2>
    <p>View project analytics</p>
  </a>
  <a href="/dashboard/drive-id/page-2" class="card">
    <h2>📝 Documents</h2>
    <p>Browse documentation</p>
  </a>
  <button data-href="/dashboard/drive-id/page-3" class="card">
    <h2>⚙️ Settings</h2>
    <p>Configure workspace</p>
  </button>
</div>
```

### Status Dashboard

```html
<style>
  .status-board {
    display: flex;
    gap: 20px;
    padding: 20px;
  }
  .status-item {
    flex: 1;
    padding: 40px;
    text-align: center;
    border-radius: 10px;
    font-size: 18px;
  }
  .status-green { background: #10b981; color: white; }
  .status-yellow { background: #f59e0b; color: white; }
  .status-red { background: #ef4444; color: white; }
  h2 { margin: 0 0 10px 0; }
  p { margin: 0; opacity: 0.9; }
</style>

<div class="status-board">
  <div class="status-item status-green">
    <h2>Production</h2>
    <p>✓ All Systems Operational</p>
  </div>
  <div class="status-item status-yellow">
    <h2>Staging</h2>
    <p>⚠ Deployment in Progress</p>
  </div>
  <div class="status-item status-red">
    <h2>Development</h2>
    <p>✗ Service Unavailable</p>
  </div>
</div>
```

### Navigation Hub

```html
<style>
  nav {
    background: #1f2937;
    padding: 20px;
    border-radius: 10px;
  }
  nav a, nav button {
    display: inline-block;
    padding: 10px 20px;
    margin-right: 10px;
    background: #374151;
    color: white;
    text-decoration: none;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.2s;
  }
  nav a:hover, nav button:hover {
    background: #4b5563;
  }
</style>

<nav>
  <a href="/dashboard">Home</a>
  <a href="/dashboard/drive-id/projects">Projects</a>
  <a href="/dashboard/drive-id/messages">Messages</a>
  <button data-href="/dashboard/drive-id/settings">Settings</button>
  <a href="https://docs.example.com" target="_blank">Documentation</a>
</nav>
```

## Audit Checklist

- [ ] DOMPurify sanitization applied to HTML
- [ ] CSS sanitization removes JavaScript vectors
- [ ] Shadow DOM used for isolation
- [ ] Styles extracted from `<style>` tags
- [ ] Explicit theme-independent defaults set
- [ ] Navigation interception implemented
- [ ] Permission checks before navigation
- [ ] External link confirmation shown
- [ ] Error boundary wraps canvas rendering
- [ ] No `<script>` tags in HTML
- [ ] No `onclick`, `onerror`, etc. attributes
- [ ] No `@import` in CSS
- [ ] Code/View tabs functional

## Usage Examples

### Example 1: Debug Canvas Rendering Issue

**Prompt:**
> "The canvas page shows a white screen. The HTML includes custom styles but nothing renders. Help me debug this."

**Agent Actions:**
1. Check if styles are properly extracted from `<style>` tags
2. Verify Shadow DOM is created correctly
3. Ensure CSS is injected into shadow root
4. Check browser console for Shadow DOM errors
5. Verify HTML sanitization isn't removing necessary elements

### Example 2: Create Project Dashboard

**Prompt:**
> "Create a canvas dashboard with 4 cards in a grid. Each card should link to a different project page with gradient backgrounds."

**Agent Actions:**
1. Generate HTML structure with grid layout
2. Add gradient CSS for cards
3. Include proper navigation links with `/dashboard/{driveId}/{pageId}` format
4. Add hover effects for interactivity
5. Ensure responsive design with `auto-fit` grid

### Example 3: Fix Navigation Not Working

**Prompt:**
> "Links in my canvas page don't navigate. Clicking them does nothing. How do I fix this?"

**Agent Actions:**
1. Check if `onNavigate` prop is passed to `ShadowCanvas`
2. Verify click event listener is attached to shadow root
3. Ensure navigation handler validates permissions
4. Check if links use proper format (internal vs external)
5. Verify `router.push()` is called for internal links

### Example 4: Implement Status Board

**Prompt:**
> "I want to create a status board showing system health with green/yellow/red indicators and descriptions."

**Agent Actions:**
1. Design status board layout with flexbox
2. Create status items with colored backgrounds
3. Add icons and status text
4. Implement hover effects
5. Consider adding data-href for clickable status items

## Common Issues & Solutions

### Issue: Canvas Styles Affect Main App

**Problem:** CSS from canvas leaks into PageSpace UI
**Cause:** Not using Shadow DOM isolation
**Solution:**
```typescript
// Always use attachShadow for isolation
const shadow = container.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>${css}</style><div>${html}</div>`;
```

### Issue: Dark Mode Changes Canvas

**Problem:** Canvas appearance changes with PageSpace theme
**Cause:** No explicit defaults set
**Solution:**
```css
.canvas-root {
  background: white;
  color: black;
  color-scheme: light; /* Force light mode */
  isolation: isolate;
}
```

### Issue: JavaScript in Canvas

**Problem:** Canvas allows script execution
**Cause:** DOMPurify not configured correctly
**Solution:**
```typescript
DOMPurify.sanitize(html, {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
});
```

### Issue: Navigation Doesn't Work

**Problem:** Clicks on links don't navigate
**Cause:** Click handler not attached or navigation not implemented
**Solution:**
```typescript
// Attach click handler to shadow root
shadow.addEventListener('click', handleClick);

// Implement handleClick to process links
const handleClick = (e: Event) => {
  const link = (e.target as HTMLElement).closest('a');
  if (link) {
    e.preventDefault();
    onNavigate(link.getAttribute('href'), isExternal);
  }
};
```

### Issue: External Imports Loading

**Problem:** Canvas loads external stylesheets
**Cause:** CSS sanitization doesn't block @import
**Solution:**
```typescript
// Block @import in CSS sanitizer
css.replace(/@import\s+url\s*\(['"]?(?!data:)[^'")]+['"]?\)/gi, '');
```

### Issue: Styles Not Applied

**Problem:** CSS in `<style>` tags not rendering
**Cause:** Styles not extracted and injected into shadow root
**Solution:**
```typescript
// Extract styles from HTML
const { html, css } = extractStylesFromHTML(content);

// Inject into shadow root
shadow.innerHTML = `
  <style>${sanitizeCSS(css)}</style>
  <div>${sanitizedHTML}</div>
`;
```

### Issue: Permission Denied on Navigation

**Problem:** Users can't navigate to pages they have access to
**Cause:** Permission check implementation issue
**Solution:**
```typescript
// Check permissions via API
const response = await fetch(`/api/pages/${pageId}/permissions/check`);
const { canView } = await response.json();
if (!canView) {
  toast.error('Permission denied');
  return;
}
router.push(url);
```

## Security Considerations

### HTML Sanitization Layers

1. **DOMPurify**: Remove dangerous tags and attributes
2. **Forbidden Tags**: script, iframe, object, embed, link, meta
3. **Forbidden Attributes**: onerror, onload, onclick, etc.
4. **Allow Safe Attributes**: data-href, data-navigate for navigation

### CSS Sanitization Layers

1. **JavaScript Execution**: Remove `expression()`, `javascript:`, `-moz-binding`
2. **External Imports**: Block `@import` statements
3. **Data URIs**: Allow `data:` URIs for inline images/fonts
4. **Behavior**: Block IE `behavior` property

### Navigation Security

1. **Permission Validation**: Check access before navigation
2. **External Confirmation**: Confirm external link clicks
3. **URL Validation**: Verify internal URLs match expected format
4. **noopener/noreferrer**: Use for external links

## Performance Considerations

### Rendering Optimization

- **Shadow DOM Reuse**: Reuse shadow root across renders
- **Minimize DOM Nodes**: Keep HTML structure simple
- **Efficient CSS**: Use Grid/Flexbox over complex positioning
- **Event Delegation**: Single click handler for all navigation

### Memory Management

- **Cleanup Listeners**: Remove event listeners on unmount
- **Avoid Memory Leaks**: Clear shadow root references
- **Image Optimization**: Use appropriate image sizes

## Related Documentation

- [Canvas Dashboard Architecture](../../2.0-architecture/2.6-features/canvas-dashboards.md)
- [Building Canvas Dashboards](../../3.0-guides-and-tools/building-canvas-dashboards.md)
- [Security & Sanitization](../../2.0-architecture/2.2-backend/security.md)
- [Page Types](../../2.0-architecture/2.6-features/page-types.md)
- [Editor System Expert](./editor-system-expert.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose