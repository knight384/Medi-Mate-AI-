import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { HealthMemoryService } from '@/lib/health-intelligence/memory';
import { MemoryCategory } from '@/lib/health-intelligence/types';
import { readBoundedJson } from '@/lib/security/request-boundary';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const category = req.nextUrl.searchParams.get('category') as MemoryCategory | undefined;
  const memories = await HealthMemoryService.getActiveMemories(session.user.id, category);
  return NextResponse.json({ memories });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await readBoundedJson<{
      category: MemoryCategory;
      key: string;
      content: string;
      sourceType?: 'USER_EXPLICIT' | 'CONVERSATION_SUMMARY';
    }>(req, { maxBytes: 16 * 1024 });

    const memory = await HealthMemoryService.recordMemory({
      userId: session.user.id,
      category: body.category,
      key: body.key,
      content: body.content,
      sourceType: body.sourceType || 'USER_EXPLICIT',
    });

    return NextResponse.json({ memory });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await readBoundedJson<{
      memoryId: string;
      isPaused: boolean;
    }>(req, { maxBytes: 4 * 1024 });

    const success = await HealthMemoryService.togglePauseMemory(
      session.user.id,
      body.memoryId,
      body.isPaused
    );

    return NextResponse.json({ success });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const memoryId = req.nextUrl.searchParams.get('id');
  if (!memoryId) {
    return NextResponse.json({ error: 'Missing memory id' }, { status: 400 });
  }

  const success = await HealthMemoryService.deleteMemory(session.user.id, memoryId);
  return NextResponse.json({ success });
}
