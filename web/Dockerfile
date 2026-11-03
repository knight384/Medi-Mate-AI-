# Multi-stage Hardened Production Dockerfile for MediMate AI Web Application

# Stage 1: Dependency Installation
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY scripts ./scripts/

RUN npm ci --ignore-scripts && \
    node scripts/patch-zod.cjs && \
    npx prisma generate

# Stage 2: Application Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Stage 3: Hardened Runtime Container
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Non-root user configuration (UID 10001)
RUN addgroup --system --gid 10001 nodejs && \
    adduser --system --uid 10001 nextjs

# Scratch directory with non-root ownership
RUN mkdir -p /tmp/scratch && chown -R nextjs:nodejs /tmp/scratch && chmod 700 /tmp/scratch

# Copy required production assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs:nodejs

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health/live || exit 1

CMD ["npm", "run", "start"]
