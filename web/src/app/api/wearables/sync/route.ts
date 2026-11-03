import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { WearableSyncEngine } from '@/lib/wearables/sync';
import { WearableRAGSummaryService } from '@/lib/wearables/rag-summary';
import { NormalizedObservation, WearableProviderId } from '@/lib/wearables/types';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const body = await req.json();
    const { providerId, mode = 'INCREMENTAL', lookbackDays = 7, generateRAGSummary = true } =
      body as {
        providerId: WearableProviderId;
        mode?: 'HISTORICAL' | 'INCREMENTAL';
        lookbackDays?: number;
        generateRAGSummary?: boolean;
      };

    if (!providerId) {
      return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    }

    const syncResult = await WearableSyncEngine.syncUserProvider({
      userId,
      providerId,
      mode,
      lookbackDays,
    });

    let ragSummaryResult = null;

    if (generateRAGSummary && syncResult.status === 'SUCCESS') {
      try {
        const now = new Date();
        const start = new Date(now.getTime() - lookbackDays * 86400000);

        // Fetch recent observations from HealthData
        const obsRecords = await prisma.healthData.findMany({
          where: {
            authorId: userId,
            type: 'WEARABLE_OBSERVATION',
            createdAt: { gte: start },
            metadata: {
              path: ['providerId'],
              equals: providerId,
            },
          },
        });

        const observations = obsRecords.map((r) => r.data as unknown as NormalizedObservation);

        if (observations.length > 0) {
          const summary = WearableRAGSummaryService.buildSummary({
            userId,
            providerId,
            period: 'WEEKLY',
            startDate: start,
            endDate: now,
            observations,
          });

          ragSummaryResult = await WearableRAGSummaryService.publishSummaryToRAG(summary);
        }
      } catch {
        // RAG summary optional on offline microservice
      }
    }

    return NextResponse.json({
      success: syncResult.status === 'SUCCESS',
      syncResult,
      ragSummaryResult,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
