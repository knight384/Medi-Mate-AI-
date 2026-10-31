import { NextResponse } from 'next/server';

/**
 * DECOMMISSIONED: Public document access is permanently disabled for patient data security.
 * All medical document downloads must go through the authenticated endpoint:
 * GET /api/health-data/[id]/file
 */
export async function GET() {
  return NextResponse.json(
    {
      error: 'Public file access is decommissioned. Authenticate and retrieve documents via /api/health-data/[id]/file',
      code: 'PUBLIC_ACCESS_DECOMMISSIONED',
    },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
