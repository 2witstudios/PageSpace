# Integration: Docker

This document outlines how pagespace uses Docker and Docker Compose to create a consistent, containerized local development environment.

## Overview

We use Docker to containerize each part of our application stack. The entire local environment is orchestrated by the [`docker-compose.yml`](docker-compose.yml:1) file at the root of the project. This approach ensures that every developer has the exact same setup, regardless of their host operating system, which eliminates "it works on my machine" problems.

The primary command to get started is `docker-compose up`.

## Service Architecture

Our `docker-compose.yml` defines the following key services:

### 1. `postgres`

-   **Purpose:** Runs our PostgreSQL database.
-   **Image:** Uses the official `postgres:17.5-alpine` image.
-   **Persistence:** Database files are persisted to a Docker volume named `postgres_data` to ensure data is not lost when the container is stopped or restarted.
-   **Healthcheck:** Includes a healthcheck to ensure that other services don't start until the database is fully ready to accept connections.
-   **Port Mapping:** Exposes PostgreSQL on port 5432.

### 2. `migrate`

-   **Purpose:** A short-lived utility container that runs database migrations.
-   **Dockerfile:** [`apps/web/Dockerfile.migrate`](apps/web/Dockerfile.migrate:1)
-   **Startup Order:** Waits for the `postgres` service to be healthy before running.
-   **Command:** Executes `pnpm run db:migrate` to ensure our database schema is up-to-date before the applications start.
-   **Healthcheck:** Includes a basic healthcheck to confirm the migration service is functioning.

### 3. `web`

-   **Purpose:** The main Next.js frontend and backend application.
-   **Dockerfile:** [`apps/web/Dockerfile`](apps/web/Dockerfile:1)
-   **Build Strategy:** This is a multi-stage Dockerfile that is optimized for build speed and a small final image size.
    -   `deps` stage: Installs all `pnpm` dependencies. This layer is only rebuilt if the lockfile changes.
    -   `builder` stage: Copies the dependencies and source code, then runs `pnpm build` to build the Next.js application.
    -   `runner` stage: A minimal production image that copies only the necessary standalone build artifacts from the `builder` stage.
-   **Dependencies:** It waits for the `migrate` service to complete successfully before starting.
-   **Port Mapping:** Exposes the web application on port 3000.
-   **Resource Limits:** Limited to 512MB of memory for optimal resource usage.

### 4. `realtime`

-   **Purpose:** The standalone Socket.IO server for real-time communication.
-   **Dockerfile:** [`apps/realtime/Dockerfile`](apps/realtime/Dockerfile:1)
-   **Build Strategy:** This is a simpler multi-stage build that installs dependencies and then copies the source code into a production image.
-   **Execution:** It uses `tsx` to run the TypeScript source code (`apps/realtime/src/index.ts`) directly, without a separate build step for the server itself.
-   **Dependencies:** It also waits for the `migrate` service to complete.
-   **Port Mapping:** Exposes the realtime service on port 3001.
-   **Resource Limits:** Limited to 256MB of memory for optimal resource usage.

### 5. `seed` (Available but not configured)

-   **Purpose:** A utility container for seeding the database with initial data.
-   **Dockerfile:** [`apps/web/Dockerfile.seed`](apps/web/Dockerfile.seed:1)
-   **Command:** Would execute `pnpm --filter @pagespace/db db:seed` to populate the database with initial data.
-   **Note:** This service is available via its Dockerfile but not currently configured in the docker-compose.yml file. It can be added manually if initial data seeding is required.

## How to Use

### Starting the Environment

To build and start all services, run the following command from the root of the project:

```bash
docker-compose up
```

To force a rebuild of the container images if you've made changes to a `Dockerfile`:

```bash
docker-compose up --build
```

### Stopping the Environment

To stop and remove all the containers, run:

```bash
docker-compose down
```

## Environment Variables

For Dockerized environments, most necessary environment variables for inter-service communication (like `DATABASE_URL` and `NEXT_PUBLIC_REALTIME_URL`) are defined directly within the [`docker-compose.yml`](docker-compose.yml:1) file. This ensures that the containers can connect to each other using their service names (e.g., `postgres:5432`).

### Required Environment Variables

-   `DATABASE_URL`: Used by `migrate`, `web`, and `realtime` services to connect to PostgreSQL. Set to `postgresql://user:password@postgres:5432/pagespace` for inter-container communication.
-   `NEXT_PUBLIC_REALTIME_URL`: Used by the `web` service to connect to the `realtime` server. Must be accessible from the client browser.
-   `WEB_APP_URL`: Used by the `realtime` service for CORS configuration to allow requests from the web application.
-   `REALTIME_PORT`: Port configuration for the realtime service (typically 3001).
-   `PORT`: Port configuration for the web service (typically 3000).

### Environment File Usage

The docker-compose configuration uses an `env_file: .env` directive for all services, meaning you **do need** a local `.env` file for the Dockerized environment to function properly. This file should contain:

```bash
NEXT_PUBLIC_REALTIME_URL=http://localhost:3001
WEB_APP_URL=http://localhost:3000
REALTIME_PORT=3001
```

Additional environment variables for AI providers, authentication secrets, and other application-specific settings should also be included in your `.env` file.
**Last Updated:** 2025-08-21