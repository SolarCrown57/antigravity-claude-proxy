/**
 * ID Generator Utilities
 * Generates unique IDs for requests, sessions, and tool calls
 */

import { randomUUID } from 'crypto';

/**
 * Generate a unique request ID
 * @returns {string} Request ID prefixed with 'agent-'
 */
export function generateRequestId() {
    return `agent-${randomUUID()}`;
}

/**
 * Generate a unique session ID
 * @returns {string} Negative numeric session ID as string
 */
export function generateSessionId() {
    return String(-Math.floor(Math.random() * 9e18));
}

/**
 * Generate a unique tool call ID
 * @returns {string} Tool call ID prefixed with 'call_'
 */
export function generateToolCallId() {
    return `call_${randomUUID().replace(/-/g, '')}`;
}

export default {
    generateRequestId,
    generateSessionId,
    generateToolCallId
};
