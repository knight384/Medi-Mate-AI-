'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Sparkles, Brain, Bell, Bot } from 'lucide-react';
import { CompanionView } from '@/components/health-intelligence/companion-view';
import { InsightsOverview } from '@/components/health-intelligence/insights-overview';
import { MemoryManager } from '@/components/health-intelligence/memory-manager';
import { RemindersManager } from '@/components/health-intelligence/reminders-manager';
import { HealthInsight } from '@/lib/health-intelligence/types';
import { UserMemoryItem } from '@/lib/health-intelligence/memory';
import { HealthReminderItem, UserAlertPreferences } from '@/lib/health-intelligence/alerts/alert-service';

export default function HealthIntelligencePage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'COMPANION' | 'INSIGHTS' | 'MEMORY' | 'REMINDERS'>('COMPANION');
  const [insights, setInsights] = useState<HealthInsight[]>([]);
  const [memories, setMemories] = useState<UserMemoryItem[]>([]);
  const [reminders, setReminders] = useState<HealthReminderItem[]>([]);
  const [preferences, setPreferences] = useState<UserAlertPreferences | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [insightsRes, memoryRes, alertsRes] = await Promise.all([
        fetch('/api/health-intelligence/insights').catch(() => null),
        fetch('/api/health-intelligence/memory').catch(() => null),
        fetch('/api/health-intelligence/alerts').catch(() => null),
      ]);

      if (insightsRes?.ok) {
        const d = await insightsRes.json();
        setInsights(d.insights || []);
      }
      if (memoryRes?.ok) {
        const d = await memoryRes.json();
        setMemories(d.memories || []);
      }
      if (alertsRes?.ok) {
        const d = await alertsRes.json();
        setReminders(d.reminders || []);
        setPreferences(d.preferences || null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Navigation & Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.back()}
              className="text-zinc-600 dark:text-zinc-400"
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                AI Health Companion & Intelligence
              </h1>
              <p className="text-xs sm:text-sm text-zinc-500">
                Evidence-grounded medical document interpretation, wearable telemetry, and health memory.
              </p>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="flex items-center gap-1.5 p-1 bg-zinc-200/70 dark:bg-zinc-800/70 rounded-lg text-xs font-medium">
            <button
              onClick={() => setActiveTab('COMPANION')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                activeTab === 'COMPANION'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900'
              }`}
            >
              <Bot className="h-3.5 w-3.5" /> Companion
            </button>
            <button
              onClick={() => setActiveTab('INSIGHTS')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                activeTab === 'INSIGHTS'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" /> Insights
            </button>
            <button
              onClick={() => setActiveTab('MEMORY')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                activeTab === 'MEMORY'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900'
              }`}
            >
              <Brain className="h-3.5 w-3.5" /> Memory
            </button>
            <button
              onClick={() => setActiveTab('REMINDERS')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                activeTab === 'REMINDERS'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900'
              }`}
            >
              <Bell className="h-3.5 w-3.5" /> Reminders
            </button>
          </div>
        </div>

        {/* Tab Views */}
        {activeTab === 'COMPANION' && <CompanionView />}
        {activeTab === 'INSIGHTS' && <InsightsOverview insights={insights} loading={loading} />}
        {activeTab === 'MEMORY' && <MemoryManager memories={memories} onRefresh={fetchData} />}
        {activeTab === 'REMINDERS' && (
          <RemindersManager reminders={reminders} preferences={preferences} onRefresh={fetchData} />
        )}
      </div>
    </div>
  );
}
