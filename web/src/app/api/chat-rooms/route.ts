import {Prisma} from "@/lib/prisma";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {withTenantContext} from "@/lib/db-tenant";

export interface ChatRoom extends Prisma.ChatRoomGetPayload<{
    select: {
        id: true,
        name: true,
        assistantMode: { select: { id: true, name: true, description: true, systemPrompt: true } },
        llmProviderId: true,
        llmProviderModelId: true,
        createdAt: true,
        lastActivityAt: true,
    }
}> {
    id: string
}

export interface ChatRoomListResponse {
    chatRooms: ChatRoom[]
}

export interface ChatRoomCreateResponse extends ChatRoom {
    id: string
}

export async function GET() {
    const session = await auth()
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({error: 'Unauthorized'}, {status: 401})
    }
    const userId = session.user.id;

    const chatRooms = await withTenantContext(userId, async (tx) => {
        return tx.chatRoom.findMany({
            select: {
                id: true,
                name: true,
                llmProviderId: true,
                llmProviderModelId: true,
                assistantMode: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        systemPrompt: true
                    }
                },
                createdAt: true,
                lastActivityAt: true,
            },
            where: {authorId: userId},
            orderBy: {lastActivityAt: 'desc'},
        });
    });

    return NextResponse.json<ChatRoomListResponse>({
        chatRooms
    })
}

export async function POST() {
    const session = await auth()
    const user = session?.user
    if (!session || !user || !user.id) {
        return NextResponse.json({error: 'Unauthorized'}, {status: 401})
    }

    const {id} = await withTenantContext(user.id, async (tx) => {
        // Get the last used chat room to get its assistant mode
        const lastChatRoom = await tx.chatRoom.findFirst({
            where: {authorId: user.id},
            orderBy: {updatedAt: 'desc'},
            select: {assistantModeId: true}
        });

        // If we have a last chat room, use its assistant mode, otherwise find the first one
        const assistantModeId = lastChatRoom?.assistantModeId || (await tx.assistantMode.findFirstOrThrow({
            where: {authorId: user.id}
        })).id;

        return tx.chatRoom.create({
            data: {
                authorId: user.id,
                name: 'New Chat',
                assistantModeId: assistantModeId,
                llmProviderId: (await tx.lLMProvider.findFirstOrThrow({where: {authorId: user.id}})).id,
            },
        });
    });

    const chatRoom = await withTenantContext(user.id, async (tx) => {
        return tx.chatRoom.findUniqueOrThrow({
            where: {id: id},
            select: {
                id: true,
                name: true,
                llmProviderId: true,
                llmProviderModelId: true,
                assistantMode: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        systemPrompt: true
                    }
                },
                createdAt: true,
                lastActivityAt: true
            }
        });
    });
    return NextResponse.json<ChatRoomCreateResponse>(chatRoom);
}
