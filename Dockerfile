services:
  postgres:
    image: postgres:17.5-alpine
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-pagespace}
      POSTGRES_USER: ${POSTGRES_USER:-user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-password}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-user} -d ${POSTGRES_DB:-pagespace}"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 200M
    networks:
      - internal

  migrate:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-migrate:latest
    depends_on:
      postgres:
        condition: service_healthy
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-user}:${POSTGRES_PASSWORD:-password}@postgres:5432/${POSTGRES_DB:-pagespace}
      PNPM_HOME: /usr/local/bin
    command: >
      sh -c "
        echo 'Starting database migrations...' &&
        pnpm run db:migrate &&
        echo 'Migrations complete, starting services...'
      "
    healthcheck:
      test: ["CMD", "echo", "Migration service healthy"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - internal

  # Permission fixer - runs once to fix existing volume permissions
  processor-permissions:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-processor:latest
    user: root
    volumes:
      - file_storage:/data/files
      - cache_storage:/data/cache
    command: |
      sh -c '
        echo "Fixing volume permissions..."
        chown -R 1000:1000 /data/files /data/cache
        echo "Permissions fixed successfully"
      '
    restart: "no"
    networks:
      - internal

  processor:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-processor:latest
    restart: unless-stopped
    expose:
      - "3003"
    depends_on:
      migrate:
        condition: service_completed_successfully
      postgres:
        condition: service_healthy
      processor-permissions:
        condition: service_completed_successfully
    volumes:
      - file_storage:/data/files
      - cache_storage:/data/cache
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-user}:${POSTGRES_PASSWORD:-password}@postgres:5432/${POSTGRES_DB:-pagespace}
      FILE_STORAGE_PATH: /data/files
      CACHE_PATH: /data/cache
      PORT: 3003
      NODE_OPTIONS: --max-old-space-size=1024
      ENABLE_OCR: ${ENABLE_OCR:-false}
      ENABLE_EXTERNAL_OCR: ${ENABLE_EXTERNAL_OCR:-false}
      GOOGLE_AI_DEFAULT_API_KEY: ${GOOGLE_AI_DEFAULT_API_KEY}
      STORAGE_DEFAULT_QUOTA_MB: ${STORAGE_DEFAULT_QUOTA_MB:-500}
      STORAGE_MAX_FILE_SIZE_MB: ${STORAGE_MAX_FILE_SIZE_MB:-20}
      STORAGE_MAX_CONCURRENT_UPLOADS: ${STORAGE_MAX_CONCURRENT_UPLOADS:-5}
      STORAGE_MIN_FREE_MEMORY_MB: ${STORAGE_MIN_FREE_MEMORY_MB:-500}
      STORAGE_ENABLE_QUOTAS: ${STORAGE_ENABLE_QUOTAS:-true}
      PROCESSOR_AUTH_REQUIRED: ${PROCESSOR_AUTH_REQUIRED:-true}
      PROCESSOR_UPLOAD_RATE_LIMIT: ${PROCESSOR_UPLOAD_RATE_LIMIT:-100}
      PROCESSOR_UPLOAD_RATE_WINDOW: ${PROCESSOR_UPLOAD_RATE_WINDOW:-3600}
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3003/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          memory: 1280M
    user: "1000:1000"
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=100m
    security_opt:
      - no-new-privileges:true
    networks:
      - internal

  web:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-web:latest
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${PORT:-3000}:3000"
    depends_on:
      migrate:
        condition: service_completed_successfully
      processor:
        condition: service_healthy
    volumes:
      - file_storage:/app/storage
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-user}:${POSTGRES_PASSWORD:-password}@postgres:5432/${POSTGRES_DB:-pagespace}
      NEXT_PUBLIC_REALTIME_URL: ${NEXT_PUBLIC_REALTIME_URL}
      FILE_STORAGE_PATH: /app/storage
      PROCESSOR_URL: http://processor:3003
      CRON_SECRET: ${CRON_SECRET}
      PORT: 3000
      HOSTNAME: 0.0.0.0
      NODE_OPTIONS: --max-old-space-size=640
      # Managed AI provider keys (per-user BYOK retired in PR #1191).
      # Set the env vars for each provider you want enabled in production;
      # anything left unset shows up as Unavailable in the model picker
      # and is rejected by /api/ai/settings PATCH with 503.
      GLM_DEFAULT_API_KEY: ${GLM_DEFAULT_API_KEY}
      GOOGLE_AI_DEFAULT_API_KEY: ${GOOGLE_AI_DEFAULT_API_KEY}
      OPENROUTER_DEFAULT_API_KEY: ${OPENROUTER_DEFAULT_API_KEY}
      ANTHROPIC_DEFAULT_API_KEY: ${ANTHROPIC_DEFAULT_API_KEY}
      OPENAI_DEFAULT_API_KEY: ${OPENAI_DEFAULT_API_KEY}
      XAI_DEFAULT_API_KEY: ${XAI_DEFAULT_API_KEY}
      GLM_CODER_DEFAULT_API_KEY: ${GLM_CODER_DEFAULT_API_KEY}
      MINIMAX_DEFAULT_API_KEY: ${MINIMAX_DEFAULT_API_KEY}
      AZURE_OPENAI_API_KEY: ${AZURE_OPENAI_API_KEY}
      AZURE_OPENAI_ENDPOINT: ${AZURE_OPENAI_ENDPOINT}
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL}
      LMSTUDIO_BASE_URL: ${LMSTUDIO_BASE_URL}
      STORAGE_DEFAULT_QUOTA_MB: ${STORAGE_DEFAULT_QUOTA_MB:-500}
      STORAGE_MAX_FILE_SIZE_MB: ${STORAGE_MAX_FILE_SIZE_MB:-20}
      STORAGE_MAX_CONCURRENT_UPLOADS: ${STORAGE_MAX_CONCURRENT_UPLOADS:-5}
      STORAGE_MIN_FREE_MEMORY_MB: ${STORAGE_MIN_FREE_MEMORY_MB:-500}
      STORAGE_ENABLE_QUOTAS: ${STORAGE_ENABLE_QUOTAS:-true}
      NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB: ${NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB:-20}
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET}
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: ${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}
      STRIPE_PRICE_ID_PRO: ${STRIPE_PRICE_ID_PRO}
      STRIPE_PRICE_ID_FOUNDER: ${STRIPE_PRICE_ID_FOUNDER}
      STRIPE_PRICE_ID_BUSINESS: ${STRIPE_PRICE_ID_BUSINESS}
      NEXT_PUBLIC_STRIPE_PRICE_ID_PRO: ${NEXT_PUBLIC_STRIPE_PRICE_ID_PRO}
      NEXT_PUBLIC_STRIPE_PRICE_ID_FOUNDER: ${NEXT_PUBLIC_STRIPE_PRICE_ID_FOUNDER}
      NEXT_PUBLIC_STRIPE_PRICE_ID_BUSINESS: ${NEXT_PUBLIC_STRIPE_PRICE_ID_BUSINESS}
      NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL}
      NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: ${NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID}
    deploy:
      resources:
        limits:
          memory: 768M
    networks:
      - internal
      - frontend

  cron:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-cron:latest
    restart: unless-stopped
    depends_on:
      web:
        condition: service_started
    environment:
      CRON_SECRET: ${CRON_SECRET}
    networks:
      - internal

  marketing:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-marketing:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3004:3004"
    environment:
      PORT: 3004
      NEXT_PUBLIC_MARKETING_URL: https://pagespace.ai
      NEXT_PUBLIC_APP_URL: https://pagespace.ai
      NEXT_PUBLIC_COOKIE_DOMAIN: .pagespace.ai
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: ${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
      NEXT_PUBLIC_ENABLE_ONE_TAP: "true"
      RESEND_API_KEY: ${RESEND_API_KEY}
      FROM_EMAIL: ${FROM_EMAIL:-noreply@pagespace.ai}
      NODE_ENV: production
    deploy:
      resources:
        limits:
          memory: 256M
    networks:
      - frontend

  realtime:
    image: ghcr.io/${GITHUB_USERNAME}/pagespace-realtime:latest
    restart: unless-stopped
    ports:
      - "${REALTIME_PORT:-3001}:3001"
    depends_on:
      migrate:
        condition: service_completed_successfully
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-user}:${POSTGRES_PASSWORD:-password}@postgres:5432/${POSTGRES_DB:-pagespace}
      PORT: ${REALTIME_PORT:-3001}
      CORS_ORIGIN: ${WEB_APP_URL:-http://localhost:3000}
    deploy:
      resources:
        limits:
          memory: 256M
    networks:
      - internal
      - frontend

networks:
  internal:
    driver: bridge
    internal: true
  frontend:
    driver: bridge

volumes:
  postgres_data:
  file_storage:
  cache_storage: