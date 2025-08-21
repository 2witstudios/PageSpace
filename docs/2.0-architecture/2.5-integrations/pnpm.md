# Integration: pnpm

This document outlines how pagespace uses pnpm for package management in our monorepo.

## Why pnpm?

pnpm is a fast and disk space-efficient package manager. We use it to manage the dependencies for our monorepo, which contains the web application, the realtime server, and all shared packages. Its key advantages for our project are:

-   **Disk Space Efficiency:** pnpm's unique content-addressable storage system saves disk space by storing packages in a global store and creating hard links to them in projects. This is highly beneficial in a monorepo with many shared dependencies.
-   **Fast Installation:** By avoiding duplication and using a global cache, pnpm is significantly faster than other package managers.
-   **Strictness:** pnpm creates a non-flat `node_modules` directory. This prevents packages from accessing dependencies that are not explicitly declared in their `package.json`, which helps avoid phantom dependency issues and ensures our dependency graph is explicit and reliable.

## Monorepo Workspace Configuration

Our monorepo's structure is defined in the [`pnpm-workspace.yaml`](pnpm-workspace.yaml:1) file. It specifies that all subdirectories within `apps/` and `packages/` are treated as separate workspaces:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

This allows us to manage dependencies for each application (e.g., `web`) and shared library (e.g., `db`) independently while still being able to link them together and run commands across the entire repository.

## Project Scripts & Common Commands

The root [`package.json`](package.json:1) contains several important scripts for managing the project. These scripts often use `pnpm`'s filtering capabilities (`--filter`) to target specific workspaces.

### Key Scripts

-   `pnpm dev`: Starts the development servers for all applications within the `apps` directory in parallel.
    ```json
    "dev": "pnpm --filter \"./apps/*\" --parallel dev"
    ```
-   `pnpm build`: Builds all applications within the `apps` directory.
    ```json
    "build": "pnpm --filter ./apps/* build"
    ```
-   `pnpm db:generate`: Generates Drizzle ORM migration files based on schema changes.
    ```json
    "db:generate": "drizzle-kit generate"
    ```
-   `pnpm db:migrate`: Applies pending database migrations. This command specifically targets the `@pagespace/db` package.
    ```json
    "db:migrate": "pnpm --filter @pagespace/db db:migrate"
    ```

### Common Commands for Onboarding

-   **Install all dependencies:**
    ```bash
    pnpm install
    ```
-   **Run a script in a specific workspace (e.g., the web app):**
    ```bash
    pnpm --filter web dev
    ```
-   **Add a dependency to a specific workspace:**
    ```bash
    # Add to the web app
    pnpm --filter web add react-query

    # Add a dev dependency to the shared db package
    pnpm --filter @pagespace/db add -D @types/pg
    ```
-   **Run a command in the root of the monorepo:**
    ```bash
    pnpm -w <command> # e.g., pnpm -w test
    ```

## Dependency Overrides

We use the `pnpm.overrides` field in the root [`package.json`](package.json:1) to enforce a specific version of a dependency across all workspaces. This is useful for resolving version conflicts or ensuring a critical package remains on a known-stable version.

Currently, we override `drizzle-orm`:
```json
"pnpm": {
  "overrides": {
    "drizzle-orm": "^0.32.2"
  }
  **Last Updated:** 2025-08-13
}
```
This ensures that every workspace in the monorepo uses this exact version of `drizzle-orm`, providing consistency and preventing potential bugs from version mismatches.