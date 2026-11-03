import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getWearableConnector, wearableRegistry } from '@/lib/wearables/registry';
import { generateOAuthState, generatePKCE } from '@/lib/wearables/oauth';
import { HealthDataCategory, WearableProviderId } from '@/lib/wearables/types';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const body = await req.json();
    const { providerId, categories, redirectUri } = body as {
      providerId: WearableProviderId;
      categories: HealthDataCategory[];
      redirectUri?: string;
    };

    if (!providerId || !wearableRegistry.isProviderSupported(providerId)) {
      return NextResponse.json(
        { error: `Invalid or unsupported wearable provider: ${providerId}` },
        { status: 400 }
      );
    }

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return NextResponse.json(
        { error: 'At least one health data category must be authorized' },
        { status: 400 }
      );
    }

    const connector = getWearableConnector(providerId);
    const caps = connector.getCapabilities();

    if (caps.integrationStatus === 'BLOCKED') {
      return NextResponse.json(
        {
          error: `Provider '${caps.displayName}' is currently BLOCKED: ${caps.statusReason}`,
          providerId,
          status: caps.integrationStatus,
          reason: caps.statusReason,
        },
        { status: 400 }
      );
    }

    // Default redirectUri to current origin callback
    const origin = req.headers.get('origin') || 'http://localhost:3000';
    const effectiveRedirectUri = redirectUri || `${origin}/api/wearables/callback`;

    const { codeVerifier, codeChallenge } = caps.supportsPKCE
      ? generatePKCE()
      : { codeVerifier: undefined, codeChallenge: undefined };

    const state = generateOAuthState({
      userId,
      providerId,
      redirectUri: effectiveRedirectUri,
      codeVerifier,
      ttlSeconds: 600,
    });

    const authUrl = await connector.getAuthorizationUrl({
      state,
      codeChallenge,
      categories,
      redirectUri: effectiveRedirectUri,
    });

    return NextResponse.json({
      authUrl,
      state,
      providerId,
      categories,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
