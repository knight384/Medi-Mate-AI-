import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkRateLimit,
  InMemoryRateLimiter,
  getClientIp,
} from './rate-limiter';
import { redisConnectionManager } from '@/lib/redis/connection-manager';

describe('InMemoryRateLimiter', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
  });

  it('allows requests within capacity', () => {
    const res1 = limiter.check('test-user', 3, 60);
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);
    expect(res1.limit).toBe(3);
    expect(res1.source).toBe('memory-fallback');

    const res2 = limiter.check('test-user', 3, 60);
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = limiter.check('test-user', 3, 60);
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);
  });

  it('blocks requests exceeding limit', () => {
    limiter.check('test-user', 2, 60);
    limiter.check('test-user', 2, 60);

    const blocked = limiter.check('test-user', 2, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetSeconds).toBeGreaterThan(0);
  });

  it('resets after window expiration', () => {
    vi.useFakeTimers();
    try {
      limiter.check('expiring-user', 1, 10);
      const blocked = limiter.check('expiring-user', 1, 10);
      expect(blocked.allowed).toBe(false);

      // Advance past window (11 seconds)
      vi.advanceTimersByTime(11_000);

      const afterExpiry = limiter.check('expiring-user', 1, 10);
      expect(afterExpiry.allowed).toBe(true);
      expect(afterExpiry.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkRateLimit with Redis and Outage Fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses Redis pipeline when Redis is connected', async () => {
    const mockExec = vi.fn().mockResolvedValue([
      [null, 2], // count
      [null, 55], // ttl
    ]);
    const mockPipeline = {
      incr: vi.fn().mockReturnThis(),
      ttl: vi.fn().mockReturnThis(),
      exec: mockExec,
    };
    const mockClient = {
      pipeline: vi.fn().mockReturnValue(mockPipeline),
      expire: vi.fn().mockResolvedValue(1),
    };

    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(mockClient as unknown as ReturnType<typeof redisConnectionManager.getClient>);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: true,
      lastError: null,
      reconnectAttempts: 0,
    });

    const result = await checkRateLimit('user-1', {
      maxRequests: 5,
      windowSeconds: 60,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
    expect(result.source).toBe('redis');
    expect(mockPipeline.incr).toHaveBeenCalled();
  });

  it('falls back to in-memory limiter when Redis is disconnected without throwing', async () => {
    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(null);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: false,
      lastError: 'Connection refused',
      reconnectAttempts: 3,
    });

    const result = await checkRateLimit('fallback-user-1', {
      maxRequests: 2,
      windowSeconds: 60,
      prefix: 'outage-test',
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe('memory-fallback');
    expect(result.remaining).toBe(1);

    const result2 = await checkRateLimit('fallback-user-1', {
      maxRequests: 2,
      windowSeconds: 60,
      prefix: 'outage-test',
    });
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(0);

    // 3rd attempt should be blocked even during Redis outage
    const result3 = await checkRateLimit('fallback-user-1', {
      maxRequests: 2,
      windowSeconds: 60,
      prefix: 'outage-test',
    });
    expect(result3.allowed).toBe(false);
  });

  it('falls back to in-memory limiter when Redis pipeline throws an error', async () => {
    const mockPipeline = {
      incr: vi.fn().mockReturnThis(),
      ttl: vi.fn().mockReturnThis(),
      exec: vi.fn().mockRejectedValue(new Error('Redis timeout error')),
    };
    const mockClient = {
      pipeline: vi.fn().mockReturnValue(mockPipeline),
    };

    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(mockClient as unknown as ReturnType<typeof redisConnectionManager.getClient>);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: true,
      lastError: null,
      reconnectAttempts: 0,
    });

    const result = await checkRateLimit('error-user', {
      maxRequests: 5,
      windowSeconds: 60,
      prefix: 'err-test',
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe('memory-fallback');
  });

  it('respects failClosed: true on Redis outage', async () => {
    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(null);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: false,
      lastError: 'Connection refused',
      reconnectAttempts: 1,
    });

    const result = await checkRateLimit('fail-closed-user', {
      maxRequests: 5,
      windowSeconds: 60,
      failClosed: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe('getClientIp & Proxy Spoofing Defense', () => {
  it('ignores client-sent x-forwarded-for when trustProxy is disabled (spoofing protection)', () => {
    const req = new Request('http://localhost', {
      headers: {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18',
        'x-real-ip': '198.51.100.4',
        'cf-connecting-ip': '1.1.1.1',
      },
    });

    // Untrusted mode (default): direct external client cannot spoof its IP
    expect(getClientIp(req, { trustProxy: false })).toBe('127.0.0.1');
  });

  it('honors forwarding headers only when explicitly configured with trustProxy: true', () => {
    const req = new Request('http://localhost', {
      headers: {
        'cf-connecting-ip': '198.51.100.25',
      },
    });
    expect(getClientIp(req, { trustProxy: true })).toBe('198.51.100.25');

    const reqXff = new Request('http://localhost', {
      headers: {
        'x-forwarded-for': '203.0.113.50, 10.0.0.1',
      },
    });
    expect(getClientIp(reqXff, { trustProxy: true })).toBe('203.0.113.50');
  });

  it('rejects malformed and injection-laden IP headers into quarantined malformed-ip bucket', () => {
    const maliciousHeaders = [
      '192.168.1.999', // invalid octet
      '203.0.113.1; DROP TABLE users;', // SQL injection
      '<script>alert(1)</script>', // XSS
      '../../etc/passwd', // path traversal
      'not-an-ip-address', // garbage string
      '   ', // whitespace only
    ];

    for (const badIp of maliciousHeaders) {
      const req = new Request('http://localhost', {
        headers: { 'x-forwarded-for': badIp },
      });
      expect(getClientIp(req, { trustProxy: true })).toBe('malformed-ip');
    }
  });

  it('validates IPv6 and loopback addresses properly', () => {
    const reqIpv6 = new Request('http://localhost', {
      headers: { 'x-real-ip': '::1' },
    });
    expect(getClientIp(reqIpv6, { trustProxy: true })).toBe('::1');
  });

  it('defaults to safe fallback when no headers are present', () => {
    const req = new Request('http://localhost');
    expect(getClientIp(req, { trustProxy: true, defaultIp: '10.0.0.99' })).toBe('10.0.0.99');
  });
});

describe('Multi-Replica Scaling & Redis Reconnection Scenarios', () => {
  it('applies conservative per-instance limits across multi-replica cluster during Redis outage', async () => {
    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(null);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: false,
      lastError: 'Redis cluster offline',
      reconnectAttempts: 3,
    });

    // 3 replicas configured; total global budget is 6 requests.
    // Each replica should enforce conservative emergency budget of 6 / 3 = 2 requests.
    const config = {
      maxRequests: 6,
      windowSeconds: 60,
      replicaCount: 3,
      prefix: 'replica-test',
    };

    const res1 = await checkRateLimit('user-rep', config);
    expect(res1.allowed).toBe(true);
    expect(res1.limit).toBe(2);

    const res2 = await checkRateLimit('user-rep', config);
    expect(res2.allowed).toBe(true);

    const res3 = await checkRateLimit('user-rep', config);
    expect(res3.allowed).toBe(false); // Blocked after 2 requests on this instance
    expect(res3.source).toBe('memory-fallback');
  });
});
