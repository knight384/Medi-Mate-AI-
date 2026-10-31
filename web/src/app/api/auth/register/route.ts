import {NextResponse} from "next/server";
import {hash} from "bcryptjs";
import prisma from "@/lib/prisma";
import assistantModeSeed from "../../../../../prisma/data/assistant-mode.json";
import llmProviderSeed from "../../../../../prisma/data/llm-provider.json";
import { readBoundedJson } from "@/lib/security/request-boundary";
import { validateStructuralBounds } from "@/lib/security/structural-boundary";
import { handleApiError, AppError } from "@/lib/errors";

const MAX_REGISTER_PAYLOAD_BYTES = 64 * 1024; // 64 KB

export async function POST(request: Request) {
    try {
        const body = await readBoundedJson<{ username?: unknown; password?: unknown }>(request, {
            maxBytes: MAX_REGISTER_PAYLOAD_BYTES,
        });

        validateStructuralBounds(body, {
            maxDepth: 2,
            maxKeys: 10,
            maxStringLength: 256,
        });

        const {username, password} = body;
        if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
            return NextResponse.json({message: "Username and password are required"}, {status: 400});
        }

        if (username.length > 100) {
            return NextResponse.json({message: "Username must not exceed 100 characters"}, {status: 400});
        }

        if (password.length > 128) {
            return NextResponse.json({message: "Password must not exceed 128 characters"}, {status: 400});
        }

        // Hash the password
        const hashedPassword = await hash(password, 10);

        // Save the user to the database within an isolated transaction
        await prisma.$transaction(async (tx) => {
            // Create a new user (strictly bounded fields to prevent privilege escalation)
            const user = await tx.user.create({
                data: {
                    username,
                    password: hashedPassword,
                    hasOnboarded: false,
                }
            });

            // Set tenant context for this transaction so subsequent inserts pass RLS checks
            if (typeof tx.$executeRaw === 'function') {
                await tx.$executeRaw`SELECT set_config('app.current_user_id', ${user.id}, true);`;
            }

            // Create assistant modes for the newly registered user
            await tx.assistantMode.createMany({
                data: assistantModeSeed.map((mode) => ({
                    ...mode,
                    authorId: user.id,
                    visibility: 'PRIVATE',
                })),
            });

            // Create llm providers for the newly registered user
            await tx.lLMProvider.createMany({
                data: llmProviderSeed.map((provider) => ({
                    ...provider,
                    authorId: user.id
                })),
            });
        });

        return NextResponse.json({message: "success"}, {status: 201});
    } catch (e) {
        if (e instanceof AppError) {
            return handleApiError(e);
        }
        console.error(e);
        return NextResponse.json({message: "An error occurred"}, {status: 400});
    }
}
