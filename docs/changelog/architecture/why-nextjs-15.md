# Why Next.js 15

> App Router, React 19, Server Components

## The Decision

PageSpace was built on Next.js 15 from day one - the most ambitious Next.js release, featuring the stable App Router, React 19 support, and a fundamentally different mental model from Pages Router.

## Key Architectural Choices

### App Router Over Pages Router

**The Choice**: Use the new App Router pattern exclusively.

**Why**:
- Server Components reduce client-side JavaScript
- Nested layouts enable shared UI without prop drilling
- Built-in loading and error states
- Parallel routes for complex UI patterns

**Trade-offs**:
- Learning curve for developers familiar with Pages Router
- Some ecosystem libraries hadn't caught up
- Async params in route handlers required careful handling

### React 19 Features

**The Choice**: Target React 19 from the start.

**Why**:
- `use()` hook for cleaner async patterns
- Improved suspense boundaries
- Better hydration error messages
- Actions and form handling

### Server Components Strategy

*To be documented as commits reveal specific decisions.*

## Breaking Changes We Navigated

### Async Route Params

Next.js 15 made `params` in dynamic routes Promise-based:

```typescript
// Required pattern in Next.js 15
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return Response.json({ id });
}
```

This affected every route handler and required systematic updates.

## Evolution Through Commits

*This section will be populated as commits are processed, documenting how Next.js-related decisions evolved.*

---

*Last updated: 2026-01-21 | Version: 0*
