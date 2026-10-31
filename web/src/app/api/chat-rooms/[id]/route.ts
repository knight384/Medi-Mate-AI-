import { NextRequest, NextResponse } from 'next/server';
import { ChatRoom } from '@/app/api/chat-rooms/route';
import { assertResourceOwner, requireAuth } from '@/lib/api/auth-helpers';
import { handleApiError, NotFoundError } from '@/lib/errors';
import { withTenantContext } from '@/lib/db-tenant';

export interface ChatRoomPatchRequest {
  assistantModeId: string;
}

export interface ChatRoomPatchResponse {
  chatRoom: ChatRoom;
}

export interface ChatRoomGetResponse {
  chatRoom: ChatRoom;
}

const chatRoomSelect = {
  id: true,
  name: true,
  authorId: true,
  assistantMode: {
    select: {
      id: true,
      name: true,
      description: true,
      systemPrompt: true,
    },
  },
  llmProviderId: true,
  llmProviderModelId: true,
  createdAt: true,
  lastActivityAt: true,
} as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const chatRoom = await withTenantContext(session.user.id, async (tx) => {
      return tx.chatRoom.findUnique({
        where: { id },
        select: chatRoomSelect,
      });
    });

    if (!chatRoom) throw new NotFoundError('Chat room not found');
    assertResourceOwner(chatRoom.authorId, session.user.id);

    const { authorId, ...safeChatRoom } = chatRoom;
    void authorId;
    return NextResponse.json<ChatRoomGetResponse>({ chatRoom: safeChatRoom as ChatRoom });
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
    const body: ChatRoomPatchRequest = await req.json();

    const chatRoom = await withTenantContext(session.user.id, async (tx) => {
      const existing = await tx.chatRoom.findUniqueOrThrow({
        where: { id },
        select: { authorId: true },
      });
      assertResourceOwner(existing.authorId, session.user.id);

      return tx.chatRoom.update({
        where: { id },
        data: body,
        select: chatRoomSelect,
      });
    });

    const { authorId, ...safeChatRoom } = chatRoom;
    void authorId;
    return NextResponse.json<ChatRoomPatchResponse>({ chatRoom: safeChatRoom as ChatRoom });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    await withTenantContext(session.user.id, async (tx) => {
      const existing = await tx.chatRoom.findUniqueOrThrow({
        where: { id },
        select: { authorId: true },
      });
      assertResourceOwner(existing.authorId, session.user.id);

      await tx.chatRoom.delete({ where: { id } });
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
