import { NextRequest } from 'next/server';
import { requireAuth, assertResourceOwner } from '@/lib/api/auth-helpers';
import { handleApiError, NotFoundError } from '@/lib/errors';
import { localStorageDriver, safeBasename } from '@/lib/storage';
import { withTenantContext } from '@/lib/db-tenant';
import { Readable } from 'node:stream';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const record = await withTenantContext(session.user.id, async (tx) => {
      return tx.healthData.findUnique({
        where: { id },
        select: {
          id: true,
          type: true,
          status: true,
          authorId: true,
          filePath: true,
          fileType: true,
          data: true,
        },
      });
    });

    if (!record || record.status === 'DELETING') {
      throw new NotFoundError('Health data record not found');
    }

    assertResourceOwner(record.authorId, session.user.id);

    if (record.type !== 'FILE' || !record.filePath) {
      throw new NotFoundError('No document attached to this health data record');
    }

    // Resolve opaque storage key via private storage driver
    const { stream, size, mimeType } = await localStorageDriver.readStream(record.filePath);

    // Extract safe display filename from record data
    const recordData = (record.data && typeof record.data === 'object') ? (record.data as Record<string, unknown>) : {};
    const rawFileName = typeof recordData.fileName === 'string'
      ? recordData.fileName
      : typeof recordData.originalName === 'string'
        ? recordData.originalName
        : 'medical_report.pdf';

    const safeName = safeBasename(rawFileName) || 'medical_report.pdf';
    const encodedName = encodeURIComponent(safeName);

    // Convert Node Readable to Web ReadableStream for standard Response
    const webStream = Readable.toWeb(stream);

    return new Response(webStream as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': record.fileType || mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeName.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`,
        'Content-Length': String(size),
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
