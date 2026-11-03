import { describe, it, expect } from 'vitest';
import { HealthSafetyPolicy } from '../safety-policy';

describe('HealthSafetyPolicy', () => {
  it('delivers emergency guidance for region-specific emergency numbers', () => {
    const resIndia = HealthSafetyPolicy.evaluateSafety({
      query: 'Patient is having sudden severe chest pain',
      intent: 'EMERGENCY_QUERY',
      regionCode: 'IN',
    });

    expect(resIndia.isEmergency).toBe(true);
    expect(resIndia.emergencyGuidance).toContain('112');
    expect(resIndia.emergencyGuidance).toContain('cannot automatically dispatch');

    const resUS = HealthSafetyPolicy.evaluateSafety({
      query: 'Shortness of breath',
      intent: 'EMERGENCY_QUERY',
      regionCode: 'US',
    });
    expect(resUS.emergencyGuidance).toContain('911');
  });

  it('detects violations when proposed response attempts medication dosing adjustments', () => {
    const check = HealthSafetyPolicy.evaluateSafety({
      query: 'My blood pressure was high',
      intent: 'MEDICATION_INQUIRY',
      proposedResponse: 'You should increase your dose of lisinopril to 20 mg instead.',
    });

    expect(check.isSafe).toBe(false);
    expect(check.violations.some((v) => v.includes('medication dosing'))).toBe(true);
  });

  it('detects violations when proposed response attempts definitive diagnosis', () => {
    const check = HealthSafetyPolicy.evaluateSafety({
      query: 'What is this rash?',
      intent: 'SYMPTOM_ASSESSMENT',
      proposedResponse: 'My diagnosis is that you definitely have diabetes-related dermatitis.',
    });

    expect(check.isSafe).toBe(false);
    expect(check.violations.some((v) => v.includes('clinical diagnosis'))).toBe(true);
  });

  it('returns clean abstention when evidence is absent', () => {
    const noData = HealthSafetyPolicy.buildAbstentionResponse('NO_DATA');
    expect(noData).toContain('do not have access to any recorded measurements');

    const conflicting = HealthSafetyPolicy.buildAbstentionResponse('CONFLICTING_DATA');
    expect(conflicting).toContain('conflicting measurements');
  });
});
