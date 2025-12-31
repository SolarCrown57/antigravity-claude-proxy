// Account Management: List, Filter, Delete, Reset

let cachedAccounts = [];
let currentFilter = localStorage.getItem('accountFilter') || 'all';

// Initialize filter state
function initFilterState() {
    const savedFilter = localStorage.getItem('accountFilter') || 'all';
    currentFilter = savedFilter;
    updateFilterButtonState(savedFilter);
}

// Update filter button state
function updateFilterButtonState(filter) {
    document.querySelectorAll('.stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = {
        'all': 'totalAccounts',
        'available': 'availableAccounts',
        'rateLimited': 'rateLimitedAccounts',
        'invalid': 'invalidAccounts'
    };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// Filter accounts
function filterAccounts(filter) {
    currentFilter = filter;
    localStorage.setItem('accountFilter', filter);
    updateFilterButtonState(filter);
    renderAccounts(cachedAccounts);
}

async function loadAccounts() {
    try {
        const response = await authFetch('/admin/accounts', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
            renderAccounts(data.data);
            updateServerInfo(data.status);
        } else {
            showToast('Failed to load: ' + (data.message || 'Unknown error'), 'error');
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            showToast('Failed to load accounts: ' + error.message, 'error');
        }
    }
}

function updateServerInfo(status) {
    const serverInfo = document.getElementById('serverInfo');
    if (serverInfo && status) {
        serverInfo.textContent = status.summary || `${status.total} accounts`;
    }
}

function renderAccounts(accounts) {
    if (accounts !== cachedAccounts) {
        cachedAccounts = accounts;
    }

    // Update stats
    const total = accounts.length;
    const available = accounts.filter(a => !a.isRateLimited && !a.isInvalid).length;
    const rateLimited = accounts.filter(a => a.isRateLimited).length;
    const invalid = accounts.filter(a => a.isInvalid).length;

    document.getElementById('totalAccounts').textContent = total;
    document.getElementById('availableAccounts').textContent = available;
    document.getElementById('rateLimitedAccounts').textContent = rateLimited;
    document.getElementById('invalidAccounts').textContent = invalid;

    // Filter accounts based on current filter
    let filteredAccounts = accounts;
    if (currentFilter === 'available') {
        filteredAccounts = accounts.filter(a => !a.isRateLimited && !a.isInvalid);
    } else if (currentFilter === 'rateLimited') {
        filteredAccounts = accounts.filter(a => a.isRateLimited);
    } else if (currentFilter === 'invalid') {
        filteredAccounts = accounts.filter(a => a.isInvalid);
    }

    const accountList = document.getElementById('accountList');
    if (filteredAccounts.length === 0) {
        const emptyText = currentFilter === 'all' ? 'No accounts configured' :
                          currentFilter === 'available' ? 'No available accounts' :
                          currentFilter === 'rateLimited' ? 'No rate-limited accounts' : 'No invalid accounts';
        const emptyHint = currentFilter === 'all' ? 'Click OAuth button above to add an account' : 'Click "Total" to view all accounts';
        accountList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }

    accountList.innerHTML = filteredAccounts.map((account, index) => {
        const originalIndex = cachedAccounts.findIndex(a => a.email === account.email);
        const accountNumber = originalIndex + 1;

        // Determine status
        let statusClass = 'available';
        let statusText = 'Available';
        let cardClass = '';

        if (account.isInvalid) {
            statusClass = 'invalid';
            statusText = 'Invalid';
            cardClass = 'invalid';
        } else if (account.isRateLimited) {
            statusClass = 'rate-limited';
            const remaining = account.rateLimitResetTime ? account.rateLimitResetTime - Date.now() : 0;
            statusText = remaining > 0 ? `Limited (${formatDuration(remaining)})` : 'Rate Limited';
            cardClass = 'rate-limited';
        }

        const safeEmail = escapeHtml(account.email);
        const safeEmailJs = escapeJs(account.email);
        const safeSource = escapeHtml(account.source || 'unknown');
        const lastUsed = account.lastUsed ? getRelativeTime(account.lastUsed) : 'never';
        const invalidReason = account.invalidReason ? escapeHtml(account.invalidReason) : '';

        return `
        <div class="account-card ${cardClass}">
            <div class="account-header">
                <span class="account-email" title="${safeEmail}">${safeEmail}</span>
                <span class="account-index">#${accountNumber}</span>
            </div>
            <div class="account-info">
                <div class="info-row">
                    <span class="info-label">📧</span>
                    <span class="info-value">${safeEmail}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">🔗</span>
                    <span class="info-value">${safeSource}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">⏰</span>
                    <span class="info-value">Last used: ${lastUsed}</span>
                </div>
                ${invalidReason ? `
                <div class="info-row">
                    <span class="info-label">⚠️</span>
                    <span class="info-value" style="color: var(--danger);">${invalidReason}</span>
                </div>
                ` : ''}
                <div class="info-row">
                    <span class="info-label">📊</span>
                    <span class="status ${statusClass}">${statusText}</span>
                </div>
            </div>
            <div class="account-actions">
                ${account.isRateLimited ? `
                <button class="btn btn-info btn-xs" onclick="clearRateLimit('${safeEmailJs}')" title="Clear rate limit">Clear Limit</button>
                ` : ''}
                ${account.isInvalid ? `
                <button class="btn btn-warning btn-xs" onclick="revalidateAccount('${safeEmailJs}')" title="Re-validate account">Re-validate</button>
                ` : ''}
                <button class="btn btn-danger btn-xs" onclick="deleteAccount('${safeEmailJs}')" title="Delete account">Delete</button>
            </div>
        </div>
    `}).join('');
}

async function deleteAccount(email) {
    const confirmed = await showConfirm(`Delete account ${email}? This cannot be undone.`, 'Delete Account');
    if (!confirmed) return;

    showLoading('Deleting...');
    try {
        const response = await authFetch(`/admin/accounts/${encodeURIComponent(email)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('Account deleted', 'success');
            loadAccounts();
        } else {
            showToast(data.message || 'Delete failed', 'error');
        }
    } catch (error) {
        hideLoading();
        if (error.message !== 'Unauthorized') {
            showToast('Delete failed: ' + error.message, 'error');
        }
    }
}

async function clearRateLimit(email) {
    showLoading('Clearing rate limit...');
    try {
        const response = await authFetch(`/admin/accounts/${encodeURIComponent(email)}/clear-limit`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('Rate limit cleared', 'success');
            loadAccounts();
        } else {
            showToast(data.message || 'Failed to clear limit', 'error');
        }
    } catch (error) {
        hideLoading();
        if (error.message !== 'Unauthorized') {
            showToast('Failed: ' + error.message, 'error');
        }
    }
}

async function revalidateAccount(email) {
    showLoading('Re-validating account...');
    try {
        const response = await authFetch(`/admin/accounts/${encodeURIComponent(email)}/revalidate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('Account re-validated', 'success');
            loadAccounts();
        } else {
            showToast(data.message || 'Re-validation failed', 'error');
        }
    } catch (error) {
        hideLoading();
        if (error.message !== 'Unauthorized') {
            showToast('Failed: ' + error.message, 'error');
        }
    }
}

async function resetAllRateLimits() {
    const confirmed = await showConfirm('Reset all rate limits? This will clear rate limit status for all accounts.', 'Reset Rate Limits');
    if (!confirmed) return;

    showLoading('Resetting rate limits...');
    try {
        const response = await authFetch('/admin/accounts/reset-limits', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('All rate limits reset', 'success');
            loadAccounts();
        } else {
            showToast(data.message || 'Reset failed', 'error');
        }
    } catch (error) {
        hideLoading();
        if (error.message !== 'Unauthorized') {
            showToast('Reset failed: ' + error.message, 'error');
        }
    }
}
