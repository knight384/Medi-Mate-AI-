/**
 * MediMate AI — Controlled Health Information Retrieval Planner & Allowlisted Tools
 * Phase 8: Safe, typed, read-only information tools for the Health Companion.
 * Guarantees server-side tenant isolation, bounded results, and zero arbitrary execution.
 */

import prisma from '@/lib/prisma';
import { ragClient } from '@/lib/rag/rag-client';
import { LongitudinalHealthService } from '../longitudinal';
import { HealthMemoryService } from '../memory';
import { NormalizedObservation, WearableSummary } from '@/lib/wearables/types';

export interface ToolExecutionContext {
  userId: string;
  tenantId?: string;
}

export type HealthToolName =
  | 'get_medical_history'
  | 'get_latest_lab_results'
  | 'get_document_summary'
  | 'get_document_section'
  | 'get_heart_rate_history'
  | 'get_sleep_history'
  | 'get_activity_history'
  | 'get_hrv_history'
  | 'get_health_measurements'
  | 'compare_health_periods'
  | 'get_wearable_summary'
  | 'get_user_health_goals';

export interface ToolDefinition {
  name: HealthToolName;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  handler: (ctx: ToolExecutionContext, args: any) => Promise<any>;
}

export class HealthToolRegistry {
  private static tools: Map<HealthToolName, ToolDefinition> = new Map();

  static registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  static getTool(name: HealthToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  static getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Safe dispatcher that validates context, applies timeouts, and catches failures cleanly.
   */
  static async executeTool(
    name: HealthToolName,
    ctx: ToolExecutionContext,
    args: Record<string, unknown> = {}
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!ctx.userId) {
      return { success: false, error: 'Unauthorized: missing user context' };
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool ${name} not found in allowlisted registry.` };
    }

    try {
      // 5-second timeout safeguard for any tool execution
      const result = await Promise.race([
        tool.handler(ctx, args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tool execution timeout')), 5000)),
      ]);

      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message || 'Tool execution failed' };
    }
  }
}

// -------------------------------------------------------------
// Register Allowlisted Read-Only Tools
// -------------------------------------------------------------

// 1. get_medical_history
HealthToolRegistry.registerTool({
  name: 'get_medical_history',
  description: 'Retrieves authorized patient clinical history (conditions, medications, allergies, procedures).',
  parameters: {},
  handler: async (ctx) => {
    const records = await prisma.healthData.findMany({
      where: { authorId: ctx.userId, type: 'PERSONAL_INFO' },
      take: 5,
    });
    return records.map((r) => r.data);
  },
});

// 2. get_latest_lab_results
HealthToolRegistry.registerTool({
  name: 'get_latest_lab_results',
  description: 'Queries recent laboratory records and extracted biomarkers.',
  parameters: {
    testName: { type: 'string', description: 'Optional specific test name (e.g. HbA1c, Cholesterol)' },
  },
  handler: async (ctx, args) => {
    // Query RAG microservice for lab results
    const query = args.testName ? `laboratory test results for ${args.testName}` : 'recent blood tests and laboratory results';
    try {
      const ragRes = await ragClient.queryRAG({
        userId: ctx.userId,
        query,
        topK: 3,
      });
      return {
        query,
        citations: ragRes.citations,
        sourceDocuments: ragRes.sourceDocuments,
      };
    } catch {
      return { message: 'No laboratory records currently retrievable.' };
    }
  },
});

// 3. get_document_summary
HealthToolRegistry.registerTool({
  name: 'get_document_summary',
  description: 'Retrieves an evidence-grounded summary of uploaded medical documents via RAG.',
  parameters: {
    documentId: { type: 'string', description: 'Optional document ID to focus on' },
  },
  handler: async (ctx, args) => {
    try {
      const ragRes = await ragClient.queryRAG({
        userId: ctx.userId,
        query: 'comprehensive clinical summary of medical document',
        documentIds: args.documentId ? [args.documentId] : undefined,
        topK: 4,
      });
      return {
        summary: ragRes.summary || ragRes.answer,
        citations: ragRes.citations,
      };
    } catch {
      return { message: 'Document summary unavailable.' };
    }
  },
});

// 4. get_document_section
HealthToolRegistry.registerTool({
  name: 'get_document_section',
  description: 'Searches for a specific section or topic within uploaded clinical documents.',
  parameters: {
    sectionTopic: { type: 'string', description: 'Topic or heading to locate', required: true },
  },
  handler: async (ctx, args) => {
    if (!args.sectionTopic) throw new Error('sectionTopic is required');
    const ragRes = await ragClient.queryRAG({
      userId: ctx.userId,
      query: args.sectionTopic,
      topK: 3,
    });
    return { citations: ragRes.citations };
  },
});

// 5. get_heart_rate_history
HealthToolRegistry.registerTool({
  name: 'get_heart_rate_history',
  description: 'Retrieves resting heart rate observations within a bounded date window (up to 30 days).',
  parameters: {
    days: { type: 'number', description: 'Number of recent days to inspect (default 7, max 30)' },
  },
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
    const startDate = new Date(Date.now() - days * 86400000);
    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: startDate },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    return records
      .map((r) => r.data as unknown as NormalizedObservation)
      .filter((o) => o.metric === 'RESTING_HEART_RATE');
  },
});

// 6. get_sleep_history
HealthToolRegistry.registerTool({
  name: 'get_sleep_history',
  description: 'Retrieves sleep duration and efficiency observations over a bounded window (up to 30 days).',
  parameters: {
    days: { type: 'number', description: 'Number of recent days to inspect (default 7, max 30)' },
  },
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
    const startDate = new Date(Date.now() - days * 86400000);
    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: startDate },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    return records
      .map((r) => r.data as unknown as NormalizedObservation)
      .filter((o) => o.metric === 'SLEEP_DURATION' || o.metric === 'SLEEP_EFFICIENCY');
  },
});

// 7. get_activity_history
HealthToolRegistry.registerTool({
  name: 'get_activity_history',
  description: 'Retrieves daily steps and active calorie telemetry over a bounded window (up to 30 days).',
  parameters: {
    days: { type: 'number', description: 'Number of days to inspect (default 7, max 30)' },
  },
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
    const startDate = new Date(Date.now() - days * 86400000);
    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: startDate },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    return records
      .map((r) => r.data as unknown as NormalizedObservation)
      .filter((o) => o.metric === 'STEPS' || o.metric === 'ACTIVE_CALORIES');
  },
});

// 8. get_hrv_history
HealthToolRegistry.registerTool({
  name: 'get_hrv_history',
  description: 'Retrieves Heart Rate Variability (HRV in ms) continuous observations.',
  parameters: {
    days: { type: 'number', description: 'Number of days to inspect (default 7, max 30)' },
  },
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
    const startDate = new Date(Date.now() - days * 86400000);
    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: startDate },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    return records
      .map((r) => r.data as unknown as NormalizedObservation)
      .filter((o) => o.metric === 'HRV');
  },
});

// 9. get_health_measurements
HealthToolRegistry.registerTool({
  name: 'get_health_measurements',
  description: 'Retrieves structured physiological measurements (e.g. blood pressure, SpO2, weight).',
  parameters: {
    metric: { type: 'string', description: 'Metric type name (e.g. SPO2, BLOOD_PRESSURE, WEIGHT)' },
  },
  handler: async (ctx, args) => {
    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_OBSERVATION',
      },
      take: 30,
      orderBy: { createdAt: 'desc' },
    });
    const obs = records.map((r) => r.data as unknown as NormalizedObservation);
    return args.metric ? obs.filter((o) => o.metric === args.metric) : obs;
  },
});

// 10. compare_health_periods
HealthToolRegistry.registerTool({
  name: 'compare_health_periods',
  description: 'Computes longitudinal period-over-period statistics (e.g. week vs previous week).',
  parameters: {
    metric: { type: 'string', description: 'Metric to compare (e.g. STEPS, RESTING_HEART_RATE, SLEEP_DURATION)', required: true },
    periodType: { type: 'string', description: 'Comparison interval: WEEK_VS_PREVIOUS or MONTH_VS_PREVIOUS' },
  },
  handler: async (ctx, args) => {
    if (!args.metric) throw new Error('metric argument is required');
    const periodType = args.periodType === 'MONTH_VS_PREVIOUS' ? 'MONTH_VS_PREVIOUS' : 'WEEK_VS_PREVIOUS';
    const intervals = LongitudinalHealthService.buildStandardIntervals(periodType);

    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_OBSERVATION',
        createdAt: { gte: intervals.periodA.startDate },
      },
      take: 100,
    });
    const observations = records.map((r) => r.data as unknown as NormalizedObservation);

    return LongitudinalHealthService.comparePeriods({
      metric: args.metric,
      periodA: intervals.periodA,
      periodB: intervals.periodB,
      observations,
    });
  },
});

// 11. get_wearable_summary
HealthToolRegistry.registerTool({
  name: 'get_wearable_summary',
  description: 'Retrieves pre-calculated daily or weekly wearable summaries.',
  parameters: {
    period: { type: 'string', description: 'Period: DAILY, WEEKLY, or MONTHLY' },
  },
  handler: async (ctx, args) => {
    const records = await prisma.healthData.findMany({
      where: {
        authorId: ctx.userId,
        type: 'WEARABLE_SUMMARY',
      },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
    const summaries = records.map((r) => r.data as unknown as WearableSummary);
    return args.period ? summaries.filter((s) => s.period === args.period) : summaries;
  },
});

// 12. get_user_health_goals
HealthToolRegistry.registerTool({
  name: 'get_user_health_goals',
  description: 'Retrieves user-approved health goals and conversational memory preferences.',
  parameters: {},
  handler: async (ctx) => {
    return HealthMemoryService.getActiveMemories(ctx.userId);
  },
});
