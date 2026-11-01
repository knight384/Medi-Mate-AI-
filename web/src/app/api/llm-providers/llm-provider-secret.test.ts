import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/db-tenant', () => ({
  withTenantContext: vi.fn(),
}));

interface ProviderItem {
  id: string;
  hasApiKey: boolean;
  apiKey: string;
}

interface ProvidersResponse {
  llmProviders: ProviderItem[];
}

interface PatchResponse {
  llmProvider: ProviderItem;
}

type GetHandler = () => Promise<NextResponse<ProvidersResponse>>;
type PatchHandler = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) => Promise<NextResponse<PatchResponse>>;
type EncryptFn = (text: string) => string;

describe('LLMProvider Secret Isolation & Response Scrubbing', () => {
  const mockUser = { id: 'user_owner_123', username: 'clinician_bob' };
  const syntheticRawKey = 'sk-synthetic-live-secret-never-expose-9876543210';
  let getProviders: GetHandler;
  let updateProvider: PatchHandler;
  let encrypt: EncryptFn;
  let encryptedKey: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 'k').toString('base64');
    const route = await import('./route');
    const updateRoute = await import('./[id]/route');
    const enc = await import('@/lib/encryption');
    getProviders = route.GET as unknown as GetHandler;
    updateProvider = updateRoute.PATCH as unknown as PatchHandler;
    encrypt = enc.encrypt;
    encryptedKey = encrypt(syntheticRawKey);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/llm-providers', () => {
    it('returns 401 when unauthenticated', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue(null);
      const res = await getProviders();
      expect(res.status).toBe(401);
    });

    it('returns masked apiKey indicator and hasApiKey, never exposing plaintext secrets in JSON payload', async () => {
      const { auth } = await import('@/auth');
      const { withTenantContext } = await import('@/lib/db-tenant');
      vi.mocked(auth).mockResolvedValue({ user: mockUser } as unknown as Awaited<ReturnType<typeof auth>>);

      vi.mocked(withTenantContext).mockImplementation(async (_userId, callback) => {
        const mockTx = {
          lLMProvider: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'prov_1',
                company: 'OpenAI',
                model: 'gpt-4o',
                apiEndpoint: 'https://api.openai.com/v1',
                apiKey: encryptedKey,
                authorId: 'user_owner_123',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: 'prov_system',
                company: 'LocalOllama',
                model: 'llama3',
                apiEndpoint: 'http://localhost:11434',
                apiKey: '',
                authorId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          },
        };
        return callback(mockTx as unknown as Parameters<typeof callback>[0]);
      });

      const res = await getProviders();
      expect(res.status).toBe(200);

      const json = await res.json();
      const stringified = JSON.stringify(json);

      // Verify that plaintext key is STRICTLY absent from the serialized response
      expect(stringified).not.toContain(syntheticRawKey);

      expect(json.llmProviders).toHaveLength(2);

      // Owner provider check
      const ownerProv = json.llmProviders.find((p) => p.id === 'prov_1');
      expect(ownerProv?.hasApiKey).toBe(true);
      expect(ownerProv?.apiKey).toBe('••••••••');

      // System / empty key provider check
      const sysProv = json.llmProviders.find((p) => p.id === 'prov_system');
      expect(sysProv?.hasApiKey).toBe(false);
      expect(sysProv?.apiKey).toBe('');
    });
  });

  describe('PATCH /api/llm-providers/[id]', () => {
    it('does not overwrite existing encrypted key when placeholder •••••••• is passed', async () => {
      const { auth } = await import('@/auth');
      const { withTenantContext } = await import('@/lib/db-tenant');
      vi.mocked(auth).mockResolvedValue({ user: mockUser } as unknown as Awaited<ReturnType<typeof auth>>);

      const updateMock = vi.fn().mockResolvedValue({
        id: 'prov_1',
        providerId: 'prov_1',
        name: 'OpenAI',
        company: 'OpenAI',
        model: 'gpt-4o',
        apiURL: 'https://api.openai.com/v1',
        apiKey: encryptedKey,
        authorId: 'user_owner_123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      vi.mocked(withTenantContext).mockImplementation(async (_userId, callback) => {
        const mockTx = {
          lLMProvider: {
            update: updateMock,
          },
        };
        return callback(mockTx as unknown as Parameters<typeof callback>[0]);
      });

      const req = new NextRequest('http://localhost:3000/api/llm-providers/prov_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiURL: 'https://api.openai.com/v1',
          apiKey: '••••••••', // Masked placeholder sent back by client
        }),
      });

      const res = await updateProvider(req, { params: Promise.resolve({ id: 'prov_1' }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(JSON.stringify(json)).not.toContain(syntheticRawKey);
      expect(json.llmProvider.hasApiKey).toBe(true);
      expect(json.llmProvider.apiKey).toBe('••••••••');

      // Verify DB update did not update apiKey with placeholder string
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'prov_1' },
        data: {
          apiURL: 'https://api.openai.com/v1',
        },
      });
    });

    it('encrypts new key and returns masked indicator in response', async () => {
      const { auth } = await import('@/auth');
      const { withTenantContext } = await import('@/lib/db-tenant');
      vi.mocked(auth).mockResolvedValue({ user: mockUser } as unknown as Awaited<ReturnType<typeof auth>>);

      const newRawKey = 'sk-brand-new-secret-synthetic-key-11223344';
      const updateMock = vi.fn().mockResolvedValue({
        id: 'prov_1',
        providerId: 'prov_1',
        name: 'OpenAI',
        company: 'OpenAI',
        model: 'gpt-4o',
        apiURL: 'https://api.openai.com/v1',
        apiKey: encrypt(newRawKey),
        authorId: 'user_owner_123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      vi.mocked(withTenantContext).mockImplementation(async (_userId, callback) => {
        const mockTx = {
          lLMProvider: {
            update: updateMock,
          },
        };
        return callback(mockTx as unknown as Parameters<typeof callback>[0]);
      });

      const req = new NextRequest('http://localhost:3000/api/llm-providers/prov_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiURL: 'https://api.openai.com/v1',
          apiKey: newRawKey,
        }),
      });

      const res = await updateProvider(req, { params: Promise.resolve({ id: 'prov_1' }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(JSON.stringify(json)).not.toContain(newRawKey);
      expect(json.llmProvider.hasApiKey).toBe(true);
      expect(json.llmProvider.apiKey).toBe('••••••••');

      // Verify DB update called with encrypted key
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            apiKey: expect.any(String),
          }),
        })
      );
      const passedApiKey = updateMock.mock.calls[0][0].data.apiKey;
      expect(passedApiKey).not.toBe(newRawKey);
      expect(passedApiKey).not.toBe('••••••••');
    });
  });
});
