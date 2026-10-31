import { useState, useEffect, useCallback, useRef } from 'react';

export interface DocumentPreviewHealthData {
  id?: string | null;
  type?: string | null;
  fileType?: string | null;
  filePath?: string | null;
  status?: string | null;
}

export interface DocumentPreviewState {
  previewUrl: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  downloadUrl: string | null;
}

/**
 * Resolves the authenticated document download URL for a HealthData record.
 * Returns null if the record is not a FILE or is marked DELETING.
 * Never returns or leaks physical storage keys or public cloud URLs.
 */
export function getAuthenticatedDocumentUrl(
  healthData?: DocumentPreviewHealthData | null
): string | null {
  if (healthData?.type === 'FILE' && healthData?.id && healthData?.status !== 'DELETING') {
    return `/api/health-data/${healthData.id}/file`;
  }
  return null;
}

/**
 * Fetches the document blob from the authenticated endpoint.
 */
export async function fetchDocumentPreviewBlob(
  documentId: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; blob?: Blob; error?: string }> {
  try {
    const response = await fetch(`/api/health-data/${documentId}/file`, { signal });
    if (!response.ok) {
      let error = `Failed to load document preview (HTTP ${response.status}).`;
      if (response.status === 401 || response.status === 403) {
        error = 'Unauthorized: You do not have permission to view this document.';
      } else if (response.status === 404) {
        error = 'Document not found or has been removed.';
      }
      return { ok: false, status: response.status, error };
    }
    const blob = await response.blob();
    return { ok: true, status: 200, blob };
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      return { ok: false, status: 0, error: 'Request aborted' };
    }
    return { ok: false, status: 500, error: 'Network error while retrieving document preview.' };
  }
}

/**
 * Custom React hook for securely previewing private medical documents.
 * 
 * Never loads documents directly from physical file paths or opaque storage keys.
 * Instead, fetches from the authenticated endpoint `GET /api/health-data/[id]/file`,
 * converts the response into an in-memory browser Blob, and generates an object URL.
 * Automatically manages object URL lifecycle, AbortController cancellation, and error states.
 */
export function useAuthenticatedDocumentPreview(
  healthData?: DocumentPreviewHealthData | null
): DocumentPreviewState {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState<number>(0);

  const activeUrlRef = useRef<string | null>(null);

  const retry = useCallback(() => {
    setRetryCount((c) => c + 1);
  }, []);

  const downloadUrl = getAuthenticatedDocumentUrl(healthData);

  useEffect(() => {
    // If not a file record or missing ID, clear state
    if (healthData?.type !== 'FILE' || !healthData?.id) {
      if (activeUrlRef.current && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
      setPreviewUrl(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Records undergoing deletion are inaccessible
    if (healthData.status === 'DELETING') {
      if (activeUrlRef.current && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
      setPreviewUrl(null);
      setError('Document is being deleted and is unavailable.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const loadDocument = async () => {
      const result = await fetchDocumentPreviewBlob(healthData.id!, controller.signal);

      if (!result.ok) {
        if (result.error !== 'Request aborted') {
          setError(result.error || 'Failed to load document preview.');
          setLoading(false);
        }
        return;
      }

      const blob = result.blob!;
      if (activeUrlRef.current && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(activeUrlRef.current);
      }

        const objectUrl = (typeof URL !== 'undefined' && URL.createObjectURL)
          ? URL.createObjectURL(blob)
          : `blob:mock/${healthData.id}`;

        activeUrlRef.current = objectUrl;
        setPreviewUrl(objectUrl);
        setLoading(false);
    };

    loadDocument();

    return () => {
      controller.abort();
      if (activeUrlRef.current && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
    };
  }, [healthData?.id, healthData?.type, healthData?.status, retryCount]);

  return {
    previewUrl,
    loading,
    error,
    retry,
    downloadUrl,
  };
}
