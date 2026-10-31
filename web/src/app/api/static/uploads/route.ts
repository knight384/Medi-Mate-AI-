import { NextResponse } from 'next/server';

/**
 * Public static upload route has been permanently decommissioned.
 * All document uploads MUST go through private authenticated /api/health-data.
 */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: 'Public file access is decommissioned. Use private authenticated /api/health-data.',
      code: 'PUBLIC_ACCESS_DECOMMISSIONED',
    },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}
