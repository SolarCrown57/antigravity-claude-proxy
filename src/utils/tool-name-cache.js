/**
 * Tool Name Cache
 * Caches tool name mappings (sanitized -> original) per session and model
 *
 * When tools are sent to the upstream API, their names must be sanitized.
 * When responses come back, we need to restore the original names.
 */

// Cache: `${sessionId}::${model}::${safeName}` -> { originalName, ts }
const toolNameMap = new Map();

const MAX_ENTRIES = 512;
const ENTRY_TTL_MS = 30 * 60 * 1000;      // 30 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate cache key
 */
function makeKey(sessionId, model, safeName) {
    return `${sessionId || ''}::${model || ''}::${safeName || ''}`;
}

/**
 * Prune cache to target size (FIFO order)
 */
function pruneSize(targetSize) {
    if (toolNameMap.size <= targetSize) return;
    const removeCount = toolNameMap.size - targetSize;
    let removed = 0;
    for (const key of toolNameMap.keys()) {
        toolNameMap.delete(key);
        removed++;
        if (removed >= removeCount) break;
    }
}

/**
 * Prune expired entries
 */
function pruneExpired(now) {
    for (const [key, entry] of toolNameMap.entries()) {
        if (!entry || typeof entry.ts !== 'number') continue;
        if (now - entry.ts > ENTRY_TTL_MS) {
            toolNameMap.delete(key);
        }
    }
}

// Periodic cleanup
let cleanupInterval = null;
function startCleanup() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(() => {
        pruneExpired(Date.now());
    }, CLEANUP_INTERVAL_MS);
    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }
}

/**
 * Store a tool name mapping
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {string} safeName - Sanitized tool name
 * @param {string} originalName - Original tool name
 */
export function setToolNameMapping(sessionId, model, safeName, originalName) {
    if (!safeName || !originalName || safeName === originalName) return;
    const key = makeKey(sessionId, model, safeName);
    toolNameMap.set(key, { originalName, ts: Date.now() });
    pruneSize(MAX_ENTRIES);
    startCleanup();
}

/**
 * Get original tool name from sanitized name
 * @param {string} sessionId - Session ID
 * @param {string} model - Model name
 * @param {string} safeName - Sanitized tool name
 * @returns {string|null} Original tool name or null if not found
 */
export function getOriginalToolName(sessionId, model, safeName) {
    if (!safeName) return null;
    const key = makeKey(sessionId, model, safeName);
    const entry = toolNameMap.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (typeof entry.ts === 'number' && now - entry.ts > ENTRY_TTL_MS) {
        toolNameMap.delete(key);
        return null;
    }
    return entry.originalName || null;
}

/**
 * Clear all tool name mappings
 */
export function clearToolNameMappings() {
    toolNameMap.clear();
}

/**
 * Get current cache size
 * @returns {number} Number of entries in cache
 */
export function getCacheSize() {
    return toolNameMap.size;
}

export default {
    setToolNameMapping,
    getOriginalToolName,
    clearToolNameMappings,
    getCacheSize
};
