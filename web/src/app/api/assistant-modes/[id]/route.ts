import {NextRequest, NextResponse} from "next/server";
import {AssistantMode} from "@/app/api/assistant-modes/route";
import {auth} from "@/auth";
import {withTenantContext} from "@/lib/db-tenant";

export interface AssistantModePatchRequest {
    systemPrompt?: string
}

export interface AssistantModePatchResponse {
    assistantMode: AssistantMode
}

export async function PATCH(
    req: NextRequest,
    {params}: { params: Promise<{ id: string }> }
) {
    const session = await auth()
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({message: "Unauthorized"}, {status: 401});
    }
    const userId = session.user.id;

    const {id} = await params
    const body: AssistantModePatchRequest = await req.json()

    const assistantMode = await withTenantContext(userId, async (tx) => {
        // Check if the user is the author of the assistant mode
        const checkAuthor = await tx.assistantMode.findUnique({select: {authorId: true}, where: {id}})
        if (checkAuthor?.authorId !== userId) {
            return null;
        }

        return tx.assistantMode.update({
            where: {id},
            data: body,
            select: {
                id: true,
                name: true,
                description: true,
                systemPrompt: true
            }
        });
    });

    if (!assistantMode) {
        return NextResponse.json({message: "Forbidden"}, {status: 403});
    }

    return NextResponse.json<AssistantModePatchResponse>({assistantMode})
}
