/**
 * MediMate AI — Medical Safety Policy & Clinical Guardrails
 * Phase 8: Enforces clinical safety, medication prescribing restrictions,
 * non-diagnostic boundaries, and transparent uncertainty acknowledgment.
 */

import { getRegionalEmergencyDetails } from '@/lib/clinical/emergency-guidance';
import { HealthQueryIntent } from './types';

export interface SafetyCheckResult {
  isSafe: boolean;
  isEmergency: boolean;
  emergencyGuidance?: string;
  violations: string[];
  disclaimers: string[];
  recommendedClinicianPrompts: string[];
}

export class HealthSafetyPolicy {
  /**
   * Evaluates a user message or proposed assistant response against clinical safety guardrails.
   */
  static evaluateSafety(params: {
    query?: string;
    intent: HealthQueryIntent;
    regionCode?: string;
    proposedResponse?: string;
  }): SafetyCheckResult {
    const { query = '', intent, regionCode, proposedResponse = '' } = params;
    const violations: string[] = [];
    const disclaimers: string[] = [];
    const recommendedClinicianPrompts: string[] = [];

    const isEmergency = intent === 'EMERGENCY_QUERY' || (query && /\b(chest pain|cannot breathe|heart attack|stroke)\b/i.test(query));
    let emergencyGuidance: string | undefined;

    if (isEmergency) {
      const details = getRegionalEmergencyDetails(regionCode);
      emergencyGuidance = `${details.instructions} ${details.disclaimer}`;
      disclaimers.push(emergencyGuidance);
      return {
        isSafe: true,
        isEmergency: true,
        emergencyGuidance,
        violations: [],
        disclaimers,
        recommendedClinicianPrompts: [
          'Seek immediate in-person emergency medical care or call emergency services.',
        ],
      };
    }

    // Medication prescribing restrictions
    const medicationChangePatterns = [
      /\b(increase your dose|decrease your dose|stop taking|discontinue|take \d+\s*mg instead)\b/i,
      /\b(i prescribe|i recommend you take|start taking \w+)\b/i,
    ];
    for (const pattern of medicationChangePatterns) {
      if (pattern.test(proposedResponse)) {
        violations.push('Model attempted to prescribe or modify medication dosing.');
      }
    }

    // Diagnostic assertion check
    const diagnosticAssertionPatterns = [
      /\byou (have|are suffering from|definitely have) (diabetes|cancer|hypertension|cardiac arrest)\b/i,
      /\bmy diagnosis is\b/i,
    ];
    for (const pattern of diagnosticAssertionPatterns) {
      if (pattern.test(proposedResponse)) {
        violations.push('Model attempted to provide a definitive clinical diagnosis.');
      }
    }

    // Intent-specific standard disclaimers
    if (intent === 'WEARABLE_TREND_INTERPRETATION') {
      disclaimers.push(
        'Wearable sensor observations are consumer-grade measurements intended for general health tracking and do not constitute a diagnostic medical test.'
      );
      recommendedClinicianPrompts.push(
        'Are there specific symptoms accompanying these wearable changes?',
        'Would a formal clinical evaluation or laboratory test be indicated?'
      );
    } else if (intent === 'MEDICATION_INQUIRY') {
      disclaimers.push(
        'MediMate AI cannot recommend, alter, or prescribe medications. Any changes to medication or dosage must be discussed with your prescribing physician or pharmacist.'
      );
      recommendedClinicianPrompts.push(
        'What was the intended dosage and schedule for this medication?',
        'Are there any potential drug interactions with other medications I take?'
      );
    } else if (intent === 'DOCUMENT_EXPLANATION') {
      disclaimers.push(
        'Medical document explanations are educational summaries based on provided records. Reference ranges and clinical implications should be confirmed with your doctor.'
      );
      recommendedClinicianPrompts.push(
        'What do out-of-range biomarkers mean in the context of my complete medical history?',
        'Is any follow-up testing recommended?'
      );
    }

    return {
      isSafe: violations.length === 0,
      isEmergency: false,
      violations,
      disclaimers,
      recommendedClinicianPrompts,
    };
  }

  /**
   * Generates a safe response when clinical evidence is absent, conflicting, or stale.
   */
  static buildAbstentionResponse(reason: 'NO_DATA' | 'CONFLICTING_DATA' | 'INSUFFICIENT_SAMPLE'): string {
    switch (reason) {
      case 'NO_DATA':
        return 'I do not have access to any recorded measurements or uploaded medical documents matching this question. Please upload your medical records or synchronize your health sensors to view relevant information.';
      case 'CONFLICTING_DATA':
        return 'The available records contain conflicting measurements from different dates or reporting providers. Both values have been preserved in your record history, but a healthcare provider should review them to clarify the discrepancy.';
      case 'INSUFFICIENT_SAMPLE':
        return 'There are not enough continuous observations recorded during this period to calculate a reliable trend. At least several days of continuous telemetry are required to avoid misleading conclusions.';
    }
  }
}
