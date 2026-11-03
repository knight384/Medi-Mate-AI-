import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { PersonalizedInsightEngine } from '@/lib/health-intelligence/insights/insight-engine';
import { NormalizedObservation } from '@/lib/wearables/types';

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

  try {
    const rawRecords = await prisma.healthData.findMany({
      where: {
        authorId: userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: thirtyDaysAgo },
      },
      orderBy: { createdAt: 'asc' },
    });

    const observations = rawRecords.map((r) => r.data as unknown as NormalizedObservation);
    const insights = PersonalizedInsightEngine.generateInsights({
      userId,
      observations,
    });

    return NextResponse.json({ insights });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
