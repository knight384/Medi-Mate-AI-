import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { WearableDeletionService } from '@/lib/wearables/deletion';
import { WearableProviderId } from '@/lib/wearables/types';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const body = await req.json();
    const { providerId, purgeData = false } = body as {
      providerId: WearableProviderId;
      purgeData?: boolean;
    };

    if (!providerId) {
      return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    }

    if (purgeData) {
      const purgeResult = await WearableDeletionService.deleteProviderHealthData(
        userId,
        providerId
      );
      return NextResponse.json({
        success: true,
        action: 'PURGED_AND_DISCONNECTED',
        result: purgeResult,
      });
    }

    const disconnectResult = await WearableDeletionService.disconnectProvider(
      userId,
      providerId
    );

    return NextResponse.json({
      success: disconnectResult.success,
      action: 'DISCONNECTED',
      tokenRevoked: disconnectResult.tokenRevoked,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
