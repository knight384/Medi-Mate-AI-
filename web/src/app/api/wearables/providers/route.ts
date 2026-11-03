import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { listSupportedProviders } from '@/lib/wearables/registry';
import { WearableConsentService } from '@/lib/wearables/consent';
import { WearableProviderId } from '@/lib/wearables/types';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  const capabilities = listSupportedProviders();

  if (!userId) {
    // Return capabilities without user-specific connection info
    return NextResponse.json({
      providers: capabilities.map((c) => ({
        ...c,
        connected: false,
        activeConsent: null,
      })),
    });
  }

  // Retrieve user's connections and consents
  let connections: any[] = [];
  try {
    connections = await prisma.wearableConnection.findMany({
      where: { userId },
    });
  } catch {
    // fallback if DB offline
  }

  const results = await Promise.all(
    capabilities.map(async (c) => {
      const conn = connections.find((cn) => cn.providerId === c.providerId);
      const consent = await WearableConsentService.getActiveConsent(
        userId,
        c.providerId as WearableProviderId
      );

      return {
        ...c,
        connected: conn ? conn.status === 'CONNECTED' : false,
        status: conn?.status || 'DISCONNECTED',
        lastSyncAt: conn?.lastSyncAt || null,
        lastSyncStatus: conn?.lastSyncStatus || null,
        activeConsent: consent
          ? {
              categories: consent.categories,
              purpose: consent.purpose,
              grantedAt: consent.grantedAt,
            }
          : null,
      };
    })
  );

  return NextResponse.json({ providers: results });
}
