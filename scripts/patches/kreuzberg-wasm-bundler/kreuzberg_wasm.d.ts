/* tslint:disable */
/* eslint-disable */

/**
 * Get information about the WASM module
 */
export class ModuleInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the module name
     */
    name(): string;
    /**
     * Get the module version
     */
    version(): string;
}

/**
 * WASM-compatible PDF page iterator.
 *
 * Holds pre-rendered PNG pages and yields them one at a time on `next()`.
 * In WASM, true lazy rendering is limited because `PdfPageIterator::from_file`
 * requires filesystem access; instead we pre-render and dispense pages lazily.
 *
 * # JavaScript Usage
 *
 * ```js
 * const iter = new PdfPageIteratorWasm(pdfBytes, 150);
 * console.log(`Total pages: ${iter.pageCount()}`);
 * let result;
 * while ((result = iter.next()) !== null) {
 *     // result is a Uint8Array of PNG bytes
 *     processPage(result);
 * }
 * iter.free();
 * ```
 */
export class PdfPageIteratorWasm {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Free the iterator's internal state.
     */
    free(): void;
    /**
     * Create a new PDF page iterator from raw PDF bytes.
     */
    constructor(data: Uint8Array, dpi?: number | null);
    /**
     * Return the next page as `{ pageIndex: number, data: Uint8Array }`, or null if exhausted.
     */
    next(): any;
    /**
     * Total number of pages in the PDF.
     */
    pageCount(): number;
}

/**
 * Batch extract from multiple byte arrays (asynchronous).
 *
 * Asynchronously processes multiple document byte arrays in parallel.
 * Non-blocking alternative to `batchExtractBytesSync`.
 *
 * # JavaScript Parameters
 *
 * * `dataList: Uint8Array[]` - Array of document bytes
 * * `mimeTypes: string[]` - Array of MIME types (must match dataList length)
 * * `config?: object` - Optional extraction configuration (applied to all)
 * * `fileConfigs?: (object | null)[]` - Optional per-file config overrides (must match dataList length if provided)
 *
 * # Returns
 *
 * `Promise<object[]>` - Promise resolving to array of ExtractionResults
 *
 * # Throws
 *
 * Rejects if dataList and mimeTypes lengths don't match, or if fileConfigs
 * is provided and its length doesn't match dataList.
 *
 * # Example
 *
 * ```javascript
 * import { batchExtractBytes } from '@kreuzberg/wasm';
 *
 * const responses = await Promise.all([
 *   fetch('doc1.pdf'),
 *   fetch('doc2.docx')
 * ]);
 *
 * const buffers = await Promise.all(
 *   responses.map(r => r.arrayBuffer().then(b => new Uint8Array(b)))
 * );
 *
 * const results = await batchExtractBytes(
 *   buffers,
 *   ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
 *   null
 * );
 *
 * // With per-file configs:
 * const fileConfigs = [{ ocrConfig: { language: 'eng' } }, null];
 * const results2 = await batchExtractBytes(buffers, mimeTypes, null, fileConfigs);
 * ```
 */
export function batchExtractBytes(data_list: Uint8Array[], mime_types: string[], config?: any | null, file_configs?: any[] | null): Promise<any>;

/**
 * Batch extract from multiple byte arrays (synchronous).
 *
 * Processes multiple document byte arrays in parallel. All documents use the
 * same extraction configuration unless per-file configs are provided.
 *
 * # JavaScript Parameters
 *
 * * `dataList: Uint8Array[]` - Array of document bytes
 * * `mimeTypes: string[]` - Array of MIME types (must match dataList length)
 * * `config?: object` - Optional extraction configuration (applied to all)
 * * `fileConfigs?: (object | null)[]` - Optional per-file config overrides (must match dataList length if provided)
 *
 * # Returns
 *
 * `object[]` - Array of ExtractionResults in the same order as inputs
 *
 * # Throws
 *
 * Throws if dataList and mimeTypes lengths don't match, or if fileConfigs
 * is provided and its length doesn't match dataList.
 *
 * # Example
 *
 * ```javascript
 * import { batchExtractBytesSync } from '@kreuzberg/wasm';
 *
 * const buffers = [buffer1, buffer2, buffer3];
 * const mimeTypes = ['application/pdf', 'text/plain', 'image/png'];
 * const results = batchExtractBytesSync(buffers, mimeTypes, null);
 *
 * results.forEach((result, i) => {
 *   console.log(`Document ${i}: ${result.content.substring(0, 50)}...`);
 * });
 *
 * // With per-file configs:
 * const fileConfigs = [{ ocrConfig: { language: 'eng' } }, null, null];
 * const results2 = batchExtractBytesSync(buffers, mimeTypes, null, fileConfigs);
 * ```
 */
export function batchExtractBytesSync(data_list: Uint8Array[], mime_types: string[], config?: any | null, file_configs?: any[] | null): any;

/**
 * Batch extract from multiple Files or Blobs (asynchronous).
 *
 * Processes multiple web File or Blob objects in parallel using the FileReader API.
 * Only available in browser environments (FileReader API limitation).
 * For server-side environments, use `batchExtractBytes` with file data converted to Uint8Array.
 *
 * # JavaScript Parameters
 *
 * * `files: (File | Blob)[]` - Array of files or blobs to extract
 * * `config?: object` - Optional extraction configuration (applied to all)
 *
 * # Returns
 *
 * `Promise<object[]>` - Promise resolving to array of ExtractionResults
 *
 * # Example
 *
 * ```javascript
 * import { batchExtractFiles } from '@kreuzberg/wasm';
 *
 * // From file input with multiple files
 * const fileInput = document.getElementById('file-input');
 * const files = Array.from(fileInput.files);
 *
 * const results = await batchExtractFiles(files, null);
 * console.log(`Processed ${results.length} files`);
 * ```
 */
export function batchExtractFiles(files: File[], config?: any | null): Promise<any>;

/**
 * Batch extract from multiple files (synchronous) - NOT AVAILABLE IN WASM.
 *
 * File system operations are not available in WebAssembly environments.
 * Use `batchExtractBytesSync` or `batchExtractBytes` instead.
 *
 * # Throws
 *
 * Always throws: "File operations are not available in WASM. Use batchExtractBytesSync or batchExtractBytes instead."
 */
export function batchExtractFilesSync(): any;

/**
 * Clear all registered OCR backends.
 *
 * # Returns
 *
 * Ok if clearing succeeds, Err if an error occurs.
 *
 * # Example
 *
 * ```javascript
 * clearOcrBackends();
 * ```
 */
export function clear_ocr_backends(): void;

/**
 * Clear all registered post-processors.
 *
 * # Returns
 *
 * Ok if clearing succeeds, Err if an error occurs.
 *
 * # Example
 *
 * ```javascript
 * clearPostProcessors();
 * ```
 */
export function clear_post_processors(): void;

/**
 * Clear all registered validators.
 *
 * # Returns
 *
 * Ok if clearing succeeds, Err if an error occurs.
 *
 * # Example
 *
 * ```javascript
 * clearValidators();
 * ```
 */
export function clear_validators(): void;

/**
 * Compresses multiple entries into a 7z archive in WebAssembly environment.
 *
 * This function creates a compressed archive from multiple file entries,
 * designed specifically for WASM targets.
 *
 * # Arguments
 * * `entries` - Vector of JavaScript strings representing file names/paths
 * * `datas` - Vector of Uint8Arrays containing the file data corresponding to entries
 */
export function compress(entries: string[], datas: Uint8Array[]): Uint8Array;

/**
 * Decompresses a 7z archive in WebAssembly environment.
 *
 * This function is specifically designed for WASM targets and uses JavaScript interop
 * to handle the decompression process with a callback function.
 *
 * # Arguments
 * * `src` - Uint8Array containing the compressed archive data
 * * `pwd` - Password string for encrypted archives (use empty string for unencrypted)
 * * `f` - JavaScript callback function to handle extracted entries
 */
export function decompress(src: Uint8Array, pwd: string, f: Function): void;

/**
 * Detect MIME type from raw file bytes.
 *
 * Uses magic byte signatures and content analysis to detect the MIME type of
 * a document from its binary content. Falls back to text detection if binary
 * detection fails.
 *
 * # JavaScript Parameters
 *
 * * `data: Uint8Array` - The raw file bytes
 *
 * # Returns
 *
 * `string` - The detected MIME type (e.g., "application/pdf", "image/png")
 *
 * # Throws
 *
 * Throws an error if MIME type cannot be determined from the content.
 *
 * # Example
 *
 * ```javascript
 * import { detectMimeFromBytes } from '@kreuzberg/wasm';
 * import { readFileSync } from 'fs';
 *
 * const pdfBytes = readFileSync('document.pdf');
 * const mimeType = detectMimeFromBytes(new Uint8Array(pdfBytes));
 * console.log(mimeType); // "application/pdf"
 * ```
 */
export function detectMimeFromBytes(data: Uint8Array): string;

/**
 * Discover configuration file in the project hierarchy.
 *
 * In WebAssembly environments, configuration discovery is not available because
 * there is no file system access. This function always returns an error with a
 * descriptive message directing users to use `loadConfigFromString()` instead.
 *
 * # JavaScript Parameters
 *
 * None
 *
 * # Returns
 *
 * Never returns successfully.
 *
 * # Throws
 *
 * Always throws an error with message:
 * "discoverConfig is not available in WebAssembly (no file system access). Use loadConfigFromString() instead."
 *
 * # Example
 *
 * ```javascript
 * import { discoverConfig } from '@kreuzberg/wasm';
 *
 * try {
 *   const config = discoverConfig();
 * } catch (e) {
 *   console.error(e.message);
 *   // "discoverConfig is not available in WebAssembly (no file system access).
 *   // Use loadConfigFromString() instead."
 * }
 * ```
 */
export function discoverConfig(): any;

/**
 * Extract content from a byte array (asynchronous).
 *
 * Asynchronously extracts text, tables, images, and metadata from a document.
 * Non-blocking alternative to `extractBytesSync` suitable for large documents
 * or browser environments.
 *
 * # JavaScript Parameters
 *
 * * `data: Uint8Array` - The document bytes to extract
 * * `mimeType: string` - MIME type of the data (e.g., "application/pdf")
 * * `config?: object` - Optional extraction configuration
 *
 * # Returns
 *
 * `Promise<object>` - Promise resolving to ExtractionResult
 *
 * # Throws
 *
 * Rejects if data is malformed or MIME type is unsupported.
 *
 * # Example
 *
 * ```javascript
 * import { extractBytes } from '@kreuzberg/wasm';
 *
 * // Fetch from URL
 * const response = await fetch('document.pdf');
 * const arrayBuffer = await response.arrayBuffer();
 * const data = new Uint8Array(arrayBuffer);
 *
 * const result = await extractBytes(data, 'application/pdf', null);
 * console.log(result.content.substring(0, 100));
 * ```
 */
export function extractBytes(data: Uint8Array, mime_type: string, config?: any | null): Promise<any>;

/**
 * Extract content from a byte array (synchronous).
 *
 * Extracts text, tables, images, and metadata from a document represented as bytes.
 * This is a synchronous, blocking operation suitable for smaller documents or when
 * async execution is not available.
 *
 * # JavaScript Parameters
 *
 * * `data: Uint8Array` - The document bytes to extract
 * * `mimeType: string` - MIME type of the data (e.g., "application/pdf", "image/png")
 * * `config?: object` - Optional extraction configuration
 *
 * # Returns
 *
 * `object` - ExtractionResult with extracted content and metadata
 *
 * # Throws
 *
 * Throws an error if data is malformed or MIME type is unsupported.
 *
 * # Example
 *
 * ```javascript
 * import { extractBytesSync } from '@kreuzberg/wasm';
 * import { readFileSync } from 'fs';
 *
 * const buffer = readFileSync('document.pdf');
 * const data = new Uint8Array(buffer);
 * const result = extractBytesSync(data, 'application/pdf', null);
 * console.log(result.content);
 * ```
 */
export function extractBytesSync(data: Uint8Array, mime_type: string, config?: any | null): any;

/**
 * Extract content from a web File or Blob (asynchronous).
 *
 * Extracts content from a web File (from `<input type="file">`) or Blob object
 * using the FileReader API. Only available in browser environments (FileReader API limitation).
 * For server-side environments, use `extractBytes` with file data converted to Uint8Array.
 *
 * # JavaScript Parameters
 *
 * * `file: File | Blob` - The file or blob to extract
 * * `mimeType?: string` - Optional MIME type hint (auto-detected if omitted)
 * * `config?: object` - Optional extraction configuration
 *
 * # Returns
 *
 * `Promise<object>` - Promise resolving to ExtractionResult
 *
 * # Throws
 *
 * Rejects if file cannot be read or is malformed.
 *
 * # Example
 *
 * ```javascript
 * import { extractFile } from '@kreuzberg/wasm';
 *
 * // From file input
 * const fileInput = document.getElementById('file-input');
 * const file = fileInput.files[0];
 *
 * const result = await extractFile(file, null, null);
 * console.log(`Extracted ${result.content.length} characters`);
 * ```
 */
export function extractFile(file: File, mime_type?: string | null, config?: any | null): Promise<any>;

/**
 * Extract content from a file (synchronous) - NOT AVAILABLE IN WASM.
 *
 * File system operations are not available in WebAssembly environments.
 * Use `extractBytesSync` or `extractBytes` instead.
 *
 * # Throws
 *
 * Always throws: "File operations are not available in WASM. Use extractBytesSync or extractBytes instead."
 */
export function extractFileSync(): any;

/**
 * Get file extensions for a given MIME type.
 *
 * Looks up all known file extensions that correspond to the specified MIME type.
 * Returns a JavaScript Array of extension strings (without leading dots).
 *
 * # JavaScript Parameters
 *
 * * `mimeType: string` - The MIME type to look up (e.g., "application/pdf")
 *
 * # Returns
 *
 * `string[]` - Array of file extensions for the MIME type
 *
 * # Throws
 *
 * Throws an error if the MIME type is not recognized.
 *
 * # Example
 *
 * ```javascript
 * import { getExtensionsForMime } from '@kreuzberg/wasm';
 *
 * const pdfExts = getExtensionsForMime('application/pdf');
 * console.log(pdfExts); // ["pdf"]
 *
 * const jpegExts = getExtensionsForMime('image/jpeg');
 * console.log(jpegExts); // ["jpg", "jpeg"]
 * ```
 */
export function getExtensionsForMime(mime_type: string): Array<any>;

/**
 * Get MIME type from file extension.
 *
 * Looks up the MIME type associated with a given file extension.
 * Returns None if the extension is not recognized.
 *
 * # JavaScript Parameters
 *
 * * `extension: string` - The file extension (with or without leading dot)
 *
 * # Returns
 *
 * `string | null` - The MIME type if found, null otherwise
 *
 * # Example
 *
 * ```javascript
 * import { getMimeFromExtension } from '@kreuzberg/wasm';
 *
 * const pdfMime = getMimeFromExtension('pdf');
 * console.log(pdfMime); // "application/pdf"
 *
 * const docMime = getMimeFromExtension('docx');
 * console.log(docMime); // "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 *
 * const unknownMime = getMimeFromExtension('unknown');
 * console.log(unknownMime); // null
 * ```
 */
export function getMimeFromExtension(extension: string): string;

/**
 * Get module information
 */
export function get_module_info(): ModuleInfo;

/**
 * Initialize the WASM module
 * This function should be called once at application startup
 */
export function init(): void;

export function initThreadPool(_num_threads: number): Promise<any>;

/**
 * Helper function to initialize the thread pool with error handling
 * Accepts the number of threads to use for the thread pool.
 * Returns true if initialization succeeded, false for graceful degradation.
 *
 * This function wraps init_thread_pool with panic handling to ensure graceful
 * degradation if thread pool initialization fails. The application will continue
 * to work in single-threaded mode if the thread pool cannot be initialized.
 */
export function init_thread_pool_safe(num_threads: number): boolean;

/**
 * Establishes a binding between an external Pdfium WASM module and `pdfium-render`'s WASM module.
 * This function should be called from Javascript once the external Pdfium WASM module has been loaded
 * into the browser. It is essential that this function is called _before_ initializing
 * `pdfium-render` from within Rust code. For an example, see:
 * <https://github.com/ajrcarey/pdfium-render/blob/master/examples/index.html>
 */
export function initialize_pdfium_render(pdfium_wasm_module: any, local_wasm_module: any, debug: boolean): boolean;

/**
 * List all registered OCR backend names.
 *
 * # Returns
 *
 * Array of OCR backend names, or Err if an error occurs.
 *
 * # Example
 *
 * ```javascript
 * const backends = listOcrBackends();
 * console.log(backends); // ["tesseract", "custom-ocr", ...]
 * ```
 */
export function list_ocr_backends(): Array<any>;

/**
 * List all registered post-processor names.
 *
 * # Returns
 *
 * Array of post-processor names, or Err if an error occurs.
 *
 * # Example
 *
 * ```javascript
 * const processors = listPostProcessors();
 * console.log(processors); // ["my-post-processor", ...]
 * ```
 */
export function list_post_processors(): Array<any>;

/**
 * List all registered validator names.
 *
 * # Returns
 *
 * Array of validator names, or Err if an error occurs.
 *
 * # Example
 *
 * ```javascript
 * const validators = listValidators();
 * console.log(validators); // ["min-content-length", ...]
 * ```
 */
export function list_validators(): Array<any>;

/**
 * Load configuration from a string in the specified format.
 *
 * Parses configuration content from TOML, YAML, or JSON formats and returns
 * a JavaScript object representing the ExtractionConfig. This is the primary
 * way to load configuration in WebAssembly environments since file system
 * access is not available.
 *
 * # JavaScript Parameters
 *
 * * `content: string` - The configuration content as a string
 * * `format: string` - The format of the content: "toml", "yaml", or "json"
 *
 * # Returns
 *
 * `object` - JavaScript object representing the ExtractionConfig
 *
 * # Throws
 *
 * Throws an error if:
 * - The content is invalid for the specified format
 * - The format is not one of "toml", "yaml", or "json"
 * - Required configuration fields are missing or invalid
 *
 * # Example
 *
 * ```javascript
 * import { loadConfigFromString } from '@kreuzberg/wasm';
 *
 * // Load from TOML string
 * const tomlConfig = `
 * use_cache = true
 * enable_quality_processing = true
 * `;
 * const config1 = loadConfigFromString(tomlConfig, 'toml');
 * console.log(config1.use_cache); // true
 *
 * // Load from YAML string
 * const yamlConfig = `
 * use_cache: true
 * enable_quality_processing: true
 * `;
 * const config2 = loadConfigFromString(yamlConfig, 'yaml');
 *
 * // Load from JSON string
 * const jsonConfig = `{"use_cache": true, "enable_quality_processing": true}`;
 * const config3 = loadConfigFromString(jsonConfig, 'json');
 * ```
 */
export function loadConfigFromString(content: string, format: string): any;

/**
 * Normalize a MIME type string.
 *
 * Normalizes a MIME type by converting to lowercase and removing parameters
 * (e.g., "application/json; charset=utf-8" becomes "application/json").
 * This is useful for consistent MIME type comparison.
 *
 * # JavaScript Parameters
 *
 * * `mimeType: string` - The MIME type string to normalize
 *
 * # Returns
 *
 * `string` - The normalized MIME type
 *
 * # Example
 *
 * ```javascript
 * import { normalizeMimeType } from '@kreuzberg/wasm';
 *
 * const normalized1 = normalizeMimeType('Application/JSON');
 * console.log(normalized1); // "application/json"
 *
 * const normalized2 = normalizeMimeType('text/html; charset=utf-8');
 * console.log(normalized2); // "text/html"
 *
 * const normalized3 = normalizeMimeType('Text/Plain; charset=ISO-8859-1');
 * console.log(normalized3); // "text/plain"
 * ```
 */
export function normalizeMimeType(mime_type: string): string;

/**
 * Check if OCR support is available in this WASM build.
 *
 * Returns `true` if the `ocr-wasm` feature was enabled at build time.
 */
export function ocrIsAvailable(): boolean;

/**
 * A callback function that can be invoked by Pdfium's `FPDF_LoadCustomDocument()` function,
 * wrapping around `crate::utils::files::read_block_from_callback()` to shuffle data buffers
 * from our WASM memory heap to Pdfium's WASM memory heap as they are loaded.
 */
export function read_block_from_callback_wasm(param: number, position: number, pBuf: number, size: number): number;

/**
 * Register a custom OCR backend.
 *
 * # Arguments
 *
 * * `backend` - JavaScript object implementing the OcrBackendProtocol interface:
 *   - `name(): string` - Unique backend name
 *   - `supportedLanguages(): string[]` - Array of language codes the backend supports
 *   - `processImage(imageBase64: string, language: string): Promise<string>` - Process image and return JSON result
 *
 * # Returns
 *
 * Ok if registration succeeds, Err with description if it fails.
 *
 * # Example
 *
 * ```javascript
 * registerOcrBackend({
 *   name: () => "custom-ocr",
 *   supportedLanguages: () => ["en", "es", "fr"],
 *   processImage: async (imageBase64, language) => {
 *     const buffer = Buffer.from(imageBase64, "base64");
 *     // Process image with custom OCR engine
 *     const text = await customOcrEngine.recognize(buffer, language);
 *     return JSON.stringify({
 *       content: text,
 *       mime_type: "text/plain",
 *       metadata: {}
 *     });
 *   }
 * });
 * ```
 */
export function register_ocr_backend(backend: any): void;

/**
 * Register a custom post-processor.
 *
 * # Arguments
 *
 * * `processor` - JavaScript object implementing the PostProcessorProtocol interface:
 *   - `name(): string` - Unique processor name
 *   - `process(jsonString: string): Promise<string>` - Process function that takes JSON input
 *   - `processingStage(): "early" | "middle" | "late"` - Optional processing stage (defaults to "middle")
 *
 * # Returns
 *
 * Ok if registration succeeds, Err with description if it fails.
 *
 * # Example
 *
 * ```javascript
 * registerPostProcessor({
 *   name: () => "my-post-processor",
 *   processingStage: () => "middle",
 *   process: async (jsonString) => {
 *     const result = JSON.parse(jsonString);
 *     // Process the extraction result
 *     result.metadata.processed_by = "my-post-processor";
 *     return JSON.stringify(result);
 *   }
 * });
 * ```
 */
export function register_post_processor(processor: any): void;

/**
 * Register a custom validator.
 *
 * # Arguments
 *
 * * `validator` - JavaScript object implementing the ValidatorProtocol interface:
 *   - `name(): string` - Unique validator name
 *   - `validate(jsonString: string): Promise<string>` - Validation function returning empty string on success, error message on failure
 *   - `priority(): number` - Optional priority (defaults to 50, higher runs first)
 *
 * # Returns
 *
 * Ok if registration succeeds, Err with description if it fails.
 *
 * # Example
 *
 * ```javascript
 * registerValidator({
 *   name: () => "min-content-length",
 *   priority: () => 100,
 *   validate: async (jsonString) => {
 *     const result = JSON.parse(jsonString);
 *     if (result.content.length < 100) {
 *       return "Content too short"; // Validation failure
 *     }
 *     return ""; // Success
 *   }
 * });
 * ```
 */
export function register_validator(validator: any): void;

/**
 * Render a single page of a PDF to a PNG byte buffer (synchronous).
 *
 * # JavaScript Parameters
 *
 * * `data: Uint8Array` - The PDF document bytes
 * * `pageIndex: number` - Zero-based page index
 * * `dpi?: number` - Optional DPI (default 150)
 *
 * # Returns
 *
 * `Uint8Array` - PNG image data.
 */
export function renderPdfPageSync(data: Uint8Array, page_index: number, dpi?: number | null): Uint8Array;

/**
 * Unregister an OCR backend by name.
 *
 * # Arguments
 *
 * * `name` - Name of the OCR backend to unregister
 *
 * # Returns
 *
 * Ok if unregistration succeeds, Err if the backend is not found or other error occurs.
 *
 * # Example
 *
 * ```javascript
 * unregisterOcrBackend("custom-ocr");
 * ```
 */
export function unregister_ocr_backend(name: string): void;

/**
 * Unregister a post-processor by name.
 *
 * # Arguments
 *
 * * `name` - Name of the post-processor to unregister
 *
 * # Returns
 *
 * Ok if unregistration succeeds, Err if the processor is not found or other error occurs.
 *
 * # Example
 *
 * ```javascript
 * unregisterPostProcessor("my-post-processor");
 * ```
 */
export function unregister_post_processor(name: string): void;

/**
 * Unregister a validator by name.
 *
 * # Arguments
 *
 * * `name` - Name of the validator to unregister
 *
 * # Returns
 *
 * Ok if unregistration succeeds, Err if the validator is not found or other error occurs.
 *
 * # Example
 *
 * ```javascript
 * unregisterValidator("min-content-length");
 * ```
 */
export function unregister_validator(name: string): void;

/**
 * Version of the kreuzberg-wasm binding
 */
export function version(): string;

/**
 * A callback function that can be invoked by Pdfium's `FPDF_SaveAsCopy()` and `FPDF_SaveWithVersion()`
 * functions, wrapping around `crate::utils::files::write_block_from_callback()` to shuffle data buffers
 * from Pdfium's WASM memory heap to our WASM memory heap as they are written.
 */
export function write_block_from_callback_wasm(param: number, buf: number, size: number): number;
