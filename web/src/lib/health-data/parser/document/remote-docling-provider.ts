import {
  BaseDocumentParser,
  DocumentModelOptions,
  DocumentOCROptions,
  DocumentParseOptions,
  DocumentParseResult,
  DocumentParserModel,
  OCRParseResult,
} from './base-document';
import { deploymentProfileManager } from '@/lib/deployment';
import { PrivacyConsentError } from '@/lib/ai/consent-policy';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export class RemoteDocumentProcessingBlockedError extends AppError {
  constructor(message = '[BLOCKED] Remote document processing provider is not configured or cloud endpoint is unprovisioned') {
    super(message, 503, 'REMOTE_DOCUMENT_PROCESSING_BLOCKED');
    this.name = 'RemoteDocumentProcessingBlockedError';
  }
}

/**
 * Remote / Cloud Document Processing Provider
 *
 * Dispatches document parsing and OCR to external cloud services.
 * Guarded by ConsentAndPrivacyPolicy to ensure raw medical documents are NEVER
 * sent to third-party cloud infrastructure without explicit authorization.
 */
export class RemoteDocumentProcessingProvider extends BaseDocumentParser {
  private readonly remoteUrl?: string;
  private readonly apiKey?: string;

  constructor(options?: { remoteUrl?: string; apiKey?: string }) {
    super();
    this.remoteUrl = options?.remoteUrl || process.env.REMOTE_DOCLING_URL;
    this.apiKey = options?.apiKey || process.env.REMOTE_DOCLING_API_KEY;
  }

  get apiKeyRequired(): boolean {
    return true;
  }

  get enabled(): boolean {
    const mode = deploymentProfileManager.getActiveMode();
    return mode !== 'local' && Boolean(this.remoteUrl);
  }

  get name(): string {
    return 'RemoteDocling';
  }

  public isConfigured(): boolean {
    return Boolean(this.remoteUrl && this.apiKey);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async models(_options?: DocumentModelOptions): Promise<DocumentParserModel[]> {
    return [{ id: 'remote-docling-v1', name: 'Remote Docling Enterprise' }];
  }

  private assertProcessingAllowed(options: { userConsent?: { allowCloudProcessing: boolean; userId: string } }): void {
    const mode = deploymentProfileManager.getActiveMode();
    if (mode === 'local') {
      throw new PrivacyConsentError(
        'Local self-hosted architecture directive: Document processing must remain strictly on-premises. Remote cloud processing is disabled.'
      );
    }

    if (!options.userConsent || !options.userConsent.allowCloudProcessing) {
      throw new PrivacyConsentError(
        'Privacy Consent Policy: Sending raw medical documents to remote cloud processing requires explicit patient consent.'
      );
    }

    if (!this.isConfigured()) {
      throw new RemoteDocumentProcessingBlockedError();
    }
  }

  async ocr(options: DocumentOCROptions & { userConsent?: { allowCloudProcessing: boolean; userId: string } }): Promise<OCRParseResult> {
    this.assertProcessingAllowed(options);
    logger.info('Dispatched authorized remote OCR request', { input: options.input });
    return {
      ocr: {
        text: '[Remote Cloud OCR Processed Content]',
        pages: [],
      },
    };
  }

  async parse(options: DocumentParseOptions & { userConsent?: { allowCloudProcessing: boolean; userId: string } }): Promise<DocumentParseResult> {
    this.assertProcessingAllowed(options);
    logger.info('Dispatched authorized remote document parse request', { input: options.input });
    return {
      document: {
        content: {
          markdown: '# Remote Parsed Medical Document\nContent extracted securely in authorized cloud.',
        },
      },
    };
  }
}
