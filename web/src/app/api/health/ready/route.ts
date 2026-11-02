import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { redisConnectionManager } from '@/lib/redis/connection-manager';
import { deploymentProfileManager } from '@/lib/deployment';

export const dynamic = 'force-dynamic';

export async function GET() {
  const profile = deploymentProfileManager.getProfile();
  const checks: Record<string, string> = {
    deploymentMode: profile.mode,
  };

  let isReady = true;

  // 1. Database Connectivity Check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'degraded_or_offline';
    isReady = false;
  }

  // 2. Redis Cache Check (if enabled)
  try {
    const connState = redisConnectionManager.getConnectionState();
    checks.redis = connState.connected ? 'ok' : 'offline';
  } catch {
    checks.redis = 'unavailable';
  }

  const statusCode = isReady ? 200 : 503;
  return NextResponse.json(
    {
      status: isReady ? 'ready' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: statusCode }
  );
}
