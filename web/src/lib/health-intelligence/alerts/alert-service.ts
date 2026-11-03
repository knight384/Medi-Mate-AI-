/**
 * MediMate AI — Opt-In Health Alerts & Reminders Service
 * Phase 8: Governs informational updates, user-configured reminders, quiet hours,
 * deduplication cooldowns, and non-emergency safety boundaries.
 */

import prisma from '@/lib/prisma';

export interface HealthReminderItem {
  id: string;
  userId: string;
  title: string;
  description?: string | null;
  category: 'MEDICATION_REMINDER' | 'MEASUREMENT_REMINDER' | 'ACTIVITY_GOAL' | 'APPOINTMENT';
  scheduleType: 'DAILY' | 'WEEKLY' | 'ONE_OFF';
  scheduleTime: string; // e.g. "09:00" or ISO date string
  isEnabled: boolean;
  lastTriggeredAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserAlertPreferences {
  userId: string;
  optInInformationalTrends: boolean;
  quietHoursStart: string; // "22:00"
  quietHoursEnd: string;   // "07:00"
  cooldownHours: number;   // default 24
}

const inMemoryReminderStore: Map<string, HealthReminderItem> = new Map();
const inMemoryPreferencesStore: Map<string, UserAlertPreferences> = new Map();
const alertTriggerLog: { userId: string; topic: string; timestamp: Date }[] = [];

export class HealthAlertService {
  /**
   * Sets or retrieves alert preferences for a user.
   */
  static getAlertPreferences(userId: string): UserAlertPreferences {
    const existing = inMemoryPreferencesStore.get(userId);
    if (existing) return existing;
    const defaultPref: UserAlertPreferences = {
      userId,
      optInInformationalTrends: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      cooldownHours: 24,
    };
    inMemoryPreferencesStore.set(userId, defaultPref);
    return defaultPref;
  }

  static updateAlertPreferences(
    userId: string,
    updates: Partial<Omit<UserAlertPreferences, 'userId'>>
  ): UserAlertPreferences {
    const cur = this.getAlertPreferences(userId);
    const updated = { ...cur, ...updates };
    inMemoryPreferencesStore.set(userId, updated);
    return updated;
  }

  /**
   * Evaluates whether current wall-clock time falls inside the user's quiet hours window.
   */
  static isInQuietHours(userId: string, checkDate: Date = new Date()): boolean {
    const prefs = this.getAlertPreferences(userId);
    const [startH, startM] = prefs.quietHoursStart.split(':').map(Number);
    const [endH, endM] = prefs.quietHoursEnd.split(':').map(Number);

    const currentMinutes = checkDate.getHours() * 60 + checkDate.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes > endMinutes) {
      // Overnight span (e.g. 22:00 -> 07:00)
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } else {
      // Intra-day span (e.g. 13:00 -> 15:00)
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
  }

  /**
   * Checks whether an alert for a specific topic is still within its cooldown window.
   */
  static isAlertInCooldown(userId: string, topic: string, checkDate: Date = new Date()): boolean {
    const prefs = this.getAlertPreferences(userId);
    const cooldownMs = prefs.cooldownHours * 3600 * 1000;

    const recent = alertTriggerLog
      .filter((l) => l.userId === userId && l.topic === topic)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    if (!recent) return false;
    return checkDate.getTime() - recent.timestamp.getTime() < cooldownMs;
  }

  /**
   * Records that an alert was triggered to maintain cooldown deduplication.
   */
  static recordAlertTriggered(userId: string, topic: string, date: Date = new Date()): void {
    alertTriggerLog.push({ userId, topic, timestamp: date });
  }

  /**
   * Creates a user-configured reminder.
   */
  static async createReminder(params: {
    userId: string;
    title: string;
    description?: string;
    category: HealthReminderItem['category'];
    scheduleType: HealthReminderItem['scheduleType'];
    scheduleTime: string;
    metadata?: Record<string, unknown>;
  }): Promise<HealthReminderItem> {
    try {
      const record = await prisma.healthReminder.create({
        data: {
          userId: params.userId,
          title: params.title,
          description: params.description,
          category: params.category,
          scheduleType: params.scheduleType,
          scheduleTime: params.scheduleTime,
          metadata: params.metadata as any,
          isEnabled: true,
        },
      });

      return {
        id: record.id,
        userId: record.userId,
        title: record.title,
        description: record.description,
        category: record.category as HealthReminderItem['category'],
        scheduleType: record.scheduleType as HealthReminderItem['scheduleType'],
        scheduleTime: record.scheduleTime,
        isEnabled: record.isEnabled,
        lastTriggeredAt: record.lastTriggeredAt,
        metadata: record.metadata as Record<string, unknown> | null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    } catch {
      // In-memory fallback
      const id = `rem_${params.userId}_${Date.now()}`;
      const item: HealthReminderItem = {
        id,
        userId: params.userId,
        title: params.title,
        description: params.description,
        category: params.category,
        scheduleType: params.scheduleType,
        scheduleTime: params.scheduleTime,
        isEnabled: true,
        lastTriggeredAt: null,
        metadata: params.metadata || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      inMemoryReminderStore.set(id, item);
      return item;
    }
  }

  /**
   * Retrieves all reminders for a user.
   */
  static async getReminders(userId: string): Promise<HealthReminderItem[]> {
    try {
      const records = await prisma.healthReminder.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      return records.map((r) => ({
        id: r.id,
        userId: r.userId,
        title: r.title,
        description: r.description,
        category: r.category as HealthReminderItem['category'],
        scheduleType: r.scheduleType as HealthReminderItem['scheduleType'],
        scheduleTime: r.scheduleTime,
        isEnabled: r.isEnabled,
        lastTriggeredAt: r.lastTriggeredAt,
        metadata: r.metadata as Record<string, unknown> | null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    } catch {
      return Array.from(inMemoryReminderStore.values()).filter((r) => r.userId === userId);
    }
  }

  /**
   * Toggles or deletes a reminder.
   */
  static async toggleReminder(userId: string, reminderId: string, isEnabled: boolean): Promise<boolean> {
    try {
      await prisma.healthReminder.updateMany({
        where: { id: reminderId, userId },
        data: { isEnabled },
      });
      return true;
    } catch {
      const item = inMemoryReminderStore.get(reminderId);
      if (item && item.userId === userId) {
        item.isEnabled = isEnabled;
        item.updatedAt = new Date();
        return true;
      }
      return false;
    }
  }

  static async deleteReminder(userId: string, reminderId: string): Promise<boolean> {
    try {
      const res = await prisma.healthReminder.deleteMany({
        where: { id: reminderId, userId },
      });
      return res.count > 0;
    } catch {
      const item = inMemoryReminderStore.get(reminderId);
      if (item && item.userId === userId) {
        inMemoryReminderStore.delete(reminderId);
        return true;
      }
      return false;
    }
  }

  /**
   * Clears in-memory stores for testing.
   */
  static _resetInMemoryStore(): void {
    inMemoryReminderStore.clear();
    inMemoryPreferencesStore.clear();
    alertTriggerLog.length = 0;
  }
}
