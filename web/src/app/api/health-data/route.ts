import prisma, { Prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { parseHealthData } from "@/lib/health-data/parser/pdf";
import { auth } from "@/auth";
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { getErrorMessage, handleApiError, AppError } from '@/lib/errors';
import { readBoundedJson } from '@/lib/security/request-boundary';
import { validateStructuralBounds } from '@/lib/security/structural-boundary';
import {
    localStorageDriver,
    generateStorageKey,
} from '@/lib/storage';
import { readBoundedMultipart } from '@/lib/storage/multipart-reader';

export interface HealthData extends Prisma.HealthDataGetPayload<{
    select: {
        id: true,
        type: true,
        data: true,
        metadata: true,
        status: true,
        fileType: true,
        filePath: true,
        createdAt: true,
        updatedAt: true,
    }
}> {
    id: string
}

export interface HealthDataCreateRequest {
    id?: string;
    type: string;
    data: Prisma.InputJsonValue;
    filePath?: string | null;
    fileType?: string | null;
}

export interface HealthDataListResponse {
    healthDataList: HealthData[]
}

export interface HealthDataCreateResponse extends HealthData {
    id: string;
}

export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const contentType = req.headers.get('content-type');
    if (!contentType) {
        return NextResponse.json({ error: 'Missing content-type header' }, { status: 400 });
    }

    const MAX_JSON_BYTES = 2 * 1024 * 1024; // 2 MB

    if (contentType.includes('application/json')) {
        let data: HealthDataCreateRequest;
        try {
            data = await readBoundedJson<HealthDataCreateRequest>(req, { maxBytes: MAX_JSON_BYTES });
            validateStructuralBounds(data, {
                maxDepth: 6,
                maxKeys: 300,
                maxArrayLength: 500,
            });
        } catch (err) {
            if (err instanceof AppError) return handleApiError(err);
            return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
        }
        const healthData = await prisma.healthData.create({
            data: { ...data, authorId: session.user.id }
        });
        return NextResponse.json<HealthDataCreateResponse>(healthData);
    }

    if (contentType.includes('multipart/form-data')) {
        if (process.env.NODE_ENV === 'production' && !process.env.MEDIMATE_STORAGE_DIR) {
            logger.error('Document upload rejected: MEDIMATE_STORAGE_DIR is not configured in production');
            return NextResponse.json(
                { error: 'Persistent storage is not configured for production environment', code: 'STORAGE_NOT_CONFIGURED' },
                { status: 503 }
            );
        }

        let multipartResult;
        try {
            multipartResult = await readBoundedMultipart(req);
        } catch (err) {
            if (err instanceof AppError) return handleApiError(err);
            return NextResponse.json({ error: 'Failed to process multipart upload' }, { status: 400 });
        }

        const { fields, file, cleanup } = multipartResult;
        if (!file) {
            await cleanup();
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        const id = fields.id;
        const visionParser = fields.visionParser;
        const visionParserModel = fields.visionParserModel;
        const visionParserApiKey = fields.visionParserApiKey;
        const visionParserApiUrl = fields.visionParserApiUrl;

        const documentParser = fields.documentParser;
        const documentParserModel = fields.documentParserModel;
        const documentParserApiKey = fields.documentParserApiKey;

        const extension = path.extname(file.safeName) || '.bin';
        const storageKey = generateStorageKey(session.user.id, extension);
        const targetPath = localStorageDriver.resolveSecurePath(storageKey);

        try {
            await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
            if (await localStorageDriver.exists(storageKey)) {
                await cleanup();
                logger.error('Storage collision: file already exists', { storageKey });
                return NextResponse.json({ error: 'Storage collision detected' }, { status: 409 });
            }
            await fsp.rename(file.tempPath, targetPath);
        } catch (err) {
            await cleanup();
            logger.error('Failed to move upload to private storage', { error: (err as Error).message });
            return NextResponse.json({ error: 'Failed to store document' }, { status: 500 });
        }

        const baseData = {
            fileName: file.safeName,
            originalName: file.originalFilename,
            size: file.size,
            sha256: file.sha256,
        };

        let healthData;
        try {
            healthData = await prisma.healthData.create({
                data: {
                    id: id ? (id as string) : undefined,
                    type: 'FILE',
                    status: 'PARSING',
                    filePath: storageKey,
                    fileType: file.detectedMime,
                    data: { ...baseData },
                    authorId: session.user.id,
                },
            });

            // Process file through private OCR pipeline
            const { data, pages, ocrResults } = await parseHealthData({
                file: storageKey,
                visionParser: visionParser ? {
                    parser: visionParser,
                    model: visionParserModel,
                    apiKey: visionParserApiKey,
                    apiUrl: visionParserApiUrl || undefined,
                } : undefined,
                documentParser: documentParser ? {
                    parser: documentParser,
                    model: documentParserModel,
                    apiKey: documentParserApiKey,
                } : undefined,
            });

            healthData = await prisma.healthData.update({
                where: { id: healthData.id },
                data: {
                    status: 'COMPLETED',
                    metadata: JSON.parse(JSON.stringify({ ocr: ocrResults[0], dataPerPage: pages[0] })),
                    data: { ...baseData, ...data[0] },
                },
            });

            return NextResponse.json(healthData);
        } catch (error) {
            logger.error('Error processing health data file', { message: getErrorMessage(error) });
            const parsingLogs: string[] = [`Error: ${getErrorMessage(error)}`];
            if (healthData) {
                healthData = await prisma.healthData.update({
                    where: { id: healthData.id },
                    data: {
                        status: 'COMPLETED',
                        data: { ...baseData, parsingLogs },
                    },
                });
                return NextResponse.json(healthData);
            }
            await localStorageDriver.delete(storageKey);
            return NextResponse.json({ error: 'Failed to process file' }, { status: 500 });
        }
    }

    return NextResponse.json({ error: 'Unsupported content-type' }, { status: 415 });
}

export async function GET() {
    const session = await auth();
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Create personal info if it doesn't exist
    const personalInfo = await prisma.healthData.findFirst({
        where: { authorId: session.user.id, type: 'PERSONAL_INFO' },
    });
    if (personalInfo === null) {
        await prisma.healthData.create({
            data: { type: 'PERSONAL_INFO', authorId: session.user.id, data: {} },
        });
    }

    const healthDataList = await prisma.healthData.findMany({
        where: { authorId: session.user.id },
        orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json<HealthDataListResponse>({
        healthDataList,
    });
}
