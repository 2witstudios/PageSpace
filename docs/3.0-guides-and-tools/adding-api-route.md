# How to Add a New API Route

This guide provides instructions for adding new API routes to the web application, following the conventions established in the Next.js App Router.

## 1. File and Folder Structure

API routes are located in `apps/web/src/app/api/`. Each route is defined by a `route.ts` file within a directory that maps to the URL path.

-   **Static Routes**: For a route like `/api/users/find`, the file is at `apps/web/src/app/api/users/find/route.ts`.
-   **Dynamic Routes**: For a route like `/api/pages/[pageId]`, the file is at `apps/web/src/app/api/pages/[pageId]/route.ts`.

## 2. Route Handler Functions

Each `route.ts` file exports async functions corresponding to HTTP methods (e.g., `GET`, `POST`, `PUT`, `DELETE`).

**CRITICAL**: All API route handlers in Next.js 15 MUST be `async` functions that return a `Response` or `NextResponse` object.

### Example: `GET` Handler

```typescript
// Example: apps/web/src/app/api/auth/me/route.ts
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  // Your logic here
  return NextResponse.json({ message: 'Hello, world!' });
}
```

### Example: `POST` Handler

```typescript
// Example: apps/web/src/app/api/auth/signup/route.ts
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const body = await request.json();
  // Your logic here
  return NextResponse.json({ received: body }, { status: 201 });
}
```

## 3. Handling Request Data

### Dynamic Route Parameters

In Next.js 15, dynamic route parameters (`context.params`) are **Promises** and must be awaited.

```typescript
// Example: apps/web/src/app/api/pages/[pageId]/route.ts
import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params; // MUST await
  return NextResponse.json({ pageId });
}
```

### Search Parameters

Use the `URL` constructor to get search parameters from the request URL.

```typescript
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  return NextResponse.json({ name });
}
```

### Request Body

To get the body of a `POST` or `PUT` request, use the `.json()` method.

```typescript
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const data = await request.json();
  return NextResponse.json({ data });
}
```

## 4. Authentication

Most routes require authentication. A helper function `decodeToken` from `@pagespace/lib` is used to verify the `accessToken` cookie.

```typescript
import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib';
import { parse } from 'cookie';

export async function GET(req: Request) {
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { userId } = decoded;
  // Proceed with authenticated logic
  return NextResponse.json({ userId });
}
```

## 5. Data Access and Error Handling

Use the Drizzle ORM instance from `@pagespace/db` to interact with the database. Always wrap database queries in a `try...catch` block to handle potential errors gracefully.

```typescript
import { NextResponse } from 'next/server';
import { db, users } from '@pagespace/db';
import { eq } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const allUsers = await db.select().from(users);
    return NextResponse.json(allUsers);
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return NextResponse.json(
      { error: 'Failed to fetch users' },
      { status: 500 }
    );
  }
}
```

## 6. Updating API Documentation

After adding or modifying an API route, you **MUST** update the central API documentation. Refer to the format specified in `api_routes.md` and add or update the relevant file in `docs/2.0-architecture/2.4-api/`.
**Last Updated:** 2025-08-13