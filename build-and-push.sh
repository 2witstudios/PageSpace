#!/bin/bash

# PageSpace - Build and Push to GitHub Container Registry
# Repository: 2witstudios/PageSpace

set -e  # Exit on any error

USERNAME="2witstudios"
REPO="pagespace"

echo "🔨 Building PageSpace Docker images..."

# Build all services
echo "Building migrate service..."
docker build -f apps/web/Dockerfile.migrate -t ghcr.io/$USERNAME/$REPO-migrate:latest .

echo "Building web service..."
docker build -f apps/web/Dockerfile -t ghcr.io/$USERNAME/$REPO-web:latest .

echo "Building realtime service..."
docker build -f apps/realtime/Dockerfile -t ghcr.io/$USERNAME/$REPO-realtime:latest .

echo "✅ All images built successfully!"

echo "🚀 Pushing to GitHub Container Registry..."

# Push to GitHub Container Registry
docker push ghcr.io/$USERNAME/$REPO-migrate:latest
docker push ghcr.io/$USERNAME/$REPO-web:latest
docker push ghcr.io/$USERNAME/$REPO-realtime:latest

echo "✅ All images pushed successfully!"
echo ""
echo "Images available at:"
echo "  - ghcr.io/$USERNAME/$REPO-migrate:latest"
echo "  - ghcr.io/$USERNAME/$REPO-web:latest"
echo "  - ghcr.io/$USERNAME/$REPO-realtime:latest"