import type {Prisma} from "@/lib/prisma";
import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {decrypt} from "@/lib/encryption";
import {currentDeploymentEnv} from "@/lib/current-deployment-env";
import {withTenantContext} from "@/lib/db-tenant";

export interface LLMProvider extends Prisma.LLMProviderGetPayload<{
    select: {
        id: true,
        providerId: true,
        name: true,
        apiKey: true,
        apiURL: true,
    }
}> {
    id: string
}

export interface LLMProviderListResponse {
    llmProviders: LLMProvider[]
}

export async function GET() {
    const session = await auth()
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({error: 'Unauthorized'}, {status: 401})
    }
    const userId = session.user.id;

    const llmProviders = await withTenantContext(userId, async (tx) => {
        return tx.lLMProvider.findMany({
            where: {authorId: userId},
            orderBy: {order: 'asc'}
        });
    });

    return NextResponse.json<LLMProviderListResponse>({
        llmProviders: llmProviders
            .filter(({providerId}) => {
                // exclude Ollama from cloud deployment
                if (currentDeploymentEnv === 'cloud') return !['ollama'].includes(providerId)
                return true;
            })
            .map((provider) => {
                let decryptedApiKey: string
                try {
                    decryptedApiKey = decrypt(provider.apiKey)
                } catch {
                    decryptedApiKey = ''
                }

                // Strictly ensure private API keys are never exposed if the provider is not user-owned
                const apiKey = provider.authorId === userId ? decryptedApiKey : '';

                return {...provider, apiKey}
            })
    })
}
