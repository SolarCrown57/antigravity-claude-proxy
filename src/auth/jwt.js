/**
 * JWT Authentication Module
 * Simple JWT-based authentication for admin panel
 */

import { createHmac, randomBytes } from 'crypto';

// Default admin credentials (can be overridden via environment variables)
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

// JWT secret - generated on startup or from environment
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');

// Token expiration (24 hours)
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Admin credentials
let adminUsername = process.env.ADMIN_USERNAME || DEFAULT_USERNAME;
let adminPassword = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;

/**
 * Generate a simple JWT token
 * @param {Object} payload - Token payload
 * @returns {string} JWT token
 */
export function generateToken(payload) {
    const header = {
        alg: 'HS256',
        typ: 'JWT'
    };

    const now = Date.now();
    const tokenPayload = {
        ...payload,
        iat: now,
        exp: now + TOKEN_EXPIRY_MS
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
    const signature = createHmac('sha256', JWT_SECRET)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');

    return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify a JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object|null} Decoded payload or null if invalid
 */
export function verifyToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [headerB64, payloadB64, signature] = parts;

        // Verify signature
        const expectedSignature = createHmac('sha256', JWT_SECRET)
            .update(`${headerB64}.${payloadB64}`)
            .digest('base64url');

        if (signature !== expectedSignature) return null;

        // Decode payload
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

        // Check expiration
        if (payload.exp && payload.exp < Date.now()) return null;

        return payload;
    } catch (error) {
        return null;
    }
}

/**
 * Express middleware for JWT authentication
 */
export function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'No token provided'
        });
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    if (!payload) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired token'
        });
    }

    req.user = payload;
    next();
}

/**
 * Validate admin credentials
 * @param {string} username - Username to validate
 * @param {string} password - Password to validate
 * @returns {boolean} True if credentials are valid
 */
export function validateCredentials(username, password) {
    return username === adminUsername && password === adminPassword;
}

/**
 * Update admin credentials
 * @param {string} username - New username
 * @param {string} password - New password (optional)
 */
export function updateCredentials(username, password) {
    if (username) adminUsername = username;
    if (password) adminPassword = password;
}

/**
 * Get current admin username
 * @returns {string} Current admin username
 */
export function getAdminUsername() {
    return adminUsername;
}

export default {
    generateToken,
    verifyToken,
    authMiddleware,
    validateCredentials,
    updateCredentials,
    getAdminUsername
};
