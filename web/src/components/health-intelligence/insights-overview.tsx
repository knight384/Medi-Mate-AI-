'use client';

import React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { HealthInsight } from '@/lib/health-intelligence/types';
import { Activity, Moon, Heart, FlaskConical, Sparkles, AlertCircle } from 'lucide-react';

interface InsightsOverviewProps {
  insights: HealthInsight[];
  loading?: boolean;
}

export function InsightsOverview({ insights, loading }: InsightsOverviewProps) {
  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-zinc-500 animate-pulse">
        Aggregating clinical records and analyzing continuous health telemetry...
      </div>
    );
  }

  if (insights.length === 0) {
    return (
      <Card className="border-dashed bg-white/50 dark:bg-zinc-900/50">
        <CardContent className="py-8 text-center space-y-2">
          <Sparkles className="h-8 w-8 mx-auto text-zinc-400" />
          <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">No Insights Generated Yet</h3>
          <p className="text-sm text-zinc-500 max-w-md mx-auto">
            Synchronize wearable devices or upload clinical lab reports to generate personalized, non-diagnostic observational insights.
          </p>
        </CardContent>
      </Card>
    );
  }

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'ACTIVITY':
        return <Activity className="h-5 w-5 text-emerald-500" />;
      case 'SLEEP':
        return <Moon className="h-5 w-5 text-indigo-500" />;
      case 'HEART':
        return <Heart className="h-5 w-5 text-rose-500" />;
      case 'LABS':
        return <FlaskConical className="h-5 w-5 text-amber-500" />;
      default:
        return <Sparkles className="h-5 w-5 text-cyan-500" />;
    }
  };

  const getCoverageBadge = (coverage: string) => {
    switch (coverage) {
      case 'HIGH':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-medium">High Evidence</span>;
      case 'MEDIUM':
        return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 font-medium">Moderate Evidence</span>;
      default:
        return <span className="px-2 py-0.5 text-xs rounded-full bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300 font-medium">Limited Evidence</span>;
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {insights.map((insight) => (
          <Card key={insight.id} className="relative overflow-hidden border border-zinc-200 dark:border-zinc-800 hover:shadow-md transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                    {getCategoryIcon(insight.category)}
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                      {insight.title}
                    </CardTitle>
                    <CardDescription className="text-xs text-zinc-500">
                      Period: {insight.dateInterval.startDate} {insight.dateInterval.startDate !== insight.dateInterval.endDate && `to ${insight.dateInterval.endDate}`}
                    </CardDescription>
                  </div>
                </div>
                {getCoverageBadge(insight.evidenceCoverage)}
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
                {insight.description}
              </p>

              {insight.limitations && insight.limitations.length > 0 && (
                <div className="p-2.5 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 text-xs text-zinc-500 space-y-1">
                  <div className="flex items-center gap-1 font-medium text-zinc-600 dark:text-zinc-400">
                    <AlertCircle className="h-3.5 w-3.5" /> Limitations & Quality Notes
                  </div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {insight.limitations.map((lim, idx) => (
                      <li key={idx}>{lim}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-lg text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          <strong>Non-Diagnostic Observational Notice:</strong> These insights reflect automated mathematical aggregations of consumer sensors and personal records. They do not constitute a medical diagnosis or treatment plan. Consult your physician regarding persistent changes.
        </span>
      </div>
    </div>
  );
}
