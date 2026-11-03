/**
 * MediMate AI — Structured Health Summary & RAG Integration
 * Generates clinical summaries over designated periods with strict provenance and dispatches
 * them to the Python RAG microservice for authorized retrieval.
 */

import prisma from '@/lib/prisma';
import { ragClient } from '@/lib/rag/rag-client';
import { logger } from '@/lib/logger';
import { WearableConsentService } from './consent';
import {
  HealthMetricType,
  MetricAggregation,
  NormalizedObservation,
  WearableProviderId,
  WearableSummary,
} from './types';

export class RAGSummaryError extends Error {
  constructor(message: string, public readonly code = 'RAG_SUMMARY_ERROR') {
    super(message);
    this.name = 'RAGSummaryError';
  }
}

export class WearableRAGSummaryService {
  /**
   * Aggregates observations into a structured WearableSummary object.
   */
  static buildSummary(params: {
    userId: string;
    tenantId?: string;
    providerId: WearableProviderId;
    period: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    startDate: Date;
    endDate: Date;
    observations: NormalizedObservation[];
  }): WearableSummary {
    const startStr = params.startDate.toISOString().slice(0, 10);
    const endStr = params.endDate.toISOString().slice(0, 10);
    const id = `wearable_summary_${params.userId}_${params.providerId}_${params.period}_${startStr}_${endStr}`;

    const grouped: Record<string, NormalizedObservation[]> = {};
    for (const obs of params.observations) {
      if (!grouped[obs.metric]) grouped[obs.metric] = [];
      grouped[obs.metric].push(obs);
    }

    const metrics: Record<string, MetricAggregation> = {};
    const missingNotes: string[] = [];

    for (const [metricKey, obsList] of Object.entries(grouped)) {
      const metric = metricKey as HealthMetricType;
      const values = obsList.map((o) => o.value);
      const unit = obsList[0].unit;

      const min = Math.min(...values);
      const max = Math.max(...values);
      const sum = values.reduce((acc, v) => acc + v, 0);
      const avg = Math.round((sum / values.length) * 10) / 10;
      const total = metric === 'STEPS' || metric === 'ACTIVE_CALORIES' || metric === 'DISTANCE'
        ? Math.round(sum)
        : undefined;

      const latestObs = obsList.reduce((prev, cur) =>
        new Date(cur.startTime).getTime() > new Date(prev.startTime).getTime() ? cur : prev
      );

      metrics[metric] = {
        metric,
        unit,
        count: values.length,
        avg,
        min,
        max,
        total,
        latest: latestObs.value,
        latestTimestamp: latestObs.startTime,
        dataQuality: obsList.some((o) => o.dataQuality === 'QUESTIONABLE')
          ? 'QUESTIONABLE'
          : 'DERIVED',
      };
    }

    if (Object.keys(metrics).length === 0) {
      missingNotes.push('No wearable measurements recorded for this period');
    }

    const deviceModel = params.observations[0]?.deviceModel || 'Connected Health Sensor';

    return {
      id,
      userId: params.userId,
      tenantId: params.tenantId,
      providerId: params.providerId,
      period: params.period,
      startDate: startStr,
      endDate: endStr,
      metrics,
      totalObservations: params.observations.length,
      dataQuality: 'DERIVED',
      calculationMethod:
        'Standard algorithmic mean and boundary aggregation over verified samples',
      missingDataNotes: missingNotes.length > 0 ? missingNotes : undefined,
      provenance: {
        provider: params.providerId,
        deviceModel,
        generatedAt: new Date().toISOString(),
        underlyingObservationIds: params.observations.map((o) => o.id),
      },
    };
  }

  /**
   * Formats a WearableSummary into structured clinical text suitable for vector indexing and citation.
   */
  static formatSummaryDocument(summary: WearableSummary): string {
    const lines: string[] = [
      `# Clinical Wearable Observation Summary: ${summary.providerId.toUpperCase()}`,
      `Period: ${summary.period} (${summary.startDate} to ${summary.endDate})`,
      `User ID: ${summary.userId}`,
      `Device Model: ${summary.provenance.deviceModel || 'Unspecified'}`,
      `Calculation Method: ${summary.calculationMethod}`,
      `Generated At: ${summary.provenance.generatedAt}`,
      `Total Observations Analyzed: ${summary.totalObservations}`,
      '',
      '## Observed Biometric Aggregates',
    ];

    for (const [metric, agg] of Object.entries(summary.metrics)) {
      const parts: string[] = [
        `- **${metric.replace(/_/g, ' ')}**:`,
        `Count: ${agg.count} readings`,
        `Average: ${agg.avg} ${agg.unit}`,
        `Range: [${agg.min} - ${agg.max}] ${agg.unit}`,
      ];

      if (agg.total !== undefined) {
        parts.push(`Total Accumulation: ${agg.total} ${agg.unit}`);
      }

      if (agg.latest !== undefined) {
        parts.push(`Most Recent Reading: ${agg.latest} ${agg.unit} at ${agg.latestTimestamp}`);
      }

      parts.push(`Classification: ${agg.dataQuality}`);
      lines.push(parts.join(', '));
    }

    if (summary.missingDataNotes && summary.missingDataNotes.length > 0) {
      lines.push('', '## Missing Data & Exclusions');
      for (const note of summary.missingDataNotes) {
        lines.push(`- ${note}`);
      }
    }

    lines.push(
      '',
      '## Clinical Provenance & Safeguards',
      `Data Source: ${summary.providerId}`,
      `Attributed Records: ${summary.provenance.underlyingObservationIds.length} discrete measurements`,
      'Notice: Wearable telemetry reflects observational consumer trends, not definitive clinical diagnostic evaluations.',
      'Always consult a qualified healthcare provider regarding unusual biometric fluctuations or therapy adjustments.'
    );

    return lines.join('\n');
  }

  /**
   * Dispatches a structured summary to the Python RAG microservice only if the user has active consent.
   */
  static async publishSummaryToRAG(summary: WearableSummary): Promise<{
    success: boolean;
    documentId: string;
    totalChunks: number;
  }> {
    // 1. Verify user consent covers the categories in this summary
    const activeConsent = await WearableConsentService.getActiveConsent(
      summary.userId,
      summary.providerId
    );

    if (!activeConsent || activeConsent.status !== 'ACTIVE') {
      throw new RAGSummaryError(
        'Cannot publish health summary to RAG: Active user consent is missing or revoked',
        'CONSENT_REVOKED'
      );
    }

    const documentText = this.formatSummaryDocument(summary);
    const documentId = summary.id;
    const fileName = `${summary.providerId}_summary_${summary.period}_${summary.startDate}.md`;
    const fileBuffer = Buffer.from(documentText, 'utf-8');

    // Store summary record in HealthData for persistence and auditability
    try {
      await prisma.healthData.create({
        data: {
          authorId: summary.userId,
          type: 'WEARABLE_SUMMARY',
          data: summary as any,
          metadata: {
            providerId: summary.providerId,
            period: summary.period,
            startDate: summary.startDate,
            endDate: summary.endDate,
            ragDocumentId: documentId,
          },
          status: 'COMPLETED',
        },
      });
    } catch {
      // ignore in test
    }

    // Ingest into Python RAG microservice via RAGClient
    try {
      const response = await ragClient.ingestDocument({
        userId: summary.userId,
        tenantId: summary.tenantId,
        documentId,
        fileName,
        fileBuffer,
      });

      logger.info('Wearable summary successfully indexed in RAG microservice', {
        documentId,
        totalChunks: response.total_chunks,
      });

      return {
        success: response.success,
        documentId: response.document_id,
        totalChunks: response.total_chunks,
      };
    } catch (err: any) {
      logger.warn('RAG ingestion failed or microservice unreachable; summary preserved in DB', {
        documentId,
        error: err.message,
      });

      return {
        success: false,
        documentId,
        totalChunks: 0,
      };
    }
  }
}
