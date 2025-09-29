"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileProcessor = void 0;
exports.getFileProcessor = getFileProcessor;
const promises_1 = require("fs/promises");
const path_1 = require("path");
const crypto_1 = require("crypto");
const db_1 = require("@pagespace/db");
const mammoth_1 = __importDefault(require("mammoth"));
/**
 * File processor for extracting text content from various file types
 * - PDF: pdf-parse library
 * - Word: mammoth library
 * - Text: direct extraction
 * - Images: AI vision API for OCR (marks as visual if OCR fails)
 */
class FileProcessor {
    STORAGE_ROOT;
    constructor() {
        this.STORAGE_ROOT = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-files';
    }
    async processFile(pageId) {
        const startTime = Date.now();
        try {
            // Get page data from database
            const [page] = await db_1.db
                .select()
                .from(db_1.pages)
                .where((0, db_1.eq)(db_1.pages.id, pageId))
                .limit(1);
            if (!page || !page.filePath) {
                return {
                    success: false,
                    content: '',
                    processingStatus: 'failed',
                    error: 'Page or file path not found'
                };
            }
            // Fetch file - prefer HTTP from processor, fallback to local FS
            let buffer;
            try {
                // Primary: Fetch from processor service via HTTP
                const processorUrl = process.env.PROCESSOR_URL || 'http://processor:3003';
                const contentHash = page.filePath; // filePath stores the content hash
                console.log(`[FileProcessor] Fetching file via HTTP: ${processorUrl}/cache/${contentHash}/original`);
                const response = await fetch(`${processorUrl}/cache/${contentHash}/original`, {
                    signal: AbortSignal.timeout(15000), // 15 second timeout
                });
                if (!response.ok) {
                    throw new Error(`Processor returned ${response.status}: ${response.statusText}`);
                }
                buffer = Buffer.from(await response.arrayBuffer());
                console.log(`[FileProcessor] Successfully fetched via HTTP, size: ${buffer.length}`);
            }
            catch (httpError) {
                // Fallback: Try local filesystem (for legacy records or during transition)
                console.warn(`[FileProcessor] HTTP fetch failed, falling back to local FS: ${httpError instanceof Error ? httpError.message : 'Unknown error'}`);
                try {
                    // Try with /original suffix (new structure)
                    const fullPath = (0, path_1.join)(this.STORAGE_ROOT, page.filePath, 'original');
                    buffer = await (0, promises_1.readFile)(fullPath);
                    console.log(`[FileProcessor] Fallback successful - found at ${fullPath}`);
                }
                catch {
                    // Try without /original suffix for very old records or different structure
                    const fullPath = (0, path_1.join)(this.STORAGE_ROOT, page.filePath);
                    buffer = await (0, promises_1.readFile)(fullPath);
                    console.log(`[FileProcessor] Fallback successful - found at ${fullPath} (legacy path)`);
                }
            }
            // Calculate content hash for deduplication
            const contentHash = (0, crypto_1.createHash)('sha256').update(buffer).digest('hex');
            // Check if we've already processed this exact file
            if (page.contentHash === contentHash && page.processingStatus === 'completed') {
                console.log(`Skipping duplicate file for page ${pageId}`);
                return {
                    success: true,
                    content: page.content || '',
                    processingStatus: 'completed',
                    extractionMethod: page.extractionMethod,
                    contentHash
                };
            }
            // Process based on mime type
            console.log(`Processing ${page.mimeType} file for page ${pageId}`);
            const result = await this.extractContent(buffer, page.mimeType || '', page.originalFileName || '', pageId);
            // Calculate metadata
            const metadata = {
                ...result.metadata,
                processingTimeMs: Date.now() - startTime,
                wordCount: result.content ? result.content.split(/\s+/).filter(w => w).length : 0,
                characterCount: result.content ? result.content.length : 0,
            };
            return {
                success: result.success,
                content: result.content,
                processingStatus: result.processingStatus,
                extractionMethod: result.extractionMethod,
                metadata,
                contentHash
            };
        }
        catch (error) {
            console.error(`Processing failed for page ${pageId}:`, error);
            return {
                success: false,
                content: '',
                processingStatus: 'failed',
                error: error instanceof Error ? error.message : 'Unknown error',
                metadata: {
                    processingTimeMs: Date.now() - startTime
                }
            };
        }
    }
    async extractContent(buffer, mimeType, fileName, pageId) {
        try {
            let content = '';
            let extractionMethod = 'text';
            let metadata = {};
            // Handle different file types
            switch (mimeType) {
                // PDF Files
                case 'application/pdf':
                    const pdfResult = await this.extractPDF(buffer);
                    content = pdfResult.content;
                    extractionMethod = 'text';
                    metadata = pdfResult.metadata;
                    break;
                // Word Documents
                case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                case 'application/msword':
                    content = await this.extractDOCX(buffer);
                    extractionMethod = 'text';
                    metadata.method = 'mammoth';
                    break;
                // Text-based files
                case 'text/plain':
                case 'text/markdown':
                case 'text/csv':
                case 'text/html':
                case 'text/css':
                case 'text/javascript':
                case 'application/javascript':
                case 'application/typescript':
                case 'text/x-python':
                case 'text/x-java':
                case 'text/x-c':
                case 'text/x-cpp':
                case 'text/x-csharp':
                case 'text/x-go':
                case 'text/x-rust':
                case 'text/x-ruby':
                case 'text/x-php':
                case 'text/x-swift':
                case 'text/x-kotlin':
                case 'text/x-scala':
                case 'text/x-yaml':
                case 'text/x-toml':
                case 'text/x-sql':
                case 'text/x-shell':
                case 'text/x-powershell':
                case 'application/json':
                case 'application/xml':
                case 'text/xml':
                    content = buffer.toString('utf-8');
                    extractionMethod = 'text';
                    metadata.method = 'direct';
                    break;
                // Image files - need AI OCR
                case 'image/jpeg':
                case 'image/jpg':
                case 'image/png':
                case 'image/gif':
                case 'image/webp':
                case 'image/bmp':
                case 'image/tiff':
                case 'image/svg+xml':
                    // For images, we'll use AI vision API for OCR
                    const ocrResult = await this.extractWithAIVision(buffer, mimeType, pageId);
                    if (ocrResult.success && ocrResult.content) {
                        content = ocrResult.content;
                        extractionMethod = 'ocr';
                        metadata = ocrResult.metadata;
                    }
                    else {
                        // If OCR fails or no text found, mark as visual
                        return {
                            success: true,
                            content: '',
                            processingStatus: 'visual',
                            extractionMethod: 'visual',
                            metadata: {
                                method: 'ai-vision',
                                error: ocrResult.error || 'No text found in image'
                            }
                        };
                    }
                    break;
                default:
                    // Check if it's a text file based on extension
                    const extension = fileName.split('.').pop()?.toLowerCase();
                    if (this.isTextFileExtension(extension)) {
                        content = buffer.toString('utf-8');
                        extractionMethod = 'text';
                        metadata.method = 'text-by-extension';
                    }
                    else {
                        // Binary or unsupported file - mark as visual
                        return {
                            success: true,
                            content: '',
                            processingStatus: 'visual',
                            extractionMethod: 'visual',
                            metadata: {
                                unsupportedType: mimeType
                            }
                        };
                    }
            }
            // Sanitize and check content
            content = this.sanitizeContent(content);
            const hasContent = !!(content && content.trim().length > 0);
            return {
                success: hasContent,
                content: content,
                processingStatus: hasContent ? 'completed' : 'visual',
                extractionMethod: hasContent ? extractionMethod : 'visual',
                metadata
            };
        }
        catch (error) {
            console.error('Content extraction failed:', error);
            throw error;
        }
    }
    /**
     * Extract text from PDF files
     */
    async extractPDF(buffer) {
        try {
            // Dynamic import to avoid build issues
            // @ts-ignore - pdf-parse doesn't have types
            const pdfParse = (await Promise.resolve().then(() => __importStar(require('pdf-parse-debugging-disabled')))).default;
            const data = await pdfParse(buffer);
            return {
                content: data.text || '',
                metadata: {
                    method: 'pdf-parse',
                    pageCount: data.numpages,
                    info: data.info
                }
            };
        }
        catch (error) {
            console.error('PDF extraction failed:', error);
            // Return empty content rather than throwing
            return {
                content: '',
                metadata: {
                    method: 'pdf-parse',
                    error: error instanceof Error ? error.message : 'PDF extraction failed'
                }
            };
        }
    }
    /**
     * Extract text from Word documents
     */
    async extractDOCX(buffer) {
        try {
            const result = await mammoth_1.default.extractRawText({ buffer });
            // Log any warnings from mammoth
            if (result.messages && result.messages.length > 0) {
                console.warn('DOCX extraction messages:', result.messages);
            }
            return result.value || '';
        }
        catch (error) {
            console.error('DOCX extraction failed:', error);
            return '';
        }
    }
    /**
     * Extract text from images using AI vision API
     */
    async extractWithAIVision(buffer, mimeType, pageId) {
        try {
            // Check if we have API keys configured
            const openaiKey = process.env.OPENAI_API_KEY;
            const anthropicKey = process.env.ANTHROPIC_API_KEY;
            const openrouterKey = process.env.OPENROUTER_API_KEY;
            if (!openaiKey && !anthropicKey && !openrouterKey) {
                console.log(`No AI API keys configured for OCR. Marking page ${pageId} as visual.`);
                return {
                    success: false,
                    content: '',
                    metadata: { method: 'ai-vision', status: 'no-api-keys' },
                    error: 'No AI API keys configured for OCR'
                };
            }
            // Convert buffer to base64
            const base64Image = buffer.toString('base64');
            const dataUrl = `data:${mimeType};base64,${base64Image}`;
            // Try OpenAI first if available
            if (openaiKey) {
                try {
                    const response = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${openaiKey}`
                        },
                        body: JSON.stringify({
                            model: 'gpt-4o-mini',
                            messages: [
                                {
                                    role: 'user',
                                    content: [
                                        {
                                            type: 'text',
                                            text: 'Extract all text from this image. Return only the text content, preserving the layout as much as possible. If there is no text in the image, return "NO_TEXT_FOUND".'
                                        },
                                        {
                                            type: 'image_url',
                                            image_url: {
                                                url: dataUrl
                                            }
                                        }
                                    ]
                                }
                            ],
                            max_tokens: 4096
                        })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        const extractedText = data.choices[0]?.message?.content || '';
                        if (extractedText && extractedText !== 'NO_TEXT_FOUND') {
                            console.log(`Successfully extracted text from image for page ${pageId} using OpenAI`);
                            return {
                                success: true,
                                content: extractedText,
                                metadata: {
                                    method: 'ai-vision',
                                    provider: 'openai',
                                    model: 'gpt-4o-mini'
                                }
                            };
                        }
                    }
                }
                catch (error) {
                    console.error('OpenAI OCR failed:', error);
                }
            }
            // Try Anthropic if OpenAI failed or unavailable
            if (anthropicKey) {
                try {
                    const response = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': anthropicKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify({
                            model: 'claude-3-haiku-20240307',
                            max_tokens: 4096,
                            messages: [
                                {
                                    role: 'user',
                                    content: [
                                        {
                                            type: 'text',
                                            text: 'Extract all text from this image. Return only the text content, preserving the layout as much as possible. If there is no text in the image, return "NO_TEXT_FOUND".'
                                        },
                                        {
                                            type: 'image',
                                            source: {
                                                type: 'base64',
                                                media_type: mimeType,
                                                data: base64Image
                                            }
                                        }
                                    ]
                                }
                            ]
                        })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        const extractedText = data.content[0]?.text || '';
                        if (extractedText && extractedText !== 'NO_TEXT_FOUND') {
                            console.log(`Successfully extracted text from image for page ${pageId} using Anthropic`);
                            return {
                                success: true,
                                content: extractedText,
                                metadata: {
                                    method: 'ai-vision',
                                    provider: 'anthropic',
                                    model: 'claude-3-haiku'
                                }
                            };
                        }
                    }
                }
                catch (error) {
                    console.error('Anthropic OCR failed:', error);
                }
            }
            // No text found in image
            console.log(`No text found in image for page ${pageId}`);
            return {
                success: false,
                content: '',
                metadata: {
                    method: 'ai-vision',
                    status: 'no-text-found'
                },
                error: 'No text found in image'
            };
        }
        catch (error) {
            console.error('AI Vision OCR failed:', error);
            return {
                success: false,
                content: '',
                metadata: {
                    method: 'ai-vision',
                    error: error instanceof Error ? error.message : 'OCR failed'
                },
                error: error instanceof Error ? error.message : 'OCR failed'
            };
        }
    }
    /**
     * Check if file extension indicates a text file
     */
    isTextFileExtension(extension) {
        if (!extension)
            return false;
        const textExtensions = [
            'txt', 'md', 'markdown', 'rst', 'log',
            'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
            'py', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
            'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala',
            'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1',
            'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
            'json', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less',
            'sql', 'graphql', 'gql',
            'r', 'R', 'rmd', 'Rmd',
            'vue', 'svelte',
            'dockerfile', 'containerfile',
            'makefile', 'cmake',
            'gitignore', 'env', 'editorconfig', 'prettierrc', 'eslintrc',
            'lock'
        ];
        return textExtensions.includes(extension.toLowerCase());
    }
    /**
     * Sanitize content for storage
     */
    sanitizeContent(content) {
        if (!content)
            return '';
        // Remove null bytes and other problematic characters
        return content
            .replace(/\0/g, '')
            .replace(/\r\n/g, '\n')
            .replace(/\n{4,}/g, '\n\n\n') // Max 3 newlines
            .replace(/[ \t]+$/gm, '') // Trailing whitespace
            .trim();
    }
}
exports.FileProcessor = FileProcessor;
// Export singleton instance
let processor = null;
async function getFileProcessor() {
    if (!processor) {
        processor = new FileProcessor();
    }
    return processor;
}
