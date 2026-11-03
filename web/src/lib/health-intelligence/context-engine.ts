/**
 * MediMate AI — Unified Health Context Engine
 * Phase 8: Central health-context aggregation layer uniting clinical documents (via RAG),
 * structured time-series observations, wearable daily/weekly summaries, and user memory.
 */

import prisma from '@/lib/prisma';
import { ragClient } from '@/lib/rag/rag-client';
import { NormalizedObservation, WearableSummary } from '@/lib/wearables/types';
import { HealthMemoryService } from './memory';
import {
  ObservationEvidenceCitation,
  StructuredHealthContext,
} from './types';

export interface HealthContextOptions {
  query?: string;
  startDate?: Date;
  endDate?: Date;
  metricFilters?: string[];
  includeRag?: boolean;
  maxObservations?: number;
}

export class HealthContextEngine {
  /**
   * Aggregates authorized clinical, wearable, and conversational health context for a user.
   */
  static async aggregateContext(
    userId: string,
    options: HealthContextOptions = {}
  ): Promise<StructuredHealthContext> {
    const {
      query,
      startDate = new Date(Date.now() - 30 * 86400000), // Default 30 days
      endDate = new Date(),
      metricFilters,
      includeRag = true,
      maxObservations = 50,
    } = options;

    const retrievedAt = new Date().toISOString();
    const dataQualityNotes: string[] = [];

    // 1. Fetch structured HealthData (personal info, wearable observations, summaries)
    let rawHealthRecords: any[] = [];
    try {
      rawHealthRecords = await prisma.healthData.findMany({
        where: {
          authorId: userId,
          createdAt: { gte: startDate, lte: endDate },
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch {
      rawHealthRecords = [];
    }

    // Extract patient info & history
    const personalInfoRecords = rawHealthRecords.filter((r) => r.type === 'PERSONAL_INFO');
    const medicalHistory = {
      recordedConditions: [] as string[],
      allergies: [] as string[],
      medications: [] as string[],
      procedures: [] as string[],
    };

    for (const rec of personalInfoRecords) {
      const data = rec.data as any;
      if (data?.conditions && Array.isArray(data.conditions)) {
        medicalHistory.recordedConditions.push(...data.conditions);
      }
      if (data?.allergies && Array.isArray(data.allergies)) {
        medicalHistory.allergies.push(...data.allergies);
      }
      if (data?.medications && Array.isArray(data.medications)) {
        medicalHistory.medications.push(...data.medications);
      }
      if (data?.procedures && Array.isArray(data.procedures)) {
        medicalHistory.procedures.push(...data.procedures);
      }
    }

    // Extract wearable observations
    const observationRecords = rawHealthRecords.filter((r) => r.type === 'WEARABLE_OBSERVATION');
    const rawObs = observationRecords
      .map((r) => r.data as unknown as NormalizedObservation)
      .filter((obs) => obs && (metricFilters ? metricFilters.includes(obs.metric) : true))
      .slice(0, maxObservations);

    const recentObservations: ObservationEvidenceCitation[] = rawObs.map((obs) => ({
      observationId: obs.id,
      metric: obs.metric,
      value: obs.value,
      unit: obs.unit,
      timestamp: obs.startTime,
      providerId: obs.providerId,
      isDerived: false,
      quality: obs.dataQuality,
    }));

    // Extract wearable summaries
    const summaryRecords = rawHealthRecords.filter((r) => r.type === 'WEARABLE_SUMMARY');
    const wearableSummaries = summaryRecords
      .map((r) => r.data as unknown as WearableSummary)
      .filter((s) => Boolean(s))
      .map((s) => ({
        providerId: s.providerId,
        period: s.period,
        startDate: s.startDate,
        endDate: s.endDate,
        metrics: Object.entries(s.metrics || {}).reduce((acc, [k, v]) => {
          acc[k] = {
            avg: v.avg ?? 0,
            min: v.min ?? 0,
            max: v.max ?? 0,
            count: v.count,
            unit: v.unit,
          };
          return acc;
        }, {} as Record<string, { avg: number; min: number; max: number; count: number; unit: string }>),
      }));

    // 2. Fetch User-Controlled Memory (Goals & Preferences)
    const activeMemories = await HealthMemoryService.getActiveMemories(userId);
    const userGoals = activeMemories
      .filter((m) => m.category === 'GOAL')
      .map((m) => m.content);
    const userPreferences = activeMemories
      .filter((m) => m.category === 'PREFERENCE')
      .reduce((acc, m) => {
        acc[m.key] = m.content;
        return acc;
      }, {} as Record<string, string>);
    const memorySummaries = activeMemories
      .filter((m) => m.category === 'CONVERSATION_SUMMARY' || m.category === 'TOPIC')
      .map((m) => m.content);

    // 3. Query RAG microservice if query provided and enabled
    const ragContextSnippets: string[] = [];
    const laboratoryResults: StructuredHealthContext['laboratoryResults'] = [];

    if (includeRag && query && query.trim().length > 0) {
      try {
        const ragRes = await ragClient.queryRAG({
          userId,
          query,
          topK: 4,
        });

        if (ragRes?.citations) {
          for (const cit of ragRes.citations) {
            ragContextSnippets.push(
              `[Document: ${cit.document_name}, Page: ${cit.page_number}, Section: ${cit.section_heading}]:\n${cit.excerpt}`
            );

            // Extract any structured lab mention if discernible
            const labMatch = cit.excerpt.match(/\b(HbA1c|Glucose|Cholesterol|Triglycerides|Hemoglobin|WBC|TSH|Creatinine|BUN)\s*[:=]?\s*([0-9.]+)\s*([a-zA-Z/%]+)/i);
            if (labMatch) {
              laboratoryResults.push({
                testName: labMatch[1],
                value: parseFloat(labMatch[2]) || labMatch[2],
                unit: labMatch[3],
                date: cit.document_name.includes('202') ? cit.document_name.slice(0, 10) : 'Recent Report',
                documentId: cit.document_id,
              });
            }
          }
        }
      } catch {
        dataQualityNotes.push('RAG microservice was temporarily unreachable; relying on direct structured measurements and memories.');
      }
    }

    if (recentObservations.length === 0 && wearableSummaries.length === 0) {
      dataQualityNotes.push('No wearable measurements recorded for the selected interval.');
    }

    return {
      userId,
      retrievedAt,
      medicalHistory,
      laboratoryResults,
      wearableSummaries,
      recentObservations,
      userGoalsAndPreferences: {
        goals: userGoals,
        preferences: userPreferences,
        memorySummaries,
      },
      ragContextSnippets,
      dataQualityNotes,
    };
  }

  /**
   * Formats aggregated context into a bounded clinical summary for the LLM prompt.
   */
  static formatForPrompt(ctx: StructuredHealthContext): string {
    const sections: string[] = [];

    if (ctx.medicalHistory.recordedConditions.length > 0 || ctx.medicalHistory.medications.length > 0) {
      sections.push(
        `### Recorded Patient Medical History:\n- Conditions: ${ctx.medicalHistory.recordedConditions.join(', ') || 'None reported'}\n- Medications: ${ctx.medicalHistory.medications.join(', ') || 'None reported'}\n- Allergies: ${ctx.medicalHistory.allergies.join(', ') || 'None reported'}`
      );
    }

    if (ctx.userGoalsAndPreferences.goals.length > 0) {
      sections.push(
        `### User-Confirmed Health Goals:\n- ${ctx.userGoalsAndPreferences.goals.join('\n- ')}`
      );
    }

    if (ctx.laboratoryResults.length > 0) {
      const labs = ctx.laboratoryResults
        .map((l) => `- ${l.testName}: ${l.value} ${l.unit} (Date: ${l.date}${l.referenceRange ? `, Ref: ${l.referenceRange}` : ''})`)
        .join('\n');
      sections.push(`### Extracted Laboratory Results:\n${labs}`);
    }

    if (ctx.wearableSummaries.length > 0) {
      const summaries = ctx.wearableSummaries
        .map((s) => {
          const metricsStr = Object.entries(s.metrics)
            .map(([m, val]) => `${m}: avg ${val.avg} ${val.unit} (min ${val.min}, max ${val.max}, count ${val.count})`)
            .join('; ');
          return `- ${s.providerId.toUpperCase()} [${s.period}: ${s.startDate} to ${s.endDate}]: ${metricsStr}`;
        })
        .join('\n');
      sections.push(`### Wearable Telemetry Summaries (Non-Diagnostic Consumer Data):\n${summaries}`);
    } else if (ctx.recentObservations.length > 0) {
      const obsStr = ctx.recentObservations
        .slice(0, 10)
        .map((o) => `- ${o.metric}: ${o.value} ${o.unit} at ${o.timestamp.slice(0, 16)} (${o.providerId})`)
        .join('\n');
      sections.push(`### Recent Continuous Observations (Sample):\n${obsStr}`);
    }

    if (ctx.ragContextSnippets.length > 0) {
      sections.push(`### Authorized Medical Records Snippets (RAG):\n${ctx.ragContextSnippets.join('\n\n')}`);
    }

    if (ctx.dataQualityNotes.length > 0) {
      sections.push(`### Context Limitations & Missing Information:\n- ${ctx.dataQualityNotes.join('\n- ')}`);
    }

    return sections.join('\n\n');
  }
}
