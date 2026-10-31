import { NextRequest, NextResponse } from 'next/server';
import prisma, { Prisma } from '@/lib/prisma';
import { HealthData } from '@/app/api/health-data/route';
import { assertResourceOwner, requireAuth } from '@/lib/api/auth-helpers';
import { handleApiError, NotFoundError } from '@/lib/errors';
import { cacheService } from '@/lib/redis';
import { readBoundedJson } from '@/lib/security/request-boundary';
import { validateStructuralBounds } from '@/lib/security/structural-boundary';
import { localStorageDriver, isValidStorageKey } from '@/lib/storage';
import { withTenantContext } from '@/lib/db-tenant';
import { logger } from '@/lib/logger';

export interface HealthDataPatchRequest {
  data?: Prisma.InputJsonValue;
}

export interface HealthDataGetResponse {
  healthData: HealthData;
}

type HealthDataRecord = Prisma.HealthDataGetPayload<{
  select: {
    id: true;
    type: true;
    data: true;
    metadata: true;
    status: true;
    fileType: true;
    filePath: true;
    createdAt: true;
    updatedAt: true;
    authorId: true;
  };
}>;

async function fetchHealthDataRecord(id: string, userId?: string): Promise<HealthDataRecord> {
  if (userId) {
    return withTenantContext(userId, async (tx) => {
      return tx.healthData.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          type: true,
          data: true,
          metadata: true,
          status: true,
          fileType: true,
          filePath: true,
          createdAt: true,
          updatedAt: true,
          authorId: true,
        },
      });
    });
  }

  return prisma.healthData.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      type: true,
      data: true,
      metadata: true,
      status: true,
      fileType: true,
      filePath: true,
      createdAt: true,
      updatedAt: true,
      authorId: true,
    },
  });
}

function toPublicHealthData(record: HealthDataRecord): HealthData {
  const { authorId: _authorId, ...healthData } = record;
  void _authorId;
  return healthData;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const record = await cacheService.getOrSet(
      `health-data:${id}`,
      () => fetchHealthDataRecord(id, session.user.id),
      { ttlSeconds: 300 },
    );

    assertResourceOwner(record.authorId, session.user.id);
    if (record.status === 'DELETING') {
      throw new NotFoundError('Health data record not found');
    }
    return NextResponse.json<HealthDataGetResponse>({ healthData: toPublicHealthData(record) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth();
    const { id } = await params;
    const body: HealthDataPatchRequest = await readBoundedJson<HealthDataPatchRequest>(req, {
      maxBytes: 2 * 1024 * 1024,
    });
    validateStructuralBounds(body, {
      maxDepth: 6,
      maxKeys: 300,
      maxArrayLength: 500,
    });

    const healthData = await withTenantContext(session.user.id, async (tx) => {
      const existing = await tx.healthData.findUniqueOrThrow({ where: { id } });
      assertResourceOwner(existing.authorId, session.user.id);
      if (existing.status === 'DELETING') {
        throw new NotFoundError('Health data record not found');
      }

      return tx.healthData.update({
        where: { id },
        data: body,
      });
    });

    await cacheService.delete(`health-data:${id}`);
    return NextResponse.json({ healthData });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const existing = await withTenantContext(session.user.id, async (tx) => {
      const record = await tx.healthData.findUniqueOrThrow({ where: { id } });
      assertResourceOwner(record.authorId, session.user.id);

      // 1. Mark status as DELETING in DB so concurrent access fails closed and state is recoverable
      if (record.status !== 'DELETING') {
        await tx.healthData.update({
          where: { id },
          data: { status: 'DELETING' },
        });
      }
      return record;
    });

    // 2. Idempotent physical file deletion
    if (existing.filePath && isValidStorageKey(existing.filePath)) {
      try {
        await localStorageDriver.delete(existing.filePath);
      } catch (storageErr) {
        logger.error('Failed to remove storage document during deletion', {
          id,
          error: (storageErr as Error).message,
        });
        throw storageErr; // Ensure failure halts DB deletion so retry can clean up
      }
    }

    // 3. Finalize database deletion and purge cache
    await withTenantContext(session.user.id, async (tx) => {
      await tx.healthData.delete({ where: { id } });
    });
    await cacheService.delete(`health-data:${id}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
