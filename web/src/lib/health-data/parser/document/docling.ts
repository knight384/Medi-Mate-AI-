import {
    BaseDocumentParser,
    DocumentModelOptions,
    DocumentOCROptions,
    DocumentParseOptions,
    DocumentParseResult,
    DocumentParserModel,
    OCRParseResult
} from "@/lib/health-data/parser/document/base-document";
import fetch from 'node-fetch'
import FormData from 'form-data'
import fs from 'node:fs'
import {currentDeploymentEnv} from "@/lib/current-deployment-env";
import {logger} from "@/lib/logger";

/**
 * Docling Serve v1 Asynchronous API Lifecycle:
 *
 * For long-running or batch conversions of complex multi-page clinical records,
 * Docling Serve v1 exposes an official asynchronous task processing workflow:
 *
 * 1. Dispatch Asynchronous Conversion:
 *    POST /v1/convert/file/async
 *    - Consumes multipart/form-data identical to /v1/convert/file
 *    - Returns HTTP 200 with JSON payload: { "task_id": string }
 *
 * 2. Status Polling:
 *    GET /v1/status/poll/{task_id}
 *    - Returns current task execution status:
 *      { "task_id": string, "status": "PENDING" | "STARTED" | "SUCCESS" | "FAILURE" }
 *    - Caller polls this endpoint using exponential backoff until a terminal state is reached.
 *    - NOTE: Do NOT use legacy non-standard paths like /v1/convert/tasks/{task_id}.
 *
 * 3. Retrieve Conversion Artifacts:
 *    GET /v1/result/{task_id}
 *    - Once /v1/status/poll/{task_id} reports "SUCCESS", this endpoint retrieves
 *      the completed document payload (markdown, json_content, or exported tables).
 */
export interface DoclingAsyncTaskResponse {
    task_id: string;
}

export type DoclingPollTaskStatus = 'PENDING' | 'STARTED' | 'SUCCESS' | 'FAILURE';

export interface DoclingTaskStatusResponse {
    task_id: string;
    status: DoclingPollTaskStatus;
    error?: string;
}

export type DoclingConversionStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

export interface DoclingCompletenessMetadata {
    status: DoclingConversionStatus;
    isIncomplete: boolean;
    errors?: unknown[];
}

export interface DoclingOCRParseResult extends OCRParseResult, DoclingCompletenessMetadata {
    ocr: unknown;
}

export interface DoclingDocumentParseResult extends DocumentParseResult, DoclingCompletenessMetadata {
    document: {
        content: {
            markdown: string;
        };
    };
}

interface DoclingV1Response {
    status?: 'success' | 'partial_success' | 'skipped' | 'failure';
    errors?: unknown[];
    document?: {
        json_content?: unknown;
        md_content?: string;
    };
}

export class DoclingDocumentParser extends BaseDocumentParser {
    get apiKeyRequired(): boolean {
        return false;
    }

    get enabled(): boolean {
        return currentDeploymentEnv === 'local' || currentDeploymentEnv === 'hybrid' || Boolean(process.env.DOCLING_URL);
    }

    get name(): string {
        return "Docling";
    }

    public get baseUrl(): string {
        return process.env.DOCLING_URL || 'http://docling-serve:5001';
    }

    public get timeoutMs(): number {
        return Number(process.env.DOCLING_TIMEOUT_MS) || 60000;
    }

    // Required by interface; this parser exposes a single fixed model.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async models(_options?: DocumentModelOptions): Promise<DocumentParserModel[]> {
        return [
            {id: 'document-parse', name: 'Document Parse'}
        ];
    }

    async ocr(options: DocumentOCROptions): Promise<DoclingOCRParseResult> {
        const formData = new FormData();
        // Use official v1 ocr_preset parameter rather than deprecated ocr_engine
        formData.append('ocr_preset', 'auto');
        formData.append('pdf_backend', 'dlparse_v2');
        formData.append('from_formats', 'pdf');
        formData.append('from_formats', 'docx');
        formData.append('from_formats', 'image');
        formData.append('force_ocr', 'false');
        formData.append('image_export_mode', 'placeholder');
        formData.append('ocr_lang', 'en');
        formData.append('ocr_lang', 'ko');
        formData.append('table_mode', 'fast');
        formData.append('files', fs.createReadStream(options.input));
        formData.append('abort_on_error', 'false');
        formData.append('to_formats', 'json');
        formData.append('return_as_file', 'false');
        formData.append('do_ocr', 'true');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            // Official Docling Serve v1.x API endpoint
            const response = await fetch(`${this.baseUrl}/v1/convert/file`, {
                method: 'POST',
                headers: {'accept': 'application/json'},
                body: formData,
                signal: controller.signal as import('node-fetch').RequestInit['signal'],
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Docling Serve API error (${response.status}): ${errorBody || response.statusText}`);
            }

            const data = await response.json() as DoclingV1Response;

            // Handle status codes explicitly
            if (data.status === 'failure' || data.status === 'skipped') {
                const errMsg = data.errors && data.errors.length > 0 ? JSON.stringify(data.errors) : `Conversion status was '${data.status}'`;
                throw new Error(`Docling conversion failed: ${errMsg}`);
            }

            const {document} = data;
            if (!document || !document.json_content) {
                throw new Error(`Docling Serve v1 API response missing document.json_content (status: ${data.status || 'unknown'})`);
            }

            const isPartial = data.status === 'partial_success';
            if (isPartial) {
                logger.warn('Docling Serve returned partial_success for OCR conversion', {
                    errorCount: data.errors?.length ?? 0
                });
            }

            const convertedJsonContent = this.convertJsonContent(document.json_content);
            return {
                ocr: convertedJsonContent,
                status: isPartial ? 'PARTIAL' : 'SUCCESS',
                isIncomplete: isPartial,
                errors: data.errors,
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async parse(options: DocumentParseOptions): Promise<DoclingDocumentParseResult> {
        const formData = new FormData();
        formData.append('ocr_preset', 'auto');
        formData.append('pdf_backend', 'dlparse_v2');
        formData.append('from_formats', 'pdf');
        formData.append('from_formats', 'docx');
        formData.append('from_formats', 'image');
        formData.append('force_ocr', 'true');
        formData.append('image_export_mode', 'placeholder');
        formData.append('ocr_lang', 'en');
        formData.append('ocr_lang', 'ko');
        formData.append('table_mode', 'fast');
        formData.append('files', fs.createReadStream(options.input));
        formData.append('abort_on_error', 'false');
        formData.append('to_formats', 'md');
        formData.append('return_as_file', 'false');
        formData.append('do_ocr', 'true');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            // Official Docling Serve v1.x API endpoint
            const response = await fetch(`${this.baseUrl}/v1/convert/file`, {
                method: 'POST',
                headers: {'accept': 'application/json'},
                body: formData,
                signal: controller.signal as import('node-fetch').RequestInit['signal'],
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Docling Serve API error (${response.status}): ${errorBody || response.statusText}`);
            }

            const data = await response.json() as DoclingV1Response;

            // Handle status codes explicitly
            if (data.status === 'failure' || data.status === 'skipped') {
                const errMsg = data.errors && data.errors.length > 0 ? JSON.stringify(data.errors) : `Conversion status was '${data.status}'`;
                throw new Error(`Docling conversion failed: ${errMsg}`);
            }

            const {document} = data;
            if (!document || typeof document.md_content !== 'string') {
                throw new Error(`Docling Serve v1 API response missing document.md_content (status: ${data.status || 'unknown'})`);
            }

            const isPartial = data.status === 'partial_success';
            if (isPartial) {
                logger.warn('Docling Serve returned partial_success for document parsing', {
                    errorCount: data.errors?.length ?? 0
                });
            }

            return {
                document: {content: {markdown: document.md_content}},
                status: isPartial ? 'PARTIAL' : 'SUCCESS',
                isIncomplete: isPartial,
                errors: data.errors,
            };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private convertCoordinates(bbox: { l: number; t: number; r: number; b: number }, pageHeight: number) {
        if (!bbox) return null;

        return {
            vertices: [
                {
                    x: Math.round(bbox.l),
                    y: Math.round(pageHeight - bbox.t)
                },
                {
                    x: Math.round(bbox.r),
                    y: Math.round(pageHeight - bbox.t)
                },
                {
                    x: Math.round(bbox.r),
                    y: Math.round(pageHeight - bbox.b)
                },
                {
                    x: Math.round(bbox.l),
                    y: Math.round(pageHeight - bbox.b)
                }
            ]
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private convertJsonContent(data: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = {
            metadata: {pages: []},
            pages: [],
            stored: false
        };

        // Process each page
        for (const [pageNum, value] of Object.entries(data.pages)) {
            const pageInfo = value as { size: { width: number, height: number } }
            const pageHeight = pageInfo.size.height;
            const pageWidth = pageInfo.size.width;

            // Add page metadata
            result.metadata.pages.push({
                height: pageHeight,
                page: parseInt(pageNum),
                width: pageWidth
            });

            // Initialize page object
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pageObject: any = {
                height: pageHeight,
                id: parseInt(pageNum) - 1,
                text: "",
                width: pageWidth,
                words: []
            };

            // Process text elements and create full text content
            let wordId = 0;
            let fullText = "";
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.texts.forEach((text: any) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                text.prov.forEach((prov: any) => {
                    if (prov.page_no.toString() === pageNum) {
                        pageObject.words.push({
                            boundingBox: this.convertCoordinates(prov.bbox, pageHeight),
                            confidence: 0.98,
                            id: wordId++,
                            text: text.text
                        });
                        fullText += text.text + " ";
                    }
                });
            });

            // Set full text content
            pageObject.text = fullText.trim();
            result.pages.push(pageObject);

            // Set overall document text
            result.text = fullText.trim();
        }

        return result;
    }
}
