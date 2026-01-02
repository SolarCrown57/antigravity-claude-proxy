/**
 * OpenAI Response Converter
 * Converts Google/Antigravity responses to OpenAI Chat Completions format
 */

import crypto from 'crypto';
import { cacheSignature } from '../signature-cache.js';
import { getOriginalToolName } from '../../utils/tool-name-cache.js';
import { MIN_SIGNATURE_LENGTH } from '../../constants.js';

/**
 * Map Google finish reason to OpenAI finish reason
 */
function mapFinishReason(googleReason) {
    switch (googleReason) {
        case 'STOP':
            return 'stop';
        case 'MAX_TOKENS':
            return 'length';
        case 'TOOL_USE':
        case 'FUNCTION_CALL':
            return 'tool_calls';
        case 'SAFETY':
            return 'content_filter';
        default:
            return 'stop';
    }
}

/**
 * Convert Google response to OpenAI Chat Completions format (non-streaming)
 *
 * @param {Object} googleResponse - Google/Antigravity format response
 * @param {string} originalModel - Original model name requested
 * @param {string} sessionId - Session ID for tool name lookup
 * @returns {Object} OpenAI format response
 */
export function convertGoogleToOpenAI(googleResponse, originalModel, sessionId) {
    const candidate = googleResponse.candidates?.[0] || {};
    const content = candidate.content || {};
    const parts = content.parts || [];
    const usage = googleResponse.usageMetadata || {};

    let messageContent = '';
    let reasoningContent = '';
    const toolCalls = [];
    let toolCallIndex = 0;

    for (const part of parts) {
        if (part.thought === true) {
            // Thinking block -> reasoning_content
            reasoningContent += part.text || '';
        } else if (part.functionCall) {
            // Function call -> tool_calls
            const funcCall = part.functionCall;
            let toolId = funcCall.id;
            if (!toolId) {
                const hashInput = `${funcCall.name}:${JSON.stringify(funcCall.args || {})}`;
                toolId = `call_${crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 24)}`;
            }

            // Restore original tool name
            const originalName = getOriginalToolName(sessionId, originalModel, funcCall.name) || funcCall.name;

            // Cache signature for future requests
            const signature = part.thoughtSignature;
            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                cacheSignature(toolId, signature);
            }

            toolCalls.push({
                id: toolId,
                type: 'function',
                function: {
                    name: originalName,
                    arguments: JSON.stringify(funcCall.args || {})
                },
                // Include thoughtSignature for clients that support it
                ...(signature ? { thoughtSignature: signature } : {})
            });
            toolCallIndex++;
        } else if (part.text !== undefined) {
            // Regular text
            messageContent += part.text;
        }
    }

    const finishReason = mapFinishReason(candidate.finishReason);

    // Build the message object
    const message = {
        role: 'assistant',
        content: messageContent || null
    };

    // Add reasoning_content if present (DeepSeek-style thinking)
    if (reasoningContent) {
        message.reasoning_content = reasoningContent;
    }

    // Add tool_calls if present
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    // Build the response
    const response = {
        id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: originalModel,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason
        }],
        usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)
        }
    };

    // Add cached token info if available
    if (usage.cachedContentTokenCount) {
        response.usage.prompt_tokens_details = {
            cached_tokens: usage.cachedContentTokenCount
        };
    }

    return response;
}

/**
 * Create an OpenAI streaming chunk
 *
 * @param {Object} options - Chunk options
 * @param {string} options.id - Completion ID
 * @param {string} options.model - Model name
 * @param {Object} options.delta - Delta content
 * @param {string} options.finishReason - Finish reason (null for intermediate chunks)
 * @param {Object} options.usage - Usage info (only for final chunk)
 * @returns {Object} OpenAI streaming chunk
 */
export function createStreamChunk({ id, model, delta, finishReason = null, usage = null }) {
    const chunk = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }]
    };

    if (usage) {
        chunk.usage = usage;
    }

    return chunk;
}

/**
 * Generator to convert Google SSE response to OpenAI streaming format
 *
 * @param {ReadableStream} responseBody - Response body stream
 * @param {string} originalModel - Original model name
 * @param {string} sessionId - Session ID for tool name lookup
 * @yields {Object} OpenAI streaming chunks
 */
export async function* streamGoogleToOpenAI(responseBody, originalModel, sessionId) {
    const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let hasEmittedStart = false;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let finishReason = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    // Pending tool calls to accumulate
    const pendingToolCalls = [];

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
                const innerResponse = data.response || data;

                // Extract usage
                const usage = innerResponse.usageMetadata;
                if (usage) {
                    inputTokens = usage.promptTokenCount || inputTokens;
                    outputTokens = usage.candidatesTokenCount || outputTokens;
                    cacheReadTokens = usage.cachedContentTokenCount || cacheReadTokens;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const content = firstCandidate.content || {};
                const parts = content.parts || [];

                // Emit initial chunk with role
                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;
                    yield createStreamChunk({
                        id: completionId,
                        model: originalModel,
                        delta: { role: 'assistant', content: '' }
                    });
                }

                for (const part of parts) {
                    if (part.thought === true) {
                        // Thinking -> reasoning_content delta
                        const text = part.text || '';
                        if (part.thoughtSignature) {
                            currentThinkingSignature = part.thoughtSignature;
                        }

                        if (text) {
                            yield createStreamChunk({
                                id: completionId,
                                model: originalModel,
                                delta: { reasoning_content: text }
                            });
                        }
                        currentBlockType = 'thinking';

                    } else if (part.text !== undefined && part.text) {
                        // Regular text
                        yield createStreamChunk({
                            id: completionId,
                            model: originalModel,
                            delta: { content: part.text }
                        });
                        currentBlockType = 'text';

                    } else if (part.functionCall) {
                        // Function call
                        const funcCall = part.functionCall;
                        let toolId = funcCall.id;
                        if (!toolId) {
                            const hashInput = `${funcCall.name}:${JSON.stringify(funcCall.args || {})}`;
                            toolId = `call_${crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 24)}`;
                        }

                        const originalName = getOriginalToolName(sessionId, originalModel, funcCall.name) || funcCall.name;

                        // Cache signature
                        const signature = part.thoughtSignature;
                        if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                            cacheSignature(toolId, signature);
                        }

                        const toolCall = {
                            index: pendingToolCalls.length,
                            id: toolId,
                            type: 'function',
                            function: {
                                name: originalName,
                                arguments: JSON.stringify(funcCall.args || {})
                            }
                        };

                        if (signature) {
                            toolCall.thoughtSignature = signature;
                        }

                        pendingToolCalls.push(toolCall);
                        finishReason = 'tool_calls';
                        currentBlockType = 'tool_use';
                    }
                }

                // Check finish reason
                if (firstCandidate.finishReason) {
                    finishReason = mapFinishReason(firstCandidate.finishReason);
                }

            } catch (parseError) {
                console.log('[OpenAI Converter] SSE parse error:', parseError.message);
            }
        }
    }

    // Emit tool calls if any
    if (pendingToolCalls.length > 0) {
        yield createStreamChunk({
            id: completionId,
            model: originalModel,
            delta: { tool_calls: pendingToolCalls }
        });
    }

    // Final chunk with finish_reason and usage
    yield createStreamChunk({
        id: completionId,
        model: originalModel,
        delta: {},
        finishReason,
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {})
        }
    });
}

export default {
    convertGoogleToOpenAI,
    createStreamChunk,
    streamGoogleToOpenAI
};
