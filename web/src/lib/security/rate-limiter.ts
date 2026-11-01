import { logger } from '@/lib/logger';
import { redisConnectionManager } from '@/lib/redis/connection-manager';
import { buildRedisKey } from '@/lib/redis/config';

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  prefix?: string;
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  source: 'redis' | 'memory-fallback';
}

interface MemoryEntry {
  count: number;
  resetAt: number; // Unix timestamp ms
}

export class InMemoryRateLimiter {
  private store = new Map<string, MemoryEntry>();
  private lastCleanup = Date.now();

  check(key: string, maxRequests: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    this.cleanupIfNeeded(now);

    const entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      const resetAt = now + windowSeconds * 1000;
      this.store.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        limit: maxRequests,
        remaining: maxRequests - 1,
        resetSeconds: windowSeconds,
        source: 'memory-fallback',
      };
    }

    if (entry.count >= maxRequests) {
      const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      return {
        allowed: false,
        limit: maxRequests,
        remaining: 0,
        resetSeconds,
        source: 'memory-fallback',
      };
    }

    entry.count += 1;
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return {
      allowed: true,
      limit: maxRequests,
      remaining: maxRequests - entry.count,
      resetSeconds,
      source: 'memory-fallback',
    };
  }

  reset(): void {
    this.store.clear();
  }

  private cleanupIfNeeded(now: number): void {
    if (now - this.lastCleanup > 60_000) {
      this.lastCleanup = now;
      for (const [k, v] of this.store.entries()) {
        if (now > v.resetAt) {
          this.store.delete(k);
        }
      }
    }
  }
}

export const inMemoryLimiter = new InMemoryRateLimiter();

/**
 * Retrieves client IP from standard reverse proxy headers.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return '127.0.0.1';
}

/**
 * Checks and increments rate limit counter for an identifier.
 * Uses Redis when connected. Falls back to in-memory limiter during outages
 * to prevent silent removal of security protections.
 */
export async function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const { windowSeconds, maxRequests, prefix = 'rl', failClosed = false } = config;
  const key = `${prefix}:${identifier}`;

  try {
    const client = redisConnectionManager.getClient();
    if (client && redisConnectionManager.getConnectionState().connected) {
      const redisKey = buildRedisKey(key);
      const pipeline = client.pipeline();
      pipeline.incr(redisKey);
      pipeline.ttl(redisKey);
      const results = await pipeline.exec();

      if (results && results[0] && results[1]) {
        const [err1, countVal] = results[0];
        const [err2, ttlVal] = results[1];

        if (!err1 && !err2 && typeof countVal === 'number' && typeof ttlVal === 'number') {
          let ttl = ttlVal;
          if (ttl === -1) {
            // First increment without TTL, establish expiration
            await client.expire(redisKey, windowSeconds);
            ttl = windowSeconds;
          }

          const allowed = countVal <= maxRequests;
          const remaining = Math.max(0, maxRequests - countVal);
          const resetSeconds = ttl > 0 ? ttl : windowSeconds;

          return {
            allowed,
            limit: maxRequests,
            remaining,
            resetSeconds,
            source: 'redis',
          };
        }
      }
    }
  } catch (error) {
    logger.warn('Redis rate-limiter failed, evaluating fallback behavior', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Redis outage, unconfigured, or errored
  if (failClosed) {
    logger.error('Redis unavailable and failClosed is true; rejecting sensitive request', { key });
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      resetSeconds: windowSeconds,
      source: 'memory-fallback',
    };
  }

  logger.warn('Enforcing conservative in-memory rate limit due to Redis outage/unavailability', { key });
  return inMemoryLimiter.check(key, maxRequests, windowSeconds);
}
