// UI Components: Toast, Modal, Loading

function showToast(message, type = 'info', title = '') {
    const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
    const titles = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Info' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const safeTitle = escapeHtml(title || titles[type]);
    const safeMessage = escapeHtml(message);
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${safeTitle}</div>
            <div class="toast-message">${safeMessage}</div>
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showConfirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal';
        const safeTitle = escapeHtml(title);
        const safeMessage = escapeHtml(message);
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">${safeTitle}</div>
                <div class="modal-message">${safeMessage}</div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); window.modalResolve(false)">Cancel</button>
                    <button class="btn btn-danger" onclick="this.closest('.modal').remove(); window.modalResolve(true)">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) { modal.remove(); resolve(false); } };
        window.modalResolve = resolve;
    });
}

function showLoading(text = 'Processing...') {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loadingOverlay';
    const safeText = escapeHtml(text);
    overlay.innerHTML = `<div class="spinner"></div><div class="loading-text">${safeText}</div>`;
    document.body.appendChild(overlay);
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.remove();
}

function switchTab(tab, saveState = true) {
    // Update html element class to prevent flicker
    if (tab === 'settings') {
        document.documentElement.classList.add('tab-settings');
    } else {
        document.documentElement.classList.remove('tab-settings');
    }

    // Remove active state from all tabs
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    // Find and activate the target tab button
    const targetTab = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (targetTab) {
        targetTab.classList.add('active');
    }

    const accountsPage = document.getElementById('accountsPage');
    const settingsPage = document.getElementById('settingsPage');

    // Hide all pages and remove animation class
    accountsPage.classList.add('hidden');
    accountsPage.classList.remove('page-enter');
    settingsPage.classList.add('hidden');
    settingsPage.classList.remove('page-enter');

    // Show corresponding page with animation
    if (tab === 'accounts') {
        accountsPage.classList.remove('hidden');
        void accountsPage.offsetWidth;
        accountsPage.classList.add('page-enter');
    } else if (tab === 'settings') {
        settingsPage.classList.remove('hidden');
        void settingsPage.offsetWidth;
        settingsPage.classList.add('page-enter');
        loadServerStatus();
    }

    // Save current tab state to localStorage
    if (saveState) {
        localStorage.setItem('currentTab', tab);
    }
}

// Restore tab state
function restoreTabState() {
    const savedTab = localStorage.getItem('currentTab');
    if (savedTab && (savedTab === 'accounts' || savedTab === 'settings')) {
        switchTab(savedTab, false);
    }
}
