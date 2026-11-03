import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { getWearableConnector } from '@/lib/wearables/registry';
import { consumeOAuthState, encryptOAuthToken } from '@/lib/wearables/oauth';
import { WearableConsentService } from '@/lib/wearables/consent';
import { WearableSyncEngine } from '@/lib/wearables/sync';
import { HealthDataCategory, WearableProviderId } from '@/lib/wearables/types';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const body = await req.json();
    const { code, state, providerId, categories } = body as {
      code: string;
      state: string;
      providerId: WearableProviderId;
      categories: HealthDataCategory[];
    };

    if (!code || !state || !providerId) {
      return NextResponse.json(
        { error: 'Missing required OAuth parameters (code, state, providerId)' },
        { status: 400 }
      );
    }

    // 1. Consume and verify state (anti-CSRF)
    const stateMeta = consumeOAuthState(state, userId, providerId);

    // 2. Exchange code with upstream provider
    const connector = getWearableConnector(providerId);
    const tokenResult = await connector.exchangeCode({
      code,
      codeVerifier: stateMeta.codeVerifier,
      redirectUri: stateMeta.redirectUri,
    });

    // 3. Encrypt access and refresh tokens at rest using AES-256-GCM
    const encryptedAccess = encryptOAuthToken({
      token: tokenResult.accessToken,
      userId,
      providerId,
    });

    const encryptedRefresh = tokenResult.refreshToken
      ? encryptOAuthToken({
          token: tokenResult.refreshToken,
          userId,
          providerId,
        })
      : null;

    const tokenExpiresAt = tokenResult.expiresInSeconds
      ? new Date(Date.now() + tokenResult.expiresInSeconds * 1000)
      : null;

    // 4. Record granular user consent
    await WearableConsentService.recordConsent({
      userId,
      providerId,
      categories: categories || ['HEART', 'ACTIVITY', 'SLEEP'],
      purpose: 'Continuous biometric monitoring and AI health companion assistance',
    });

    // 5. Store connection in database
    await prisma.wearableConnection.upsert({
      where: {
        userId_providerId: { userId, providerId },
      },
      update: {
        status: 'CONNECTED',
        encryptedAccessToken: encryptedAccess,
        encryptedRefreshToken: encryptedRefresh,
        tokenExpiresAt,
        scope: tokenResult.scope,
        externalUserId: tokenResult.externalUserId,
      },
      create: {
        userId,
        providerId,
        status: 'CONNECTED',
        encryptedAccessToken: encryptedAccess,
        encryptedRefreshToken: encryptedRefresh,
        tokenExpiresAt,
        scope: tokenResult.scope,
        externalUserId: tokenResult.externalUserId,
      },
    });

    // 6. Trigger initial historical backfill sync in background
    let syncResult = null;
    try {
      syncResult = await WearableSyncEngine.syncUserProvider({
        userId,
        providerId,
        mode: 'HISTORICAL',
        lookbackDays: 7,
      });
    } catch {
      // background sync catch
    }

    return NextResponse.json({
      success: true,
      providerId,
      status: 'CONNECTED',
      syncResult,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
