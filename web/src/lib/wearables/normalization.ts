/**
 * MediMate AI — Health Data Normalization & Quality Verification
 * Normalizes units, validates physiological ranges, and generates deterministic deduplication keys.
 */

import crypto from 'crypto';
import {
  DataQualityClassification,
  HealthDataCategory,
  HealthMetricType,
  NormalizedObservation,
  WearableProviderId,
} from './types';

export class NormalizationError extends Error {
  constructor(message: string, public readonly code = 'NORMALIZATION_ERROR') {
    super(message);
    this.name = 'NormalizationError';
  }
}

/**
 * Standard unit targets for each metric type.
 */
export const TARGET_METRIC_UNITS: Record<HealthMetricType, string> = {
  HEART_RATE: 'bpm',
  RESTING_HEART_RATE: 'bpm',
  HRV: 'ms',
  ECG_RECORDING: 'lead_i_mv',
  STEPS: 'count',
  DISTANCE: 'meters',
  ACTIVE_CALORIES: 'kcal',
  ACTIVITY_DURATION: 'seconds',
  EXERCISE_SESSION: 'session',
  SLEEP_DURATION: 'seconds',
  SLEEP_STAGE: 'stage',
  SLEEP_EFFICIENCY: 'percentage',
  SLEEP_RESPIRATORY_RATE: 'breaths_per_min',
  SPO2: 'percentage',
  BLOOD_PRESSURE_SYSTOLIC: 'mmHg',
  BLOOD_PRESSURE_DIASTOLIC: 'mmHg',
  BODY_TEMPERATURE: 'celsius',
  RESPIRATORY_RATE: 'breaths_per_min',
  WEIGHT: 'kg',
  BMI: 'kg/m2',
};

/**
 * Maps metric types to their overarching health category.
 */
export const METRIC_TO_CATEGORY: Record<HealthMetricType, HealthDataCategory> = {
  HEART_RATE: 'HEART',
  RESTING_HEART_RATE: 'HEART',
  HRV: 'HEART',
  ECG_RECORDING: 'HEART',
  STEPS: 'ACTIVITY',
  DISTANCE: 'ACTIVITY',
  ACTIVE_CALORIES: 'ACTIVITY',
  ACTIVITY_DURATION: 'ACTIVITY',
  EXERCISE_SESSION: 'ACTIVITY',
  SLEEP_DURATION: 'SLEEP',
  SLEEP_STAGE: 'SLEEP',
  SLEEP_EFFICIENCY: 'SLEEP',
  SLEEP_RESPIRATORY_RATE: 'SLEEP',
  SPO2: 'VITALS',
  BLOOD_PRESSURE_SYSTOLIC: 'VITALS',
  BLOOD_PRESSURE_DIASTOLIC: 'VITALS',
  BODY_TEMPERATURE: 'VITALS',
  RESPIRATORY_RATE: 'VITALS',
  WEIGHT: 'BODY',
  BMI: 'BODY',
};

/**
 * Converts a raw numeric value to the standard target unit.
 */
export function convertUnit(
  value: number,
  sourceUnit: string,
  targetUnit: string
): { value: number; converted: boolean } {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new NormalizationError(`Invalid numeric value: ${value}`);
  }

  const src = sourceUnit.trim().toLowerCase();
  const tgt = targetUnit.trim().toLowerCase();

  if (src === tgt) {
    return { value, converted: false };
  }

  // Distance conversions
  if ((src === 'miles' || src === 'mi') && tgt === 'meters') {
    return { value: Math.round(value * 1609.344 * 100) / 100, converted: true };
  }
  if ((src === 'km' || src === 'kilometers') && tgt === 'meters') {
    return { value: Math.round(value * 1000 * 100) / 100, converted: true };
  }
  if ((src === 'feet' || src === 'ft') && tgt === 'meters') {
    return { value: Math.round(value * 0.3048 * 100) / 100, converted: true };
  }

  // Weight conversions
  if ((src === 'lbs' || src === 'pounds' || src === 'lb') && tgt === 'kg') {
    return { value: Math.round((value * 0.45359237) * 100) / 100, converted: true };
  }
  if ((src === 'grams' || src === 'g') && tgt === 'kg') {
    return { value: Math.round((value / 1000) * 100) / 100, converted: true };
  }

  // Temperature conversions
  if ((src === 'fahrenheit' || src === 'f') && tgt === 'celsius') {
    return { value: Math.round(((value - 32) * (5 / 9)) * 10) / 10, converted: true };
  }

  // Duration conversions
  if ((src === 'minutes' || src === 'min') && tgt === 'seconds') {
    return { value: Math.round(value * 60), converted: true };
  }
  if ((src === 'hours' || src === 'hrs' || src === 'h') && tgt === 'seconds') {
    return { value: Math.round(value * 3600), converted: true };
  }
  if ((src === 'milliseconds' || src === 'ms') && tgt === 'seconds') {
    return { value: Math.round(value / 1000), converted: true };
  }

  // Percentage conversions (e.g. fraction 0.98 to 98)
  if (src === 'ratio' && tgt === 'percentage') {
    return { value: Math.round(value * 100 * 100) / 100, converted: true };
  }

  // If no recognized conversion exists, retain value and note unconverted
  return { value, converted: false };
}

/**
 * Validates physiological plausibility and sets data quality classification.
 */
export function validatePhysiologicalRange(
  metric: HealthMetricType,
  value: number
): { isValid: boolean; quality: DataQualityClassification; warning?: string } {
  switch (metric) {
    case 'HEART_RATE':
      if (value < 30 || value > 250) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Heart rate ${value} bpm is outside physiological human threshold (30-250 bpm)`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'RESTING_HEART_RATE':
      if (value < 25 || value > 160) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Resting heart rate ${value} bpm is outside expected resting threshold (25-160 bpm)`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'SPO2':
      if (value < 50 || value > 100) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `SpO2 ${value}% is outside plausible sensor bounds (50-100%)`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'BODY_TEMPERATURE':
      if (value < 30.0 || value > 44.0) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Body temperature ${value}°C is outside compatible physiological limits (30-44°C)`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'STEPS':
      if (value < 0 || value > 200_000) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Step count ${value} is outside non-negative single-day plausible limits`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'SLEEP_DURATION':
      if (value < 0 || value > 86400) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Sleep duration ${value} seconds exceeds a 24-hour single session`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'BLOOD_PRESSURE_SYSTOLIC':
      if (value < 50 || value > 300) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Systolic BP ${value} mmHg outside physiological range`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    case 'BLOOD_PRESSURE_DIASTOLIC':
      if (value < 30 || value > 200) {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Diastolic BP ${value} mmHg outside physiological range`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };

    default:
      if (value < 0 && metric !== 'HRV') {
        return {
          isValid: false,
          quality: 'QUESTIONABLE',
          warning: `Negative value for non-negative metric ${metric}`,
        };
      }
      return { isValid: true, quality: 'MEASURED' };
  }
}

/**
 * Computes a deterministic deduplication hash for an observation.
 * Form: sha256(userId + ":" + providerId + ":" + metric + ":" + startTime + ":" + externalRecordId)
 */
export function computeDeduplicationHash(params: {
  userId: string;
  providerId: WearableProviderId;
  metric: HealthMetricType;
  startTime: string;
  externalRecordId: string;
}): string {
  const payload = [
    params.userId,
    params.providerId,
    params.metric,
    params.startTime,
    params.externalRecordId,
  ].join(':');

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Normalizes a raw observation from any connector into a standardized, validated observation.
 */
export function normalizeObservation(params: {
  userId: string;
  tenantId?: string;
  providerId: WearableProviderId;
  externalRecordId: string;
  metric: HealthMetricType;
  rawValue: number;
  rawUnit: string;
  startTime: string | Date;
  endTime?: string | Date;
  timezoneOffsetMinutes?: number;
  deviceModel?: string;
  metadata?: Record<string, any>;
}): NormalizedObservation {
  const targetUnit = TARGET_METRIC_UNITS[params.metric];
  const { value: normalizedValue } = convertUnit(
    params.rawValue,
    params.rawUnit,
    targetUnit
  );

  const startIso =
    params.startTime instanceof Date
      ? params.startTime.toISOString()
      : new Date(params.startTime).toISOString();

  const endIso = params.endTime
    ? params.endTime instanceof Date
      ? params.endTime.toISOString()
      : new Date(params.endTime).toISOString()
    : startIso;

  // Verify temporal ordering
  if (new Date(startIso).getTime() > new Date(endIso).getTime()) {
    throw new NormalizationError(
      `Observation startTime (${startIso}) cannot be later than endTime (${endIso})`
    );
  }

  // Validate range & assign quality
  const rangeCheck = validatePhysiologicalRange(params.metric, normalizedValue);

  const id = computeDeduplicationHash({
    userId: params.userId,
    providerId: params.providerId,
    metric: params.metric,
    startTime: startIso,
    externalRecordId: params.externalRecordId,
  });

  return {
    id,
    userId: params.userId,
    tenantId: params.tenantId,
    providerId: params.providerId,
    externalRecordId: params.externalRecordId,
    metric: params.metric,
    category: METRIC_TO_CATEGORY[params.metric],
    value: normalizedValue,
    unit: targetUnit,
    rawSourceValue: params.rawValue,
    rawSourceUnit: params.rawUnit,
    startTime: startIso,
    endTime: endIso,
    timezoneOffsetMinutes: params.timezoneOffsetMinutes,
    dataQuality: rangeCheck.quality,
    deviceModel: params.deviceModel,
    metadata: {
      ...params.metadata,
      ...(rangeCheck.warning ? { warning: rangeCheck.warning } : {}),
    },
    syncedAt: new Date().toISOString(),
  };
}
