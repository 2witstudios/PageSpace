# Canvas Dashboard Architecture

## Philosophy: Canvas as Custom Visual Interfaces

PageSpace treats canvas pages not just as static content, but as **fully functional, custom-built dashboards with working navigation**. Unlike traditional document pages, canvas pages allow users to write raw HTML and CSS to create rich visual interfaces that integrate seamlessly with PageSpace's navigation system.

---

## Core Architectural Principles

### 1. Pages as Dashboard Containers

Canvas pages are `CANVAS` page types that serve as containers for custom HTML/CSS dashboards:

```
📁 Project Management/
├── 📄 Requirements.md
├── 📁 Sprint 1/
│   ├── 🎨 Sprint Dashboard      ← CANVAS page with custom HTML
│   └── 📄 Sprint Notes.md
└── 🎨 Project Overview          ← CANVAS page with navigation grid
```

**Implications:**
- Canvas pages can serve as visual navigation hubs for folders
- Custom dashboards integrate with PageSpace's permission system
- HTML/CSS content is isolated from the main application styling
- Navigation works seamlessly between canvas and other page types

### 2. Shadow DOM Isolation Architecture

Canvas pages utilize **Web Components Shadow DOM** for complete style and script isolation:

```typescript
// ShadowCanvas component architecture
const shadow = container.attachShadow({ mode: 'open' });

// Complete isolation from parent theme
shadow.innerHTML = `
  <style>
    /* Base reset for theme independence */
    .canvas-root {
      background: white;  // Always white, regardless of theme
      color: black;       // Consistent text color
    }
    /* User styles */
    ${extractedCSS}
  </style>
  <div class="canvas-root">
    ${sanitizedHTML}
  </div>
`;
```

**Benefits:**
- **Style Isolation**: Canvas CSS doesn't affect PageSpace UI
- **Theme Independence**: Dashboards look identical in light/dark mode
- **Security**: No JavaScript execution, only HTML/CSS
- **Predictability**: What users write is exactly what renders

### 3. Functional Navigation System

Canvas pages support multiple navigation patterns through intelligent link interception:

```html
<!-- Internal PageSpace navigation -->
<a href="/dashboard/drive-id/page-id">Go to Page</a>
<a href="/dashboard">Dashboard Home</a>

<!-- Button navigation with data attributes -->
<button data-href="/settings">Settings</button>
<button data-navigate="/dashboard">Dashboard</button>

<!-- External links (with confirmation) -->
<a href="https://example.com" target="_blank">External Site</a>
```

**Navigation Flow:**
1. Shadow DOM intercepts all clicks
2. Determines if link is internal or external
3. For internal links: Validates permissions and uses Next.js router
4. For external links: Shows confirmation dialog and opens in new tab

---

## Security Model

### HTML/CSS Sanitization

Canvas pages implement a multi-layer security approach:

```typescript
// 1. HTML Sanitization via DOMPurify
const sanitizedHTML = DOMPurify.sanitize(html, {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  ADD_ATTR: ['data-href', 'data-navigate']
});

// 2. CSS Sanitization
const sanitizedCSS = css
  .replace(/expression\s*\(/gi, '')      // Block IE expressions
  .replace(/-moz-binding/gi, '')         // Block Firefox XBL
  .replace(/javascript:/gi, '')          // Block JavaScript URLs
  .replace(/@import\s+url/gi, '');       // Block external imports
```

### Permission Integration

Canvas navigation respects PageSpace's permission system:

```typescript
// Before navigation, check user permissions
const accessLevel = await getUserAccessLevel(userId, pageId);
if (!accessLevel?.canView) {
  toast.error('You do not have permission to view this page');
  return;
}
```

---

## Technical Implementation

### Component Architecture

```
/components/canvas/
├── ShadowCanvas.tsx       # Main Shadow DOM component
└── /lib/canvas/
    ├── css-sanitizer.ts   # CSS security utilities
    └── sample-dashboard.html  # Example dashboard
```

### Style Extraction and Processing

Canvas pages automatically extract and process embedded styles:

```typescript
// Extract <style> tags from HTML
const extractStylesFromHTML = (html: string) => {
  const styleTags = temp.querySelectorAll('style');
  let css = '';

  styleTags.forEach(tag => {
    css += tag.textContent;
    tag.remove(); // Remove from HTML
  });

  return { html, css };
};
```

### Theme Independence

Canvas content is completely independent from PageSpace's theme:

```css
/* Canvas root always has explicit defaults */
.canvas-root {
  background: white;
  color: black;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;

  /* Isolation from parent */
  isolation: isolate;
  color-scheme: light; /* Force light mode */
}
```

---

## Use Cases

### 1. Folder Dashboards

Create visual navigation for project folders:

```html
<style>
  .project-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
  }
  .card {
    background: linear-gradient(135deg, #667eea, #764ba2);
    padding: 20px;
    border-radius: 10px;
    color: white;
  }
</style>

<div class="project-grid">
  <a href="/dashboard/drive/requirements" class="card">
    <h2>Requirements</h2>
    <p>Project specifications</p>
  </a>
  <a href="/dashboard/drive/design" class="card">
    <h2>Design</h2>
    <p>UI/UX mockups</p>
  </a>
</div>
```

### 2. Status Dashboards

Build real-time status boards:

```html
<style>
  .status-board {
    display: flex;
    gap: 20px;
  }
  .status-item {
    flex: 1;
    padding: 30px;
    text-align: center;
    border-radius: 10px;
  }
  .status-green { background: #10b981; color: white; }
  .status-yellow { background: #f59e0b; color: white; }
  .status-red { background: #ef4444; color: white; }
</style>

<div class="status-board">
  <div class="status-item status-green">
    <h2>Production</h2>
    <p>All Systems Operational</p>
  </div>
  <div class="status-item status-yellow">
    <h2>Staging</h2>
    <p>Deployment in Progress</p>
  </div>
</div>
```

### 3. Navigation Hubs

Create custom navigation experiences:

```html
<nav>
  <a href="/dashboard">Home</a>
  <a href="/dashboard/projects">Projects</a>
  <a href="/dashboard/messages">Messages</a>
  <button data-href="/settings">Settings</button>
</nav>
```

---

## AI Compatibility

Canvas pages work seamlessly with AI generation:

- **Standard HTML/CSS**: AI models naturally generate compatible code
- **No Framework Knowledge**: No need to understand React, Tailwind, etc.
- **Direct Manipulation**: AI can create and modify dashboards directly
- **Visual Descriptions**: Users can describe layouts and get working HTML/CSS

Example AI prompt:
> "Create a dashboard with 3 cards in a grid, purple gradient background, with links to projects, tasks, and settings"

The AI generates standard HTML/CSS that works immediately in canvas pages.

---

## Performance Considerations

### Shadow DOM Benefits

- **Isolated Rendering**: Canvas styles don't trigger main app reflows
- **Cached Styles**: Style extraction happens once per render
- **Native Browser API**: No framework overhead

### Optimization Strategies

1. **Minimize DOM Nodes**: Keep HTML structure simple
2. **Efficient CSS**: Use CSS Grid/Flexbox over complex positioning
3. **Image Optimization**: Use appropriate image sizes
4. **Lazy Loading**: Consider pagination for large dashboards

---

## Future Enhancements

### Planned Features

1. **Data Binding**: Connect dashboards to PageSpace data
2. **Widget Library**: Pre-built dashboard components
3. **Live Preview**: Real-time editing preview
4. **Export/Import**: Share dashboard templates
5. **Responsive Editor**: Visual responsive design tools

### Under Consideration

- **Limited JavaScript**: Safe subset for interactivity
- **Chart Integration**: Built-in charting library
- **External Data**: Fetch and display external APIs
- **Collaboration**: Multi-user dashboard editing

---

## Related Documentation

- [Adding Page Type Guide](../../3.0-guides-and-tools/adding-page-type.md)
- [Building Canvas Dashboards Guide](../../3.0-guides-and-tools/building-canvas-dashboards.md)
- [Component Organization](../2.1-frontend/components.md)
- [Security & Permissions](../2.2-backend/permissions.md)