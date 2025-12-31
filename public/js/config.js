// Configuration Management: Server Status, Quotas, Settings

let serverStartTime = Date.now();

async function loadServerStatus() {
    try {
        const response = await authFetch('/health', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();

        document.getElementById('statusValue').textContent = data.status === 'ok' ? '✓ Running' : '✗ Error';
        document.getElementById('statusValue').style.color = data.status === 'ok' ? 'var(--success)' : 'var(--danger)';
        document.getElementById('portValue').textContent = window.location.port || '8080';

        // Calculate uptime (approximate)
        const uptime = Date.now() - serverStartTime;
        document.getElementById('uptimeValue').textContent = formatDuration(uptime);

        // Update server info
        if (data.accounts) {
            document.getElementById('serverInfo').textContent = data.accounts;
        }
    } catch (error) {
        document.getElementById('statusValue').textContent = '✗ Error';
        document.getElementById('statusValue').style.color = 'var(--danger)';
        if (error.message !== 'Unauthorized') {
            console.error('Failed to load server status:', error);
        }
    }
}

async function loadQuotas() {
    const quotaDisplay = document.getElementById('quotaDisplay');
    quotaDisplay.innerHTML = '<div class="quota-loading">Loading quotas...</div>';

    try {
        const response = await authFetch('/account-limits', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();

        if (data.accounts && data.accounts.length > 0) {
            let html = '';

            for (const account of data.accounts) {
                html += `<div class="quota-item">
                    <div class="quota-model-name">${escapeHtml(account.email)}</div>`;

                if (account.status !== 'ok') {
                    html += `<div class="quota-info-row">
                        <span class="quota-percentage" style="color: var(--danger);">${escapeHtml(account.status)}</span>
                        ${account.error ? `<span class="quota-reset">${escapeHtml(account.error)}</span>` : ''}
                    </div>`;
                } else if (account.limits) {
                    // Show first few model quotas
                    const models = Object.entries(account.limits).slice(0, 3);
                    for (const [modelId, quota] of models) {
                        if (!quota) continue;
                        const pct = quota.remainingFraction !== null ? Math.round(quota.remainingFraction * 100) : 0;
                        const barColor = pct > 50 ? 'var(--success)' : pct > 20 ? 'var(--warning)' : 'var(--danger)';

                        html += `
                        <div style="margin-top: 0.25rem;">
                            <div style="font-size: 0.65rem; color: var(--text-light);">${escapeHtml(modelId.split('/').pop())}</div>
                            <div class="quota-bar-container">
                                <div class="quota-bar" style="width: ${pct}%; background: ${barColor};"></div>
                            </div>
                            <div class="quota-info-row">
                                <span class="quota-percentage">${quota.remaining || pct + '%'}</span>
                                ${quota.resetTime ? `<span class="quota-reset">Reset: ${new Date(quota.resetTime).toLocaleTimeString()}</span>` : ''}
                            </div>
                        </div>`;
                    }
                }

                html += '</div>';
            }

            quotaDisplay.innerHTML = html;
        } else {
            quotaDisplay.innerHTML = '<div class="quota-empty">No quota data available</div>';
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            quotaDisplay.innerHTML = `<div class="quota-error">Failed to load quotas: ${escapeHtml(error.message)}</div>`;
        }
    }
}

async function refreshTokens() {
    const confirmed = await showConfirm('Force refresh all tokens? This will clear token caches.', 'Refresh Tokens');
    if (!confirmed) return;

    showLoading('Refreshing tokens...');
    try {
        const response = await authFetch('/refresh-token', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        hideLoading();

        if (data.status === 'ok') {
            showToast('Tokens refreshed successfully', 'success');
            loadAccounts();
            loadServerStatus();
        } else {
            showToast(data.error || 'Refresh failed', 'error');
        }
    } catch (error) {
        hideLoading();
        if (error.message !== 'Unauthorized') {
            showToast('Refresh failed: ' + error.message, 'error');
        }
    }
}

async function saveAdminSettings(e) {
    e.preventDefault();
    const form = e.target;
    const username = form.elements['ADMIN_USERNAME'].value.trim();
    const password = form.elements['ADMIN_PASSWORD'].value;

    if (!username) {
        showToast('Username is required', 'warning');
        return;
    }

    showLoading('Saving settings...');
    try {
        const response = await authFetch('/admin/settings', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                username,
                password: password || undefined
            })
        });

        const data = await response.json();
        hideLoading();

        if (data.success) {
            showToast('Settings saved', 'success');
            form.elements['ADMIN_PASSWORD'].value = '';
        } else {
            showToast(data.message || 'Save failed', 'error');
        }
    } catch (error) {
        hideLoading();
        if (error.message !== 'Unauthorized') {
            showToast('Save failed: ' + error.message, 'error');
        }
    }
}
