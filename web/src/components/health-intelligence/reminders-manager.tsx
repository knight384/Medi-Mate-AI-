'use client';

import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bell, Clock, Trash2, Plus, Moon } from 'lucide-react';
import { HealthReminderItem, UserAlertPreferences } from '@/lib/health-intelligence/alerts/alert-service';

interface RemindersManagerProps {
  reminders: HealthReminderItem[];
  preferences: UserAlertPreferences | null;
  onRefresh: () => void;
}

export function RemindersManager({ reminders, preferences, onRefresh }: RemindersManagerProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<HealthReminderItem['category']>('MEASUREMENT_REMINDER');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    try {
      await fetch('/api/health-intelligence/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          category,
          scheduleType: 'DAILY',
          scheduleTime,
        }),
      });
      setTitle('');
      onRefresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (id: string, isEnabled: boolean) => {
    await fetch('/api/health-intelligence/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderId: id, isEnabled: !isEnabled }),
    });
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/health-intelligence/alerts?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    onRefresh();
  };

  return (
    <Card className="border border-zinc-200 dark:border-zinc-800">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Opt-In Reminders & Quiet Hours</CardTitle>
              <CardDescription className="text-xs">
                Configure informational measurement reminders and quiet hours.
              </CardDescription>
            </div>
          </div>
          {preferences && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">
              <Moon className="h-3.5 w-3.5 text-indigo-400" /> Quiet Hours: {preferences.quietHoursStart} - {preferences.quietHoursEnd}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Create Reminder */}
        <form onSubmit={handleCreate} className="p-4 bg-zinc-50 dark:bg-zinc-900 rounded-lg space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Add Reminder</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Input
              placeholder="Reminder label (e.g. Log blood pressure)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-sm"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as any)}
              className="px-3 py-1.5 text-sm rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200"
            >
              <option value="MEASUREMENT_REMINDER">Measurement Reminder</option>
              <option value="ACTIVITY_GOAL">Daily Activity Goal</option>
              <option value="MEDICATION_REMINDER">Medication Log Reminder</option>
              <option value="APPOINTMENT">Clinical Appointment</option>
            </select>
            <Input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className="text-sm"
            />
          </div>
          <Button type="submit" size="sm" disabled={submitting} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-1" /> Add Reminder
          </Button>
        </form>

        {/* Existing Reminders */}
        <div className="space-y-2">
          {reminders.length === 0 ? (
            <div className="py-6 text-center text-xs text-zinc-400">
              No reminders scheduled. All alerts are strictly opt-in and non-emergency.
            </div>
          ) : (
            reminders.map((r) => (
              <div
                key={r.id}
                className={`p-3 rounded-lg border text-sm flex items-center justify-between gap-3 ${
                  r.isEnabled
                    ? 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800'
                    : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 opacity-60'
                }`}
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{r.title}</span>
                    <span className="text-[10px] text-zinc-400 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {r.scheduleTime} ({r.scheduleType})
                    </span>
                  </div>
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{r.category}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggle(r.id, r.isEnabled)}
                    className="h-7 text-xs"
                  >
                    {r.isEnabled ? 'Active' : 'Disabled'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(r.id)}
                    className="h-7 w-7 p-0 text-red-500 hover:text-red-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
