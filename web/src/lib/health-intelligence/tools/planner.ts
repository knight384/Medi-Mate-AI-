/**
 * MediMate AI — Health Information Retrieval Planner
 * Phase 8: Analyzes user query, determines intent, plans allowlisted tool operations,
 * and orchestrates context collection safely.
 */

import { detectEmergencyKeywords } from '@/lib/clinical/emergency-guidance';
import { HealthQueryIntent } from '../types';
import { HealthToolName, HealthToolRegistry, ToolExecutionContext } from './tool-registry';

export interface PlannedOperation {
  tool: HealthToolName;
  args: Record<string, unknown>;
  reason: string;
}

export interface RetrievalPlan {
  intent: HealthQueryIntent;
  isEmergency: boolean;
  operations: PlannedOperation[];
}

export class HealthRetrievalPlanner {
  /**
   * Classifies query intent based on linguistic and clinical patterns.
   */
  static classifyIntent(query: string): HealthQueryIntent {
    const q = query.trim().toLowerCase();

    // 1. Emergency detection takes absolute precedence
    if (detectEmergencyKeywords(q)) {
      return 'EMERGENCY_QUERY';
    }

    // 2. Medication inquiry
    if (/\b(medication|dose|dosage|pills|prescrib|take my meds|metformin|lisinopril|statin|antibiotic)\b/i.test(q)) {
      return 'MEDICATION_INQUIRY';
    }

    // 3. Wearable trend / continuous telemetry
    if (/\b(resting heart rate|hrv|steps|sleep|activity|calories|heart rate variability|spo2|wearable|fitbit|oura)\b/i.test(q)) {
      return 'WEARABLE_TREND_INTERPRETATION';
    }

    // 4. Document / lab test explanation
    if (/\b(blood test|lab result|hba1c|cholesterol|document|report|pdf|uploaded|biomarker|lab)\b/i.test(q)) {
      return 'DOCUMENT_EXPLANATION';
    }

    // 5. Personal record query
    if (/\b(my medical history|conditions|allergies|surgeries|procedures|records|my health)\b/i.test(q)) {
      return 'PERSONAL_RECORD_QUERY';
    }

    // 6. Symptom assessment
    if (/\b(headache|fever|cough|sore throat|rash|nausea|tired|fatigue|dizzy)\b/i.test(q)) {
      return 'SYMPTOM_ASSESSMENT';
    }

    // Default: General health education
    return 'GENERAL_EDUCATION';
  }

  /**
   * Creates an execution plan of allowlisted read-only tool calls.
   */
  static planRetrieval(query: string): RetrievalPlan {
    const intent = this.classifyIntent(query);
    const isEmergency = intent === 'EMERGENCY_QUERY';
    const operations: PlannedOperation[] = [];

    if (isEmergency) {
      // Do not delay emergency guidance with unnecessary database lookups
      return { intent, isEmergency, operations };
    }

    const q = query.toLowerCase();

    // Check for period comparisons
    if (/\b(compare|trend|change|changed|higher|lower|difference|versus|vs)\b/i.test(q)) {
      if (/\b(heart rate|rhr|resting)\b/i.test(q)) {
        operations.push({
          tool: 'compare_health_periods',
          args: { metric: 'RESTING_HEART_RATE', periodType: 'WEEK_VS_PREVIOUS' },
          reason: 'Compare resting heart rate across past two weeks',
        });
      } else if (/\b(sleep)\b/i.test(q)) {
        operations.push({
          tool: 'compare_health_periods',
          args: { metric: 'SLEEP_DURATION', periodType: 'WEEK_VS_PREVIOUS' },
          reason: 'Compare sleep duration across past two weeks',
        });
      } else if (/\b(step|activity)\b/i.test(q)) {
        operations.push({
          tool: 'compare_health_periods',
          args: { metric: 'STEPS', periodType: 'WEEK_VS_PREVIOUS' },
          reason: 'Compare daily steps across past two weeks',
        });
      }
    }

    // Intent-specific retrieval operations
    switch (intent) {
      case 'DOCUMENT_EXPLANATION':
        operations.push({
          tool: 'get_latest_lab_results',
          args: {},
          reason: 'Retrieve recent laboratory test records and citations',
        });
        operations.push({
          tool: 'get_document_summary',
          args: {},
          reason: 'Retrieve summarized clinical document context',
        });
        break;

      case 'WEARABLE_TREND_INTERPRETATION':
        if (/\b(heart rate|rhr)\b/i.test(q) && !operations.some((o) => o.tool === 'compare_health_periods')) {
          operations.push({
            tool: 'get_heart_rate_history',
            args: { days: 14 },
            reason: 'Retrieve resting heart rate time series',
          });
        }
        if (/\b(sleep)\b/i.test(q) && !operations.some((o) => o.tool === 'compare_health_periods')) {
          operations.push({
            tool: 'get_sleep_history',
            args: { days: 14 },
            reason: 'Retrieve sleep history observations',
          });
        }
        if (/\b(step|activity|calorie)\b/i.test(q) && !operations.some((o) => o.tool === 'compare_health_periods')) {
          operations.push({
            tool: 'get_activity_history',
            args: { days: 14 },
            reason: 'Retrieve activity observations',
          });
        }
        if (/\b(hrv)\b/i.test(q)) {
          operations.push({
            tool: 'get_hrv_history',
            args: { days: 14 },
            reason: 'Retrieve HRV observations',
          });
        }
        operations.push({
          tool: 'get_wearable_summary',
          args: { period: 'WEEKLY' },
          reason: 'Retrieve pre-calculated weekly telemetry summary',
        });
        break;

      case 'PERSONAL_RECORD_QUERY':
        operations.push({
          tool: 'get_medical_history',
          args: {},
          reason: 'Retrieve patient personal medical history',
        });
        operations.push({
          tool: 'get_user_health_goals',
          args: {},
          reason: 'Retrieve user confirmed goals and preferences',
        });
        break;

      case 'MEDICATION_INQUIRY':
        operations.push({
          tool: 'get_medical_history',
          args: {},
          reason: 'Inspect recorded medications in patient profile',
        });
        operations.push({
          tool: 'get_document_section',
          args: { sectionTopic: 'medications and prescriptions' },
          reason: 'Check uploaded medical documents for documented medications',
        });
        break;

      case 'SYMPTOM_ASSESSMENT':
      case 'GENERAL_EDUCATION':
      default:
        // Keep baseline context; tools not strictly required unless specific metrics are mentioned
        break;
    }

    return { intent, isEmergency, operations };
  }

  /**
   * Orchestrates the planned tool operations and aggregates results into a clean dictionary.
   */
  static async executePlan(
    plan: RetrievalPlan,
    ctx: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    for (const op of plan.operations) {
      const res = await HealthToolRegistry.executeTool(op.tool, ctx, op.args);
      if (res.success) {
        results[op.tool] = res.data;
      }
    }

    return results;
  }
}
