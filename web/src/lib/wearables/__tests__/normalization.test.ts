import { describe, it, expect } from 'vitest';
import {
  convertUnit,
  validatePhysiologicalRange,
  computeDeduplicationHash,
  normalizeObservation,
  NormalizationError,
} from '../normalization';

describe('Wearable Data Normalization & Quality Verification (Phase 7)', () => {
  describe('Unit Conversions', () => {
    it('accurately converts miles to meters', () => {
      const { value, converted } = convertUnit(3.5, 'miles', 'meters');
      expect(converted).toBe(true);
      expect(value).toBe(5632.7);
    });

    it('accurately converts kilometers to meters', () => {
      const { value, converted } = convertUnit(5.2, 'km', 'meters');
      expect(converted).toBe(true);
      expect(value).toBe(5200);
    });

    it('accurately converts pounds to kilograms', () => {
      const { value, converted } = convertUnit(170, 'lbs', 'kg');
      expect(converted).toBe(true);
      expect(value).toBe(77.11);
    });

    it('accurately converts Fahrenheit to Celsius', () => {
      const { value, converted } = convertUnit(98.6, 'Fahrenheit', 'celsius');
      expect(converted).toBe(true);
      expect(value).toBe(37.0);
    });

    it('accurately converts minutes to seconds', () => {
      const { value, converted } = convertUnit(45, 'minutes', 'seconds');
      expect(converted).toBe(true);
      expect(value).toBe(2700);
    });
  });

  describe('Physiological Boundary Checks', () => {
    it('accepts normal physiological heart rates as MEASURED', () => {
      const check = validatePhysiologicalRange('HEART_RATE', 72);
      expect(check.isValid).toBe(true);
      expect(check.quality).toBe('MEASURED');
    });

    it('flags unphysiological heart rates as QUESTIONABLE', () => {
      const lowCheck = validatePhysiologicalRange('HEART_RATE', 15);
      expect(lowCheck.isValid).toBe(false);
      expect(lowCheck.quality).toBe('QUESTIONABLE');
      expect(lowCheck.warning).toContain('outside physiological human threshold');

      const highCheck = validatePhysiologicalRange('HEART_RATE', 290);
      expect(highCheck.isValid).toBe(false);
      expect(highCheck.quality).toBe('QUESTIONABLE');
    });

    it('flags sensor artifact SpO2 (<50%) as QUESTIONABLE', () => {
      const check = validatePhysiologicalRange('SPO2', 42);
      expect(check.isValid).toBe(false);
      expect(check.quality).toBe('QUESTIONABLE');
      expect(check.warning).toContain('outside plausible sensor bounds');
    });

    it('validates step counts and rejects negative values', () => {
      expect(validatePhysiologicalRange('STEPS', 10500).isValid).toBe(true);
      expect(validatePhysiologicalRange('STEPS', -100).isValid).toBe(false);
    });
  });

  describe('Deterministic Deduplication Keys', () => {
    it('produces identical SHA-256 hash for identical biometric observations', () => {
      const hash1 = computeDeduplicationHash({
        userId: 'user_42',
        providerId: 'fitbit',
        metric: 'RESTING_HEART_RATE',
        startTime: '2026-11-03T04:00:00.000Z',
        externalRecordId: 'fb_rhr_2026-11-03',
      });

      const hash2 = computeDeduplicationHash({
        userId: 'user_42',
        providerId: 'fitbit',
        metric: 'RESTING_HEART_RATE',
        startTime: '2026-11-03T04:00:00.000Z',
        externalRecordId: 'fb_rhr_2026-11-03',
      });

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
    });

    it('produces different hashes when external record ID or user differs', () => {
      const hash1 = computeDeduplicationHash({
        userId: 'user_A',
        providerId: 'fitbit',
        metric: 'RESTING_HEART_RATE',
        startTime: '2026-11-03T04:00:00.000Z',
        externalRecordId: 'rec_01',
      });

      const hash2 = computeDeduplicationHash({
        userId: 'user_B',
        providerId: 'fitbit',
        metric: 'RESTING_HEART_RATE',
        startTime: '2026-11-03T04:00:00.000Z',
        externalRecordId: 'rec_01',
      });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Observation Normalization Pipeline', () => {
    it('normalizes raw observation and validates temporal boundaries', () => {
      const obs = normalizeObservation({
        userId: 'user_101',
        providerId: 'fitbit',
        externalRecordId: 'ext_dist_999',
        metric: 'DISTANCE',
        rawValue: 4.2,
        rawUnit: 'miles',
        startTime: '2026-11-03T08:00:00.000Z',
        endTime: '2026-11-03T09:00:00.000Z',
        deviceModel: 'Fitbit Charge 6',
      });

      expect(obs.metric).toBe('DISTANCE');
      expect(obs.unit).toBe('meters');
      expect(obs.value).toBe(6759.24);
      expect(obs.rawSourceValue).toBe(4.2);
      expect(obs.rawSourceUnit).toBe('miles');
      expect(obs.category).toBe('ACTIVITY');
      expect(obs.dataQuality).toBe('MEASURED');
    });

    it('throws NormalizationError if startTime is later than endTime', () => {
      expect(() =>
        normalizeObservation({
          userId: 'user_101',
          providerId: 'fitbit',
          externalRecordId: 'bad_time_01',
          metric: 'HEART_RATE',
          rawValue: 70,
          rawUnit: 'bpm',
          startTime: '2026-11-03T10:00:00.000Z',
          endTime: '2026-11-03T09:00:00.000Z',
        })
      ).toThrow(NormalizationError);
    });
  });
});
