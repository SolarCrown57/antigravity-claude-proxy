/**
 * Admin Routes
 * API endpoints for the admin panel
 */

import express from 'express';
import crypto from 'crypto';
import { generateToken, authMiddleware, validateCredentials, updateCredentials, getAdminUsername } from '../auth/jwt.js';
import { AccountManager } from '../account-manager.js';
import { authenticateWithCode } from '../oauth.js';
import { OAUTH_CONFIG, DATA_DIR } from '../constants.js';

const router = express.Router();

// Shared account manager instance (will be set from server.js)
let accountManager = null;

/**
 * Set the account manager instance
 * @param {AccountManager} manager - Account manager instance
 */
export function setAccountManager(manager) {
    accountManager = manager;
}

// Login rate limiting
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 5 * 60 * 1000; // 5 minutes
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.ip ||
           'unknown';
}

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const attempt = loginAttempts.get(ip);

    if (!attempt) return { allowed: true };

    if (attempt.blockedUntil && now < attempt.blockedUntil) {
        const remainingSeconds = Math.ceil((attempt.blockedUntil - now) / 1000);
        return {
            allowed: false,
            message: `Too many login attempts. Please try again in ${remainingSeconds} seconds`,
            remainingSeconds
        };
    }

    if (now - attempt.lastAttempt > ATTEMPT_WINDOW) {
        loginAttempts.delete(ip);
        return { allowed: true };
    }

    return { allowed: true };
}

function recordLoginAttempt(ip, success) {
    const now = Date.now();

    if (success) {
        loginAttempts.delete(ip);
        return;
    }

    const attempt = loginAttempts.get(ip) || { count: 0, lastAttempt: now };
    attempt.count++;
    attempt.lastAttempt = now;

    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
        attempt.blockedUntil = now + BLOCK_DURATION;
        console.log(`[Admin] IP ${ip} blocked due to too many login attempts`);
    }

    loginAttempts.set(ip, attempt);
}

/**
 * Login endpoint
 */
router.post('/login', (req, res) => {
    const clientIP = getClientIP(req);

    const rateCheck = checkLoginRateLimit(clientIP);
    if (!rateCheck.allowed) {
        return res.status(429).json({
            success: false,
            message: rateCheck.message,
            retryAfter: rateCheck.remainingSeconds
        });
    }

    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    if (username.length > 100 || password.length > 100) {
        return res.status(400).json({ success: false, message: 'Input too long' });
    }

    if (validateCredentials(username, password)) {
        recordLoginAttempt(clientIP, true);
        const token = generateToken({ username, role: 'admin' });
        res.json({ success: true, token });
    } else {
        recordLoginAttempt(clientIP, false);
        res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
});

/**
 * Get all accounts
 */
router.get('/accounts', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const status = accountManager.getStatus();
        res.json({
            success: true,
            data: status.accounts,
            status: {
                total: status.total,
                available: status.available,
                rateLimited: status.rateLimited,
                invalid: status.invalid,
                summary: status.summary
            }
        });
    } catch (error) {
        console.error('[Admin] Failed to get accounts:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Delete an account
 */
router.delete('/accounts/:email', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const { email } = req.params;
        const accounts = accountManager.getAllAccounts();
        const index = accounts.findIndex(a => a.email === email);

        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        // Remove account from array
        accounts.splice(index, 1);
        await accountManager.saveToDisk();

        console.log(`[Admin] Deleted account: ${email}`);
        res.json({ success: true, message: 'Account deleted' });
    } catch (error) {
        console.error('[Admin] Failed to delete account:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Clear rate limit for an account
 */
router.post('/accounts/:email/clear-limit', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const { email } = req.params;
        const accounts = accountManager.getAllAccounts();
        const account = accounts.find(a => a.email === email);

        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        account.isRateLimited = false;
        account.rateLimitResetTime = null;
        await accountManager.saveToDisk();

        console.log(`[Admin] Cleared rate limit for: ${email}`);
        res.json({ success: true, message: 'Rate limit cleared' });
    } catch (error) {
        console.error('[Admin] Failed to clear rate limit:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Re-validate an invalid account
 */
router.post('/accounts/:email/revalidate', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const { email } = req.params;
        const accounts = accountManager.getAllAccounts();
        const account = accounts.find(a => a.email === email);

        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        // Clear invalid status
        account.isInvalid = false;
        account.invalidReason = null;

        // Try to refresh token if OAuth account
        if (account.source === 'oauth' && account.refreshToken) {
            try {
                accountManager.clearTokenCache(email);
                await accountManager.getTokenForAccount(account);
                console.log(`[Admin] Re-validated OAuth account: ${email}`);
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: `Token refresh failed: ${error.message}`
                });
            }
        }

        await accountManager.saveToDisk();
        res.json({ success: true, message: 'Account re-validated' });
    } catch (error) {
        console.error('[Admin] Failed to re-validate account:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Reset all rate limits
 */
router.post('/accounts/reset-limits', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        accountManager.resetAllRateLimits();
        await accountManager.saveToDisk();

        console.log('[Admin] Reset all rate limits');
        res.json({ success: true, message: 'All rate limits reset' });
    } catch (error) {
        console.error('[Admin] Failed to reset rate limits:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * OAuth code exchange
 */
router.post('/oauth/exchange', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const { code, port } = req.body;
        if (!code || !port) {
            return res.status(400).json({ success: false, message: 'Code and port required' });
        }

        // Exchange code for tokens
        const redirectUri = `http://localhost:${port}/oauth-callback`;
        const account = await authenticateWithCode(code, redirectUri);

        // Check if account already exists
        const accounts = accountManager.getAllAccounts();
        const existingIndex = accounts.findIndex(a => a.email === account.email);

        if (existingIndex !== -1) {
            // Update existing account
            accounts[existingIndex] = {
                ...accounts[existingIndex],
                ...account,
                isInvalid: false,
                invalidReason: null,
                isRateLimited: false,
                rateLimitResetTime: null
            };
            console.log(`[Admin] Updated existing account: ${account.email}`);
        } else {
            // Add new account
            accounts.push(account);
            console.log(`[Admin] Added new account: ${account.email}`);
        }

        await accountManager.saveToDisk();
        accountManager.clearTokenCache(account.email);

        res.json({ success: true, data: account, message: 'Account added successfully' });
    } catch (error) {
        console.error('[Admin] OAuth exchange failed:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Update admin settings
 */
router.put('/settings', authMiddleware, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username) {
            return res.status(400).json({ success: false, message: 'Username required' });
        }

        updateCredentials(username, password);
        console.log(`[Admin] Updated admin credentials for: ${username}`);

        res.json({ success: true, message: 'Settings saved' });
    } catch (error) {
        console.error('[Admin] Failed to update settings:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Manually add account with token
 */
router.post('/accounts/manual', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const { email, accessToken, refreshToken, projectId } = req.body;

        if (!accessToken) {
            return res.status(400).json({ success: false, message: 'Access token is required' });
        }

        // Generate email label if not provided
        const accountEmail = email || `manual-${crypto.randomBytes(4).toString('hex')}@manual.local`;

        // Create manual account object
        const account = {
            email: accountEmail,
            accessToken,
            refreshToken: refreshToken || null,
            projectId: projectId || null,
            source: 'manual',
            addedAt: new Date().toISOString(),
            expiresAt: Date.now() + 3600000, // Assume 1 hour expiry
            isInvalid: false,
            invalidReason: null,
            isRateLimited: false,
            rateLimitResetTime: null
        };

        // Check if account already exists
        const accounts = accountManager.getAllAccounts();
        const existingIndex = accounts.findIndex(a => a.email === accountEmail);

        if (existingIndex !== -1) {
            // Update existing account
            accounts[existingIndex] = {
                ...accounts[existingIndex],
                ...account
            };
            console.log(`[Admin] Updated manual account: ${accountEmail}`);
        } else {
            // Add new account
            accounts.push(account);
            console.log(`[Admin] Added manual account: ${accountEmail}`);
        }

        await accountManager.saveToDisk();
        accountManager.clearTokenCache(accountEmail);

        res.json({ success: true, data: account, message: 'Manual account added successfully' });
    } catch (error) {
        console.error('[Admin] Failed to add manual account:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Export configuration
 */
router.get('/settings/export', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const accounts = accountManager.getAllAccounts();
        const exportData = {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            accounts: accounts.map(acc => ({
                email: acc.email,
                accessToken: acc.accessToken,
                refreshToken: acc.refreshToken,
                projectId: acc.projectId,
                source: acc.source,
                addedAt: acc.addedAt
            }))
        };

        const filename = `antigravity-accounts-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(exportData);
    } catch (error) {
        console.error('[Admin] Failed to export config:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Import configuration
 */
router.post('/settings/import', authMiddleware, async (req, res) => {
    try {
        if (!accountManager) {
            return res.status(503).json({ success: false, message: 'Account manager not initialized' });
        }

        const { accounts, merge } = req.body;

        if (!accounts || !Array.isArray(accounts)) {
            return res.status(400).json({ success: false, message: 'Invalid import data: accounts array required' });
        }

        // Validate accounts
        const validAccounts = [];
        for (const acc of accounts) {
            if (!acc.accessToken && !acc.refreshToken) {
                continue; // Skip accounts without tokens
            }

            validAccounts.push({
                email: acc.email || `imported-${crypto.randomBytes(4).toString('hex')}@import.local`,
                accessToken: acc.accessToken || null,
                refreshToken: acc.refreshToken || null,
                projectId: acc.projectId || null,
                source: acc.source || 'import',
                addedAt: acc.addedAt || new Date().toISOString(),
                expiresAt: acc.expiresAt || Date.now() + 3600000,
                isInvalid: false,
                invalidReason: null,
                isRateLimited: false,
                rateLimitResetTime: null
            });
        }

        if (validAccounts.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid accounts found in import data' });
        }

        const existingAccounts = accountManager.getAllAccounts();

        if (merge) {
            // Merge mode: update existing, add new
            for (const newAcc of validAccounts) {
                const existingIndex = existingAccounts.findIndex(a => a.email === newAcc.email);
                if (existingIndex !== -1) {
                    existingAccounts[existingIndex] = { ...existingAccounts[existingIndex], ...newAcc };
                } else {
                    existingAccounts.push(newAcc);
                }
            }
            console.log(`[Admin] Merged ${validAccounts.length} accounts`);
        } else {
            // Replace mode: clear and replace
            existingAccounts.length = 0;
            existingAccounts.push(...validAccounts);
            console.log(`[Admin] Replaced with ${validAccounts.length} accounts`);
        }

        await accountManager.saveToDisk();
        accountManager.clearAllTokenCaches();

        res.json({
            success: true,
            message: `Imported ${validAccounts.length} account(s)`,
            count: validAccounts.length
        });
    } catch (error) {
        console.error('[Admin] Failed to import config:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Get data directory info
 */
router.get('/settings/info', authMiddleware, async (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                dataDir: DATA_DIR,
                accountCount: accountManager ? accountManager.getAllAccounts().length : 0
            }
        });
    } catch (error) {
        console.error('[Admin] Failed to get info:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
