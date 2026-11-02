/* eslint-disable */

import {ChatPromptTemplate} from "@langchain/core/prompts";
import {HealthCheckupSchema} from "@/lib/health-data/parser/schema";
import {parseWithBounds} from "@/lib/security/structural-boundary";
import {fileTypeFromBuffer} from 'file-type';
import {processBatchWithConcurrency} from "@/lib/health-data/parser/util";
import {getParsePrompt, MessagePayload} from "@/lib/health-data/parser/prompt";
import visions from "@/lib/health-data/parser/vision";
import documents from "@/lib/health-data/parser/document";
import {currentDeploymentEnv} from "@/lib/current-deployment-env";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {fromBuffer as pdf2picFromBuffer} from 'pdf2pic';
import {tasks} from "@trigger.dev/sdk/v3";
import type {pdfToImages} from "@/trigger/pdf-to-image";
import {localStorageDriver, isValidStorageKey, protectedScratchStorage} from "@/lib/storage";

interface VisionParserOptions {
    parser: string;
    model: string;
    apiKey: string;
    apiUrl?: string
}

interface DocumentParserOptions {
    parser: string;
    model: string;
    apiKey: string;
}

interface SourceParseOptions {
    file: string;
    visionParser?: VisionParserOptions
    documentParser?: DocumentParserOptions
}

interface InferenceOptions {
    imagePaths: string[],
    excludeImage: boolean,
    excludeText: boolean,
    visionParser: VisionParserOptions
    documentParser: DocumentParserOptions
}

async function loadFileBuffer(filePath: string): Promise<Buffer> {
    if (isValidStorageKey(filePath)) {
        return await localStorageDriver.readBuffer(filePath);
    }
    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
        return await fsp.readFile(filePath);
    }
    throw new Error(`Unauthorized or invalid document path: ${filePath}`);
}

async function documentOCR({document, documentParser}: { document: string, documentParser: DocumentParserOptions }) {
    // If document is stored in private storage, decrypt to short-lived temp file for OCR
    if (isValidStorageKey(document)) {
        return await localStorageDriver.withDecryptedTempFile(document, async (tempPath) => {
            return await runParserOcr(tempPath, documentParser);
        });
    }

    return await runParserOcr(document, documentParser);
}

async function runParserOcr(inputPath: string, documentParser: DocumentParserOptions) {
    const parser = documents.find(e => e.name === documentParser.parser);
    if (!parser) throw new Error('Invalid document parser');

    const models = await parser.models();
    const model = models.find(e => e.id === documentParser.model);
    if (!model) throw new Error('Invalid document parser model');

    const {ocr} = await parser.ocr({input: inputPath, model: model, apiKey: documentParser.apiKey});
    return ocr;
}

async function documentParse({document, documentParser}: {
    document: string,
    documentParser: DocumentParserOptions
}): Promise<any> {

    // Get the document parser
    const parser = documents.find(e => e.name === documentParser.parser)
    if (!parser) throw new Error('Invalid document parser')

    // Get the ocr result
    const models = await parser.models()
    const model = models.find(e => e.id === documentParser.model)
    if (!model) throw new Error('Invalid document parser model')

    // Get the parse result
    const {document: result} = await parser.parse({input: document, model: model, apiKey: documentParser.apiKey})

    return result
}

async function inference(inferenceOptions: InferenceOptions) {
    const {
        imagePaths,
        excludeImage,
        excludeText,
        visionParser: visionParserOptions,
        documentParser: documentParserOptions
    } = inferenceOptions

    // Extract text data if not excluding text
    const pageDataList: { page_content: string }[] | undefined = !excludeText ? await processBatchWithConcurrency(
        imagePaths,
        async (path) => {
            const {content} = await documentParse({document: path, documentParser: documentParserOptions})
            const {markdown} = content
            return {page_content: markdown}
        },
        2
    ) : undefined

    // Extract image data if not excluding images
    const imageDataList: string[] = !excludeImage ? await processBatchWithConcurrency(
        imagePaths,
        async (itemPath) => {
            if (itemPath.startsWith('data:')) {
                return itemPath;
            }
            try {
                const buffer = await fsp.readFile(itemPath);
                return `data:image/png;base64,${buffer.toString('base64')}`;
            } catch (readErr) {
                throw new Error(`Failed to read page image artifact: ${itemPath}`);
            }
        },
        4
    ) : []

    // Batch Inputs
    const numPages = pageDataList ? pageDataList.length : imageDataList.length
    const batchInputs: MessagePayload[] = new Array(numPages).fill(0).map((_, i) => ({
        ...(!excludeText && pageDataList ? {context: pageDataList[i].page_content} : {}),
        ...(!excludeImage && imageDataList ? {image_data: imageDataList[i]} : {})
    }))

    // Generate Messages
    const messages = ChatPromptTemplate.fromMessages(getParsePrompt({excludeImage, excludeText}));

    // Select Vision Parser
    const visionParser = visions.find(e => e.name === visionParserOptions.parser)
    if (!visionParser) throw new Error('Invalid vision parser')

    // Get models
    const visionParserModels = await visionParser.models({
        apiUrl: visionParserOptions.apiUrl,
    })
    const visionParserModel = visionParserModels.find(e => e.id === visionParserOptions.model)
    if (!visionParserModel) throw new Error('Invalid vision parser model')

    // Process the batch inputs
    const batchData = await processBatchWithConcurrency(
        batchInputs,
        async (input) => visionParser.parse({
            model: visionParserModel,
            messages: messages,
            input: input,
            apiKey: visionParserOptions.apiKey,
            apiUrl: visionParserOptions.apiUrl,
        }),
        3
    )

    // Merge the data into a single object
    let mergeData: any = {}
    let mergedTestResult: { [key: string]: any } = {}
    let mergedTestResultPage: { [key: string]: { page: number } } = {}

    for (let page = 0; page < batchData.length; page++) {
        const {test_result: testResult, ...healthCheckup} = batchData[page]
        for (const [key, value] of Object.entries(testResult)) {
            if (value && (value as { value: string }).value) {
                mergedTestResult[key] = value
                mergedTestResultPage[key] = {page: page + 1}
            }
        }

        // Merge health checkup data
        mergeData = {
            ...mergeData,
            ...healthCheckup,
        }
    }

    // Update test_result with merged data
    mergeData['test_result'] = mergedTestResult

    // Create final HealthCheckup object
    const finalHealthCheckup = parseWithBounds(HealthCheckupSchema, mergeData, {
        maxDepth: 5,
        maxKeys: 500,
    })

    return {
        finalHealthCheckup: finalHealthCheckup,
        mergedTestResultPage: mergedTestResultPage,
    }
}

/**
 * Convert a document to images
 * - Uses in-memory base64 buffers
 * - Writes temporary page images to private storage temp directory outside web/public/
 * - Returns paths and temp directory for lifecycle cleanup
 */
async function documentToImages({file: filePath}: Pick<SourceParseOptions, 'file'>): Promise<{
    imagePaths: string[];
    tempDir: string;
    releaseTempDir?: () => Promise<void>;
}> {
    const fileBuffer = await loadFileBuffer(filePath);
    const result = await fileTypeFromBuffer(fileBuffer);
    if (!result) throw new Error('Invalid file type');
    const mime = result.mime;

    // Convert pdf to images, or use the image as is
    const images: string[] = [];
    if (mime === 'application/pdf') {
        if (currentDeploymentEnv === 'local') {
            const pdf2picConverter = pdf2picFromBuffer(fileBuffer, {preserveAspectRatio: true});
            for (const image of await pdf2picConverter.bulk(-1, {responseType: 'base64'})) {
                if (image.base64) images.push(`data:image/png;base64,${image.base64}`);
            }
        } else {
            const result = await tasks.triggerAndPoll<typeof pdfToImages>(
                'pdf-to-image',
                {pdfUrl: filePath},
                {pollIntervalMs: 5000},
            );
            if (result.status === 'COMPLETED' && result.output) {
                images.push(...result.output.images.map((image) => `data:image/png;base64,${image}`));
            } else {
                throw new Error('Failed to convert the pdf to images');
            }
        }
    } else {
        images.push(`data:${mime};base64,${fileBuffer.toString('base64')}`);
    }

    // Write image data to protected scratch storage (RAM-backed tmpfs where available)
    const { dirPath: tempDir, release: releaseTempDir } =
        await protectedScratchStorage.allocateDir('ocr_scratch', 'pdf_page_extraction');

    const imagePaths: string[] = [];
    for (let i = 0; i < images.length; i++) {
        const pagePath = path.join(tempDir, `page_${i}.png`);
        await fsp.writeFile(pagePath, Buffer.from(images[i].split(',')[1], 'base64'), { mode: 0o600 });
        imagePaths.push(pagePath);
    }

    return { imagePaths, tempDir, releaseTempDir };
}

/**
 * Parse the health data with guaranteed temporary file cleanup
 */
export async function parseHealthData(options: SourceParseOptions) {
    const {file: filePath} = options

    // VisionParser
    const visionParser = options.visionParser || {
        parser: 'OpenAI',
        model: 'gpt-4o',
        apiKey: process.env.OPENAI_API_KEY as string
    }

    // Document Parser
    const documentParser = options.documentParser || {
        parser: 'Upstage',
        model: 'document-parse',
        apiKey: process.env.UPSTAGE_API_KEY as string
    }

    // Prepare images and track temporary directory
    const { imagePaths, tempDir, releaseTempDir } = await documentToImages({file: filePath});

    try {
        // Prepare ocr results
        const ocrResults = await documentOCR({
            document: filePath,
            documentParser: documentParser
        });

        // Prepare parse results
        await processBatchWithConcurrency(
            imagePaths,
            async (path) => documentParse({document: path, documentParser: documentParser}),
            3
        );

        // Merge the results
        const baseInferenceOptions = {imagePaths, visionParser, documentParser}
        const [
            {finalHealthCheckup: resultTotal, mergedTestResultPage: resultTotalPages},
            {finalHealthCheckup: resultText, mergedTestResultPage: resultTextPages},
            {finalHealthCheckup: resultImage, mergedTestResultPage: resultImagePages}
        ] = await Promise.all([
            inference({...baseInferenceOptions, excludeImage: false, excludeText: false}),
            inference({...baseInferenceOptions, excludeImage: false, excludeText: true}),
            inference({...baseInferenceOptions, excludeImage: true, excludeText: false}),
        ]);

        const resultDictTotal = resultTotal.test_result
        const resultDictText = resultText.test_result
        const resultDictImage = resultImage.test_result

        const mergedTestResult: { [key: string]: any } = {}
        const mergedPageResult: { [key: string]: { page: number } | null } = {}

        for (const key of HealthCheckupSchema.shape.test_result.keyof().options) {
            const valueTotal =
                resultDictTotal.hasOwnProperty(key) &&
                resultDictTotal[key] !== null &&
                resultDictTotal[key]!.value !== null
                    ? resultDictTotal[key]
                    : null;
            const pageTotal = valueTotal !== null ? resultTotalPages[key] : null;

            const valueText =
                resultDictText.hasOwnProperty(key) &&
                resultDictText[key] !== null &&
                resultDictText[key]!.value !== null
                    ? resultDictText[key]
                    : null;
            const pageText = valueText !== null ? resultTextPages[key] : null;

            const valueImage =
                resultDictImage.hasOwnProperty(key) &&
                resultDictImage[key] !== null &&
                resultDictImage[key]!.value !== null
                    ? resultDictImage[key]
                    : null;
            const pageImage = valueImage !== null ? resultImagePages[key] : null;

            if (valueTotal === null) {
                if (valueText !== null) {
                    mergedTestResult[key] = valueText;
                    mergedPageResult[key] = pageText;
                } else if (valueImage !== null) {
                    mergedTestResult[key] = valueImage;
                    mergedPageResult[key] = pageImage;
                } else {
                    mergedTestResult[key] = valueText;
                    mergedPageResult[key] = pageText;
                }
            } else {
                mergedTestResult[key] = valueTotal;
                mergedPageResult[key] = pageTotal;
            }
        }

        // Remove all null values in mergedTestResult
        for (const key in mergedTestResult) {
            if (mergedTestResult[key] === null) {
                delete mergedTestResult[key]
            }
        }

        const healthCheckup = parseWithBounds(
            HealthCheckupSchema,
            {
                ...resultTotal,
                test_result: mergedTestResult
            },
            {
                maxDepth: 5,
                maxKeys: 500,
            }
        )

        return {data: [healthCheckup], pages: [mergedPageResult], ocrResults: [ocrResults]}
    } finally {
        // Guaranteed cleanup of temporary scratch page images and lease release
        if (releaseTempDir) {
            try {
                await releaseTempDir();
            } catch {
                // Ignore cleanup error if already removed
            }
        } else if (tempDir) {
            try {
                await fsp.rm(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore
            }
        }
    }
}
