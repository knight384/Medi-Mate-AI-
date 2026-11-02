import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api/auth-helpers';
import { checkRateLimit } from '@/lib/security/rate-limiter';
import { readBoundedJson } from '@/lib/security/request-boundary';
import { validateStructuralBounds } from '@/lib/security/structural-boundary';
import { handleApiError, AppError } from '@/lib/errors';
import { ragClient } from '@/lib/rag/rag-client';

export interface ClientRAGQueryRequest {
  query: string;
  top_k?: number;
  document_ids?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const userId = session.user.id;

    // Rate-limiting check
    const rateLimit = await checkRateLimit(userId, {
      prefix: 'rag-query',
      maxRequests: 30,
      windowSeconds: 60,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded for RAG queries.' },
        { status: 429 }
      );
    }

    const body = await readBoundedJson<ClientRAGQueryRequest>(req, { maxBytes: 64 * 1024 });
    validateStructuralBounds(body, {
      maxDepth: 3,
      maxKeys: 10,
      maxStringLength: 2000,
    });

    if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const ragResponse = await ragClient.queryRAG({
      userId,
      query: body.query.trim(),
      topK: body.top_k,
      documentIds: body.document_ids,
    });

    return NextResponse.json(ragResponse);
  } catch (error) {
    if (error instanceof AppError) return handleApiError(error);
    return NextResponse.json({ error: 'Internal RAG query failure' }, { status: 500 });
  }
}
