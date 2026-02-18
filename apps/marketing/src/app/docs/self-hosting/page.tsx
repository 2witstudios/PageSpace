import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Self-Hosting",
  description: "Deploy PageSpace on your own infrastructure. Overview of services, Docker setup, and configuration requirements.",
  path: "/docs/self-hosting",
  keywords: ["self-hosting", "deployment", "Docker", "on-premise", "infrastructure"],
});

const content = `
# Self-Hosting

PageSpace can be deployed on your own infrastructure using Docker. This gives you full control over your data, AI provider configuration, and network security.

## Requirements

- **Docker** and **Docker Compose** v2+
- **PostgreSQL** 15+ (or use the included Docker container)
- **Redis** (optional, for permission caching)
- **Node.js** 20+ (for building from source)
- **2 GB RAM minimum** (4 GB recommended)
- **10 GB disk** for the application (storage for uploads varies)

## Services

PageSpace consists of three services:

| Service | Port | Description |
|---------|------|-------------|
| **Web** | 3000 | Next.js 15 application — handles all API routes, UI rendering, and AI streaming |
| **Realtime** | 3001 | Socket.IO server — handles real-time collaboration, live editing, and presence |
| **Processor** | 3003 | File processing — handles uploads, image optimization, text extraction |

All three services connect to the same PostgreSQL database. The web service communicates with realtime and processor via internal HTTP.

## Quick Start

\`\`\`bash
# Clone the repository
git clone https://github.com/pagespace/pagespace.git
cd pagespace

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# At minimum, set DATABASE_URL and a JWT_SECRET

# Start with Docker Compose
docker compose up -d
\`\`\`

PageSpace will be available at \`http://localhost:3000\`.

## Section Overview

### [Docker Setup](/docs/self-hosting/docker)

Step-by-step Docker Compose configuration, including PostgreSQL, Redis, and all three PageSpace services.

### [Environment Variables](/docs/self-hosting/environment)

Complete reference for all environment variables: database, auth, AI providers, file storage, and service URLs.

### [Architecture](/docs/self-hosting/architecture)

How the three services communicate, database schema, and scaling considerations.
`;

export default function SelfHostingPage() {
  return <DocsMarkdown content={content} />;
}
