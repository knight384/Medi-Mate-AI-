'use client';

import React, { useState } from 'react';
import { Activity, Heart, Moon, ShieldCheck, Thermometer, Zap } from 'lucide-react';

export interface TrendMetricGroup {
  metric: string;
  unit: string;
  dataPoints: {
    timestamp: string;
    value: number;
    providerId: string;
    deviceModel?: string;
    dataQuality: string;
  }[];
  summary: {
    avg: number;
    min: number;
    max: number;
    count: number;
    total?: number;
  };
}

interface HealthTrendChartsProps {
  metrics: Record<string, TrendMetricGroup>;
  selectedRange: string;
  onRangeChange: (range: string) => void;
  isLoading?: boolean;
}

export function HealthTrendCharts({
  metrics,
  selectedRange,
  onRangeChange,
  isLoading,
}: HealthTrendChartsProps) {
  const [activeTab, setActiveTab] = useState<'HEART' | 'ACTIVITY' | 'SLEEP' | 'VITALS'>('HEART');

  const rhr = metrics['RESTING_HEART_RATE'];
  const steps = metrics['STEPS'];
  const sleep = metrics['SLEEP_DURATION'];
  const spo2 = metrics['SPO2'];
  const hrv = metrics['HRV'];

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-600" />
            Continuous Health Telemetry & Trends
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Authenticated continuous biometric measurements with sensor provenance
          </p>
        </div>

        {/* Time Range Selector */}
        <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-lg">
          {(['day', 'week', 'month', '3months'] as const).map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                selectedRange === r
                  ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {r === '3months' ? '3 Months' : r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Category Pills */}
      <div className="flex gap-2 mb-6 border-b border-zinc-200 dark:border-zinc-800 pb-3">
        {[
          { key: 'HEART', label: 'Heart & HRV', icon: Heart },
          { key: 'ACTIVITY', label: 'Steps & Activity', icon: Zap },
          { key: 'SLEEP', label: 'Sleep Cycles', icon: Moon },
          { key: 'VITALS', label: 'Vitals & SpO2', icon: Thermometer },
        ].map((cat) => {
          const Icon = cat.icon;
          const isActive = activeTab === cat.key;
          return (
            <button
              key={cat.key}
              onClick={() => setActiveTab(cat.key as any)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isActive
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {cat.label}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-zinc-500 animate-pulse">
          Retrieving encrypted observations...
        </div>
      ) : (
        <div className="space-y-6">
          {/* Heart Tab */}
          {activeTab === 'HEART' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MetricCard
                title="Resting Heart Rate"
                icon={Heart}
                group={rhr}
                displayFormat={(v) => `${v} bpm`}
                badgeColor="text-rose-600 bg-rose-50 dark:bg-rose-950/30"
              />
              <MetricCard
                title="Heart Rate Variability (HRV)"
                icon={Activity}
                group={hrv}
                displayFormat={(v) => `${v} ms`}
                badgeColor="text-blue-600 bg-blue-50 dark:bg-blue-950/30"
              />
            </div>
          )}

          {/* Activity Tab */}
          {activeTab === 'ACTIVITY' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MetricCard
                title="Daily Steps"
                icon={Zap}
                group={steps}
                displayFormat={(v) => `${v.toLocaleString()} steps`}
                showTotal
                badgeColor="text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
              />
              <MetricCard
                title="Active Calories"
                icon={Zap}
                group={metrics['ACTIVE_CALORIES']}
                displayFormat={(v) => `${v} kcal`}
                showTotal
                badgeColor="text-amber-600 bg-amber-50 dark:bg-amber-950/30"
              />
            </div>
          )}

          {/* Sleep Tab */}
          {activeTab === 'SLEEP' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MetricCard
                title="Total Sleep Duration"
                icon={Moon}
                group={sleep}
                displayFormat={(v) => `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`}
                badgeColor="text-indigo-600 bg-indigo-50 dark:bg-indigo-950/30"
              />
              <MetricCard
                title="Sleep Efficiency"
                icon={ShieldCheck}
                group={metrics['SLEEP_EFFICIENCY']}
                displayFormat={(v) => `${v}%`}
                badgeColor="text-purple-600 bg-purple-50 dark:bg-purple-950/30"
              />
            </div>
          )}

          {/* Vitals Tab */}
          {activeTab === 'VITALS' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MetricCard
                title="Blood Oxygen (SpO2)"
                icon={Thermometer}
                group={spo2}
                displayFormat={(v) => `${v}%`}
                badgeColor="text-cyan-600 bg-cyan-50 dark:bg-cyan-950/30"
              />
              <MetricCard
                title="Skin Temperature"
                icon={Thermometer}
                group={metrics['BODY_TEMPERATURE']}
                displayFormat={(v) => `${v}°C`}
                badgeColor="text-orange-600 bg-orange-50 dark:bg-orange-950/30"
              />
            </div>
          )}

          {/* Clinical Provenance & Safeguard Banner */}
          <div className="bg-zinc-50 dark:bg-zinc-800/60 rounded-lg p-3 text-xs text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-800 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                Observational Health Data Notice:
              </span>{' '}
              Wearable sensor telemetry reflects non-diagnostic consumer trends. Never adjust
              medication or cardiovascular therapy without direct clinical evaluation by your physician.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  title,
  icon: Icon,
  group,
  displayFormat,
  showTotal,
  badgeColor,
}: {
  title: string;
  icon: any;
  group?: TrendMetricGroup;
  displayFormat: (val: number) => string;
  showTotal?: boolean;
  badgeColor: string;
}) {
  if (!group || group.dataPoints.length === 0) {
    return (
      <div className="bg-zinc-50 dark:bg-zinc-800/40 rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 text-center py-8">
        <Icon className="w-6 h-6 text-zinc-400 mx-auto mb-2 opacity-50" />
        <div className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{title}</div>
        <div className="text-xs text-zinc-400 mt-1">No measurements in selected time range</div>
      </div>
    );
  }

  const latest = group.dataPoints[group.dataPoints.length - 1];

  return (
    <div className="bg-zinc-50 dark:bg-zinc-800/40 rounded-xl p-5 border border-zinc-200 dark:border-zinc-800 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg ${badgeColor}`}>
              <Icon className="w-4 h-4" />
            </div>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</span>
          </div>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 uppercase">
            {latest.providerId}
          </span>
        </div>

        <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          {displayFormat(latest.value)}
        </div>
        <div className="text-xs text-zinc-400 mb-4">
          Latest reading: {new Date(latest.timestamp).toLocaleDateString()}{' '}
          {new Date(latest.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      <div className="pt-3 border-t border-zinc-200 dark:border-zinc-700/60 grid grid-cols-3 gap-2 text-center text-xs">
        <div>
          <div className="text-zinc-400 text-[10px] uppercase">Average</div>
          <div className="font-semibold text-zinc-700 dark:text-zinc-300">
            {displayFormat(group.summary.avg)}
          </div>
        </div>
        <div>
          <div className="text-zinc-400 text-[10px] uppercase">Range</div>
          <div className="font-semibold text-zinc-700 dark:text-zinc-300">
            {group.summary.min} - {group.summary.max}
          </div>
        </div>
        <div>
          <div className="text-zinc-400 text-[10px] uppercase">
            {showTotal && group.summary.total ? 'Total' : 'Readings'}
          </div>
          <div className="font-semibold text-zinc-700 dark:text-zinc-300">
            {showTotal && group.summary.total
              ? displayFormat(group.summary.total)
              : group.summary.count}
          </div>
        </div>
      </div>
    </div>
  );
}
