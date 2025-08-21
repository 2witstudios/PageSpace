# Integration: Drizzle ORM

This document outlines how pagespace uses the Drizzle ORM for all database interactions with our PostgreSQL database.

## Overview

Drizzle is a modern, lightweight TypeScript ORM that provides a type-safe, SQL-like syntax. We use it exclusively on the server-side (in Next.js API routes and the `realtime` server) to query and mutate our data. It is the single source of truth for our database structure.

All database-related code is encapsulated within its own workspace package: [`packages/db`](packages/db).

## The `db` Package

The `packages/db` package contains everything needed to connect to, query, and manage the database.

### Schema Definition

The database schema is defined in TypeScript files located in [`packages/db/src/schema/`](packages/db/src/schema). Each file typically represents a logical domain of the application (e.g., `auth.ts`, `core.ts`).

-   **Table Definition:** We use Drizzle's `pgTable` function to define our tables, columns, types, and constraints.
-   **Relations:** Drizzle's `relations` helpers are used to define the relationships between tables (e.g., one-to-many, many-to-one).

```typescript
// packages/db/src/schema/auth.ts
export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  email: text('email').unique().notNull(),
  // ...
});

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
}));
```

All the individual schema files are then exported and combined into a single `schema` object in [`packages/db/src/schema.ts`](packages/db/src/schema.ts:1). This object is what the Drizzle client uses to understand the database structure.

### Database Client

The database client is initialized and exported from [`packages/db/src/index.ts`](packages/db/src/index.ts:1).

-   **Connection:** It uses the `pg` library to create a connection pool to the PostgreSQL database, using the `DATABASE_URL` environment variable.
-   **Drizzle Instance:** It wraps the connection pool with the `drizzle` function, attaching our combined `schema` to create the fully type-safe `db` client.
-   **Re-exports:** For convenience, this file also re-exports the most commonly used query operators from Drizzle (`eq`, `and`, `gte`, etc.). This allows us to import both the `db` client and operators from a single location: `@pagespace/db`.

```typescript
// packages/db/src/index.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
});

export const db = drizzle(pool, { schema });
```

## Migration Workflow

We use `drizzle-kit` to manage our database schema migrations.

### 1. Configuration

The configuration for `drizzle-kit` is in the root [`drizzle.config.ts`](drizzle.config.ts:1) file. It tells the toolkit that we're using PostgreSQL and specifies the location of our schema file and the output directory for migration files.

```typescript
// drizzle.config.ts
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/drizzle",
  // ...
});
```

### 2. Generating Migrations

**This is a manual step that must be run whenever you change the schema.** After modifying any of the schema files in `packages/db/src/schema/`, you must run the following command from the root of the project:

```bash
pnpm db:generate
```

This command will compare the current state of your schema files with the state of the database (as tracked by previous migrations) and generate a new SQL migration file in the [`packages/db/drizzle`](packages/db/drizzle) directory.

### 3. Applying Migrations

To apply the generated migrations to the database, you can run:

```bash
pnpm db:migrate
```

This command executes the `migrate` script located at [`packages/db/src/migrate.ts`](packages/db/src/migrate.ts:1), which uses Drizzle's migrator to run any pending SQL migration files against the database. The `migrate` function itself is not directly exported for import by other packages.

**Note:** When running the application via `pnpm dev`, you will need to run migrations manually. When running via `docker-compose up`, this step is handled automatically by the `migrate` service, which runs before the main applications start.
**Last Updated:** 2025-08-13