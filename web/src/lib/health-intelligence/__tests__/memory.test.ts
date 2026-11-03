import { describe, it, expect, beforeEach } from 'vitest';
import { HealthMemoryService } from '../memory';

describe('HealthMemoryService', () => {
  const userId = 'user_test_memory_123';

  beforeEach(() => {
    HealthMemoryService._resetInMemoryStore();
  });

  it('records explicit user preferences and goals', async () => {
    const mem1 = await HealthMemoryService.recordMemory({
      userId,
      category: 'GOAL',
      key: 'daily_steps',
      content: 'Maintain 8,000 steps daily for cardiovascular health',
      sourceType: 'USER_EXPLICIT',
    });

    expect(mem1.id).toBeDefined();
    expect(mem1.key).toBe('daily_steps');
    expect(mem1.isPaused).toBe(false);

    const active = await HealthMemoryService.getActiveMemories(userId, 'GOAL');
    expect(active.length).toBe(1);
    expect(active[0].content).toContain('8,000 steps');
  });

  it('rejects speculative clinical diagnoses from being saved as permanent memory', async () => {
    await expect(
      HealthMemoryService.recordMemory({
        userId,
        category: 'TOPIC',
        key: 'inferred_condition',
        content: 'Patient is diagnosed with stage 2 hypertension',
        sourceType: 'CONVERSATION_SUMMARY',
      })
    ).rejects.toThrow('Unconfirmed clinical diagnoses cannot be automatically saved');
  });

  it('pauses and unpauses memory items correctly', async () => {
    const mem = await HealthMemoryService.recordMemory({
      userId,
      category: 'PREFERENCE',
      key: 'tone',
      content: 'Prefers simple, non-technical explanations',
    });

    await HealthMemoryService.togglePauseMemory(userId, mem.id, true);
    let active = await HealthMemoryService.getActiveMemories(userId);
    expect(active.length).toBe(0);

    await HealthMemoryService.togglePauseMemory(userId, mem.id, false);
    active = await HealthMemoryService.getActiveMemories(userId);
    expect(active.length).toBe(1);
  });

  it('deletes and purges memory with tenant isolation', async () => {
    const mem = await HealthMemoryService.recordMemory({
      userId,
      category: 'GOAL',
      key: 'sleep_goal',
      content: 'Target 7.5 hours of sleep nightly',
    });

    // Cross-user deletion fails
    const otherDeleted = await HealthMemoryService.deleteMemory('other_user_456', mem.id);
    expect(otherDeleted).toBe(false);

    // Authorized deletion succeeds
    const deleted = await HealthMemoryService.deleteMemory(userId, mem.id);
    expect(deleted).toBe(true);

    const remaining = await HealthMemoryService.getActiveMemories(userId);
    expect(remaining.length).toBe(0);
  });
});
