'use client';

import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, Send, FileText, Activity, AlertTriangle, ShieldCheck, HelpCircle } from 'lucide-react';
import { HealthCompanionResponse } from '@/lib/health-intelligence/types';

export function CompanionView() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<HealthCompanionResponse | null>(null);

  const sampleQueries = [
    'How has my resting heart rate changed recently?',
    'What was my average sleep duration last week?',
    'Explain my latest blood test and laboratory results.',
    'Compare my daily steps and activity over the last two weeks.',
    'What questions should I prepare for my upcoming doctor appointment?',
  ];

  const handleAsk = async (text: string) => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/health-intelligence/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text.trim() }),
      });
      const data = await res.json();
      if (data.response) {
        setResponse(data.response);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border border-zinc-200 dark:border-zinc-800">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-teal-50 dark:bg-teal-950 text-teal-600 dark:text-teal-400">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Evidence-Grounded Health Companion</CardTitle>
              <CardDescription className="text-xs">
                Context-aware retrieval combining medical documents, continuous telemetry, and user goals.
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Non-Diagnostic
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Sample query pills */}
        <div className="flex flex-wrap gap-1.5">
          {sampleQueries.map((q, idx) => (
            <button
              key={idx}
              onClick={() => {
                setQuery(q);
                handleAsk(q);
              }}
              className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>

        {/* Query Input */}
        <div className="flex gap-2">
          <Input
            placeholder="Ask a question about your medical documents, lab results, or wearable trends..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAsk(query)}
            disabled={loading}
          />
          <Button onClick={() => handleAsk(query)} disabled={loading || !query.trim()}>
            <Send className="h-4 w-4 mr-1" /> Ask
          </Button>
        </div>

        {/* Loading Indicator */}
        {loading && (
          <div className="py-6 text-center text-sm text-zinc-500 animate-pulse">
            Retrieving authorized context, evaluating longitudinal trends, and grounding evidence...
          </div>
        )}

        {/* Response Card */}
        {response && !loading && (
          <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 space-y-4 text-sm">
            {/* Intent Badge */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                Intent: {response.intent}
              </span>
              {response.emergencyGuidanceDelivered && (
                <span className="text-xs font-bold text-red-600 bg-red-100 dark:bg-red-950 px-2 py-0.5 rounded">
                  EMERGENCY GUIDANCE DELIVERED
                </span>
              )}
            </div>

            {/* Main Answer */}
            <div className="text-zinc-800 dark:text-zinc-200 leading-relaxed font-normal whitespace-pre-line">
              {response.answer}
            </div>

            {/* Evidence Citations */}
            {(response.citations.documents.length > 0 ||
              response.citations.observations.length > 0 ||
              response.citations.trends.length > 0) && (
              <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                <h5 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">
                  Supporting Evidence & Citations
                </h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {response.citations.documents.map((d, i) => (
                    <div key={i} className="p-2 rounded bg-white dark:bg-zinc-950 border flex items-start gap-2">
                      <FileText className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">{d.documentName} (p. {d.pageNumber})</div>
                        <div className="text-zinc-500 truncate">{d.sectionHeading}</div>
                      </div>
                    </div>
                  ))}
                  {response.citations.trends.map((t, i) => (
                    <div key={i} className="p-2 rounded bg-white dark:bg-zinc-950 border flex items-start gap-2">
                      <Activity className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">{t.metric} Comparison</div>
                        <div className="text-zinc-500">{t.reportingPeriod} ({t.sampleCount} samples)</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Suggested Doctor Questions */}
            {response.clinicianDiscussionPrompts && response.clinicianDiscussionPrompts.length > 0 && (
              <div className="p-3 rounded bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200/50 dark:border-blue-900/40 text-xs text-blue-900 dark:text-blue-200 space-y-1">
                <div className="flex items-center gap-1 font-semibold">
                  <HelpCircle className="h-3.5 w-3.5 text-blue-500" /> Suggested Questions for Your Clinician:
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {response.clinicianDiscussionPrompts.map((prompt, i) => (
                    <li key={i}>{prompt}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Limitations & Disclaimers */}
            {response.limitations.length > 0 && (
              <div className="text-[11px] text-zinc-500 space-y-0.5 pt-1">
                {response.limitations.map((lim, i) => (
                  <div key={i} className="flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500 mt-0.5" />
                    <span>{lim}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
