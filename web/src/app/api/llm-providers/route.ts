import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {currentDeploymentEnv} from "@/lib/current-deployment-env";
import {withTenantContext} from "@/lib/db-tenant";

export interface LLMProvider {
    id: string;
    providerId: string;
    name: string;
    hasApiKey: boolean;
    apiKey: string; // Strictly masked; plaintext secret is NEVER exposed over the wire
    apiURL: string;
    order: number;
    authorId?: string | null;
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
                const hasApiKey = Boolean(provider.apiKey && provider.apiKey.trim() !== '');
                // Masked indicator: NEVER serialize decrypted secrets to the client
                const apiKey = hasApiKey ? '••••••••' : '';

                return {
                    id: provider.id,
                    providerId: provider.providerId,
                    name: provider.name,
                    hasApiKey,
                    apiKey,
                    apiURL: provider.apiURL,
                    order: provider.order,
                    authorId: provider.authorId,
                };
            })
    })
}
