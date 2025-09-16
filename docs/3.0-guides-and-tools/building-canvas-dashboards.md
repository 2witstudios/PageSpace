# Building Canvas Dashboards Guide

This guide will walk you through creating custom dashboards in PageSpace using canvas pages. Canvas pages allow you to write HTML and CSS to create beautiful, functional dashboards with working navigation.

## Quick Start: Your First Dashboard

### Step 1: Create a Canvas Page

1. Navigate to the folder where you want your dashboard
2. Click "New Page" and select "Canvas" as the page type
3. Name it something like "Project Dashboard" or "Team Overview"

### Step 2: Switch to Code View

Canvas pages have two tabs:
- **Code**: Write your HTML/CSS here
- **View**: See your rendered dashboard

Click the "Code" tab to start editing.

### Step 3: Create Your First Dashboard

Copy and paste this starter template:

```html
<style>
  /* Dashboard Styles */
  .dashboard {
    padding: 40px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    font-family: -apple-system, sans-serif;
  }

  h1 {
    color: white;
    text-align: center;
    margin-bottom: 40px;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }

  .card {
    background: white;
    padding: 24px;
    border-radius: 12px;
    text-decoration: none;
    color: #333;
    transition: transform 0.2s;
  }

  .card:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 24px rgba(0,0,0,0.1);
  }

  .card h2 {
    color: #667eea;
    margin: 0 0 8px 0;
  }

  .card p {
    margin: 0;
    color: #666;
  }
</style>

<div class="dashboard">
  <h1>My Dashboard</h1>

  <div class="cards">
    <a href="/dashboard" class="card">
      <h2>📊 Overview</h2>
      <p>View main dashboard</p>
    </a>

    <a href="/dashboard/messages" class="card">
      <h2>💬 Messages</h2>
      <p>Check your conversations</p>
    </a>

    <button data-href="/settings" class="card">
      <h2>⚙️ Settings</h2>
      <p>Configure your workspace</p>
    </button>
  </div>
</div>
```

### Step 4: Save and View

1. The canvas auto-saves as you type
2. Click the "View" tab to see your dashboard
3. Try clicking the cards - they navigate!

---

## HTML/CSS Basics for Dashboards

### Structure Your Content

Use semantic HTML for better organization:

```html
<header>
  <h1>Dashboard Title</h1>
  <nav>Navigation links here</nav>
</header>

<main>
  <section class="stats">Statistics</section>
  <section class="content">Main content</section>
</main>

<footer>
  Additional information
</footer>
```

### Essential CSS Properties

#### Layouts

```css
/* Grid Layout - Perfect for cards */
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

/* Flexbox - Great for navigation */
.nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
```

#### Styling

```css
/* Gradients */
.gradient-bg {
  background: linear-gradient(135deg, #667eea, #764ba2);
}

/* Shadows */
.card {
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

/* Rounded Corners */
.rounded {
  border-radius: 12px;
}

/* Transitions */
.smooth {
  transition: all 0.3s ease;
}
```

---

## Navigation Patterns

Canvas dashboards support multiple ways to create navigation:

### Standard Links

```html
<!-- Internal PageSpace navigation -->
<a href="/dashboard">Home</a>
<a href="/dashboard/drive-id/page-id">Specific Page</a>
<a href="/settings">Settings</a>
<a href="/account">Account</a>
```

### PageSpace Protocol

Use the custom protocol for quick page links:

```html
<!-- Navigate to a page by ID (uses current drive) -->
<a href="pagespace://page/page-id-here">Go to Page</a>
```

### Button Navigation

Buttons can navigate using data attributes:

```html
<!-- Using data-href -->
<button data-href="/dashboard">Dashboard</button>

<!-- Using data-navigate -->
<button data-navigate="/settings/ai">AI Settings</button>
```

### External Links

External links open in new tabs with confirmation:

```html
<!-- Opens in new tab after confirmation -->
<a href="https://github.com" target="_blank">GitHub</a>
<a href="https://docs.example.com">Documentation</a>
```

### Card Navigation

Make entire cards clickable:

```html
<a href="/dashboard/projects" class="card">
  <h3>Projects</h3>
  <p>View all projects</p>
  <span>15 active projects →</span>
</a>
```

---

## Styling Best Practices

### 1. Use Consistent Colors

Define a color scheme at the top:

```css
<style>
  /* Color Palette */
  :root {
    --primary: #667eea;
    --secondary: #764ba2;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
    --text: #333;
    --text-light: #666;
  }

  .card {
    color: var(--text);
  }

  .btn-primary {
    background: var(--primary);
  }
</style>
```

### 2. Mobile Responsive Design

Use responsive units and media queries:

```css
/* Responsive Grid */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
}

/* Mobile Adjustments */
@media (max-width: 768px) {
  .dashboard {
    padding: 20px;
  }

  h1 {
    font-size: 24px;
  }

  .grid {
    grid-template-columns: 1fr;
  }
}
```

### 3. Consistent Spacing

Use a spacing system:

```css
/* Spacing Scale */
.p-1 { padding: 8px; }
.p-2 { padding: 16px; }
.p-3 { padding: 24px; }
.p-4 { padding: 32px; }

.m-1 { margin: 8px; }
.m-2 { margin: 16px; }
.m-3 { margin: 24px; }
.m-4 { margin: 32px; }
```

---

## Common Dashboard Patterns

### Navigation Bar

```html
<style>
  nav {
    background: rgba(255,255,255,0.1);
    backdrop-filter: blur(10px);
    padding: 20px;
    border-radius: 10px;
    margin-bottom: 30px;
  }

  nav ul {
    list-style: none;
    display: flex;
    gap: 20px;
    margin: 0;
    padding: 0;
  }

  nav a {
    color: white;
    text-decoration: none;
    padding: 8px 16px;
    border-radius: 20px;
    transition: background 0.3s;
  }

  nav a:hover {
    background: rgba(255,255,255,0.2);
  }
</style>

<nav>
  <ul>
    <li><a href="/dashboard">Home</a></li>
    <li><a href="/dashboard/projects">Projects</a></li>
    <li><a href="/dashboard/messages">Messages</a></li>
    <li><a href="/settings">Settings</a></li>
  </ul>
</nav>
```

### Statistics Cards

```html
<style>
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 20px;
    margin-bottom: 40px;
  }

  .stat-card {
    background: white;
    padding: 20px;
    border-radius: 10px;
    text-align: center;
  }

  .stat-number {
    font-size: 36px;
    font-weight: bold;
    color: #667eea;
  }

  .stat-label {
    color: #666;
    margin-top: 8px;
  }
</style>

<div class="stats">
  <div class="stat-card">
    <div class="stat-number">42</div>
    <div class="stat-label">Active Projects</div>
  </div>
  <div class="stat-card">
    <div class="stat-number">128</div>
    <div class="stat-label">Total Tasks</div>
  </div>
  <div class="stat-card">
    <div class="stat-number">8</div>
    <div class="stat-label">Team Members</div>
  </div>
  <div class="stat-card">
    <div class="stat-number">95%</div>
    <div class="stat-label">Completion</div>
  </div>
</div>
```

### Project Grid

```html
<style>
  .projects {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 24px;
  }

  .project-card {
    background: white;
    border-radius: 12px;
    overflow: hidden;
    transition: transform 0.3s;
    text-decoration: none;
    color: inherit;
  }

  .project-card:hover {
    transform: scale(1.02);
  }

  .project-header {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white;
    padding: 20px;
  }

  .project-body {
    padding: 20px;
  }

  .project-footer {
    padding: 20px;
    border-top: 1px solid #eee;
    display: flex;
    justify-content: space-between;
  }
</style>

<div class="projects">
  <a href="/dashboard/project-1" class="project-card">
    <div class="project-header">
      <h3>Project Alpha</h3>
    </div>
    <div class="project-body">
      <p>Main development project for Q1</p>
    </div>
    <div class="project-footer">
      <span>⏱ 5 days left</span>
      <span>👥 4 members</span>
    </div>
  </a>

  <a href="/dashboard/project-2" class="project-card">
    <div class="project-header">
      <h3>Project Beta</h3>
    </div>
    <div class="project-body">
      <p>Research and planning phase</p>
    </div>
    <div class="project-footer">
      <span>⏱ 2 weeks left</span>
      <span>👥 6 members</span>
    </div>
  </a>
</div>
```

---

## Advanced Techniques

### Animations

Add life to your dashboards:

```css
/* Fade In Animation */
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.card {
  animation: fadeIn 0.5s ease;
}

/* Stagger Animation */
.card:nth-child(1) { animation-delay: 0.1s; }
.card:nth-child(2) { animation-delay: 0.2s; }
.card:nth-child(3) { animation-delay: 0.3s; }

/* Hover Effects */
.card {
  transition: all 0.3s ease;
}

.card:hover {
  transform: translateY(-5px) scale(1.02);
  box-shadow: 0 20px 40px rgba(0,0,0,0.1);
}
```

### Glass Morphism

Create modern glass effects:

```css
.glass {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px;
  padding: 20px;
}
```

### Custom Scrollbars

Style scrollbars for a custom look:

```css
/* Webkit browsers */
::-webkit-scrollbar {
  width: 10px;
}

::-webkit-scrollbar-track {
  background: #f1f1f1;
}

::-webkit-scrollbar-thumb {
  background: #888;
  border-radius: 5px;
}

::-webkit-scrollbar-thumb:hover {
  background: #555;
}
```

---

## Troubleshooting

### Dashboard Looks Different in Light/Dark Mode

Canvas dashboards are intentionally independent of PageSpace's theme. They always render with a white background unless you specify otherwise. This ensures consistency.

### Links Not Working

Make sure your links follow one of these patterns:
- Regular links: `<a href="/dashboard">Link</a>`
- Buttons: `<button data-href="/dashboard">Button</button>`
- PageSpace protocol: `<a href="pagespace://page/id">Page</a>`

### Styles Not Applying

1. Ensure your styles are within `<style>` tags
2. Check for typos in class names
3. Remember that canvas styles are isolated - they don't inherit from PageSpace

### Layout Issues

1. Use `box-sizing: border-box` for predictable sizing
2. Test your dashboard at different screen sizes
3. Use CSS Grid or Flexbox for robust layouts

### Performance Issues

1. Minimize the number of DOM elements
2. Use efficient CSS selectors
3. Optimize images (use appropriate sizes)
4. Avoid complex nested structures

---

## Tips and Tricks

### 1. Start with a Template

Begin with a working example and modify it rather than starting from scratch.

### 2. Use Emojis for Icons

Emojis work great as simple icons:
```html
<h2>📊 Dashboard</h2>
<h2>📁 Files</h2>
<h2>💬 Messages</h2>
<h2>⚙️ Settings</h2>
```

### 3. Test Navigation

Always test your links in View mode to ensure they work as expected.

### 4. Keep It Simple

Start with basic layouts and add complexity gradually. Simple dashboards often work better than complex ones.

### 5. Use CSS Variables

Define colors and spacing as variables for easy updates:
```css
:root {
  --primary-color: #667eea;
  --spacing: 20px;
}
```

### 6. Comment Your Code

Add comments to remember what sections do:
```html
<!-- Navigation Bar -->
<nav>...</nav>

<!-- Main Content Grid -->
<div class="grid">...</div>
```

---

## Examples Gallery

### Minimal Dashboard

```html
<style>
  body {
    font-family: -apple-system, sans-serif;
    padding: 40px;
  }

  .links {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
  }

  a {
    padding: 12px 24px;
    background: #667eea;
    color: white;
    text-decoration: none;
    border-radius: 8px;
  }

  a:hover {
    background: #5a67d8;
  }
</style>

<h1>Quick Links</h1>
<div class="links">
  <a href="/dashboard">Dashboard</a>
  <a href="/dashboard/projects">Projects</a>
  <a href="/dashboard/messages">Messages</a>
  <a href="/settings">Settings</a>
</div>
```

### Dark Theme Dashboard

```html
<style>
  .dark-dashboard {
    background: #1a1a1a;
    color: #e0e0e0;
    min-height: 100vh;
    padding: 40px;
  }

  .dark-card {
    background: #2a2a2a;
    border: 1px solid #404040;
    padding: 24px;
    border-radius: 8px;
    margin-bottom: 20px;
  }

  .dark-card h2 {
    color: #667eea;
  }

  a {
    color: #8b9dc3;
  }
</style>

<div class="dark-dashboard">
  <h1>Dark Mode Dashboard</h1>

  <div class="dark-card">
    <h2>Section 1</h2>
    <p>Content here</p>
    <a href="/dashboard">View More →</a>
  </div>

  <div class="dark-card">
    <h2>Section 2</h2>
    <p>Content here</p>
    <a href="/settings">Configure →</a>
  </div>
</div>
```

---

## Related Resources

- [Canvas Dashboard Architecture](../2.0-architecture/2.6-features/canvas-dashboards.md)
- [Adding Page Types](./adding-page-type.md)
- [Component Organization](../2.0-architecture/2.1-frontend/components.md)