// Main Entry: Initialization and Event Binding

// Initialize on page load
initFilterState();

// If logged in, show main content
if (authToken) {
    showMainContent();
    restoreTabState();
    loadAccounts();
    // Only load server status if on settings page
    if (localStorage.getItem('currentTab') === 'settings') {
        loadServerStatus();
    }
}

// Login form submit
document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return;

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    btn.disabled = true;
    btn.classList.add('loading');
    const originalText = btn.textContent;
    btn.textContent = 'Logging in...';

    try {
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();
        if (data.success) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            showToast('Login successful', 'success');
            showMainContent();
            loadAccounts();
            loadServerStatus();
        } else {
            showToast(data.message || 'Invalid username or password', 'error');
        }
    } catch (error) {
        showToast('Login failed: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = originalText;
    }
});

// Admin settings form submit
document.getElementById('adminForm').addEventListener('submit', saveAdminSettings);

// Auto-refresh accounts every 30 seconds when logged in
setInterval(() => {
    if (authToken && document.getElementById('accountsPage') && !document.getElementById('accountsPage').classList.contains('hidden')) {
        loadAccounts();
    }
}, 30000);
