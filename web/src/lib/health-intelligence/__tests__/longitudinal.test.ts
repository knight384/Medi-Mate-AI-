import { describe, it, expect } from 'vitest';
import { LongitudinalHealthService } from '../longitudinal';
import { NormalizedObservation } from '@/lib/wearables/types';

function mockObs(partial: Partial<NormalizedObservation> & { metric: NormalizedObservation['metric']; value: number; startTime: string }): NormalizedObservation {
  return {
    id: partial.id || `obs_${Math.random()}`,
    userId: 'user_test',
    providerId: partial.providerId || 'fitbit',
    externalRecordId: partial.externalRecordId || `ext_${Math.random()}`,
    metric: partial.metric,
    category: partial.category || 'HEART',
    value: partial.value,
    unit: partial.unit || 'bpm',
    startTime: partial.startTime,
    endTime: partial.endTime || partial.startTime,
    dataQuality: partial.dataQuality || 'MEASURED',
    syncedAt: new Date().toISOString(),
  };
}

describe('LongitudinalHealthService', () => {
  it('normalizes units accurately', () => {
    // 27000 seconds = 7.5 hours
    const normSleep = LongitudinalHealthService.normalizeMetricValue('SLEEP_DURATION', 27000, 'seconds');
    expect(normSleep.value).toBe(7.5);
    expect(normSleep.unit).toBe('hours');

    // 5000 meters = 5 km
    const normDist = LongitudinalHealthService.normalizeMetricValue('DISTANCE', 5000, 'm');
    expect(normDist.value).toBe(5);
    expect(normDist.unit).toBe('km');
  });

  it('computes descriptive statistics accurately', () => {
    const vals = [60, 65, 70, 75, 80];
    const stats = LongitudinalHealthService.computeStatistics(vals);

    expect(stats.count).toBe(5);
    expect(stats.avg).toBe(70);
    expect(stats.median).toBe(70);
    expect(stats.min).toBe(60);
    expect(stats.max).toBe(80);
    expect(stats.stdDev).toBe(7.07);
  });

  it('compares periods, calculates percentage change, and applies non-diagnostic disclaimer', () => {
    const periodA = {
      label: 'Week 1',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-07T23:59:59Z'),
    };
    const periodB = {
      label: 'Week 2',
      startDate: new Date('2026-10-08T00:00:00Z'),
      endDate: new Date('2026-10-14T23:59:59Z'),
    };

    const observations: NormalizedObservation[] = [
      // Week 1: 65, 66, 67 bpm
      mockObs({ id: 'obs_1', metric: 'RESTING_HEART_RATE', value: 65, startTime: '2026-10-02T08:00:00Z' }),
      mockObs({ id: 'obs_2', metric: 'RESTING_HEART_RATE', value: 66, startTime: '2026-10-04T08:00:00Z' }),
      mockObs({ id: 'obs_3', metric: 'RESTING_HEART_RATE', value: 67, startTime: '2026-10-06T08:00:00Z' }),
      // Week 2: 72, 73, 74 bpm
      mockObs({ id: 'obs_4', metric: 'RESTING_HEART_RATE', value: 72, startTime: '2026-10-09T08:00:00Z' }),
      mockObs({ id: 'obs_5', metric: 'RESTING_HEART_RATE', value: 73, startTime: '2026-10-11T08:00:00Z' }),
      mockObs({ id: 'obs_6', metric: 'RESTING_HEART_RATE', value: 74, startTime: '2026-10-13T08:00:00Z' }),
    ];

    const result = LongitudinalHealthService.comparePeriods({
      metric: 'RESTING_HEART_RATE',
      periodA,
      periodB,
      observations,
    });

    expect(result.periodA.avg).toBe(66);
    expect(result.periodB.avg).toBe(73);
    expect(result.delta.absoluteChange).toBe(7);
    expect(result.delta.direction).toBe('INCREASE');
    expect(result.delta.isMeaningfulChange).toBe(true);
    expect(result.dataQuality.insufficientData).toBe(false);
    expect(result.nonDiagnosticDisclaimer).toContain('observational trends');
  });

  it('detects insufficient sample sizes and flags quality warnings', () => {
    const periodA = {
      label: 'Day 1',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-01T23:59:59Z'),
    };
    const periodB = {
      label: 'Day 2',
      startDate: new Date('2026-10-02T00:00:00Z'),
      endDate: new Date('2026-10-02T23:59:59Z'),
    };

    // Only 1 observation per period
    const obs: NormalizedObservation[] = [
      mockObs({ id: 'obs_1', metric: 'STEPS', category: 'ACTIVITY', value: 5000, unit: 'steps', startTime: '2026-10-01T12:00:00Z' }),
      mockObs({ id: 'obs_2', metric: 'STEPS', category: 'ACTIVITY', value: 7000, unit: 'steps', startTime: '2026-10-02T12:00:00Z' }),
    ];

    const result = LongitudinalHealthService.comparePeriods({
      metric: 'STEPS',
      periodA,
      periodB,
      observations: obs,
    });

    expect(result.dataQuality.insufficientData).toBe(true);
    expect(result.dataQuality.limitations.some((l) => l.includes('Insufficient sample size'))).toBe(true);
  });
});
