/**
 * MediMate AI — Evidence-Grounded Companion Response Generator
 * Phase 8: Synthesizes structured clinical documents, wearable telemetry, and longitudinal trends
 * into structured responses with citations and safety boundaries.
 */

import { HealthRetrievalPlanner } from './tools/planner';
import { HealthContextEngine } from './context-engine';
import { HealthSafetyPolicy } from './safety-policy';
import {
  DocumentEvidenceCitation,
  HealthCompanionResponse,
  ObservationEvidenceCitation,
  StructuredHealthCitations,
  TrendEvidenceCitation,
} from './types';

export class CompanionResponseGenerator {
  /**
   * Generates a fully grounded health companion response with citations and clinical safety boundaries.
   */
  static async generateCompanionResponse(params: {
    userId: string;
    query: string;
    regionCode?: string;
  }): Promise<HealthCompanionResponse> {
    const { userId, query, regionCode } = params;

    // 1. Plan retrieval and classify intent
    const plan = HealthRetrievalPlanner.planRetrieval(query);

    // 2. Immediate emergency short-circuit
    if (plan.isEmergency) {
      const safety = HealthSafetyPolicy.evaluateSafety({
        query,
        intent: 'EMERGENCY_QUERY',
        regionCode,
      });

      return {
        answer: safety.emergencyGuidance || 'Please seek immediate emergency medical care.',
        intent: 'EMERGENCY_QUERY',
        citations: { documents: [], observations: [], trends: [] },
        supportingFacts: ['Emergency clinical symptoms detected in user prompt.'],
        limitations: ['MediMate AI cannot dispatch emergency responders.'],
        clinicianDiscussionPrompts: safety.recommendedClinicianPrompts,
        emergencyGuidanceDelivered: true,
      };
    }

    // 3. Execute planned tools
    const toolResults = await HealthRetrievalPlanner.executePlan(plan, { userId });

    // 4. Aggregate health context
    const context = await HealthContextEngine.aggregateContext(userId, {
      query,
      includeRag: true,
      maxObservations: 20,
    });

    // 5. Build structured citations
    const docCitations: DocumentEvidenceCitation[] = [];
    const labRes = toolResults['get_latest_lab_results'] as any;
    const docSummaryRes = toolResults['get_document_summary'] as any;

    if (labRes?.citations && Array.isArray(labRes.citations)) {
      for (const c of labRes.citations) {
        docCitations.push({
          documentId: c.document_id,
          documentName: c.document_name,
          pageNumber: c.page_number,
          sectionHeading: c.section_heading,
          excerpt: c.excerpt,
          relevanceScore: c.relevance_score,
        });
      }
    } else if (docSummaryRes?.citations && Array.isArray(docSummaryRes.citations)) {
      for (const c of docSummaryRes.citations) {
        docCitations.push({
          documentId: c.document_id,
          documentName: c.document_name,
          pageNumber: c.page_number,
          sectionHeading: c.section_heading,
          excerpt: c.excerpt,
        });
      }
    }

    const obsCitations: ObservationEvidenceCitation[] = [...context.recentObservations.slice(0, 5)];

    const trendCitations: TrendEvidenceCitation[] = [];
    if (toolResults['compare_health_periods']) {
      const comp = toolResults['compare_health_periods'] as any;
      trendCitations.push({
        metric: comp.metric,
        reportingPeriod: `${comp.periodB?.label} vs ${comp.periodA?.label}`,
        sampleCount: (comp.periodA?.count || 0) + (comp.periodB?.count || 0),
        baselinePeriod: comp.periodA?.label,
        changeValue: comp.delta?.absoluteChange,
        changePercentage: comp.delta?.percentageChange,
        calculationMethod: 'Descriptive mean and standard deviation comparison',
        limitations: comp.dataQuality?.limitations,
      });
    }

    const citations: StructuredHealthCitations = {
      documents: docCitations,
      observations: obsCitations,
      trends: trendCitations,
    };

    // 6. Formulate answer text
    const safety = HealthSafetyPolicy.evaluateSafety({
      query,
      intent: plan.intent,
      regionCode,
    });

    const limitations = [...context.dataQualityNotes];
    if (trendCitations[0]?.limitations) {
      limitations.push(...trendCitations[0].limitations);
    }
    limitations.push(...safety.disclaimers);

    const supportingFacts: string[] = [];

    // Synthesize response based on retrieved evidence
    let answer = '';
    if (plan.intent === 'WEARABLE_TREND_INTERPRETATION' && trendCitations.length > 0) {
      const t = trendCitations[0];
      const comp = toolResults['compare_health_periods'] as any;
      const dirText = comp.delta?.direction === 'INCREASE' ? 'an increase' : comp.delta?.direction === 'DECREASE' ? 'a decrease' : 'a stable trend';
      answer = `Based on your synchronized continuous telemetry, your ${t.metric.replace(/_/g, ' ').toLowerCase()} showed ${dirText} of ${Math.abs(comp.delta?.absoluteChange || 0)} ${comp.unit || ''} (${Math.abs(comp.delta?.percentageChange || 0)}%) between ${comp.periodA?.label} (avg ${comp.periodA?.avg}) and ${comp.periodB?.label} (avg ${comp.periodB?.avg}).`;
      supportingFacts.push(`Analyzed ${t.sampleCount} total telemetry observations across two reporting periods.`);
    } else if (plan.intent === 'DOCUMENT_EXPLANATION' && docCitations.length > 0) {
      answer = `Based on your uploaded medical records (${docCitations.map((d) => d.documentName).join(', ')}), here is an educational summary of the documented findings:\n\n` +
        docCitations.map((d) => `• [${d.documentName}, Page ${d.pageNumber}]: ${d.excerpt.slice(0, 200)}...`).join('\n\n');
      supportingFacts.push(`Retrieved ${docCitations.length} verified excerpt(s) from clinical records.`);
    } else if (context.recentObservations.length > 0 || context.wearableSummaries.length > 0) {
      answer = 'Here is a summary of your recent health telemetry and recorded observations:\n' +
        context.recentObservations.slice(0, 3).map((o) => `• ${o.metric}: ${o.value} ${o.unit} (recorded ${o.timestamp.slice(0, 10)})`).join('\n');
      supportingFacts.push(`Referenced ${context.recentObservations.length} continuous observations.`);
    } else {
      answer = HealthSafetyPolicy.buildAbstentionResponse('NO_DATA');
      supportingFacts.push('No matching personal medical records or wearable observations found.');
    }

    return {
      answer,
      intent: plan.intent,
      citations,
      supportingFacts,
      clinicalExplanations: plan.intent === 'DOCUMENT_EXPLANATION' || plan.intent === 'WEARABLE_TREND_INTERPRETATION'
        ? 'These findings represent observational records and do not replace formal clinical consultation.'
        : undefined,
      limitations,
      clinicianDiscussionPrompts: safety.recommendedClinicianPrompts,
      emergencyGuidanceDelivered: false,
    };
  }
}
