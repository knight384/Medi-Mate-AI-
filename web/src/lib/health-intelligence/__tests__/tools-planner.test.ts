import { describe, it, expect } from 'vitest';
import { HealthRetrievalPlanner } from '../tools/planner';
import { HealthToolRegistry } from '../tools/tool-registry';

describe('HealthRetrievalPlanner & Tools', () => {
  const userId = 'user_test_tools_789';

  it('classifies emergency symptoms with immediate precedence', () => {
    const plan = HealthRetrievalPlanner.planRetrieval('I have severe chest pain and cannot breathe');
    expect(plan.isEmergency).toBe(true);
    expect(plan.intent).toBe('EMERGENCY_QUERY');
    expect(plan.operations.length).toBe(0); // Short-circuits tool execution
  });

  it('plans longitudinal comparisons for wearable trend queries', () => {
    const plan = HealthRetrievalPlanner.planRetrieval('Compare my resting heart rate trends from last week to this week');
    expect(plan.intent).toBe('WEARABLE_TREND_INTERPRETATION');
    const compOp = plan.operations.find((o) => o.tool === 'compare_health_periods');
    expect(compOp).toBeDefined();
    expect(compOp?.args.metric).toBe('RESTING_HEART_RATE');
  });

  it('plans document retrieval operations for blood test explanation queries', () => {
    const plan = HealthRetrievalPlanner.planRetrieval('Explain my latest HbA1c blood test result from the PDF');
    expect(plan.intent).toBe('DOCUMENT_EXPLANATION');
    expect(plan.operations.some((o) => o.tool === 'get_latest_lab_results')).toBe(true);
    expect(plan.operations.some((o) => o.tool === 'get_document_summary')).toBe(true);
  });

  it('rejects unauthorized tool execution without user context', async () => {
    const res = await HealthToolRegistry.executeTool('get_medical_history', { userId: '' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unauthorized');
  });

  it('rejects un-registered tool calls safely', async () => {
    const res = await HealthToolRegistry.executeTool('arbitrary_sql_tool' as any, { userId });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not found in allowlisted registry');
  });
});
