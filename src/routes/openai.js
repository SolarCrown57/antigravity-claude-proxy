/**
 * OpenAI Routes
 * Handles OpenAI Chat Completions API compatible endpoints
 *
 * Endpoints:
 * - POST /v1/chat/completions - Chat completions (streaming and non-streaming)
 * - GET /v1/models - List available models
 */

import { Router } from 'express';
import crypto from 'crypto';
import { sendRawMessage, sendRawMessageStream, listModels } from '../cloudcode-client.js';
import { convertOpenAIToGoogle } from '../format/openai/request-converter.js';
import { convertGoogleToOpenAI, streamGoogleToOpenAI } from '../format/openai/response-converter.js';
import { isThinkingModel } from '../constants.js';

/**
 * Create OpenAI router
 * @param {Object} accountManager - Account manager instance
 * @returns {Router} Express router
 */
export function createOpenAIRouter(accountManager) {
    const router = Router();

    /**
     * POST /chat/completions - Chat completions endpoint
     */
    router.post('/chat/completions', async (req, res) => {
        try {
            const openaiRequest = req.body;
            const isStreaming = openaiRequest.stream === true;

            console.log(`[OpenAI] ${isStreaming ? 'Streaming' : 'Non-streaming'} request for model: ${openaiRequest.model}`);

            // Get project ID from first available account
            const account = await accountManager.pickNext();
            if (!account) {
                return res.status(503).json({
                    error: {
                        message: 'No accounts available',
                        type: 'service_unavailable',
                        code: 'no_accounts'
                    }
                });
            }
            const token = await accountManager.getTokenForAccount(account);
            const projectId = await accountManager.getProjectForAccount(account, token);

            // Convert request to Google/Antigravity format
            const payload = convertOpenAIToGoogle(openaiRequest, projectId);
            const sessionId = payload.request.sessionId;

            if (isStreaming) {
                // Streaming response
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                try {
                    const { response } = await sendRawMessageStream(payload, accountManager);

                    // Stream the response
                    for await (const chunk of streamGoogleToOpenAI(response.body, openaiRequest.model, sessionId)) {
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }

                    res.write('data: [DONE]\n\n');
                    res.end();

                } catch (streamError) {
                    console.error('[OpenAI] Stream error:', streamError.message);
                    // Send error as SSE event
                    const errorChunk = {
                        error: {
                            message: streamError.message,
                            type: 'api_error',
                            code: 'stream_error'
                        }
                    };
                    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                    res.end();
                }

            } else {
                // Non-streaming response
                const isThinking = isThinkingModel(payload.model);

                try {
                    const { response } = await sendRawMessage(payload, accountManager, { useSSE: isThinking });

                    if (isThinking) {
                        // Parse SSE response and accumulate
                        const googleResponse = await accumulateSSEResponse(response);
                        const openaiResponse = convertGoogleToOpenAI(googleResponse, openaiRequest.model, sessionId);
                        res.json(openaiResponse);
                    } else {
                        // Parse JSON response
                        const googleResponse = await response.json();
                        const openaiResponse = convertGoogleToOpenAI(googleResponse, openaiRequest.model, sessionId);
                        res.json(openaiResponse);
                    }

                } catch (error) {
                    console.error('[OpenAI] Request error:', error.message);
                    res.status(500).json({
                        error: {
                            message: error.message,
                            type: 'api_error',
                            code: 'internal_error'
                        }
                    });
                }
            }

        } catch (error) {
            console.error('[OpenAI] Error:', error.message);

            // Determine status code
            let statusCode = 500;
            if (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('Rate limited')) {
                statusCode = 429;
            } else if (error.message.includes('No accounts available')) {
                statusCode = 503;
            }

            res.status(statusCode).json({
                error: {
                    message: error.message,
                    type: 'api_error',
                    code: statusCode === 429 ? 'rate_limit_exceeded' : 'internal_error'
                }
            });
        }
    });

    /**
     * GET /models - List available models
     */
    router.get('/models', async (req, res) => {
        try {
            const account = await accountManager.pickNext();
            if (!account) {
                return res.status(503).json({
                    error: {
                        message: 'No accounts available',
                        type: 'service_unavailable',
                        code: 'no_accounts'
                    }
                });
            }

            const token = await accountManager.getTokenForAccount(account);
            const models = await listModels(token);

            // Convert to OpenAI format
            const openaiModels = {
                object: 'list',
                data: models.data.map(model => ({
                    id: model.id,
                    object: 'model',
                    created: model.created,
                    owned_by: 'antigravity'
                }))
            };

            res.json(openaiModels);

        } catch (error) {
            console.error('[OpenAI] Models error:', error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    type: 'api_error',
                    code: 'internal_error'
                }
            });
        }
    });

    return router;
}

/**
 * Accumulate SSE response into a single Google response object
 */
async function accumulateSSEResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const finalParts = [];
    let usageMetadata = {};
    let finishReason = 'STOP';
    let accumulatedThinkingText = '';
    let accumulatedThinkingSignature = '';
    let accumulatedText = '';

    const flushThinking = () => {
        if (accumulatedThinkingText) {
            finalParts.push({
                thought: true,
                text: accumulatedThinkingText,
                thoughtSignature: accumulatedThinkingSignature
            });
            accumulatedThinkingText = '';
            accumulatedThinkingSignature = '';
        }
    };

    const flushText = () => {
        if (accumulatedText) {
            finalParts.push({ text: accumulatedText });
            accumulatedText = '';
        }
    };

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

                if (innerResponse.usageMetadata) {
                    usageMetadata = innerResponse.usageMetadata;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                if (firstCandidate.finishReason) {
                    finishReason = firstCandidate.finishReason;
                }

                const parts = firstCandidate.content?.parts || [];
                for (const part of parts) {
                    if (part.thought === true) {
                        flushText();
                        accumulatedThinkingText += (part.text || '');
                        if (part.thoughtSignature) {
                            accumulatedThinkingSignature = part.thoughtSignature;
                        }
                    } else if (part.functionCall) {
                        flushThinking();
                        flushText();
                        finalParts.push(part);
                    } else if (part.text !== undefined) {
                        if (!part.text) continue;
                        flushThinking();
                        accumulatedText += part.text;
                    }
                }
            } catch (e) {
                console.log('[OpenAI] SSE parse warning:', e.message);
            }
        }
    }

    flushThinking();
    flushText();

    return {
        candidates: [{ content: { parts: finalParts }, finishReason }],
        usageMetadata
    };
}

export default createOpenAIRouter;
