/**
 * OpenAI Request Converter
 * Converts OpenAI Chat Completions API requests to Google/Antigravity format
 */

import crypto from 'crypto';
import { generateRequestId } from '../../utils/id-generator.js';
import { convertOpenAIToolsToAntigravity, sanitizeToolName } from '../../utils/tool-converter.js';
import { setToolNameMapping } from '../../utils/tool-name-cache.js';
import { getCachedSignature } from '../signature-cache.js';
import { mapModelName, isThinkingModel, getModelFamily, GEMINI_MAX_OUTPUT_TOKENS } from '../../constants.js';

/**
 * Default generation parameters
 */
const DEFAULTS = {
    max_tokens: 32000,
    temperature: 1,
    top_p: 1,
    top_k: 50,
    thinking_budget: 16000
};

/**
 * Reasoning effort to thinking budget mapping
 */
const REASONING_EFFORT_MAP = {
    low: 8000,
    medium: 16000,
    high: 32000
};

/**
 * Extract images from OpenAI content array
 * @param {string|Array} content - Message content
 * @returns {Object} { text, images }
 */
function extractImagesFromContent(content) {
    const result = { text: '', images: [] };
    if (typeof content === 'string') {
        result.text = content;
        return result;
    }
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item.type === 'text') {
                result.text += item.text;
            } else if (item.type === 'image_url') {
                const imageUrl = item.image_url?.url || '';
                const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
                if (match) {
                    result.images.push({
                        inlineData: {
                            mimeType: `image/${match[1]}`,
                            data: match[2]
                        }
                    });
                }
            }
        }
    }
    return result;
}

/**
 * Extract system instruction from OpenAI messages
 * @param {Array} messages - OpenAI format messages
 * @returns {string} Combined system instruction
 */
function extractSystemInstruction(messages) {
    const systemTexts = [];
    for (const message of messages) {
        if (message.role === 'system') {
            const content = typeof message.content === 'string'
                ? message.content
                : (Array.isArray(message.content)
                    ? message.content.filter(item => item.type === 'text').map(item => item.text).join('')
                    : '');
            if (content.trim()) systemTexts.push(content.trim());
        } else {
            break;
        }
    }
    return systemTexts.join('\n\n');
}

/**
 * Create a thought part for thinking models
 * @param {string} text - Thought text
 * @returns {Object} Thought part
 */
function createThoughtPart(text) {
    return { text: text || ' ', thought: true };
}

/**
 * Create a function call part
 * @param {string} id - Call ID
 * @param {string} name - Function name
 * @param {Object|string} args - Arguments
 * @param {string} signature - Optional thoughtSignature
 * @returns {Object} Function call part
 */
function createFunctionCallPart(id, name, args, signature = null) {
    const part = {
        functionCall: {
            id,
            name,
            args: typeof args === 'string' ? JSON.parse(args) : args
        }
    };
    if (signature) {
        part.thoughtSignature = signature;
    }
    return part;
}

/**
 * Push user message to antigravity messages
 */
function pushUserMessage(extracted, antigravityMessages) {
    antigravityMessages.push({
        role: 'user',
        parts: [{ text: extracted.text }, ...extracted.images]
    });
}

/**
 * Find function name by tool call ID
 */
function findFunctionNameById(toolCallId, antigravityMessages) {
    for (let i = antigravityMessages.length - 1; i >= 0; i--) {
        if (antigravityMessages[i].role === 'model') {
            const parts = antigravityMessages[i].parts;
            for (const part of parts) {
                if (part.functionCall && part.functionCall.id === toolCallId) {
                    return part.functionCall.name;
                }
            }
        }
    }
    return '';
}

/**
 * Push function response to antigravity messages
 */
function pushFunctionResponse(toolCallId, functionName, resultContent, antigravityMessages) {
    const lastMessage = antigravityMessages[antigravityMessages.length - 1];
    const functionResponse = {
        functionResponse: {
            id: toolCallId,
            name: functionName,
            response: { output: resultContent }
        }
    };

    if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
        lastMessage.parts.push(functionResponse);
    } else {
        antigravityMessages.push({ role: 'user', parts: [functionResponse] });
    }
}

/**
 * Push model message to antigravity messages
 */
function pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages) {
    const lastMessage = antigravityMessages[antigravityMessages.length - 1];
    const hasToolCalls = toolCalls && toolCalls.length > 0;

    if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
        lastMessage.parts.push(...toolCalls);
    } else {
        const allParts = [...parts, ...(toolCalls || [])];
        antigravityMessages.push({ role: 'model', parts: allParts });
    }
}

/**
 * Handle assistant message conversion
 */
function handleAssistantMessage(message, antigravityMessages, enableThinking, modelName, sessionId) {
    const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
    const hasContent = message.content && message.content.trim() !== '';

    const toolCalls = hasToolCalls
        ? message.tool_calls.map(toolCall => {
            const safeName = sanitizeToolName(toolCall.function.name);
            if (safeName !== toolCall.function.name) {
                setToolNameMapping(sessionId, modelName, safeName, toolCall.function.name);
            }
            // Use cached signature if available
            const cachedSig = getCachedSignature(toolCall.id);
            const signature = enableThinking ? (toolCall.thoughtSignature || cachedSig || null) : null;
            return createFunctionCallPart(toolCall.id, safeName, toolCall.function.arguments, signature);
        })
        : [];

    const parts = [];
    if (enableThinking) {
        const reasoningText = (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0)
            ? message.reasoning_content : ' ';
        parts.push(createThoughtPart(reasoningText));
    }
    if (hasContent) {
        parts.push({ text: message.content.trimEnd() });
    }

    pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);
}

/**
 * Handle tool message conversion
 */
function handleToolCall(message, antigravityMessages) {
    const functionName = findFunctionNameById(message.tool_call_id, antigravityMessages);
    pushFunctionResponse(message.tool_call_id, functionName, message.content, antigravityMessages);
}

/**
 * Convert OpenAI messages to Antigravity format
 */
function openaiMessagesToAntigravity(openaiMessages, enableThinking, modelName, sessionId) {
    const antigravityMessages = [];
    for (const message of openaiMessages) {
        if (message.role === 'user' || message.role === 'system') {
            const extracted = extractImagesFromContent(message.content);
            pushUserMessage(extracted, antigravityMessages);
        } else if (message.role === 'assistant') {
            handleAssistantMessage(message, antigravityMessages, enableThinking, modelName, sessionId);
        } else if (message.role === 'tool') {
            handleToolCall(message, antigravityMessages);
        }
    }
    return antigravityMessages;
}

/**
 * Generate generation config
 */
function generateGenerationConfig(parameters, enableThinking, modelName) {
    const modelFamily = getModelFamily(modelName);
    const isGemini = modelFamily === 'gemini';

    const config = {
        maxOutputTokens: parameters.max_tokens || DEFAULTS.max_tokens,
        temperature: parameters.temperature ?? DEFAULTS.temperature,
        topP: parameters.top_p ?? DEFAULTS.top_p,
        topK: parameters.top_k ?? DEFAULTS.top_k
    };

    // Cap max tokens for Gemini
    if (isGemini && config.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        config.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    // Add thinking config
    if (enableThinking) {
        let thinkingBudget = parameters.thinking_budget;
        if (thinkingBudget === undefined && parameters.reasoning_effort) {
            thinkingBudget = REASONING_EFFORT_MAP[parameters.reasoning_effort] || DEFAULTS.thinking_budget;
        }
        if (thinkingBudget === undefined) {
            thinkingBudget = DEFAULTS.thinking_budget;
        }

        if (modelFamily === 'claude') {
            config.thinkingConfig = {
                include_thoughts: true,
                thinking_budget: thinkingBudget
            };
        } else if (isGemini) {
            config.thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinkingBudget
            };
        }
    }

    // Add stop sequences
    if (parameters.stop) {
        config.stopSequences = Array.isArray(parameters.stop) ? parameters.stop : [parameters.stop];
    }

    return config;
}

/**
 * Derive session ID from first user message
 */
function deriveSessionId(messages) {
    for (const msg of messages) {
        if (msg.role === 'user') {
            let content = '';
            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                content = msg.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n');
            }
            if (content) {
                const hash = crypto.createHash('sha256').update(content).digest('hex');
                return hash.substring(0, 32);
            }
        }
    }
    return crypto.randomUUID();
}

/**
 * Convert OpenAI Chat Completions request to Google/Antigravity format
 *
 * @param {Object} openaiRequest - OpenAI format request
 * @param {string} projectId - Google Cloud project ID
 * @returns {Object} Antigravity format request body
 */
export function convertOpenAIToGoogle(openaiRequest, projectId) {
    const {
        model,
        messages,
        max_tokens,
        temperature,
        top_p,
        stop,
        tools,
        reasoning_effort
    } = openaiRequest;

    const actualModelName = mapModelName(model);
    const enableThinking = isThinkingModel(actualModelName);
    const sessionId = deriveSessionId(messages);

    // Extract system instruction
    const systemInstruction = extractSystemInstruction(messages);

    // Filter out system messages for content conversion
    let filteredMessages = messages;
    let startIndex = 0;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'system') {
            startIndex = i + 1;
        } else {
            filteredMessages = messages.slice(startIndex);
            break;
        }
    }

    // Convert messages
    const contents = openaiMessagesToAntigravity(filteredMessages, enableThinking, actualModelName, sessionId);

    // Convert tools
    const convertedTools = convertOpenAIToolsToAntigravity(tools, sessionId, actualModelName);

    // Build generation config
    const generationConfig = generateGenerationConfig({
        max_tokens,
        temperature,
        top_p,
        stop,
        reasoning_effort
    }, enableThinking, actualModelName);

    // Build request
    const request = {
        contents,
        generationConfig
    };

    if (systemInstruction) {
        request.systemInstruction = {
            parts: [{ text: systemInstruction }]
        };
    }

    if (convertedTools.length > 0) {
        request.tools = convertedTools;
        request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
    }

    request.sessionId = sessionId;

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
    convertOpenAIToGoogle
};
