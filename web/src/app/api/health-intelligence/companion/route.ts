import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { CompanionResponseGenerator } from '@/lib/health-intelligence/response-generator';
import { readBoundedJson } from '@/lib/security/request-boundary';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await readBoundedJson<{ query: string }>(req, { maxBytes: 16 * 1024 });
    if (!body.query || body.query.trim().length === 0) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const regionCode = req.headers.get('x-user-region') || undefined;
    const response = await CompanionResponseGenerator.generateCompanionResponse({
      userId: session.user.id,
      query: body.query,
      regionCode,
    });

    return NextResponse.json({ response });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
