import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { HealthMetricType, NormalizedObservation } from '@/lib/wearables/types';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const searchParams = req.nextUrl.searchParams;
  const range = searchParams.get('range') || 'week'; // day, week, month, 3months
  const metricFilter = searchParams.get('metric') as HealthMetricType | null;

  const now = new Date();
  let startDate = new Date();
  switch (range) {
    case 'day':
      startDate = new Date(now.getTime() - 86400000);
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 86400000);
      break;
    case 'month':
      startDate = new Date(now.getTime() - 30 * 86400000);
      break;
    case '3months':
      startDate = new Date(now.getTime() - 90 * 86400000);
      break;
    default:
      startDate = new Date(now.getTime() - 7 * 86400000);
  }

  try {
    const records = await prisma.healthData.findMany({
      where: {
        authorId: userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: startDate },
      },
      orderBy: { createdAt: 'asc' },
    });

    const observations = records
      .map((r) => r.data as unknown as NormalizedObservation)
      .filter((obs) => (metricFilter ? obs.metric === metricFilter : true));

    // Group observations by metric
    const trendsByMetric: Record<
      string,
      {
        metric: string;
        unit: string;
        dataPoints: {
          timestamp: string;
          value: number;
          providerId: string;
          deviceModel?: string;
          dataQuality: string;
        }[];
        summary: {
          avg: number;
          min: number;
          max: number;
          count: number;
          total?: number;
        };
      }
    > = {};

    for (const obs of observations) {
      if (!trendsByMetric[obs.metric]) {
        trendsByMetric[obs.metric] = {
          metric: obs.metric,
          unit: obs.unit,
          dataPoints: [],
          summary: { avg: 0, min: Infinity, max: -Infinity, count: 0 },
        };
      }

      trendsByMetric[obs.metric].dataPoints.push({
        timestamp: obs.startTime,
        value: obs.value,
        providerId: obs.providerId,
        deviceModel: obs.deviceModel,
        dataQuality: obs.dataQuality,
      });
    }

    // Compute summaries
    for (const group of Object.values(trendsByMetric)) {
      const vals = group.dataPoints.map((dp) => dp.value);
      if (vals.length > 0) {
        const sum = vals.reduce((a, b) => a + b, 0);
        group.summary.count = vals.length;
        group.summary.min = Math.min(...vals);
        group.summary.max = Math.max(...vals);
        group.summary.avg = Math.round((sum / vals.length) * 10) / 10;
        if (group.metric === 'STEPS' || group.metric === 'ACTIVE_CALORIES') {
          group.summary.total = Math.round(sum);
        }
      }
    }

    return NextResponse.json({
      range,
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalObservations: observations.length,
      metrics: trendsByMetric,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
