#!/bin/bash

# PageSpace - Build and Push to GitHub Container Registry
# Repository: 2witstudios/PageSpace
#
# Builds linux/amd64 images for production deployment
#
# Usage:
#   Export required environment variables before running:
#   export NEXT_PUBLIC_REALTIME_URL=http://localhost:3001
#   export OPENROUTER_DEFAULT_API_KEY=your_api_key_here
#   ./build-and-push.sh
#
# Or source from .env file:
#   source .env && ./build-and-push.sh

set -e  # Exit on any error

USERNAME="2witstudios"
REPO="pagespace"

echo "🔨 Building PageSpace Docker images..."

# Build all services
echo "Building migrate service..."
docker build --platform linux/amd64 -f apps/web/Dockerfile.migrate -t ghcr.io/$USERNAME/$REPO-migrate:latest .

echo "Building web service..."
# Pass environment variables as build arguments
docker build --platform linux/amd64 -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_REALTIME_URL="${NEXT_PUBLIC_REALTIME_URL}" \
  --build-arg OPENROUTER_DEFAULT_API_KEY="${OPENROUTER_DEFAULT_API_KEY}" \
  -t ghcr.io/$USERNAME/$REPO-web:latest .

echo "Building realtime service..."
docker build --platform linux/amd64 -f apps/realtime/Dockerfile -t ghcr.io/$USERNAME/$REPO-realtime:latest .

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