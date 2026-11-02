import {NextRequest, NextResponse} from "next/server";
import type {Prisma} from "@/lib/prisma";
import {auth} from "@/auth";
import {decrypt} from "@/lib/encryption";
import {currentDeploymentEnv} from "@/lib/current-deployment-env";
import {ChatOpenAI} from "@langchain/openai";
import {ChatAnthropic} from "@langchain/anthropic";
import {ChatGoogleGenerativeAI} from "@langchain/google-genai";
import { readBoundedJson } from "@/lib/security/request-boundary";
import { validateStructuralBounds } from "@/lib/security/structural-boundary";
import { handleApiError, AppError } from "@/lib/errors";
import { withTenantContext } from "@/lib/db-tenant";
import { buildClinicalSystemPrompt } from "@/lib/clinical/emergency-guidance";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { ConsentAndPrivacyPolicy } from "@/lib/ai/consent-policy";

export interface ChatMessage extends Prisma.ChatMessageGetPayload<{
    select: {
        id: true,
        content: true,
        createdAt: true,
        role: true
    }
}> {
    id: string,
}

export interface ChatMessageListResponse {
    chatMessages: ChatMessage[]
}

export interface ChatMessageCreateRequest {
    content: string,
    role: 'USER' | 'ASSISTANT',
    settings?: {
        company: string,
        model: string,
        apiEndpoint: string,
        apiKey: string
    }
}

export async function GET(
    _req: NextRequest,
    {params}: { params: Promise<{ id: string }> }
) {
    const session = await auth()
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({error: 'Unauthorized'}, {status: 401})
    }
    const userId = session.user.id;
    const {id} = await params

    const chatMessages = await withTenantContext(userId, async (tx) => {
        return tx.chatMessage.findMany({
            where: {chatRoomId: id},
            orderBy: {createdAt: 'asc'}
        });
    });

    return NextResponse.json<ChatMessageListResponse>({chatMessages})
}

export async function POST(
    req: NextRequest,
    {params}: {
        params: Promise<{ id: string }>,
    }
) {
    const session = await auth()
    const user = session?.user
    if (!session || !user || !user.id) return NextResponse.json({error: 'Unauthorized'}, {status: 401})
    const userId = user.id;

    const rateLimit = await checkRateLimit(userId, {
        prefix: 'chat',
        maxRequests: 20,
        windowSeconds: 60,
    });
    if (!rateLimit.allowed) {
        return NextResponse.json(
            { error: 'Rate limit exceeded. Please wait a moment before sending more messages.' },
            {
                status: 429,
                headers: {
                    'Retry-After': String(rateLimit.resetSeconds),
                    'X-RateLimit-Limit': String(rateLimit.limit),
                    'X-RateLimit-Remaining': String(rateLimit.remaining),
                    'X-RateLimit-Reset': String(rateLimit.resetSeconds),
                },
            }
        );
    }

    const {id} = await params
    let body: ChatMessageCreateRequest
    try {
        body = await readBoundedJson<ChatMessageCreateRequest>(req, {
            maxBytes: 512 * 1024, // 512 KB
        });
        validateStructuralBounds(body, {
            maxDepth: 4,
            maxKeys: 20,
            maxStringLength: 100000,
        });
    } catch (err) {
        if (err instanceof AppError) return handleApiError(err);
        return NextResponse.json({error: 'Invalid request payload'}, {status: 400});
    }

    const {
        chatRoom,
        assistantMode,
        chatMessages,
        healthDataList,
        llmProvider
    } = await withTenantContext(userId, async (tx) => {
        await tx.chatMessage.create({data: {content: body.content, role: body.role, chatRoomId: id}});
        const {assistantMode} = await tx.chatRoom.update({
            where: {id},
            data: {lastActivityAt: new Date()},
            select: {assistantMode: {select: {systemPrompt: true}}}
        })
        const chatMessages = await tx.chatMessage.findMany({
            where: {chatRoomId: id},
            orderBy: {createdAt: 'asc'}
        })
        const healthDataList = await tx.healthData.findMany({where: {authorId: userId}})
        const chatRoom = await tx.chatRoom.findUniqueOrThrow({where: {id}})
        const llmProvider = await tx.lLMProvider.findUniqueOrThrow({where: {id: chatRoom.llmProviderId}});
        return {
            chatRoom,
            assistantMode,
            chatMessages,
            healthDataList,
            llmProvider
        }
    });

    let decryptedApiKey = ''
    try {
        decryptedApiKey = decrypt(llmProvider.apiKey)
    } catch {
        // If decryption fails, continue with empty string
    }

    const userRegion = req.headers.get('x-user-region') || undefined;

    const systemPrompt = buildClinicalSystemPrompt({
        regionCode: userRegion,
        assistantPrompt: assistantMode.systemPrompt,
        patientDataSummary: healthDataList.map((data) => JSON.stringify(data.data)).join('\n'),
    });

    // Validate deployment profile and privacy consent if targeting a cloud AI provider
    if (llmProvider.providerId !== 'ollama') {
        const userConsentHeader = req.headers.get('x-consent-cloud-processing');
        const allowCloudProcessing = userConsentHeader === 'true';

        ConsentAndPrivacyPolicy.assertCanProcessInCloud({
            taskType: 'clinical_query',
            sensitivity: 'HIGHLY_SENSITIVE_PHI',
            userConsent: {
                userId: session?.user?.id || '',
                allowCloudProcessing,
            },
        });
    }

    const selectedModel = chatRoom.llmProviderModelId ?? undefined;
    let chatModel: ChatOpenAI | ChatAnthropic | ChatGoogleGenerativeAI
    if (llmProvider.providerId === 'openai') {
        chatModel = new ChatOpenAI({
            apiKey: (currentDeploymentEnv === 'cloud' ? process.env.OPENAI_API_KEY : decryptedApiKey) || decryptedApiKey || process.env.OPENAI_API_KEY,
            model: selectedModel,
            configuration: {
                baseURL: llmProvider.apiURL
            }
        });
    } else if (llmProvider.providerId === 'anthropic') {
        chatModel = new ChatAnthropic({
            apiKey: (currentDeploymentEnv === 'cloud' ? process.env.ANTHROPIC_API_KEY : decryptedApiKey) || decryptedApiKey || process.env.ANTHROPIC_API_KEY,
            model: selectedModel,
            clientOptions: {
                baseURL: llmProvider.apiURL
            }
        });
    } else if (llmProvider.providerId === 'google') {
        chatModel = new ChatGoogleGenerativeAI({
            apiKey: (currentDeploymentEnv === 'cloud' ? process.env.GOOGLE_API_KEY : decryptedApiKey) || decryptedApiKey || process.env.GOOGLE_API_KEY,
            model: selectedModel,
        });
    } else if (llmProvider.providerId === 'ollama') {
        chatModel = new ChatOpenAI({
            apiKey: 'ollama',
            model: selectedModel,
            configuration: {
                baseURL: `${llmProvider.apiURL}/v1`
            }
        });
    } else {
        return NextResponse.json({error: 'Invalid LLM provider'}, {status: 400})
    }

    const messages = [
        {
            role: 'system',
            content: systemPrompt
        },
        ...chatMessages.map((message) => {
            return {
                role: message.role.toLowerCase(),
                content: message.content
            }
        })
    ]

    const responseStream = new ReadableStream({
        async start(controller) {
            try {
                const stream = await chatModel.stream(messages);
                let messageContent = ''
                for await (const chunk of stream) {
                    messageContent += chunk.text
                    controller.enqueue(`${JSON.stringify({text: chunk.text})}\n`);
                }

                await withTenantContext(userId, async (tx) => {
                    await tx.chatMessage.create({
                        data: {
                            content: messageContent,
                            role: 'ASSISTANT',
                            chatRoomId: id
                        }
                    });
                    await tx.chatRoom.update({
                        where: {id}, data: {lastActivityAt: new Date(), name: messageContent}
                    })
                });
            } catch (error) {
                console.error('Error in chat stream:', error);
                controller.enqueue(`${JSON.stringify({error: 'Failed to get response from LLM'})}\n`);
            }

            controller.close();
        }
    });

    return new NextResponse(responseStream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}
