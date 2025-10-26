# NOIP Platform - Production Dockerfile
# Multi-stage build with security hardening and optimization

# --------------------------------------------------------------------------
# Stage 1: Base Dependencies
# --------------------------------------------------------------------------
FROM node:18-alpine AS base
LABEL maintainer="NOIP Platform Team" \
      version="1.0.0" \
      description="NOIP Platform - Production Build"

# Install security updates and system dependencies
RUN apk update && \
    apk upgrade && \
    apk add --no-cache \
        curl \
        dumb-init \
        ca-certificates \
        tzdata && \
    rm -rf /var/cache/apk/*

# Set timezone
ENV TZ=UTC

# Create app user with minimal privileges
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# --------------------------------------------------------------------------
# Stage 2: Dependencies Installation
# --------------------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies with security audit
RUN npm ci --only=production && \
    npm cache clean --force && \
    npx audit-ci --moderate

# --------------------------------------------------------------------------
# Stage 3: Build Stage
# --------------------------------------------------------------------------
FROM deps AS builder
COPY . .

# Create non-root build directory
RUN mkdir -p /app/build && \
    chown -R nodejs:nodejs /app

# Build TypeScript application
RUN npm run build

# --------------------------------------------------------------------------
# Stage 4: Production Runtime
# --------------------------------------------------------------------------
FROM base AS runtime

# Security labels
LABEL security.scan="enabled" \
      security.policy="production" \
      security.runtime="non-root"

# Install runtime security monitoring
RUN apk add --no-cache \
        curl \
        jq && \
    rm -rf /var/cache/apk/*

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Create necessary directories
RUN mkdir -p /app/logs /app/tmp && \
    chown -R nodejs:nodejs /app/logs /app/tmp

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=UTC

# Health check with comprehensive validation
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Graceful shutdown handler
STOPSIGNAL SIGTERM

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "dist/app.js"]