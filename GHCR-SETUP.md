# GitHub Container Registry Setup

## 1. Authentication Setup

### Create GitHub Personal Access Token
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Select scopes:
   - `write:packages` (to push images)
   - `read:packages` (to pull images)
   - `delete:packages` (optional, to delete images)
4. Copy the token

### Login to GHCR on Local Machine
```bash
echo "YOUR_GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

### Login to GHCR on VPS Server
```bash
echo "YOUR_GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

## 2. Usage Workflow

### On Local Machine (Build & Push)
```bash
# Build and push all images using buildx
docker buildx build --platform linux/amd64 -f apps/web/Dockerfile.migrate -t ghcr.io/2witstudios/pagespace-migrate:latest --push .
docker buildx build --platform linux/amd64 -f apps/web/Dockerfile -t ghcr.io/2witstudios/pagespace-web:latest --push . --build-arg NEXT_PUBLIC_REALTIME_URL="${NEXT_PUBLIC_REALTIME_URL}" --build-arg OPENROUTER_DEFAULT_API_KEY="${OPENROUTER_DEFAULT_API_KEY}"
docker buildx build --platform linux/amd64 -f apps/realtime/Dockerfile -t ghcr.io/2witstudios/pagespace-realtime:latest --push .

# Or build and push separately
docker build -f apps/web/Dockerfile.migrate -t ghcr.io/2witstudios/pagespace-migrate:latest .
docker build -f apps/web/Dockerfile -t ghcr.io/2witstudios/pagespace-web:latest .
docker build -f apps/realtime/Dockerfile -t ghcr.io/2witstudios/pagespace-realtime:latest .

docker push ghcr.io/2witstudios/pagespace-migrate:latest
docker push ghcr.io/2witstudios/pagespace-web:latest
docker push ghcr.io/2witstudios/pagespace-realtime:latest
```

### On VPS Server (Deploy)
```bash
# Pull latest images and deploy
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# Or force recreate containers
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

## 3. Image Management

### List Images
```bash
docker images | grep ghcr.io/2witstudios/pagespace
```

### Remove Local Images (save space)
```bash
docker rmi ghcr.io/2witstudios/pagespace-migrate:latest
docker rmi ghcr.io/2witstudios/pagespace-web:latest
docker rmi ghcr.io/2witstudios/pagespace-realtime:latest
```

### Check Image Sizes
```bash
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | grep pagespace
```

## 4. Troubleshooting

### Authentication Issues
- Ensure token has correct permissions
- Check token expiration
- Re-login if needed

### Image Not Found
- Verify image was pushed successfully
- Check image name spelling
- Ensure repository visibility settings

### Build Issues
- Ensure Docker daemon is running
- Check Dockerfile paths
- Verify build context (current directory)

## 5. Repository Images

Your images will be available at:
- `ghcr.io/2witstudios/pagespace-migrate:latest`
- `ghcr.io/2witstudios/pagespace-web:latest`
- `ghcr.io/2witstudios/pagespace-realtime:latest`

View them at: https://github.com/2witstudios/PageSpace/pkgs/container