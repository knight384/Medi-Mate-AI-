import { describe, it, expect, beforeEach } from 'vitest';
import { HealthAlertService } from '../alerts/alert-service';

describe('HealthAlertService', () => {
  const userId = 'user_test_alerts_456';

  beforeEach(() => {
    HealthAlertService._resetInMemoryStore();
  });

  it('evaluates quiet hours accurately across midnight span', () => {
    HealthAlertService.updateAlertPreferences(userId, {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });

    // 23:30 is in quiet hours
    const lateNight = new Date('2026-11-03T23:30:00');
    expect(HealthAlertService.isInQuietHours(userId, lateNight)).toBe(true);

    // 04:15 is in quiet hours
    const earlyMorning = new Date('2026-11-03T04:15:00');
    expect(HealthAlertService.isInQuietHours(userId, earlyMorning)).toBe(true);

    // 14:00 is not in quiet hours
    const afternoon = new Date('2026-11-03T14:00:00');
    expect(HealthAlertService.isInQuietHours(userId, afternoon)).toBe(false);
  });

  it('enforces cooldown deduplication for informational alert topics', () => {
    HealthAlertService.updateAlertPreferences(userId, { cooldownHours: 24 });

    const topic = 'STEP_GOAL_ACHIEVED';
    const now = new Date('2026-11-03T10:00:00Z');

    expect(HealthAlertService.isAlertInCooldown(userId, topic, now)).toBe(false);

    // Trigger alert
    HealthAlertService.recordAlertTriggered(userId, topic, now);

    // Check 2 hours later -> in cooldown
    const twoHoursLater = new Date('2026-11-03T12:00:00Z');
    expect(HealthAlertService.isAlertInCooldown(userId, topic, twoHoursLater)).toBe(true);

    // Check 25 hours later -> out of cooldown
    const nextDay = new Date('2026-11-04T11:00:00Z');
    expect(HealthAlertService.isAlertInCooldown(userId, topic, nextDay)).toBe(false);
  });

  it('creates and manages user reminders', async () => {
    const reminder = await HealthAlertService.createReminder({
      userId,
      title: 'Take evening blood pressure reading',
      category: 'MEASUREMENT_REMINDER',
      scheduleType: 'DAILY',
      scheduleTime: '20:00',
    });

    expect(reminder.id).toBeDefined();
    expect(reminder.isEnabled).toBe(true);

    await HealthAlertService.toggleReminder(userId, reminder.id, false);
    const list = await HealthAlertService.getReminders(userId);
    expect(list[0].isEnabled).toBe(false);

    await HealthAlertService.deleteReminder(userId, reminder.id);
    const afterDelete = await HealthAlertService.getReminders(userId);
    expect(afterDelete.length).toBe(0);
  });
});
