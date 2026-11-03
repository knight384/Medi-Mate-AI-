/**
 * MediMate AI — Health Intelligence & Companion Core Type Definitions
 * Phase 8: Evolving into an intelligent, conversational, and personalized health companion.
 */

import { HealthMetricType, DataQualityClassification } from '@/lib/wearables/types';

export type ContextSourceType =
  | 'CLINICAL_DOCUMENT'
  | 'LABORATORY_REPORT'
  | 'CONSUMER_WEARABLE'
  | 'PATIENT_ENTERED'
  | 'DERIVED_SUMMARY'
  | 'CONVERSATION_MEMORY';

export type HealthQueryIntent =
  | 'GENERAL_EDUCATION'
  | 'DOCUMENT_EXPLANATION'
  | 'PERSONAL_RECORD_QUERY'
  | 'WEARABLE_TREND_INTERPRETATION'
  | 'MEDICATION_INQUIRY'
  | 'SYMPTOM_ASSESSMENT'
  | 'EMERGENCY_QUERY'
  | 'UNSUPPORTED';

export type MemoryCategory =
  | 'PREFERENCE'
  | 'GOAL'
  | 'TOPIC'
  | 'CONVERSATION_SUMMARY';

export type AlertCategory =
  | 'INFORMATIONAL_TREND'
  | 'MEASUREMENT_REMINDER'
  | 'ACTIVITY_GOAL'
  | 'APPOINTMENT';

export interface DocumentEvidenceCitation {
  documentId: string;
  documentName: string;
  pageNumber: number;
  sectionHeading: string;
  excerpt: string;
  relevanceScore?: number;
}

export interface ObservationEvidenceCitation {
  observationId: string;
  metric: HealthMetricType | string;
  value: number;
  unit: string;
  timestamp: string;
  providerId: string;
  isDerived: boolean;
  quality: DataQualityClassification | string;
}

export interface TrendEvidenceCitation {
  metric: HealthMetricType | string;
  reportingPeriod: string;
  sampleCount: number;
  baselinePeriod?: string;
  changeValue?: number;
  changePercentage?: number;
  calculationMethod: string;
  limitations?: string[];
}

export interface StructuredHealthCitations {
  documents: DocumentEvidenceCitation[];
  observations: ObservationEvidenceCitation[];
  trends: TrendEvidenceCitation[];
}

export interface StructuredHealthContext {
  userId: string;
  retrievedAt: string;
  medicalHistory: {
    recordedConditions: string[];
    allergies: string[];
    medications: string[];
    procedures: string[];
  };
  laboratoryResults: {
    testName: string;
    value: string | number;
    unit: string;
    referenceRange?: string;
    date: string;
    documentId?: string;
  }[];
  wearableSummaries: {
    providerId: string;
    period: string;
    startDate: string;
    endDate: string;
    metrics: Record<string, {
      avg: number;
      min: number;
      max: number;
      count: number;
      unit: string;
    }>;
  }[];
  recentObservations: ObservationEvidenceCitation[];
  userGoalsAndPreferences: {
    goals: string[];
    preferences: Record<string, string>;
    memorySummaries: string[];
  };
  ragContextSnippets: string[];
  dataQualityNotes: string[];
}

export interface LongitudinalComparisonResult {
  metric: string;
  unit: string;
  periodA: {
    label: string;
    startDate: string;
    endDate: string;
    count: number;
    avg: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
  };
  periodB: {
    label: string;
    startDate: string;
    endDate: string;
    count: number;
    avg: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
  };
  delta: {
    absoluteChange: number;
    percentageChange: number;
    direction: 'INCREASE' | 'DECREASE' | 'STABLE';
    isMeaningfulChange: boolean; // Based on threshold/stdDev, purely observational
  };
  dataQuality: {
    insufficientData: boolean;
    providerConsistency: boolean;
    missingDaysCount: number;
    limitations: string[];
  };
  nonDiagnosticDisclaimer: string;
}

export interface HealthInsight {
  id: string;
  userId: string;
  category: 'ACTIVITY' | 'SLEEP' | 'HEART' | 'LABS' | 'COMBINED';
  title: string;
  description: string;
  dateInterval: {
    startDate: string;
    endDate: string;
  };
  supportingEvidence: {
    observationIds: string[];
    metrics: string[];
    sampleSize: number;
  };
  confidenceScore: number; // 0.0 to 1.0
  evidenceCoverage: 'HIGH' | 'MEDIUM' | 'LOW';
  limitations: string[];
  safetyClassification: 'INFORMATIONAL_OBSERVATION' | 'NON_DIAGNOSTIC_TREND';
  generatedAt: string;
}

export interface HealthCompanionResponse {
  answer: string;
  intent: HealthQueryIntent;
  citations: StructuredHealthCitations;
  supportingFacts: string[];
  clinicalExplanations?: string;
  limitations: string[];
  clinicianDiscussionPrompts?: string[];
  emergencyGuidanceDelivered?: boolean;
}
