import { NextResponse } from 'next/server';
import { deploymentProfileManager } from '@/lib/deployment';

export const dynamic = 'force-dynamic';

export async function GET() {
  const profile = deploymentProfileManager.getProfile();
  return NextResponse.json(
    {
      status: 'ok',
      service: 'medimate-ai',
      deploymentMode: profile.mode,
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
