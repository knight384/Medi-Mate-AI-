/**
 * MediMate AI — Longitudinal Health Intelligence
 * Phase 8: Statistical and longitudinal comparison of continuous health metrics across time intervals.
 * Enforces unit normalization, missing-data accounting, and non-diagnostic framing.
 */

import { NormalizedObservation } from '@/lib/wearables/types';
import { LongitudinalComparisonResult } from './types';

export interface ComparisonPeriodSpec {
  label: string;
  startDate: Date;
  endDate: Date;
}

export class LongitudinalHealthService {
  /**
   * Normalizes values and units for fair comparison.
   */
  static normalizeMetricValue(metric: string, rawValue: number, rawUnit: string): { value: number; unit: string } {
    const m = metric.toUpperCase();
    const u = rawUnit.toLowerCase();

    // Sleep duration: standardizing on hours for comparative statistics
    if (m.includes('SLEEP') && (u.includes('second') || u === 's')) {
      return { value: Math.round((rawValue / 3600) * 100) / 100, unit: 'hours' };
    }
    if (m.includes('SLEEP') && (u.includes('minute') || u === 'min')) {
      return { value: Math.round((rawValue / 60) * 100) / 100, unit: 'hours' };
    }

    // Distance: standardizing on kilometers
    if (m.includes('DISTANCE') && (u.includes('meter') || u === 'm')) {
      return { value: Math.round((rawValue / 1000) * 100) / 100, unit: 'km' };
    }

    // Default: keep existing unit
    return { value: rawValue, unit: rawUnit };
  }

  /**
   * Computes standard descriptive statistics for an array of numbers.
   */
  static computeStatistics(values: number[]): {
    count: number;
    avg: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
  } {
    if (values.length === 0) {
      return { count: 0, avg: 0, median: 0, min: 0, max: 0, stdDev: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const avg = Math.round((sum / count) * 100) / 100;

    let median = 0;
    const mid = Math.floor(count / 2);
    if (count % 2 === 0) {
      median = Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
    } else {
      median = Math.round(sorted[mid] * 100) / 100;
    }

    const min = sorted[0];
    const max = sorted[count - 1];

    const variance =
      sorted.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / count;
    const stdDev = Math.round(Math.sqrt(variance) * 100) / 100;

    return { count, avg, median, min, max, stdDev };
  }

  /**
   * Compares two periods for a designated metric across a set of observations.
   */
  static comparePeriods(params: {
    metric: string;
    periodA: ComparisonPeriodSpec;
    periodB: ComparisonPeriodSpec;
    observations: NormalizedObservation[];
  }): LongitudinalComparisonResult {
    const { metric, periodA, periodB, observations } = params;

    const filterPeriod = (start: Date, end: Date) => {
      const s = start.getTime();
      const e = end.getTime();
      return observations.filter((obs) => {
        if (obs.metric !== metric) return false;
        const t = new Date(obs.startTime).getTime();
        return t >= s && t <= e;
      });
    };

    const obsA = filterPeriod(periodA.startDate, periodA.endDate);
    const obsB = filterPeriod(periodB.startDate, periodB.endDate);

    // Determine normalized unit
    const sampleObs = obsA[0] || obsB[0];
    const rawUnit = sampleObs ? sampleObs.unit : '';
    const { unit } = this.normalizeMetricValue(metric, 1, rawUnit);

    const valuesA = obsA.map((o) => this.normalizeMetricValue(metric, o.value, o.unit).value);
    const valuesB = obsB.map((o) => this.normalizeMetricValue(metric, o.value, o.unit).value);

    const statsA = this.computeStatistics(valuesA);
    const statsB = this.computeStatistics(valuesB);

    // Calculate changes: Period B relative to Period A (Baseline A -> Current B)
    const absoluteChange = Math.round((statsB.avg - statsA.avg) * 100) / 100;
    let percentageChange = 0;
    if (statsA.avg !== 0) {
      percentageChange = Math.round(((statsB.avg - statsA.avg) / statsA.avg) * 1000) / 10;
    }

    let direction: 'INCREASE' | 'DECREASE' | 'STABLE' = 'STABLE';
    if (Math.abs(percentageChange) >= 2.0) {
      direction = percentageChange > 0 ? 'INCREASE' : 'DECREASE';
    }

    // Meaningful change: if change is beyond 1 standard deviation of baseline
    const isMeaningfulChange = statsA.stdDev > 0
      ? Math.abs(absoluteChange) >= statsA.stdDev
      : Math.abs(percentageChange) >= 5.0;

    // Check data quality & limitations
    const limitations: string[] = [];
    const minSampleExpected = 3;
    const insufficientData = statsA.count < minSampleExpected || statsB.count < minSampleExpected;
    if (insufficientData) {
      limitations.push(`Insufficient sample size: period A has ${statsA.count} and period B has ${statsB.count} observations (minimum recommended is ${minSampleExpected}).`);
    }

    // Provider / device consistency check
    const providersA = new Set(obsA.map((o) => o.providerId));
    const providersB = new Set(obsB.map((o) => o.providerId));
    let providerConsistency = true;
    for (const p of providersB) {
      if (!providersA.has(p) && providersA.size > 0) {
        providerConsistency = false;
        limitations.push('Observations span different wearable sensor providers or hardware devices; variance may be due to differing sensor calibration.');
        break;
      }
    }

    // Calculate missing days estimate
    const diffDaysA = Math.max(1, Math.round((periodA.endDate.getTime() - periodA.startDate.getTime()) / 86400000));
    const diffDaysB = Math.max(1, Math.round((periodB.endDate.getTime() - periodB.startDate.getTime()) / 86400000));
    const missingDaysCount = Math.max(0, (diffDaysA - statsA.count) + (diffDaysB - statsB.count));
    if (missingDaysCount > 0) {
      limitations.push(`Estimated ${missingDaysCount} unrecorded calendar intervals between periods.`);
    }

    return {
      metric,
      unit,
      periodA: {
        label: periodA.label,
        startDate: periodA.startDate.toISOString().slice(0, 10),
        endDate: periodA.endDate.toISOString().slice(0, 10),
        count: statsA.count,
        avg: statsA.avg,
        median: statsA.median,
        min: statsA.min,
        max: statsA.max,
        stdDev: statsA.stdDev,
      },
      periodB: {
        label: periodB.label,
        startDate: periodB.startDate.toISOString().slice(0, 10),
        endDate: periodB.endDate.toISOString().slice(0, 10),
        count: statsB.count,
        avg: statsB.avg,
        median: statsB.median,
        min: statsB.min,
        max: statsB.max,
        stdDev: statsB.stdDev,
      },
      delta: {
        absoluteChange,
        percentageChange,
        direction,
        isMeaningfulChange,
      },
      dataQuality: {
        insufficientData,
        providerConsistency,
        missingDaysCount,
        limitations,
      },
      nonDiagnosticDisclaimer: 'This longitudinal comparison reflects observational trends from consumer sensors or historical records. It does not constitute a diagnostic evaluation or clinical treatment recommendation.',
    };
  }

  /**
   * Helper to build standard rolling comparison periods (e.g. week vs previous week, month vs previous month).
   */
  static buildStandardIntervals(type: 'WEEK_VS_PREVIOUS' | 'MONTH_VS_PREVIOUS', anchorDate: Date = new Date()): {
    periodA: ComparisonPeriodSpec;
    periodB: ComparisonPeriodSpec;
  } {
    const endB = new Date(anchorDate);
    if (type === 'WEEK_VS_PREVIOUS') {
      const startB = new Date(endB.getTime() - 7 * 86400000);
      const endA = new Date(startB.getTime() - 1);
      const startA = new Date(endA.getTime() - 7 * 86400000);
      return {
        periodA: { label: 'Previous Week', startDate: startA, endDate: endA },
        periodB: { label: 'Current Week', startDate: startB, endDate: endB },
      };
    } else {
      const startB = new Date(endB.getTime() - 30 * 86400000);
      const endA = new Date(startB.getTime() - 1);
      const startA = new Date(endA.getTime() - 30 * 86400000);
      return {
        periodA: { label: 'Previous Month', startDate: startA, endDate: endA },
        periodB: { label: 'Current Month', startDate: startB, endDate: endB },
      };
    }
  }
}
