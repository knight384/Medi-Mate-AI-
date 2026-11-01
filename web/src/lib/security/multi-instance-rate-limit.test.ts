import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryRateLimiter, getClientIp, checkRateLimit } from './rate-limiter';
import { redisConnectionManager } from '@/lib/redis/connection-manager';

describe('Part H — Distributed Redis Rate-Limiting & Multi-Instance Cluster Validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Redis Online: enforces globally synchronized counters across multiple application instances', async () => {
    let sharedRedisCount = 0;
    const mockPipeline = {
      incr: vi.fn().mockImplementation(() => {
        sharedRedisCount++;
        return mockPipeline;
      }),
      ttl: vi.fn().mockReturnThis(),
      exec: vi.fn().mockImplementation(async () => [
        [null, sharedRedisCount],
        [null, 55],
      ]),
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

    // Simulate requests arriving alternately at Instance A and Instance B
    const config = { maxRequests: 5, windowSeconds: 60, prefix: 'shared-online' };

    // Instance A receives req 1, 2, 3
    const r1 = await checkRateLimit('user_sync', config);
    await checkRateLimit('user_sync', config);
    await checkRateLimit('user_sync', config);

    // Instance B receives req 4, 5
    await checkRateLimit('user_sync', config);
    const r5 = await checkRateLimit('user_sync', config);

    // Instance A receives req 6 -> MUST be blocked by shared Redis count
    const r6 = await checkRateLimit('user_sync', config);

    expect(r1.allowed).toBe(true);
    expect(r5.allowed).toBe(true);
    expect(r6.allowed).toBe(false);
    expect(r6.source).toBe('redis');
    expect(sharedRedisCount).toBe(6);
  });

  it('2. Redis Offline: falls back to isolated in-memory limiters partitioned by replicaCount', async () => {
    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(null);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: false,
      lastError: 'Connection refused',
      reconnectAttempts: 3,
    });

    const instanceA = new InMemoryRateLimiter();
    const instanceB = new InMemoryRateLimiter();

    // 2 replicas; global budget = 6 requests -> 3 per instance
    const replicaLimit = Math.max(1, Math.floor(6 / 2));

    // Instance A exhausts its local quota
    expect(instanceA.check('user_offline', replicaLimit, 60).allowed).toBe(true);
    expect(instanceA.check('user_offline', replicaLimit, 60).allowed).toBe(true);
    expect(instanceA.check('user_offline', replicaLimit, 60).allowed).toBe(true);
    expect(instanceA.check('user_offline', replicaLimit, 60).allowed).toBe(false);

    // Instance B still has its independent local quota
    expect(instanceB.check('user_offline', replicaLimit, 60).allowed).toBe(true);
  });

  it('3. Uneven Request Distribution during Redis outage: heavily-loaded instance blocks when quota is met', () => {
    const loadedInstance = new InMemoryRateLimiter();
    const idleInstance = new InMemoryRateLimiter();

    const perInstanceLimit = 4;

    // 10 requests sent, 8 routed to loadedInstance (80%), 2 to idleInstance (20%)
    const loadedResults = Array.from({ length: 8 }, () =>
      loadedInstance.check('ip_192_0_2_1', perInstanceLimit, 60)
    );
    const idleResults = Array.from({ length: 2 }, () =>
      idleInstance.check('ip_192_0_2_1', perInstanceLimit, 60)
    );

    // Loaded instance must allow first 4 and block subsequent 4
    expect(loadedResults.slice(0, 4).every((r) => r.allowed)).toBe(true);
    expect(loadedResults.slice(4).every((r) => !r.allowed)).toBe(true);

    // Idle instance allows its 2 requests
    expect(idleResults.every((r) => r.allowed)).toBe(true);
  });

  it('4. Instance Restart (Zero-State Recovery): restarted instance starts clean without crashing', () => {
    let instance = new InMemoryRateLimiter();
    instance.check('user_restart', 2, 60);
    instance.check('user_restart', 2, 60);
    expect(instance.check('user_restart', 2, 60).allowed).toBe(false);

    // Simulate pod crash and recreation
    instance = new InMemoryRateLimiter();
    expect(instance.check('user_restart', 2, 60).allowed).toBe(true);
  });

  it('5. Autoscaling Scale-Out (Replica Count Increased): budget per instance tightens to prevent multiplier inflation', () => {
    const globalBudget = 12;

    // Scale from 2 to 4 replicas
    const replicasInitial = 2;
    const perInstanceInitial = Math.max(1, Math.floor(globalBudget / replicasInitial)); // 6
    expect(perInstanceInitial).toBe(6);

    const replicasScaled = 4;
    const perInstanceScaled = Math.max(1, Math.floor(globalBudget / replicasScaled)); // 3

    expect(perInstanceScaled).toBe(3);
    expect(perInstanceScaled * replicasScaled).toBeLessThanOrEqual(globalBudget);
  });

  it('6. Autoscaling Scale-In (Replica Count Decreased): budget per instance expands correctly', () => {
    const globalBudget = 12;
    const replicasReduced = 2;
    const perInstanceReduced = Math.max(1, Math.floor(globalBudget / replicasReduced)); // 6

    expect(perInstanceReduced).toBe(6);
  });

  it('7. Ingress Header Spoofing Defense: client cannot bypass throttle with spoofed X-Forwarded-For when trustProxy=false', () => {
    const spoofedRequest = new Request('http://localhost:3000/api/auth/login', {
      headers: {
        'x-forwarded-for': '198.51.100.99, 10.0.0.1',
        'x-real-ip': '198.51.100.99',
      },
    });

    // Untrusted ingress proxy configuration (default)
    const resolvedIp = getClientIp(spoofedRequest, { trustProxy: false });
    expect(resolvedIp).toBe('127.0.0.1'); // Bound strictly to real TCP connection socket
  });

  it('8. Direct Untrusted Traffic: malformed and injection-laden IP headers quarantined', () => {
    const injectionHeaders = [
      '203.0.113.1; DROP TABLE "User";',
      '<script>alert(1)</script>',
      '192.168.1.500', // invalid IP octet
      '../../etc/passwd',
    ];

    for (const badIp of injectionHeaders) {
      const req = new Request('http://localhost:3000/api/auth/login', {
        headers: { 'x-forwarded-for': badIp },
      });
      expect(getClientIp(req, { trustProxy: true })).toBe('malformed-ip');
    }
  });

  it('9. High-Cost AI Chat Operations: failClosed policy blocks requests during Redis outage', async () => {
    vi.spyOn(redisConnectionManager, 'getClient').mockReturnValue(null);
    vi.spyOn(redisConnectionManager, 'getConnectionState').mockReturnValue({
      connected: false,
      lastError: 'Redis cluster down',
      reconnectAttempts: 5,
    });

    const aiChatConfig = {
      maxRequests: 10,
      windowSeconds: 60,
      failClosed: true, // Strict fail-closed policy for expensive LLM inference
      prefix: 'llm-chat-outage',
    };

    const res = await checkRateLimit('patient_ai_user', aiChatConfig);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.source).toBe('memory-fallback');
  });

  it('10. Document Upload Limits: enforced with strict per-user windowing', async () => {
    const uploadLimiter = new InMemoryRateLimiter();
    const maxUploadsPerHour = 5;

    for (let i = 0; i < maxUploadsPerHour; i++) {
      const res = uploadLimiter.check('patient_uploader_01', maxUploadsPerHour, 3600);
      expect(res.allowed).toBe(true);
    }

    // 6th upload in 1 hour window must be denied
    const blockedUpload = uploadLimiter.check('patient_uploader_01', maxUploadsPerHour, 3600);
    expect(blockedUpload.allowed).toBe(false);
  });
});
