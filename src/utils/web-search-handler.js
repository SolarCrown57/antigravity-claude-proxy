/**
 * Web Search Handler
 * Implements the intercept-execute-resume loop for handling web_search_20250305 tool calls
 *
 * Since Google Cloud Code doesn't support web_search, this module:
 * 1. Detects web_search tool calls in streaming responses
 * 2. Executes the search locally using configured search provider
 * 3. Appends search results as tool_result to the conversation
 * 4. Re-sends the request to get the final response
 */

import crypto from 'crypto';
import { WEB_SEARCH_TOOL_NAME, SEARCH_CONFIG } from '../constants.js';
import { performWebSearch, formatSearchResults } from './search-engine.js';

/**
 * Check if the request contains web_search tool
 * @param {Object} request - Anthropic request
 * @returns {boolean}
 */
export function hasWebSearchTool(request) {
    if (!SEARCH_CONFIG.enabled) return false;
    if (!request.tools) return false;

    return request.tools.some(tool =>
        tool.name === WEB_SEARCH_TOOL_NAME ||
        tool.type === 'web_search_20250305'
    );
}

/**
 * Filter out web_search tool from tools array (for the actual API call)
 * Google Cloud Code doesn't support this tool, so we need to remove it
 * @param {Array} tools - Original tools array
 * @returns {Array} Filtered tools array
 */
export function filterWebSearchTool(tools) {
    if (!tools) return tools;
    return tools.filter(tool =>
        tool.name !== WEB_SEARCH_TOOL_NAME &&
        tool.type !== 'web_search_20250305'
    );
}

/**
 * Check if a functionCall part is a web_search tool call
 * @param {Object} part - Content part from response
 * @returns {boolean}
 */
export function isWebSearchToolCall(part) {
    if (!part.functionCall) return false;
    return part.functionCall.name === WEB_SEARCH_TOOL_NAME;
}

/**
 * Execute web search and return formatted result
 * @param {Object} toolCall - The tool call object
 * @returns {Promise<Object>} Tool result message
 */
export async function executeWebSearch(toolCall) {
    const args = toolCall.functionCall?.args || {};
    const query = args.query || '';
    const toolId = toolCall.functionCall?.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;

    console.log(`[WebSearch] Executing search for: "${query}"`);

    // Perform the search
    const results = await performWebSearch(query, SEARCH_CONFIG.maxResults);

    // Format results as text
    const formattedResults = formatSearchResults(results, query);

    console.log(`[WebSearch] Search completed, ${results.length} results`);

    return {
        toolId,
        query,
        results,
        formattedResults
    };
}

/**
 * Build the tool_use content block for assistant message
 * @param {Object} toolCall - The original tool call
 * @param {string} toolId - Tool use ID
 * @returns {Object} tool_use content block
 */
export function buildToolUseBlock(toolCall, toolId) {
    return {
        type: 'tool_use',
        id: toolId,
        name: WEB_SEARCH_TOOL_NAME,
        input: toolCall.functionCall?.args || {}
    };
}

/**
 * Build the tool_result message for user turn
 * @param {string} toolId - Tool use ID
 * @param {string} content - Search results content
 * @returns {Object} User message with tool_result
 */
export function buildToolResultMessage(toolId, content) {
    return {
        role: 'user',
        content: [{
            type: 'tool_result',
            tool_use_id: toolId,
            content: content
        }]
    };
}

/**
 * Process accumulated response parts and check for web_search tool calls
 * Returns the tool call if found, null otherwise
 * @param {Array} parts - Accumulated response parts
 * @returns {Object|null} Web search tool call or null
 */
export function findWebSearchToolCall(parts) {
    for (const part of parts) {
        if (isWebSearchToolCall(part)) {
            return part;
        }
    }
    return null;
}

/**
 * Clone a request for the resume phase (after search)
 * @param {Object} originalRequest - Original Anthropic request
 * @param {Array} assistantContent - Content blocks from assistant's response
 * @param {Object} toolResultMessage - Tool result message to append
 * @returns {Object} New request with updated messages
 */
export function buildResumeRequest(originalRequest, assistantContent, toolResultMessage) {
    const newMessages = [
        ...originalRequest.messages,
        {
            role: 'assistant',
            content: assistantContent
        },
        toolResultMessage
    ];

    return {
        ...originalRequest,
        messages: newMessages,
        // Remove web_search from tools since we've already handled it
        tools: filterWebSearchTool(originalRequest.tools)
    };
}

/**
 * Streaming web search handler generator
 * This wraps the original stream and handles web_search interception
 *
 * @param {AsyncGenerator} originalStream - Original response stream from cloudcode-client
 * @param {Object} originalRequest - Original Anthropic request
 * @param {Function} sendMessageFn - Function to send a new message (for resume)
 * @param {Object} accountManager - Account manager instance
 * @yields {Object} Anthropic SSE events
 */
export async function* handleWebSearchStream(originalStream, originalRequest, sendMessageFn, accountManager) {
    // If web search is not enabled or no web_search tool, pass through
    if (!hasWebSearchTool(originalRequest)) {
        yield* originalStream;
        return;
    }

    console.log('[WebSearch] Web search tool detected, monitoring stream...');

    // Accumulate response to detect tool calls
    const accumulatedParts = [];
    const yieldedEvents = [];
    let webSearchDetected = false;
    let currentToolCall = null;
    let messageStartEvent = null;
    let blockIndex = 0;

    // First pass: collect and yield events, detect web_search
    for await (const event of originalStream) {
        // Store message_start for potential re-emit after search
        if (event.type === 'message_start') {
            messageStartEvent = event;
        }

        // Detect web_search tool use
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            if (event.content_block.name === WEB_SEARCH_TOOL_NAME) {
                webSearchDetected = true;
                currentToolCall = {
                    functionCall: {
                        id: event.content_block.id,
                        name: event.content_block.name,
                        args: {}
                    }
                };
                // Don't yield web_search blocks to the client
                // Instead, we'll execute locally and continue
                console.log('[WebSearch] Intercepting web_search tool call');
                continue;
            }
        }

        // Accumulate tool arguments for web_search
        if (webSearchDetected && currentToolCall && event.type === 'content_block_delta') {
            if (event.delta?.type === 'input_json_delta') {
                try {
                    const partial = event.delta.partial_json;
                    // Accumulate JSON fragments
                    currentToolCall._jsonBuffer = (currentToolCall._jsonBuffer || '') + partial;
                } catch (e) {
                    // Ignore parse errors during accumulation
                }
                continue; // Don't yield delta events for web_search
            }
        }

        // Handle content_block_stop for web_search
        if (webSearchDetected && currentToolCall && event.type === 'content_block_stop') {
            // Parse accumulated JSON
            if (currentToolCall._jsonBuffer) {
                try {
                    currentToolCall.functionCall.args = JSON.parse(currentToolCall._jsonBuffer);
                } catch (e) {
                    console.log('[WebSearch] Failed to parse tool args:', e.message);
                }
            }
            accumulatedParts.push(currentToolCall);

            // Execute the search
            const searchResult = await executeWebSearch(currentToolCall);

            // Build content blocks for the assistant message
            const assistantContent = [];

            // Add any thinking blocks that were yielded
            for (const yieldedEvent of yieldedEvents) {
                if (yieldedEvent.type === 'content_block_start' && yieldedEvent.content_block?.type === 'thinking') {
                    // We need to find the corresponding deltas and construct the full thinking block
                    // For simplicity, we'll skip this for now - thinking is already streamed
                }
            }

            // Add the tool_use block
            assistantContent.push(buildToolUseBlock(currentToolCall, searchResult.toolId));

            // Build tool_result message
            const toolResultMessage = buildToolResultMessage(searchResult.toolId, searchResult.formattedResults);

            // Build resume request
            const resumeRequest = buildResumeRequest(originalRequest, assistantContent, toolResultMessage);

            console.log('[WebSearch] Resuming with search results...');

            // Resume the conversation with search results
            // Yield the resumed stream
            const resumeStream = await sendMessageFn(resumeRequest, accountManager);
            yield* resumeStream;

            return; // End this generator, resumed stream takes over
        }

        // Track block index for non-web-search events
        if (event.type === 'content_block_start') {
            blockIndex = event.index;
        }

        // Yield the event to client and track it
        yieldedEvents.push(event);
        yield event;
    }

    // No web_search detected, stream completed normally
}

export default {
    hasWebSearchTool,
    filterWebSearchTool,
    isWebSearchToolCall,
    executeWebSearch,
    buildToolUseBlock,
    buildToolResultMessage,
    findWebSearchToolCall,
    buildResumeRequest,
    handleWebSearchStream
};
