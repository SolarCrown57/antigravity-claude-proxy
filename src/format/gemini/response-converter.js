/**
 * Gemini Response Converter
 * Converts Google/Antigravity responses to Gemini API format
 *
 * Gemini format is very close to Google format, so this mainly:
 * - Unwraps the response from Antigravity wrapper
 * - Ensures proper format for clients
 */

import { cacheSignature } from '../signature-cache.js';
import { getOriginalToolName } from '../../utils/tool-name-cache.js';
import { MIN_SIGNATURE_LENGTH } from '../../constants.js';

/**
 * Process parts to restore original tool names and cache signatures
 */
function processParts(parts, sessionId, modelName) {
    if (!parts || !Array.isArray(parts)) return parts;

    return parts.map(part => {
        if (part.functionCall) {
            const funcCall = part.functionCall;

            // Restore original tool name
            const originalName = getOriginalToolName(sessionId, modelName, funcCall.name);
            if (originalName) {
                funcCall.name = originalName;
            }

            // Cache signature
            const signature = part.thoughtSignature;
            if (signature && signature.length >= MIN_SIGNATURE_LENGTH && funcCall.id) {
                cacheSignature(funcCall.id, signature);
            }
        }
        return part;
    });
}

/**
 * Convert Google/Antigravity response to Gemini format (non-streaming)
 *
 * @param {Object} googleResponse - Google/Antigravity format response
 * @param {string} modelName - Model name
 * @param {string} sessionId - Session ID for tool name lookup
 * @returns {Object} Gemini format response
 */
export function convertGoogleToGemini(googleResponse, modelName, sessionId) {
    // The response format is already Gemini-compatible
    // Just process the parts to restore tool names
    const response = { ...googleResponse };

    if (response.candidates && Array.isArray(response.candidates)) {
        response.candidates = response.candidates.map(candidate => {
            if (candidate.content && candidate.content.parts) {
                candidate.content.parts = processParts(
                    candidate.content.parts,
                    sessionId,
                    modelName
                );
            }
            return candidate;
        });
    }

    // Add model info if not present
    if (!response.modelVersion) {
        response.modelVersion = modelName;
    }

    return response;
}

/**
 * Generator to convert Google SSE response to Gemini streaming format
 *
 * @param {ReadableStream} responseBody - Response body stream
 * @param {string} modelName - Model name
 * @param {string} sessionId - Session ID for tool name lookup
 * @yields {Object} Gemini format streaming chunks
 */
export async function* streamGoogleToGemini(responseBody, modelName, sessionId) {
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);

                // Unwrap if wrapped in response field
                const response = data.response || data;

                // Process candidates
                if (response.candidates && Array.isArray(response.candidates)) {
                    response.candidates = response.candidates.map(candidate => {
                        if (candidate.content && candidate.content.parts) {
                            candidate.content.parts = processParts(
                                candidate.content.parts,
                                sessionId,
                                modelName
                            );
                        }
                        return candidate;
                    });
                }

                yield response;

            } catch (parseError) {
                console.log('[Gemini Converter] SSE parse error:', parseError.message);
            }
        }
    }
}

/**
 * Format SSE event for Gemini streaming
 * @param {Object} data - Data to send
 * @returns {string} Formatted SSE event
 */
export function formatSSEEvent(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
}

export default {
    convertGoogleToGemini,
    streamGoogleToGemini,
    formatSSEEvent
};
