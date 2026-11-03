/**
 * MediMate AI — Personalized Health Insight Engine
 * Phase 8: Generates evidence-grounded, non-diagnostic observational insights
 * from structured health data and wearable telemetry.
 */

import { NormalizedObservation } from '@/lib/wearables/types';
import { LongitudinalHealthService } from '../longitudinal';
import { HealthInsight } from '../types';

export class PersonalizedInsightEngine {
  /**
   * Generates actionable, observational health insights from a collection of observations.
   */
  static generateInsights(params: {
    userId: string;
    observations: NormalizedObservation[];
    laboratoryResults?: { testName: string; value: number | string; unit: string; date: string; referenceRange?: string }[];
    anchorDate?: Date;
  }): HealthInsight[] {
    const { userId, observations, laboratoryResults = [], anchorDate = new Date() } = params;
    const insights: HealthInsight[] = [];

    const now = anchorDate;
    const intervals = LongitudinalHealthService.buildStandardIntervals('WEEK_VS_PREVIOUS', now);

    // 1. Activity Insights (Daily Steps)
    const stepObs = observations.filter((o) => o.metric === 'STEPS');
    if (stepObs.length >= 3) {
      const comp = LongitudinalHealthService.comparePeriods({
        metric: 'STEPS',
        periodA: intervals.periodA,
        periodB: intervals.periodB,
        observations: stepObs,
      });

      if (!comp.dataQuality.insufficientData) {
        const diff = comp.delta.absoluteChange;
        const pct = Math.abs(comp.delta.percentageChange);
        const directionWord = diff >= 0 ? 'higher' : 'lower';
        const title = diff >= 0 ? 'Increased Daily Activity' : 'Decreased Daily Activity';
        const desc = `Your daily step average was ${Math.abs(diff)} steps ${directionWord} (${pct}%) this past week (${comp.periodB.avg} steps/day) compared to the previous week (${comp.periodA.avg} steps/day).`;

        insights.push({
          id: `insight_activity_${userId}_${comp.periodB.endDate}`,
          userId,
          category: 'ACTIVITY',
          title,
          description: desc,
          dateInterval: {
            startDate: comp.periodB.startDate,
            endDate: comp.periodB.endDate,
          },
          supportingEvidence: {
            observationIds: stepObs.slice(-7).map((o) => o.id),
            metrics: ['STEPS'],
            sampleSize: comp.periodB.count,
          },
          confidenceScore: comp.periodB.count >= 6 ? 0.95 : 0.8,
          evidenceCoverage: comp.periodB.count >= 6 ? 'HIGH' : 'MEDIUM',
          limitations: comp.dataQuality.limitations,
          safetyClassification: 'INFORMATIONAL_OBSERVATION',
          generatedAt: new Date().toISOString(),
        });
      }
    }

    // 2. Sleep Insights (Duration & Consistency)
    const sleepObs = observations.filter((o) => o.metric === 'SLEEP_DURATION');
    if (sleepObs.length >= 3) {
      const comp = LongitudinalHealthService.comparePeriods({
        metric: 'SLEEP_DURATION',
        periodA: intervals.periodA,
        periodB: intervals.periodB,
        observations: sleepObs,
      });

      if (!comp.dataQuality.insufficientData) {
        const avgHours = comp.periodB.avg;
        const stdDev = comp.periodB.stdDev;
        const consistencyText = stdDev <= 0.75
          ? 'consistent sleep schedule (low variability)'
          : 'moderate day-to-day schedule variability';

        const desc = `Over the past week, you averaged ${avgHours} hours of sleep per night with a ${consistencyText} (standard deviation: ±${stdDev}h).`;

        insights.push({
          id: `insight_sleep_${userId}_${comp.periodB.endDate}`,
          userId,
          category: 'SLEEP',
          title: 'Sleep Duration & Consistency',
          description: desc,
          dateInterval: {
            startDate: comp.periodB.startDate,
            endDate: comp.periodB.endDate,
          },
          supportingEvidence: {
            observationIds: sleepObs.slice(-7).map((o) => o.id),
            metrics: ['SLEEP_DURATION'],
            sampleSize: comp.periodB.count,
          },
          confidenceScore: comp.periodB.count >= 5 ? 0.9 : 0.75,
          evidenceCoverage: comp.periodB.count >= 5 ? 'HIGH' : 'MEDIUM',
          limitations: comp.dataQuality.limitations,
          safetyClassification: 'INFORMATIONAL_OBSERVATION',
          generatedAt: new Date().toISOString(),
        });
      }
    }

    // 3. Heart & Physiological Insights (Resting Heart Rate & HRV)
    const rhrObs = observations.filter((o) => o.metric === 'RESTING_HEART_RATE');
    if (rhrObs.length >= 3) {
      const comp = LongitudinalHealthService.comparePeriods({
        metric: 'RESTING_HEART_RATE',
        periodA: intervals.periodA,
        periodB: intervals.periodB,
        observations: rhrObs,
      });

      if (!comp.dataQuality.insufficientData) {
        const delta = comp.delta.absoluteChange;
        let trendSummary = 'Your resting heart rate remained stable';
        if (comp.delta.direction === 'INCREASE' && comp.delta.isMeaningfulChange) {
          trendSummary = `Your average resting heart rate was elevated by ${delta} bpm`;
        } else if (comp.delta.direction === 'DECREASE' && comp.delta.isMeaningfulChange) {
          trendSummary = `Your average resting heart rate decreased by ${Math.abs(delta)} bpm`;
        }

        insights.push({
          id: `insight_heart_${userId}_${comp.periodB.endDate}`,
          userId,
          category: 'HEART',
          title: 'Resting Heart Rate Trend',
          description: `${trendSummary} this week (${comp.periodB.avg} bpm) compared to last week (${comp.periodA.avg} bpm).`,
          dateInterval: {
            startDate: comp.periodB.startDate,
            endDate: comp.periodB.endDate,
          },
          supportingEvidence: {
            observationIds: rhrObs.slice(-7).map((o) => o.id),
            metrics: ['RESTING_HEART_RATE'],
            sampleSize: comp.periodB.count,
          },
          confidenceScore: 0.85,
          evidenceCoverage: 'HIGH',
          limitations: comp.dataQuality.limitations,
          safetyClassification: 'NON_DIAGNOSTIC_TREND',
          generatedAt: new Date().toISOString(),
        });
      }
    }

    // 4. Combined Multi-Modal Insight (Sleep + Resting HR)
    if (rhrObs.length >= 4 && sleepObs.length >= 4) {
      const recentRhr = LongitudinalHealthService.computeStatistics(
        rhrObs.slice(-7).map((o) => o.value)
      );
      const recentSleep = LongitudinalHealthService.computeStatistics(
        sleepObs.slice(-7).map((o) => LongitudinalHealthService.normalizeMetricValue('SLEEP_DURATION', o.value, o.unit).value)
      );

      insights.push({
        id: `insight_combined_${userId}_${now.toISOString().slice(0, 10)}`,
        userId,
        category: 'COMBINED',
        title: 'Sleep and Physiological Pattern Correlation',
        description: `Across ${recentSleep.count} recorded nights, your average sleep was ${recentSleep.avg}h with an average resting heart rate of ${recentRhr.avg} bpm. Consumer telemetry shows consistent baseline cardiovascular recovery.`,
        dateInterval: {
          startDate: intervals.periodB.startDate.toISOString().slice(0, 10),
          endDate: intervals.periodB.endDate.toISOString().slice(0, 10),
        },
        supportingEvidence: {
          observationIds: [...rhrObs.slice(-4).map((o) => o.id), ...sleepObs.slice(-4).map((o) => o.id)],
          metrics: ['RESTING_HEART_RATE', 'SLEEP_DURATION'],
          sampleSize: recentRhr.count + recentSleep.count,
        },
        confidenceScore: 0.8,
        evidenceCoverage: 'MEDIUM',
        limitations: [
          'Combined correlations are observational associations and do not prove physiological causality.',
          'Sensor readings may be influenced by sleep posture, strap tightness, or ambient temperature.',
        ],
        safetyClassification: 'NON_DIAGNOSTIC_TREND',
        generatedAt: new Date().toISOString(),
      });
    }

    // 5. Laboratory Records Insight
    if (laboratoryResults.length > 0) {
      const latestLab = laboratoryResults[laboratoryResults.length - 1];
      insights.push({
        id: `insight_labs_${userId}_${latestLab.date}`,
        userId,
        category: 'LABS',
        title: `Laboratory Record: ${latestLab.testName}`,
        description: `Reported value on ${latestLab.date}: ${latestLab.value} ${latestLab.unit}${latestLab.referenceRange ? ` (Reference range: ${latestLab.referenceRange})` : ''}. Review results with your healthcare provider for clinical interpretation.`,
        dateInterval: {
          startDate: latestLab.date,
          endDate: latestLab.date,
        },
        supportingEvidence: {
          observationIds: [],
          metrics: [latestLab.testName],
          sampleSize: 1,
        },
        confidenceScore: 1.0,
        evidenceCoverage: 'HIGH',
        limitations: [
          'Laboratory reports reflect specimen status at the time of collection.',
          'Reference ranges vary by laboratory methodology and patient demographics.',
        ],
        safetyClassification: 'INFORMATIONAL_OBSERVATION',
        generatedAt: new Date().toISOString(),
      });
    }

    return insights;
  }
}
