import { logger } from '@/lib/logger';
import { redisConnectionManager } from '@/lib/redis/connection-manager';
import { buildRedisKey } from '@/lib/redis/config';
import { isTrustProxy } from '@/lib/config/env';

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  prefix?: string;
  failClosed?: boolean;
  /** Estimated number of application replicas for emergency limit scaling during Redis outage */
  replicaCount?: number;
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

const IPV4_REGEX = /^(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_REGEX = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$/;

/**
 * Validates whether an input string is a valid IPv4 or IPv6 address.
 */
export function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string' || ip.length > 45) return false;
  const trimmed = ip.trim();
  return IPV4_REGEX.test(trimmed) || IPV6_REGEX.test(trimmed) || trimmed === '::1';
}

export interface GetClientIpOptions {
  /** Explicitly override whether to trust reverse proxy headers */
  trustProxy?: boolean;
  /** Fallback address if no valid client IP can be resolved */
  defaultIp?: string;
}

/**
 * Retrieves client IP with strict reverse proxy verification and spoofing protection.
 *
 * Security directive:
 * - If trustProxy is false (default in untrusted/direct environments), forwarding headers
 *   (x-forwarded-for, x-real-ip, cf-connecting-ip) are ignored to prevent external spoofing.
 * - If trustProxy is true, headers are evaluated in priority order and strictly syntax-validated.
 * - Malformed or injected values are safely mapped to a quarantined 'malformed-ip' bucket.
 */
export function getClientIp(req: Request, options?: GetClientIpOptions): string {
  const defaultIp = options?.defaultIp ?? '127.0.0.1';
  let trustProxy = options?.trustProxy;

  if (trustProxy === undefined) {
    try {
      trustProxy = isTrustProxy();
    } catch {
      trustProxy = false;
    }
  }

  // Untrusted proxy mode: direct client access cannot spoof forwarding headers
  if (!trustProxy) {
    // If client supplied forwarding headers while trustProxy is disabled, ignore them
    const directIp = req.headers.get('x-direct-ip');
    if (directIp && isValidIp(directIp)) {
      return directIp.trim();
    }
    return defaultIp;
  }

  // Trusted proxy mode: inspect Cloudflare, Nginx real-ip, or X-Forwarded-For
  if (req.headers.has('cf-connecting-ip')) {
    const cfConnectingIp = req.headers.get('cf-connecting-ip');
    const trimmed = cfConnectingIp?.trim();
    return trimmed && isValidIp(trimmed) ? trimmed : 'malformed-ip';
  }

  if (req.headers.has('x-real-ip')) {
    const realIp = req.headers.get('x-real-ip');
    const trimmed = realIp?.trim();
    return trimmed && isValidIp(trimmed) ? trimmed : 'malformed-ip';
  }

  if (req.headers.has('x-forwarded-for')) {
    const forwarded = req.headers.get('x-forwarded-for');
    const parts = forwarded ? forwarded.split(',') : [];
    const clientCandidate = parts[0]?.trim();
    if (!clientCandidate) {
      return 'malformed-ip';
    }
    return isValidIp(clientCandidate) ? clientCandidate : 'malformed-ip';
  }

  return defaultIp;
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
  const { windowSeconds, maxRequests, prefix = 'rl', failClosed = false, replicaCount = 1 } = config;
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

  // In multi-replica deployments during Redis outage, scale emergency limits conservatively
  const effectiveFallbackLimit = replicaCount > 1
    ? Math.max(1, Math.floor(maxRequests / replicaCount))
    : maxRequests;

  logger.warn('Enforcing conservative in-memory rate limit due to Redis outage/unavailability', {
    key,
    effectiveFallbackLimit,
    replicaCount,
  });

  return inMemoryLimiter.check(key, effectiveFallbackLimit, windowSeconds);
}
