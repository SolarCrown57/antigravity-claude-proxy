/**
 * Gemini Routes
 * Handles Gemini API compatible endpoints
 *
 * Endpoints:
 * - POST /v1beta/models/:model:generateContent - Non-streaming generation
 * - POST /v1beta/models/:model:streamGenerateContent - Streaming generation
 * - GET /v1beta/models - List available models
 * - GET /v1beta/models/:model - Get model info
 */

import { Router } from 'express';
import { sendRawMessage, sendRawMessageStream, listModels, fetchAvailableModels } from '../cloudcode-client.js';
import { convertGeminiToGoogle } from '../format/gemini/request-converter.js';
import { convertGoogleToGemini, streamGoogleToGemini, formatSSEEvent } from '../format/gemini/response-converter.js';

/**
 * Create Gemini router
 * @param {Object} accountManager - Account manager instance
 * @returns {Router} Express router
 */
export function createGeminiRouter(accountManager) {
    const router = Router();

    /**
     * POST /models/:model:generateContent - Non-streaming content generation
     */
    router.post('/models/:model\\:generateContent', async (req, res) => {
        try {
            const modelName = req.params.model;
            const geminiRequest = req.body;

            console.log(`[Gemini] generateContent request for model: ${modelName}`);

            // Get project ID from first available account
            const account = await accountManager.pickNext();
            if (!account) {
                return res.status(503).json({
                    error: {
                        message: 'No accounts available',
                        code: 503,
                        status: 'UNAVAILABLE'
                    }
                });
            }
            const token = await accountManager.getTokenForAccount(account);
            const projectId = await accountManager.getProjectForAccount(account, token);

            // Convert request to Antigravity format
            const payload = convertGeminiToGoogle(geminiRequest, modelName, projectId);
            const sessionId = payload.request.sessionId;

            try {
                // For thinking models, use SSE endpoint and accumulate
                const { response } = await sendRawMessage(payload, accountManager, { useSSE: true });

                // Accumulate SSE response
                const googleResponse = await accumulateSSEResponse(response);

                // Convert to Gemini format
                const geminiResponse = convertGoogleToGemini(googleResponse, modelName, sessionId);

                res.json(geminiResponse);

            } catch (error) {
                console.error('[Gemini] Request error:', error.message);
                res.status(500).json({
                    error: {
                        message: error.message,
                        code: 500,
                        status: 'INTERNAL'
                    }
                });
            }

        } catch (error) {
            console.error('[Gemini] Error:', error.message);

            let statusCode = 500;
            let status = 'INTERNAL';
            if (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('Rate limited')) {
                statusCode = 429;
                status = 'RESOURCE_EXHAUSTED';
            } else if (error.message.includes('No accounts available')) {
                statusCode = 503;
                status = 'UNAVAILABLE';
            }

            res.status(statusCode).json({
                error: {
                    message: error.message,
                    code: statusCode,
                    status
                }
            });
        }
    });

    /**
     * POST /models/:model:streamGenerateContent - Streaming content generation
     */
    router.post('/models/:model\\:streamGenerateContent', async (req, res) => {
        try {
            const modelName = req.params.model;
            const geminiRequest = req.body;
            const useSSE = req.query.alt === 'sse';

            console.log(`[Gemini] streamGenerateContent request for model: ${modelName}, SSE: ${useSSE}`);

            // Get project ID from first available account
            const account = await accountManager.pickNext();
            if (!account) {
                return res.status(503).json({
                    error: {
                        message: 'No accounts available',
                        code: 503,
                        status: 'UNAVAILABLE'
                    }
                });
            }
            const token = await accountManager.getTokenForAccount(account);
            const projectId = await accountManager.getProjectForAccount(account, token);

            // Convert request to Antigravity format
            const payload = convertGeminiToGoogle(geminiRequest, modelName, projectId);
            const sessionId = payload.request.sessionId;

            // Set up streaming response
            res.setHeader('Content-Type', useSSE ? 'text/event-stream' : 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            try {
                const { response } = await sendRawMessageStream(payload, accountManager);

                if (useSSE) {
                    // Stream as SSE events
                    for await (const chunk of streamGoogleToGemini(response.body, modelName, sessionId)) {
                        res.write(formatSSEEvent(chunk));
                    }
                    res.end();
                } else {
                    // Stream as newline-delimited JSON
                    for await (const chunk of streamGoogleToGemini(response.body, modelName, sessionId)) {
                        res.write(JSON.stringify(chunk) + '\n');
                    }
                    res.end();
                }

            } catch (streamError) {
                console.error('[Gemini] Stream error:', streamError.message);
                const errorResponse = {
                    error: {
                        message: streamError.message,
                        code: 500,
                        status: 'INTERNAL'
                    }
                };
                if (useSSE) {
                    res.write(formatSSEEvent(errorResponse));
                } else {
                    res.write(JSON.stringify(errorResponse) + '\n');
                }
                res.end();
            }

        } catch (error) {
            console.error('[Gemini] Error:', error.message);

            let statusCode = 500;
            let status = 'INTERNAL';
            if (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('Rate limited')) {
                statusCode = 429;
                status = 'RESOURCE_EXHAUSTED';
            } else if (error.message.includes('No accounts available')) {
                statusCode = 503;
                status = 'UNAVAILABLE';
            }

            res.status(statusCode).json({
                error: {
                    message: error.message,
                    code: statusCode,
                    status
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
                        code: 503,
                        status: 'UNAVAILABLE'
                    }
                });
            }

            const token = await accountManager.getTokenForAccount(account);
            const rawModels = await fetchAvailableModels(token);

            // Convert to Gemini format
            const models = [];
            if (rawModels && rawModels.models) {
                for (const [modelId, modelData] of Object.entries(rawModels.models)) {
                    models.push({
                        name: `models/${modelId}`,
                        version: '1.0',
                        displayName: modelData.displayName || modelId,
                        description: modelData.description || '',
                        inputTokenLimit: modelData.inputTokenLimit || 1048576,
                        outputTokenLimit: modelData.outputTokenLimit || 65536,
                        supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
                    });
                }
            }

            res.json({ models });

        } catch (error) {
            console.error('[Gemini] Models error:', error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    code: 500,
                    status: 'INTERNAL'
                }
            });
        }
    });

    /**
     * GET /models/:model - Get specific model info
     */
    router.get('/models/:model', async (req, res) => {
        try {
            const modelName = req.params.model;

            const account = await accountManager.pickNext();
            if (!account) {
                return res.status(503).json({
                    error: {
                        message: 'No accounts available',
                        code: 503,
                        status: 'UNAVAILABLE'
                    }
                });
            }

            const token = await accountManager.getTokenForAccount(account);
            const rawModels = await fetchAvailableModels(token);

            let modelData = null;
            if (rawModels && rawModels.models) {
                modelData = rawModels.models[modelName];
            }

            if (!modelData) {
                return res.status(404).json({
                    error: {
                        message: `Model ${modelName} not found`,
                        code: 404,
                        status: 'NOT_FOUND'
                    }
                });
            }

            res.json({
                name: `models/${modelName}`,
                version: '1.0',
                displayName: modelData.displayName || modelName,
                description: modelData.description || '',
                inputTokenLimit: modelData.inputTokenLimit || 1048576,
                outputTokenLimit: modelData.outputTokenLimit || 65536,
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
            });

        } catch (error) {
            console.error('[Gemini] Model info error:', error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    code: 500,
                    status: 'INTERNAL'
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
                console.log('[Gemini] SSE parse warning:', e.message);
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

export default createGeminiRouter;
