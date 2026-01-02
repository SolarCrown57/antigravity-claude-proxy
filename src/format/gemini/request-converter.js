/**
 * Gemini Request Converter
 * Converts Gemini API requests to Google/Antigravity format
 *
 * Gemini format is already close to Google format, so this mainly:
 * - Adds project/requestId wrapper
 * - Processes thinking signatures
 * - Normalizes tools and parameters
 */

import crypto from 'crypto';
import { generateRequestId } from '../../utils/id-generator.js';
import { convertGeminiToolsToAntigravity } from '../../utils/tool-converter.js';
import { getCachedSignature } from '../signature-cache.js';
import { mapModelName, isThinkingModel, getModelFamily, GEMINI_MAX_OUTPUT_TOKENS } from '../../constants.js';

/**
 * Default generation parameters
 */
const DEFAULTS = {
    maxOutputTokens: 32000,
    temperature: 1,
    topP: 1,
    topK: 50,
    thinkingBudget: 16000
};

/**
 * Generate unique ID for function calls without ID
 */
function generateFunctionCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Process function call IDs to ensure all have unique IDs
 * and function responses have matching IDs
 */
function processFunctionCallIds(contents) {
    const functionCallIds = [];

    // Collect all functionCall IDs
    contents.forEach(content => {
        if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
            content.parts.forEach(part => {
                if (part.functionCall) {
                    if (!part.functionCall.id) {
                        part.functionCall.id = generateFunctionCallId();
                    }
                    functionCallIds.push(part.functionCall.id);
                }
            });
        }
    });

    // Assign IDs to functionResponses
    let responseIndex = 0;
    contents.forEach(content => {
        if (content.role === 'user' && content.parts && Array.isArray(content.parts)) {
            content.parts.forEach(part => {
                if (part.functionResponse) {
                    if (!part.functionResponse.id && responseIndex < functionCallIds.length) {
                        part.functionResponse.id = functionCallIds[responseIndex];
                        responseIndex++;
                    }
                }
            });
        }
    });
}

/**
 * Create a thought part
 */
function createThoughtPart(text) {
    return { text: text || ' ', thought: true };
}

/**
 * Process model thoughts and signatures in a content object
 */
function processModelThoughts(content) {
    const parts = content.parts;

    // Find thought and standalone signature positions
    let thoughtIndex = -1;
    let signatureIndex = -1;
    let signatureValue = null;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.thought === true && !part.thoughtSignature) {
            thoughtIndex = i;
        }
        if (part.thoughtSignature && !part.thought) {
            signatureIndex = i;
            signatureValue = part.thoughtSignature;
        }
    }

    // Merge or add thought and signature
    if (thoughtIndex !== -1 && signatureIndex !== -1) {
        parts[thoughtIndex].thoughtSignature = signatureValue;
        parts.splice(signatureIndex, 1);
    } else if (thoughtIndex === -1) {
        parts.unshift(createThoughtPart(' '));
    }

    // Collect standalone signature parts (for functionCall)
    const standaloneSignatures = [];
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part.thoughtSignature && !part.thought && !part.functionCall && !part.text) {
            standaloneSignatures.unshift({ index: i, signature: part.thoughtSignature });
        }
    }

    // Assign signatures to functionCalls
    let sigIndex = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.functionCall && !part.thoughtSignature) {
            if (sigIndex < standaloneSignatures.length) {
                part.thoughtSignature = standaloneSignatures[sigIndex].signature;
                sigIndex++;
            } else {
                // Try to get from cache
                const cachedSig = getCachedSignature(part.functionCall.id);
                if (cachedSig) {
                    part.thoughtSignature = cachedSig;
                }
            }
        }
    }

    // Remove used standalone signature parts
    for (let i = standaloneSignatures.length - 1; i >= 0; i--) {
        if (i < sigIndex) {
            parts.splice(standaloneSignatures[i].index, 1);
        }
    }
}

/**
 * Derive session ID from contents
 */
function deriveSessionId(contents) {
    for (const content of contents) {
        if (content.role === 'user' && content.parts) {
            for (const part of content.parts) {
                if (part.text) {
                    const hash = crypto.createHash('sha256').update(part.text).digest('hex');
                    return hash.substring(0, 32);
                }
            }
        }
    }
    return crypto.randomUUID();
}

/**
 * Normalize generation config
 */
function normalizeGenerationConfig(config, enableThinking, modelName) {
    const modelFamily = getModelFamily(modelName);
    const isGemini = modelFamily === 'gemini';

    const normalized = {
        maxOutputTokens: config.maxOutputTokens || config.max_tokens || DEFAULTS.maxOutputTokens,
        temperature: config.temperature ?? DEFAULTS.temperature,
        topP: config.topP ?? config.top_p ?? DEFAULTS.topP,
        topK: config.topK ?? config.top_k ?? DEFAULTS.topK
    };

    // Cap max tokens for Gemini
    if (isGemini && normalized.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        normalized.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    // Handle stop sequences
    if (config.stopSequences) {
        normalized.stopSequences = config.stopSequences;
    }

    // Add thinking config
    if (enableThinking) {
        const thinkingBudget = config.thinkingBudget || config.thinking_budget || DEFAULTS.thinkingBudget;

        if (modelFamily === 'claude') {
            normalized.thinkingConfig = {
                include_thoughts: true,
                thinking_budget: thinkingBudget
            };
        } else if (isGemini) {
            normalized.thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinkingBudget
            };
        }
    }

    return normalized;
}

/**
 * Convert Gemini API request to Google/Antigravity format
 *
 * @param {Object} geminiRequest - Gemini format request body
 * @param {string} modelName - Model name from URL
 * @param {string} projectId - Google Cloud project ID
 * @returns {Object} Antigravity format request body
 */
export function convertGeminiToGoogle(geminiRequest, modelName, projectId) {
    const actualModelName = mapModelName(modelName);
    const enableThinking = isThinkingModel(actualModelName);

    // Deep clone to avoid mutation
    const request = JSON.parse(JSON.stringify(geminiRequest));

    // Process contents
    if (request.contents && Array.isArray(request.contents)) {
        processFunctionCallIds(request.contents);

        if (enableThinking) {
            request.contents.forEach(content => {
                if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
                    processModelThoughts(content);
                }
            });
        }
    }

    // Derive session ID
    const sessionId = deriveSessionId(request.contents || []);
    request.sessionId = sessionId;

    // Normalize generation config
    request.generationConfig = normalizeGenerationConfig(
        request.generationConfig || {},
        enableThinking,
        actualModelName
    );

    // Remove safety settings (not supported)
    delete request.safetySettings;

    // Convert tools
    if (request.tools && Array.isArray(request.tools)) {
        request.tools = convertGeminiToolsToAntigravity(request.tools, sessionId, actualModelName);
    }

    // Add tool config if tools present
    if (request.tools && request.tools.length > 0 && !request.toolConfig) {
        request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
    }

    // Process system instruction
    if (request.systemInstruction) {
        // Ensure proper format
        if (typeof request.systemInstruction === 'string') {
            request.systemInstruction = {
                parts: [{ text: request.systemInstruction }]
            };
        } else if (request.systemInstruction.parts) {
            // Remove role field if present (not supported in Antigravity)
            delete request.systemInstruction.role;
        }
    }

    // Wrap in Antigravity format
    const requestBody = {
        project: projectId,
        requestId: generateRequestId(),
        request,
        model: actualModelName,
        userAgent: 'antigravity'
    };

    return requestBody;
}

export default {
    convertGeminiToGoogle
};
