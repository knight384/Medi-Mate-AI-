'use client';

import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Lock,
  RefreshCw,
  Trash2,
  Watch,
  XCircle,
} from 'lucide-react';
import { HealthTrendCharts, TrendMetricGroup } from './health-trend-charts';
import { HealthDataCategory, ProviderCapabilities, WearableProviderId } from '@/lib/wearables/types';

interface ProviderItem extends ProviderCapabilities {
  connected: boolean;
  status: string;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  activeConsent?: {
    categories: HealthDataCategory[];
    purpose: string;
    grantedAt: string;
  } | null;
}

export function WearableDashboard() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState('week');
  const [metrics, setMetrics] = useState<Record<string, TrendMetricGroup>>({});
  const [trendsLoading, setTrendsLoading] = useState(false);

  // Consent modal state
  const [consentModalProvider, setConsentModalProvider] = useState<ProviderItem | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<HealthDataCategory[]>([
    'HEART',
    'ACTIVITY',
    'SLEEP',
  ]);

  useEffect(() => {
    fetchProviders();
    fetchTrends(selectedRange);
  }, []);

  const fetchProviders = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/wearables/providers');
      if (res.ok) {
        const json = await res.json();
        setProviders(json.providers || []);
      }
    } catch {
      // offline/error
    } finally {
      setIsLoading(false);
    }
  };

  const fetchTrends = async (range: string) => {
    setTrendsLoading(true);
    try {
      const res = await fetch(`/api/wearables/trends?range=${range}`);
      if (res.ok) {
        const json = await res.json();
        setMetrics(json.metrics || {});
      }
    } catch {
      // offline/error
    } finally {
      setTrendsLoading(false);
    }
  };

  const handleRangeChange = (newRange: string) => {
    setSelectedRange(newRange);
    fetchTrends(newRange);
  };

  const handleConnectClick = (provider: ProviderItem) => {
    if (provider.integrationStatus === 'BLOCKED') {
      alert(`Provider blocked: ${provider.statusReason}`);
      return;
    }
    setConsentModalProvider(provider);
    setSelectedCategories(provider.supportedCategories);
  };

  const confirmConnect = async () => {
    if (!consentModalProvider) return;
    setActionLoading(consentModalProvider.providerId);

    try {
      const res = await fetch('/api/wearables/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: consentModalProvider.providerId,
          categories: selectedCategories,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        alert(json.error || 'Connection failed');
        return;
      }

      // If mock/sandbox mode, complete mock callback immediately
      if (json.authUrl.includes('mock_') || json.state) {
        const cbRes = await fetch('/api/wearables/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: `mock_code_${Date.now()}`,
            state: json.state,
            providerId: consentModalProvider.providerId,
            categories: selectedCategories,
          }),
        });

        if (cbRes.ok) {
          await fetchProviders();
          await fetchTrends(selectedRange);
          setConsentModalProvider(null);
          return;
        }
      }

      // Live vendor OAuth redirect
      window.location.href = json.authUrl;
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSync = async (providerId: WearableProviderId) => {
    setActionLoading(`sync_${providerId}`);
    try {
      const res = await fetch('/api/wearables/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, mode: 'INCREMENTAL' }),
      });
      if (res.ok) {
        await fetchProviders();
        await fetchTrends(selectedRange);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisconnect = async (providerId: WearableProviderId, purge = false) => {
    if (
      !confirm(
        purge
          ? 'Are you sure you want to permanently delete all synchronized data from this wearable and purge AI summary indexes?'
          : 'Disconnect this provider? Future synchronization will stop immediately.'
      )
    ) {
      return;
    }

    setActionLoading(`disconnect_${providerId}`);
    try {
      const res = await fetch('/api/wearables/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, purgeData: purge }),
      });
      if (res.ok) {
        await fetchProviders();
        await fetchTrends(selectedRange);
      }
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Provider Connectivity Cards */}
      <div>
        <div className="mb-4">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Watch className="w-5 h-5 text-emerald-600" />
            Connected Wearables & Health Sources
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Secure, user-authorized continuous health telemetry with granular consent control.
          </p>
        </div>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-zinc-500 animate-pulse">
            Inspecting connected wearable providers...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {providers.map((p) => {
              const isBlocked = p.integrationStatus === 'BLOCKED';
              const isConnected = p.connected;
              const isBusy = actionLoading?.includes(p.providerId);

              return (
                <div
                  key={p.providerId}
                  className={`rounded-xl border p-5 flex flex-col justify-between transition-all ${
                    isConnected
                      ? 'bg-white dark:bg-zinc-900 border-emerald-300 dark:border-emerald-800/80 shadow-sm'
                      : isBlocked
                      ? 'bg-zinc-50 dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 opacity-75'
                      : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                          {p.displayName}
                        </h4>
                        <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                          {p.platform}
                        </span>
                      </div>

                      {/* Status Badge */}
                      {isConnected ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-800">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Connected
                        </span>
                      ) : isBlocked ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1 rounded-full border border-amber-200 dark:border-amber-800">
                          <Lock className="w-3.5 h-3.5" />
                          Blocked
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">
                          Disconnected
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
                      {isBlocked
                        ? p.statusReason
                        : `Supports ${p.supportedCategories.join(', ').toLowerCase()} observations.`}
                    </p>

                    {/* Active Consent Categories */}
                    {isConnected && p.activeConsent && (
                      <div className="mb-4 bg-emerald-50/50 dark:bg-emerald-950/20 p-2.5 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                        <div className="text-[10px] font-semibold text-emerald-800 dark:text-emerald-300 uppercase mb-1">
                          Authorized Categories:
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {p.activeConsent.categories.map((c) => (
                            <span
                              key={c}
                              className="text-[10px] bg-white dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 font-medium"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                        {p.lastSyncAt && (
                          <div className="text-[10px] text-zinc-400 mt-2">
                            Last synced: {new Date(p.lastSyncAt).toLocaleDateString()}{' '}
                            {new Date(p.lastSyncAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Action Buttons */}
                  <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-2">
                    {isConnected ? (
                      <>
                        <button
                          onClick={() => handleSync(p.providerId)}
                          disabled={isBusy}
                          className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 py-1 px-2 rounded hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-all disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                          Sync Now
                        </button>

                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDisconnect(p.providerId, false)}
                            disabled={isBusy}
                            title="Disconnect provider"
                            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDisconnect(p.providerId, true)}
                            disabled={isBusy}
                            title="Purge all data & summaries"
                            className="text-xs text-rose-500 hover:text-rose-700 dark:hover:text-rose-400 p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    ) : isBlocked ? (
                      <span className="text-[11px] text-amber-700 dark:text-amber-400 font-medium italic">
                        Native application required
                      </span>
                    ) : (
                      <button
                        onClick={() => handleConnectClick(p)}
                        disabled={isBusy}
                        className="w-full py-1.5 px-3 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Authorize & Connect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Health Trend Visualization */}
      <HealthTrendCharts
        metrics={metrics}
        selectedRange={selectedRange}
        onRangeChange={handleRangeChange}
        isLoading={trendsLoading}
      />

      {/* Granular Consent Modal */}
      {consentModalProvider && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-6 max-w-md w-full shadow-xl">
            <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-2">
              Authorize {consentModalProvider.displayName}
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
              Select which health telemetry categories MediMate AI is authorized to access.
              Consent is enforced server-side and can be revoked at any time.
            </p>

            <div className="space-y-2 mb-6">
              {consentModalProvider.supportedCategories.map((cat) => {
                const isSelected = selectedCategories.includes(cat);
                return (
                  <label
                    key={cat}
                    className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'border-emerald-400 bg-emerald-50/40 dark:bg-emerald-950/20 text-emerald-900 dark:text-emerald-200'
                        : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <span className="text-sm font-medium">{cat} Observations</span>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedCategories((prev) =>
                          isSelected ? prev.filter((c) => c !== cat) : [...prev, cat]
                        );
                      }}
                      className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                    />
                  </label>
                );
              })}
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConsentModalProvider(null)}
                className="px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={confirmConnect}
                disabled={selectedCategories.length === 0 || Boolean(actionLoading)}
                className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-all disabled:opacity-50"
              >
                {actionLoading ? 'Connecting...' : 'Grant Consent & Proceed'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
