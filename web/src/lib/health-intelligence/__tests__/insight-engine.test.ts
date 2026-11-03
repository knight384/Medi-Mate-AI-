import { describe, it, expect } from 'vitest';
import { PersonalizedInsightEngine } from '../insights/insight-engine';
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

describe('PersonalizedInsightEngine', () => {
  const userId = 'user_test_insight_123';
  const anchorDate = new Date('2026-10-15T12:00:00Z');

  it('generates activity insights when sufficient step observations exist', () => {
    const observations: NormalizedObservation[] = [
      // Previous week: 5000, 5200, 4800
      mockObs({ id: 'obs_s1', metric: 'STEPS', category: 'ACTIVITY', value: 5000, unit: 'steps', startTime: '2026-10-02T12:00:00Z' }),
      mockObs({ id: 'obs_s2', metric: 'STEPS', category: 'ACTIVITY', value: 5200, unit: 'steps', startTime: '2026-10-04T12:00:00Z' }),
      mockObs({ id: 'obs_s3', metric: 'STEPS', category: 'ACTIVITY', value: 4800, unit: 'steps', startTime: '2026-10-06T12:00:00Z' }),
      // Current week: 8000, 8500, 8200
      mockObs({ id: 'obs_s4', metric: 'STEPS', category: 'ACTIVITY', value: 8000, unit: 'steps', startTime: '2026-10-09T12:00:00Z' }),
      mockObs({ id: 'obs_s5', metric: 'STEPS', category: 'ACTIVITY', value: 8500, unit: 'steps', startTime: '2026-10-11T12:00:00Z' }),
      mockObs({ id: 'obs_s6', metric: 'STEPS', category: 'ACTIVITY', value: 8200, unit: 'steps', startTime: '2026-10-13T12:00:00Z' }),
    ];

    const insights = PersonalizedInsightEngine.generateInsights({
      userId,
      observations,
      anchorDate,
    });

    const actInsight = insights.find((i) => i.category === 'ACTIVITY');
    expect(actInsight).toBeDefined();
    expect(actInsight?.title).toContain('Increased Daily Activity');
    expect(actInsight?.description).toContain('steps/day');
    expect(actInsight?.safetyClassification).toBe('INFORMATIONAL_OBSERVATION');
  });

  it('generates multi-modal combined insights correlating sleep and heart telemetry', () => {
    const observations: NormalizedObservation[] = [
      // Resting heart rate
      mockObs({ id: 'h1', providerId: 'oura', metric: 'RESTING_HEART_RATE', value: 62, startTime: '2026-10-09T08:00:00Z' }),
      mockObs({ id: 'h2', providerId: 'oura', metric: 'RESTING_HEART_RATE', value: 60, startTime: '2026-10-10T08:00:00Z' }),
      mockObs({ id: 'h3', providerId: 'oura', metric: 'RESTING_HEART_RATE', value: 61, startTime: '2026-10-11T08:00:00Z' }),
      mockObs({ id: 'h4', providerId: 'oura', metric: 'RESTING_HEART_RATE', value: 63, startTime: '2026-10-12T08:00:00Z' }),
      // Sleep duration
      mockObs({ id: 's1', providerId: 'oura', metric: 'SLEEP_DURATION', category: 'SLEEP', value: 28800, unit: 'seconds', startTime: '2026-10-09T07:00:00Z' }),
      mockObs({ id: 's2', providerId: 'oura', metric: 'SLEEP_DURATION', category: 'SLEEP', value: 27000, unit: 'seconds', startTime: '2026-10-10T07:00:00Z' }),
      mockObs({ id: 's3', providerId: 'oura', metric: 'SLEEP_DURATION', category: 'SLEEP', value: 29000, unit: 'seconds', startTime: '2026-10-11T07:00:00Z' }),
      mockObs({ id: 's4', providerId: 'oura', metric: 'SLEEP_DURATION', category: 'SLEEP', value: 28000, unit: 'seconds', startTime: '2026-10-12T07:00:00Z' }),
    ];

    const insights = PersonalizedInsightEngine.generateInsights({
      userId,
      observations,
      anchorDate,
    });

    const combined = insights.find((i) => i.category === 'COMBINED');
    expect(combined).toBeDefined();
    expect(combined?.description).toContain('cardiovascular recovery');
    expect(combined?.limitations.some((l) => l.includes('causality'))).toBe(true);
  });
});
