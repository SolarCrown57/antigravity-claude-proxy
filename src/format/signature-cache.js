/**
 * Signature Cache
 * In-memory cache for Gemini thoughtSignatures
 *
 * Gemini models require thoughtSignature on tool calls, but Claude Code
 * strips non-standard fields. This cache stores signatures by tool_use_id
 * so they can be restored in subsequent requests.
 */

import { GEMINI_SIGNATURE_CACHE_TTL_MS } from '../constants.js';

const signatureCache = new Map();

// Periodic cleanup interval (run every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupIntervalId = null;

/**
 * Store a signature for a tool_use_id
 * @param {string} toolUseId - The tool use ID
 * @param {string} signature - The thoughtSignature to cache
 */
export function cacheSignature(toolUseId, signature) {
    if (!toolUseId || !signature) return;
    signatureCache.set(toolUseId, {
        signature,
        timestamp: Date.now()
    });

    // Start periodic cleanup if not already running
    startPeriodicCleanup();
}

/**
 * Get a cached signature for a tool_use_id
 * @param {string} toolUseId - The tool use ID
 * @returns {string|null} The cached signature or null if not found/expired
 */
export function getCachedSignature(toolUseId) {
    if (!toolUseId) return null;
    const entry = signatureCache.get(toolUseId);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
        signatureCache.delete(toolUseId);
        return null;
    }

    return entry.signature;
}

/**
 * Clear expired entries from the cache
 * Can be called periodically to prevent memory buildup
 */
export function cleanupCache() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of signatureCache) {
        if (now - entry.timestamp > GEMINI_SIGNATURE_CACHE_TTL_MS) {
            signatureCache.delete(key);
            cleaned++;
        }
    }

    // Stop periodic cleanup if cache is empty
    if (signatureCache.size === 0) {
        stopPeriodicCleanup();
    }

    if (cleaned > 0) {
        console.log(`[SignatureCache] Cleaned up ${cleaned} expired entries, ${signatureCache.size} remaining`);
    }
}

/**
 * Start periodic cleanup timer
 */
function startPeriodicCleanup() {
    if (cleanupIntervalId !== null) return;
    cleanupIntervalId = setInterval(cleanupCache, CLEANUP_INTERVAL_MS);
    // Unref the timer so it doesn't prevent process exit
    if (cleanupIntervalId.unref) {
        cleanupIntervalId.unref();
    }
}

/**
 * Stop periodic cleanup timer
 */
function stopPeriodicCleanup() {
    if (cleanupIntervalId !== null) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
}

/**
 * Get the current cache size (for debugging)
 * @returns {number} Number of entries in the cache
 */
export function getCacheSize() {
    return signatureCache.size;
}
