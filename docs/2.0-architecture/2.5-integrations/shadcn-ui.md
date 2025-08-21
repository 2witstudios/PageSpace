# Integration: shadcn/ui & Tailwind CSS v4

This document outlines how pagespace uses shadcn/ui and Tailwind CSS v4 to build its user interface.

## Overview

We use **shadcn/ui** as the foundation for our component library. It is not a traditional component library that you install as a dependency. Instead, you use the `shadcn-ui` CLI to add individual, unstyled components directly to the codebase. This gives us complete control over the code, styling, and behavior of every component.

Our styling is powered by **Tailwind CSS v4**, which takes a config-less approach. All of our themeing and design tokens are defined directly in our global CSS file.

## Key Principles

-   **You Own the Code:** Every component added from `shadcn/ui` lives inside our project at [`apps/web/src/components/ui`](apps/web/src/components/ui). We can (and should) modify them to fit our specific needs.
-   **Config-less Styling:** With Tailwind v4, there is no `tailwind.config.js` file. All theme configuration is done with CSS variables inside [`apps/web/src/app/globals.css`](apps/web/src/app/globals.css:1).
-   **Composition:** We build complex UI elements by composing simpler components together.

## Tailwind CSS v4 and Theming

The core of our design system is defined in [`apps/web/src/app/globals.css`](apps/web/src/app/globals.css:1). This is where Tailwind is imported and all our theming is configured.

The build process is initiated by [`apps/web/postcss.config.mjs`](apps/web/postcss.config.mjs:1), which simply loads the Tailwind CSS plugin:
```javascript
// apps/web/postcss.config.mjs
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
```

### Theme Definition (`@theme`)

Inside [`globals.css`](apps/web/src/app/globals.css:1), we use the `@theme` directive to define the CSS variables that our `shadcn/ui` components use. This makes our design tokens available to all of Tailwind's utility classes.

```css
/* apps/web/src/app/globals.css */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --radius-lg: var(--radius);
  /* ... and so on */
}
```

### Color Palette (Light & Dark Mode)

We define our color palettes for both light and dark modes using CSS variables with the modern `oklch()` color function. This provides more consistent and predictable colors across different displays.

**Light Mode (`:root`)**
```css
/* apps/web/src/app/globals.css */
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.15 0.02 265);
  --primary: oklch(0.6 0.15 280);
  --primary-foreground: oklch(0.98 0.01 280);
  /* ... etc. */
}
```

**Dark Mode (`.dark`)**
```css
/* apps/web/src/app/globals.css */
.dark {
  --radius: 0.625rem;
  --background: oklch(0.18 0.03 265);
  --foreground: oklch(0.95 0.01 265);
  --primary: oklch(0.65 0.15 280);
  --primary-foreground: oklch(0.15 0.03 265);
  /* ... etc. */
}
```

## Project Structure and Configuration

The `shadcn-ui` CLI is configured via the [`apps/web/components.json`](apps/web/components.json:1) file. This file tells the CLI where to place new components and how to resolve path aliases.

```json
// apps/web/components.json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```
-   `"ui": "@/components/ui"`: This is the most important alias. It tells the CLI to place all new components into the [`apps/web/src/components/ui`](apps/web/src/components/ui) directory.

## How to Add a New Component

To add a new component (e.g., a `card`), run the `shadcn-ui` CLI from the root of the monorepo:

```bash
# Make sure you are in the root directory
pnpm --filter web exec shadcn-ui@latest add card
```

This command will:
1.  Run the `shadcn-ui` CLI within the context of the `web` workspace.
2.  Add the `Card` component and its related files (`CardHeader`, `CardContent`, etc.) to [`apps/web/src/components/ui/card.tsx`](apps/web/src/components/ui/card.tsx:1).
3.  Install any necessary dependencies (e.g., `@radix-ui/react-card`).

## How to Customize a Component

To customize a component, simply open its file in [`apps/web/src/components/ui`](apps/web/src/components/ui) and edit it directly.

For example, if you want to change the default styles of the `Button` component, you would edit [`apps/web/src/components/ui/button.tsx`](apps/web/src/components/ui/button.tsx:1). You can modify the `cva` (class-variance-authority) variants to change colors, sizes, or any other Tailwind utility.

```tsx
// apps/web/src/components/ui/button.tsx

const buttonVariants = cva(
  "inline-flex items-center...",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground ...",
        // You can add a new variant here
        brand: "bg-brand-orange text-white ...",
        destructive: "...",
      },
      // ...
    },
  }
)
**Last Updated:** 2025-08-13