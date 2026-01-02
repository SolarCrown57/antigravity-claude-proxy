/**
 * Tool Converter
 * Converts tool definitions between different API formats and Google/Antigravity format
 */

import { sanitizeSchema, cleanSchemaForGemini } from '../format/schema-sanitizer.js';
import { setToolNameMapping } from './tool-name-cache.js';
import { getModelFamily } from '../constants.js';

/**
 * Sanitize tool name to be compatible with Google API
 * Only allows alphanumeric, underscore, and hyphen
 * @param {string} name - Original tool name
 * @returns {string} Sanitized tool name
 */
export function sanitizeToolName(name) {
    if (!name || typeof name !== 'string') return 'tool';
    let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    cleaned = cleaned.replace(/^_+|_+$/g, '');
    if (!cleaned) cleaned = 'tool';
    if (cleaned.length > 128) cleaned = cleaned.slice(0, 128);
    return cleaned;
}

/**
 * Convert a single tool definition to Google functionDeclaration format
 * @param {string} name - Tool name
 * @param {string} description - Tool description
 * @param {Object} parameters - Tool parameters schema
 * @param {string} sessionId - Session ID for caching
 * @param {string} modelName - Model name for caching
 * @returns {Object} functionDeclaration object
 */
function convertSingleTool(name, description, parameters, sessionId, modelName) {
    const originalName = name;
    const safeName = sanitizeToolName(originalName);

    // Cache the mapping if name was changed
    if (sessionId && modelName && safeName !== originalName) {
        setToolNameMapping(sessionId, modelName, safeName, originalName);
    }

    const rawParams = parameters || {};
    let cleanedParams = sanitizeSchema(rawParams) || {};

    // For Gemini models, apply additional cleaning
    const modelFamily = getModelFamily(modelName);
    if (modelFamily === 'gemini') {
        cleanedParams = cleanSchemaForGemini(cleanedParams);
    }

    if (cleanedParams.type === undefined) cleanedParams.type = 'object';
    if (cleanedParams.type === 'object' && cleanedParams.properties === undefined) {
        cleanedParams.properties = {};
    }

    return {
        name: safeName,
        description: description || '',
        parameters: cleanedParams
    };
}

/**
 * Convert OpenAI format tools to Antigravity format
 * OpenAI format: [{ type: 'function', function: { name, description, parameters } }]
 * @param {Array} openaiTools - OpenAI format tools
 * @param {string} sessionId - Session ID
 * @param {string} modelName - Model name
 * @returns {Array} Antigravity format tools
 */
export function convertOpenAIToolsToAntigravity(openaiTools, sessionId, modelName) {
    if (!openaiTools || openaiTools.length === 0) return [];

    return openaiTools.map((tool) => {
        const func = tool.function || {};
        const declaration = convertSingleTool(
            func.name,
            func.description,
            func.parameters,
            sessionId,
            modelName
        );

        return {
            functionDeclarations: [declaration]
        };
    });
}

/**
 * Convert Claude/Anthropic format tools to Antigravity format
 * Claude format: [{ name, description, input_schema }]
 * @param {Array} claudeTools - Claude format tools
 * @param {string} sessionId - Session ID
 * @param {string} modelName - Model name
 * @returns {Array} Antigravity format tools
 */
export function convertClaudeToolsToAntigravity(claudeTools, sessionId, modelName) {
    if (!claudeTools || claudeTools.length === 0) return [];

    return claudeTools.map((tool) => {
        const declaration = convertSingleTool(
            tool.name,
            tool.description,
            tool.input_schema,
            sessionId,
            modelName
        );

        return {
            functionDeclarations: [declaration]
        };
    });
}

/**
 * Convert Gemini format tools to Antigravity format
 * Gemini format can be:
 * 1. [{ functionDeclarations: [{ name, description, parameters }] }]
 * 2. [{ name, description, parameters }]
 * @param {Array} geminiTools - Gemini format tools
 * @param {string} sessionId - Session ID
 * @param {string} modelName - Model name
 * @returns {Array} Antigravity format tools
 */
export function convertGeminiToolsToAntigravity(geminiTools, sessionId, modelName) {
    if (!geminiTools || geminiTools.length === 0) return [];

    return geminiTools.map((tool) => {
        // Format 1: Already has functionDeclarations
        if (tool.functionDeclarations) {
            return {
                functionDeclarations: tool.functionDeclarations.map(fd =>
                    convertSingleTool(fd.name, fd.description, fd.parameters, sessionId, modelName)
                )
            };
        }

        // Format 2: Single tool definition
        if (tool.name) {
            const declaration = convertSingleTool(
                tool.name,
                tool.description,
                tool.parameters || tool.input_schema,
                sessionId,
                modelName
            );

            return {
                functionDeclarations: [declaration]
            };
        }

        // Unknown format, return as-is
        return tool;
    });
}

export default {
    sanitizeToolName,
    convertOpenAIToolsToAntigravity,
    convertClaudeToolsToAntigravity,
    convertGeminiToolsToAntigravity
};
