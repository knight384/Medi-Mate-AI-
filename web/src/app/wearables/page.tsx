'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { WearableDashboard } from '@/components/wearables/wearable-dashboard';

export default function WearablesPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.back()}
            className="text-zinc-600 dark:text-zinc-400"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </div>

        <WearableDashboard />
      </div>
    </div>
  );
}
