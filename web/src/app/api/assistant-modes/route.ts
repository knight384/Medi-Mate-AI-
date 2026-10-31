import {NextRequest, NextResponse} from "next/server";
import type {Prisma} from "@/lib/prisma";
import {auth} from "@/auth";
import {withTenantContext} from "@/lib/db-tenant";

export interface AssistantMode extends Prisma.AssistantModeGetPayload<{
    select: { id: true, name: true, description: true, systemPrompt: true }
}> {
    id: string
}

export interface AssistantModeListResponse {
    assistantModes: AssistantMode[]
}

export interface AssistantModeCreateRequest {
    name: string;
    description: string;
    systemPrompt: string;
    context: string;
    visibility: 'PUBLIC' | 'PRIVATE';
}

export interface AssistantModeCreateResponse extends AssistantMode {
    id: string;
}

export async function GET() {
    const session = await auth()
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({message: "Unauthorized"}, {status: 401});
    }
    const userId = session.user.id;

    const assistantModes = await withTenantContext(userId, async (tx) => {
        return tx.assistantMode.findMany({
            where: {
                OR: [
                    {authorId: userId, visibility: 'PRIVATE'},
                    {visibility: 'PUBLIC'},
                ],
            },
            orderBy: {id: 'asc'},
        });
    });

    return NextResponse.json<AssistantModeListResponse>({
        assistantModes
    })
}

export async function POST(req: NextRequest) {
    const session = await auth()
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({message: "Unauthorized"}, {status: 401});
    }
    const userId = session.user.id;

    const data: AssistantModeCreateRequest = await req.json()

    const assistantMode = await withTenantContext(userId, async (tx) => {
        return tx.assistantMode.create({
            data: {
                name: data.name,
                description: data.description,
                systemPrompt: data.systemPrompt,
                authorId: userId,
                visibility: data.visibility,
                contexts: {
                    create: {
                        data: data.context,
                    }
                }
            }
        });
    });

    return NextResponse.json<AssistantModeCreateResponse>(assistantMode)
}
