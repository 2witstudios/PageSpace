import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Docker Setup",
  description: "Deploy PageSpace with Docker Compose. Complete docker-compose.yml configuration for all services, PostgreSQL, and Redis.",
  path: "/docs/self-hosting/docker",
  keywords: ["Docker", "Docker Compose", "deployment", "containers", "PostgreSQL"],
});

const content = `
# Docker Setup

Deploy all PageSpace services with Docker Compose.

## docker-compose.yml

\`\`\`yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: pagespace
      POSTGRES_USER: pagespace
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pagespace"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://pagespace:\${POSTGRES_PASSWORD}@postgres:5432/pagespace
      REDIS_URL: redis://redis:6379
      REALTIME_URL: http://realtime:3001
      PROCESSOR_URL: http://processor:3003
      NEXT_PUBLIC_APP_URL: \${APP_URL:-http://localhost:3000}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  realtime:
    build:
      context: .
      dockerfile: apps/realtime/Dockerfile
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: postgresql://pagespace:\${POSTGRES_PASSWORD}@postgres:5432/pagespace
      REDIS_URL: redis://redis:6379
      SERVICE_SECRET: \${SERVICE_SECRET}
    depends_on:
      postgres:
        condition: service_healthy

  processor:
    build:
      context: .
      dockerfile: apps/processor/Dockerfile
    ports:
      - "3003:3003"
    environment:
      DATABASE_URL: postgresql://pagespace:\${POSTGRES_PASSWORD}@postgres:5432/pagespace
      UPLOAD_DIR: /data/uploads
      SERVICE_SECRET: \${SERVICE_SECRET}
    volumes:
      - uploads:/data/uploads
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
  uploads:
\`\`\`

## Running

\`\`\`bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f web

# Run database migrations
docker compose exec web pnpm db:migrate

# Stop all services
docker compose down
\`\`\`

## Building from Source

If you prefer to build locally:

\`\`\`bash
# Install dependencies
pnpm install

# Build all services
pnpm build

# Start in development mode
pnpm dev
\`\`\`

Development mode starts all three services with hot reloading:
- Web on port 3000
- Realtime on port 3001
- Processor on port 3003

## Health Checks

Each service exposes a health check endpoint:

| Service | Endpoint | Expected Response |
|---------|----------|------------------|
| Web | \`GET /api/health\` | 200 OK |
| Realtime | Socket.IO connection | Connected |
| Processor | \`GET /health\` | 200 OK |

## Reverse Proxy

For production, place a reverse proxy (nginx, Caddy, Traefik) in front of PageSpace:

\`\`\`nginx
server {
    listen 443 ssl;
    server_name pagespace.example.com;

    # Web app
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket (Socket.IO)
    location /socket.io/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
\`\`\`

Key requirements:
- **HTTPS** for secure cookies and WebSocket connections
- **WebSocket support** for the realtime service
- **Large request body** support for file uploads (100 MB max)

## Updating

\`\`\`bash
# Pull latest changes
git pull

# Rebuild containers
docker compose build

# Run migrations
docker compose exec web pnpm db:migrate

# Restart services
docker compose up -d
\`\`\`

Always run migrations after updating — schema changes are handled by Drizzle ORM migrations.
`;

export default function DockerPage() {
  return <DocsMarkdown content={content} />;
}
