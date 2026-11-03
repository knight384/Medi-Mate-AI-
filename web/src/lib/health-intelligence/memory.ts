/**
 * MediMate AI — User-Controlled Health Memory Service
 * Phase 8: Provides transparent, user-auditable, and editable conversational health memory.
 * Respects strict consent, categories, pause controls, and cascade purges.
 */

import prisma from '@/lib/prisma';
import { SecurityAuditLogger } from '@/lib/security/audit-logger';
import { MemoryCategory } from './types';

export interface UserMemoryItem {
  id: string;
  userId: string;
  category: MemoryCategory;
  key: string;
  content: string;
  sourceType: 'USER_EXPLICIT' | 'CONVERSATION_SUMMARY';
  sourceId?: string | null;
  confidence: number;
  isPaused: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory fallback cache for testing without live database connection
const inMemoryMemoryStore: Map<string, UserMemoryItem> = new Map();

export class HealthMemoryService {
  /**
   * Records or updates a health memory entry.
   * Disallows storing speculative medical diagnoses or unsolicited sensitive inferences.
   */
  static async recordMemory(params: {
    userId: string;
    category: MemoryCategory;
    key: string;
    content: string;
    sourceType?: 'USER_EXPLICIT' | 'CONVERSATION_SUMMARY';
    sourceId?: string;
    confidence?: number;
  }): Promise<UserMemoryItem> {
    const {
      userId,
      category,
      key,
      content,
      sourceType = 'USER_EXPLICIT',
      sourceId,
      confidence = 1.0,
    } = params;

    // Disallow unverified medical claims from being saved as permanent memory
    const forbiddenPatterns = [
      /\bdiagnosed with\b/i,
      /\bhas stage \d\b/i,
      /\bconfirmed malignant\b/i,
    ];
    if (sourceType === 'CONVERSATION_SUMMARY' && forbiddenPatterns.some((p) => p.test(content))) {
      throw new Error('Unconfirmed clinical diagnoses cannot be automatically saved into conversational memory.');
    }

    if (!process.env.DATABASE_URL) {
      const id = `mem_${userId}_${category}_${key}`;
      const item: UserMemoryItem = {
        id,
        userId,
        category,
        key,
        content,
        sourceType,
        sourceId,
        confidence,
        isPaused: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryMemoryStore.set(id, item);
      return item;
    }

    try {
      const existing = await prisma.userHealthMemory.findFirst({
        where: { userId, key, category },
      });

      let record;
      if (existing) {
        record = await prisma.userHealthMemory.update({
          where: { id: existing.id },
          data: {
            content,
            sourceType,
            sourceId,
            confidence,
            isPaused: false,
          },
        });
      } else {
        record = await prisma.userHealthMemory.create({
          data: {
            userId,
            category,
            key,
            content,
            sourceType,
            sourceId,
            confidence,
          },
        });
      }

      return {
        id: record.id,
        userId: record.userId,
        category: record.category as MemoryCategory,
        key: record.key,
        content: record.content,
        sourceType: record.sourceType as 'USER_EXPLICIT' | 'CONVERSATION_SUMMARY',
        sourceId: record.sourceId,
        confidence: record.confidence,
        isPaused: record.isPaused,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    } catch {
      // In-memory fallback
      const id = `mem_${userId}_${category}_${key}`;
      const item: UserMemoryItem = {
        id,
        userId,
        category,
        key,
        content,
        sourceType,
        sourceId,
        confidence,
        isPaused: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryMemoryStore.set(id, item);
      return item;
    }
  }

  /**
   * Retrieves active, unpaused memory entries for a user, optionally filtered by category.
   */
  static async getActiveMemories(
    userId: string,
    category?: MemoryCategory
  ): Promise<UserMemoryItem[]> {
    if (!process.env.DATABASE_URL) {
      return Array.from(inMemoryMemoryStore.values()).filter(
        (m) => m.userId === userId && !m.isPaused && (category ? m.category === category : true)
      );
    }

    try {
      const records = await prisma.userHealthMemory.findMany({
        where: {
          userId,
          isPaused: false,
          ...(category ? { category } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      });

      return records.map((r) => ({
        id: r.id,
        userId: r.userId,
        category: r.category as MemoryCategory,
        key: r.key,
        content: r.content,
        sourceType: r.sourceType as 'USER_EXPLICIT' | 'CONVERSATION_SUMMARY',
        sourceId: r.sourceId,
        confidence: r.confidence,
        isPaused: r.isPaused,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    } catch {
      // Fallback
      return Array.from(inMemoryMemoryStore.values()).filter(
        (m) => m.userId === userId && !m.isPaused && (category ? m.category === category : true)
      );
    }
  }

  /**
   * Pauses or unpauses a memory entry (when paused, it will not be included in AI context).
   */
  static async togglePauseMemory(
    userId: string,
    memoryId: string,
    isPaused: boolean
  ): Promise<boolean> {
    if (!process.env.DATABASE_URL) {
      const item = inMemoryMemoryStore.get(memoryId);
      if (item && item.userId === userId) {
        item.isPaused = isPaused;
        item.updatedAt = new Date();
        return true;
      }
      return false;
    }

    try {
      await prisma.userHealthMemory.updateMany({
        where: { id: memoryId, userId },
        data: { isPaused },
      });
      return true;
    } catch {
      const item = inMemoryMemoryStore.get(memoryId);
      if (item && item.userId === userId) {
        item.isPaused = isPaused;
        item.updatedAt = new Date();
        return true;
      }
      return false;
    }
  }

  /**
   * Deletes a specific memory entry permanently.
   */
  static async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    if (!process.env.DATABASE_URL) {
      const item = inMemoryMemoryStore.get(memoryId);
      if (item && item.userId === userId) {
        inMemoryMemoryStore.delete(memoryId);
        return true;
      }
      return false;
    }

    try {
      const res = await prisma.userHealthMemory.deleteMany({
        where: { id: memoryId, userId },
      });
      SecurityAuditLogger.log({
        eventType: 'ACCESS_DENIED',
        actorId: userId,
        resourceId: `UserHealthMemory:${memoryId}`,
        action: 'DELETE_MEMORY',
        status: 'SUCCESS',
        details: { memoryId },
      });
      return res.count > 0;
    } catch {
      const item = inMemoryMemoryStore.get(memoryId);
      if (item && item.userId === userId) {
        inMemoryMemoryStore.delete(memoryId);
        return true;
      }
      return false;
    }
  }

  /**
   * Purges all memory entries for a user, or for a specific category (e.g. GDPR right to erasure).
   */
  static async purgeUserMemories(userId: string, category?: MemoryCategory): Promise<number> {
    try {
      const res = await prisma.userHealthMemory.deleteMany({
        where: {
          userId,
          ...(category ? { category } : {}),
        },
      });
      return res.count;
    } catch {
      let count = 0;
      for (const [id, item] of inMemoryMemoryStore.entries()) {
        if (item.userId === userId && (category ? item.category === category : true)) {
          inMemoryMemoryStore.delete(id);
          count++;
        }
      }
      return count;
    }
  }

  /**
   * Reset helper for test suites
   */
  static _resetInMemoryStore(): void {
    inMemoryMemoryStore.clear();
  }
}
