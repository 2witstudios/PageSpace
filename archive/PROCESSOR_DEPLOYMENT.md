# PageSpace Processor Service Deployment Guide

## 🚀 Quick Start

```bash
# 1. Install dependencies (including processor)
pnpm install

# 2. Build and start all services
docker-compose up --build

# 3. Monitor services
docker stats
```

## 📋 Pre-Deployment Checklist

- [ ] Ensure Docker is installed and running
- [ ] Verify 4GB+ RAM available
- [ ] Check ports 3000, 3001, 3003, 5432 are free
- [ ] Review `.env` file configuration
- [ ] Backup any existing data if upgrading

## 🏗️ Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Web App   │────▶│  Processor   │────▶│   Storage   │
│  (768MB)    │     │   Service    │     │  (Cache +   │
│  Port 3000  │◀────│  (1280MB)    │◀────│   Files)    │
└─────────────┘     │  Port 3003   │     └─────────────┘
                    └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   PG-Boss    │
                    │    Queue     │
                    └──────────────┘
```

## 🔧 Configuration

### Environment Variables (.env)

```bash
# Database
DATABASE_URL=postgresql://user:password@postgres:5432/pagespace

# Processor Service
PROCESSOR_URL=http://processor:3003
FILE_STORAGE_PATH=/data/files
CACHE_PATH=/data/cache

# OCR Configuration (optional)
ENABLE_OCR=false
ENABLE_EXTERNAL_OCR=false

# Memory Limits (Docker)
NODE_OPTIONS_WEB=--max-old-space-size=640
NODE_OPTIONS_PROCESSOR=--max-old-space-size=1024
```

### Memory Configuration

| Service | Memory | Purpose |
|---------|--------|---------|
| PostgreSQL | 200MB | Database |
| Web | 768MB | UI/API serving |
| Processor | 1280MB | File processing |
| Realtime | 256MB | WebSocket |
| Worker | 256MB | Legacy support |
| **Total** | **2.76GB** | ~1.24GB buffer |

## 📦 Service Details

### Processor Service Features

1. **Image Optimization**
   - Automatic resizing for AI models
   - Multiple presets (ai-chat, ai-vision, thumbnail)
   - ContentHash-based deduplication
   - Smart caching system

2. **Text Extraction**
   - PDF processing
   - Word document support
   - JSON/CSV parsing
   - Automatic OCR fallback

3. **Queue Management**
   - Three priority levels
   - Rate limiting for external APIs
   - Concurrent processing control
   - Job status tracking

## 🚀 Deployment Steps

### 1. Initial Setup

```bash
# Clone repository (if not already done)
git clone <repository-url>
cd PageSpace

# Install dependencies
pnpm install

# Create .env file from template
cp .env.example .env
# Edit .env with your configuration
```

### 2. Build Services

```bash
# Build all services
docker-compose build

# Or build specific service
docker-compose build processor
```

### 3. Start Services

```bash
# Start all services (attached mode - see logs)
docker-compose up

# Start in detached mode
docker-compose up -d

# Start with rebuild
docker-compose up --build
```

### 4. Verify Deployment

```bash
# Check service health
curl http://localhost:3000/health      # Web app
curl http://localhost:3003/health      # Processor
curl http://localhost:3001/health      # Realtime

# Monitor resource usage
docker stats

# View logs
docker-compose logs -f processor       # Processor logs
docker-compose logs -f web            # Web app logs

# Check queue status
curl http://localhost:3003/api/queue/status
```

## 🔍 Monitoring

### Key Metrics to Watch

1. **Memory Usage**
   ```bash
   docker stats --format "table {{.Container}}\t{{.MemUsage}}\t{{.MemPerc}}"
   ```

2. **Queue Depth**
   ```bash
   curl http://localhost:3003/api/queue/status | jq
   ```

3. **Cache Hit Rate**
   - Monitor processor logs for "Cache hit" messages
   - Check cache directory size: `du -sh /data/cache`

### Alert Thresholds

- Memory usage > 90% for any service
- Queue depth > 100 pending jobs
- Processing time > 30s for single file
- Failed jobs > 5% of total

## 🐛 Troubleshooting

### Common Issues

#### 1. Out of Memory Errors

**Symptoms**: Service crashes, "JavaScript heap out of memory"

**Solutions**:
```bash
# Increase memory limits in docker-compose.yml
services:
  processor:
    deploy:
      resources:
        limits:
          memory: 1536M  # Increase from 1280M

# Adjust NODE_OPTIONS
NODE_OPTIONS=--max-old-space-size=1280
```

#### 2. Processor Service Unreachable

**Symptoms**: "Failed to fetch" errors in web app

**Solutions**:
```bash
# Check processor is running
docker-compose ps processor

# Check network connectivity
docker exec web ping processor

# Restart processor
docker-compose restart processor
```

#### 3. Slow Processing

**Symptoms**: Files take long to process

**Solutions**:
```bash
# Check queue status
curl http://localhost:3003/api/queue/status

# Clear old cache
docker exec processor rm -rf /data/cache/*

# Increase concurrent workers (edit queue-manager.ts)
```

### Debug Commands

```bash
# Enter processor container
docker exec -it pagespace-processor-1 sh

# Check disk usage
df -h

# View processor logs
docker-compose logs --tail=100 processor

# Check database connections
docker exec postgres psql -U user -d pagespace -c "SELECT count(*) FROM pg_stat_activity;"
```

## 🔄 Maintenance

### Daily Tasks

```bash
# Check service health
docker-compose ps

# Monitor disk usage
df -h /var/lib/docker
```

### Weekly Tasks

```bash
# Clean old cache (automatic, but can force)
curl -X POST http://localhost:3003/api/cache/cleanup

# Backup database
docker exec postgres pg_dump -U user pagespace > backup.sql

# Update Docker images
docker-compose pull
```

### Updates

```bash
# Pull latest code
git pull

# Update dependencies
pnpm install

# Rebuild and restart
docker-compose down
docker-compose up --build
```

## 🔐 Security Considerations

1. **Network Isolation**
   - Processor service only accessible internally
   - No direct external access to file storage

2. **File Validation**
   - ContentHash verification
   - MIME type checking
   - Size limits enforced

3. **Resource Limits**
   - Memory caps prevent runaway processes
   - Queue limits prevent DoS
   - Rate limiting on external APIs

## 📊 Performance Tuning

### For 4GB VPS

```yaml
# Optimized docker-compose.yml settings
services:
  web:
    deploy:
      resources:
        limits:
          memory: 768M
    environment:
      - NODE_OPTIONS=--max-old-space-size=640
      
  processor:
    deploy:
      resources:
        limits:
          memory: 1280M
    environment:
      - NODE_OPTIONS=--max-old-space-size=1024
```

### For Larger Deployments (8GB+)

```yaml
# Scale up processor
processor:
  deploy:
    resources:
      limits:
        memory: 3072M
    environment:
      - NODE_OPTIONS=--max-old-space-size=2560
```

## 🎯 Success Indicators

- ✅ All services show "healthy" status
- ✅ Memory usage stable below 80%
- ✅ Queue processing time < 10s average
- ✅ Cache hit rate > 50%
- ✅ No OOM errors in logs
- ✅ Response time < 2s for cached content

## 📚 Additional Resources

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [PG-Boss Queue Documentation](https://github.com/timgit/pg-boss)
- [Sharp Image Processing](https://sharp.pixelplumbing.com/)
- [Node.js Memory Management](https://nodejs.org/en/docs/guides/diagnostics/memory)

## 🆘 Support

If you encounter issues:

1. Check this documentation
2. Review service logs: `docker-compose logs [service-name]`
3. Check GitHub issues for similar problems
4. Create a new issue with:
   - Error messages
   - `docker stats` output
   - Relevant log excerpts
   - Steps to reproduce