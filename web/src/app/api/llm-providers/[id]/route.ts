import { NextRequest, NextResponse } from 'next/server';
import { LLMProvider } from '@/app/api/llm-providers/route';
import { encrypt } from '@/lib/encryption';
import { requireAuth } from '@/lib/api/auth-helpers';
import { handleApiError } from '@/lib/errors';
import { withTenantContext } from '@/lib/db-tenant';

export interface LLMProviderPatchRequest {
  apiKey?: string;
  apiURL?: string;
}

export interface LLMProviderPatchResponse {
  llmProvider: LLMProvider;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth();
    const { id } = await params;
    const body: LLMProviderPatchRequest = await req.json();

    const dataToUpdate: { apiURL?: string; apiKey?: string } = {};
    if (body.apiURL !== undefined) {
      dataToUpdate.apiURL = body.apiURL;
    }
    // Only encrypt and store if a real, new key is provided (not empty and not the masked placeholder)
    if (body.apiKey && body.apiKey.trim() !== '' && body.apiKey !== '••••••••') {
      dataToUpdate.apiKey = encrypt(body.apiKey.trim());
    }

    const llmProvider = await withTenantContext(session.user.id, async (tx) => {
      return tx.lLMProvider.update({
        where: { id },
        data: dataToUpdate,
      });
    });

    const hasApiKey = Boolean(llmProvider.apiKey && llmProvider.apiKey.trim() !== '');
    return NextResponse.json<LLMProviderPatchResponse>({
      llmProvider: {
        id: llmProvider.id,
        providerId: llmProvider.providerId,
        name: llmProvider.name,
        hasApiKey,
        apiKey: hasApiKey ? '••••••••' : '',
        apiURL: llmProvider.apiURL,
        order: llmProvider.order,
        authorId: llmProvider.authorId,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
