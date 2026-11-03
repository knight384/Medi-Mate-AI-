'use client';

import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Brain, Pause, Play, Trash2, Plus, ShieldCheck } from 'lucide-react';
import { UserMemoryItem } from '@/lib/health-intelligence/memory';
import { MemoryCategory } from '@/lib/health-intelligence/types';

interface MemoryManagerProps {
  memories: UserMemoryItem[];
  onRefresh: () => void;
}

export function MemoryManager({ memories, onRefresh }: MemoryManagerProps) {
  const [newKey, setNewKey] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<MemoryCategory>('GOAL');
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newContent.trim()) return;

    setSubmitting(true);
    try {
      await fetch('/api/health-intelligence/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: newCategory,
          key: newKey.trim(),
          content: newContent.trim(),
        }),
      });
      setNewKey('');
      setNewContent('');
      onRefresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleTogglePause = async (id: string, isPaused: boolean) => {
    await fetch('/api/health-intelligence/memory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: id, isPaused: !isPaused }),
    });
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to permanently delete this memory entry?')) return;
    await fetch(`/api/health-intelligence/memory?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    onRefresh();
  };

  return (
    <Card className="border border-zinc-200 dark:border-zinc-800">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
              <Brain className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">User-Controlled Health Memory</CardTitle>
              <CardDescription className="text-xs">
                Transparently inspect, pause, or delete persistent conversational health context.
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-1 rounded-full font-medium">
            <ShieldCheck className="h-3.5 w-3.5" /> Tenant Isolated
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Create Memory Form */}
        <form onSubmit={handleCreate} className="p-4 bg-zinc-50 dark:bg-zinc-900 rounded-lg space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Add Confirmed Health Goal or Preference</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
              className="px-3 py-1.5 text-sm rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200"
            >
              <option value="GOAL">Health Goal</option>
              <option value="PREFERENCE">Communication Preference</option>
              <option value="TOPIC">Monitored Topic</option>
            </select>
            <Input
              placeholder="Topic key (e.g. target_steps)"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              className="text-sm"
            />
            <Input
              placeholder="Confirmed statement or preference"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              className="text-sm"
            />
          </div>
          <Button type="submit" size="sm" disabled={submitting} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-1" /> Save Health Memory
          </Button>
        </form>

        {/* Existing Memories List */}
        <div className="space-y-2">
          {memories.length === 0 ? (
            <div className="py-6 text-center text-xs text-zinc-400">
              No conversational memories currently saved. The AI companion only remembers explicit user preferences and goals.
            </div>
          ) : (
            memories.map((m) => (
              <div
                key={m.id}
                className={`p-3 rounded-lg border text-sm flex items-center justify-between gap-3 ${
                  m.isPaused
                    ? 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 opacity-60'
                    : 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-[10px] uppercase font-bold rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                      {m.category}
                    </span>
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{m.key}</span>
                    {m.isPaused && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Paused</span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{m.content}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTogglePause(m.id, m.isPaused)}
                    title={m.isPaused ? 'Resume memory' : 'Pause memory'}
                    className="h-8 w-8 p-0"
                  >
                    {m.isPaused ? <Play className="h-4 w-4 text-emerald-500" /> : <Pause className="h-4 w-4 text-zinc-500" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(m.id)}
                    title="Delete permanently"
                    className="h-8 w-8 p-0 text-red-500 hover:text-red-700"
                  >
                    <Trash2 className="h-4 w-4" />
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
