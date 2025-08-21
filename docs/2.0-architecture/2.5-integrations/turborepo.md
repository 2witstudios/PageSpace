# Integration: Turborepo

This document provides an overview of how pagespace uses Turborepo to manage the pnpm monorepo and streamline development workflows.

## Overview

Turborepo is a high-performance build system for JavaScript and TypeScript codebases. We use it to manage our monorepo, which is composed of multiple applications and packages. Turborepo enables us to have a single, unified development experience, while still maintaining a modular and scalable architecture.

## Development

The primary command for starting the development environment is:

```bash
pnpm dev
```

This command uses Turborepo to start all the services defined in the `pnpm-workspace.yaml` file, including the `web` and `realtime` applications. Turborepo is smart enough to only rebuild the packages that have changed, which significantly speeds up development.

## Build

To build all the applications and packages in the monorepo, you can use the following command:

```bash
pnpm build
```

This command will create production-ready builds for all the applications in the `apps` directory.

## Filtering

Turborepo allows you to run commands for specific packages. For example, to only run the `dev` command for the `web` application, you can use the following command:

```bash
pnpm --filter web dev
```

This is useful for situations where you only want to work on a specific part of the application.
**Last Updated:** 2025-08-13