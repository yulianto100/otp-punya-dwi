/**
 * WA OTP Manager - Dashboard JavaScript
 * Real-time WebSocket connection and UI management
 */

(function() {
  'use strict';

  // ==================== State ====================
  const state = {
    token: localStorage.getItem('wa_otp_token'),
    user: localStorage.getItem('wa_otp_user') || 'admin',
    ws: null,
    sessions: [],
    otpLogs: [],
    messages: [],
    maxSessions: 5,
    autoScroll: true,
    currentPairingSession: null,
  };

  // ==================== Auth Check ====================
  if (!state.token) {
    window.location.href = '/login';
    return;
  }

  // ==================== DOM Elements ====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    sessionCount: $('#sessionCount'),
    userInfo: $('#userInfo'),
    sessionsGrid: $('#sessionsGrid'),
    emptySessions: $('#emptySessions'),
    otpList: $('#otpList'),
    emptyOtp: $('#emptyOtp'),
    messagesFeed: $('#messagesFeed'),
    emptyMessages: $('#emptyMessages'),
    filterSession: $('#filterSession'),
    addSessionModal: $('#addSessionModal'),
    pairingModal: $('#pairingModal'),
    pairingCode: $('#pairingCode'),
    pairingSessionName: $('#pairingSessionName'),
    sessionNameInput: $('#sessionName'),
  };

  // ==================== API Helper ====================
  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        ...options.headers,
      },
    });

    if (res.status === 401) {
      localStorage.removeItem('wa_otp_token');
      window.location.href = '/login';
      return null;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ==================== WebSocket ====================
  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}?token=${state.token}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('[WS] Connected');
      showNotification('Terhubung ke server', 'success');
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    state.ws.onclose = () => {
      console.log('[WS] Disconnected');
      // Reconnect after 3 seconds
      setTimeout(connectWS, 3000);
    };

    state.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'init':
        state.sessions = msg.data.sessions;
        state.maxSessions = msg.data.maxSessions;
        renderSessions();
        break;

      case 'session_update':
        updateSession(msg.data);
        break;

      case 'session_removed':
        removeSession(msg.data.name);
        break;

      case 'pairing_code':
        showPairingCode(msg.data);
        break;

      case 'otp':
        addOTP(msg.data);
        break;

      case 'message':
        addMessage(msg.data);
        break;

      case 'otp_cleared':
        state.otpLogs = [];
        renderOTPLogs();
        break;
    }
  }

  // ==================== Session Management ====================
  function updateSession(data) {
    const idx = state.sessions.findIndex(s => s.name === data.name);
    if (idx >= 0) {
      Object.assign(state.sessions[idx], data);
    } else {
      state.sessions.push(data);
    }
    renderSessions();
  }

  function removeSession(name) {
    state.sessions = state.sessions.filter(s => s.name !== name);
    renderSessions();
  }

  function renderSessions() {
    const count = state.sessions.filter(s => s.status === 'connected').length;
    els.sessionCount.textContent = `${count}/${state.maxSessions} session aktif`;

    // Update filter dropdown
    const currentFilter = els.filterSession.value;
    els.filterSession.innerHTML = '<option value="">Semua session</option>';
    state.sessions.forEach(s => {
      els.filterSession.innerHTML += `<option value="${s.name}">${s.name}</option>`;
    });
    els.filterSession.value = currentFilter;

    if (state.sessions.length === 0) {
      els.sessionsGrid.innerHTML = '';
      els.sessionsGrid.appendChild(els.emptySessions);
      els.emptySessions.style.display = 'block';
      return;
    }

    els.emptySessions.style.display = 'none';

    els.sessionsGrid.innerHTML = state.sessions.map(session => `
      <div class="session-card" data-session="${session.name}">
        <div class="session-card-header">
          <span class="session-name">${escapeHtml(session.name)}</span>
          <span class="session-status ${session.status}">
            <span class="session-status-dot"></span>
            ${getStatusLabel(session.status)}
          </span>
        </div>
        ${session.phone ? `<span class="session-phone">+${session.phone}</span>` : ''}
        ${session.pairingCode ? `
          <div class="pairing-code-display">
            <span class="pairing-code-text">${session.pairingCode}</span>
            <button class="btn btn-sm btn-ghost" onclick="app.copyPairingCode('${session.pairingCode}')">📋</button>
          </div>
        ` : ''}
        <div class="session-actions">
          ${session.status === 'pairing_code' || session.status === 'connecting' ? `
            <button class="btn btn-sm btn-primary" onclick="app.showPairingModal('${session.name}')">
              📱 Pairing Code
            </button>
          ` : ''}
          <button class="btn btn-sm btn-danger" onclick="app.logoutSession('${session.name}')">
            🗑️ Logout
          </button>
        </div>
      </div>
    `).join('');
  }

  function getStatusLabel(status) {
    const labels = {
      'connected': 'Terhubung',
      'connecting': 'Menghubungkan...',
      'pairing_code': 'Menunggu Pairing',
      'reconnecting': 'Menyambung ulang...',
      'disconnected': 'Terputus',
      'error': 'Error',
    };
    return labels[status] || status;
  }

  // ==================== OTP Management ====================
  function addOTP(data) {
    state.otpLogs.unshift(data);

    // Keep max 200 logs in memory
    if (state.otpLogs.length > 200) {
      state.otpLogs = state.otpLogs.slice(0, 200);
    }

    renderOTPLogs();

    // Play notification sound
    playNotificationSound();

    // Show browser notification
    showBrowserNotification(data);

    // Flash title
    flashTitle(`OTP: ${data.otp}`);
  }

  function renderOTPLogs() {
    const filter = els.filterSession.value;
    let logs = state.otpLogs;

    if (filter) {
      logs = logs.filter(l => l.session === filter);
    }

    if (logs.length === 0) {
      els.emptyOtp.style.display = 'block';
      els.otpList.innerHTML = '';
      return;
    }

    els.emptyOtp.style.display = 'none';

    els.otpList.innerHTML = logs.slice(0, 50).map(log => `
      <div class="otp-card">
        <div class="otp-card-header">
          <span class="otp-app">${escapeHtml(log.app)}</span>
          <span class="otp-time">${formatTime(log.timestamp)}</span>
        </div>
        <div class="otp-code" onclick="app.copyOTP(this, '${log.otp}')" title="Klik untuk copy">
          ${log.otp}
        </div>
        <div class="otp-sender">Dari: ${escapeHtml(log.sender)}</div>
        <div class="otp-message">${escapeHtml(log.message).substring(0, 100)}${log.message.length > 100 ? '...' : ''}</div>
        <span class="otp-session-tag">📱 ${escapeHtml(log.session)}</span>
      </div>
    `).join('');
  }

  // ==================== Messages Feed ====================
  function addMessage(data) {
    state.messages.unshift(data);

    // Keep max 500 messages
    if (state.messages.length > 500) {
      state.messages = state.messages.slice(0, 500);
    }

    renderMessages();
  }

  function renderMessages() {
    if (state.messages.length === 0) {
      els.emptyMessages.style.display = 'flex';
      return;
    }

    els.emptyMessages.style.display = 'none';

    // Show last 100 messages
    const recentMessages = state.messages.slice(0, 100);

    els.messagesFeed.innerHTML = recentMessages.map(msg => `
      <div class="message-item ${msg.hasOtp ? 'has-otp' : ''}">
        <span class="message-time">${formatTimeShort(msg.timestamp)}</span>
        <span class="message-session">${escapeHtml(msg.session)}</span>
        <span class="message-sender">${escapeHtml(msg.sender)}:</span>
        <span class="message-text">${escapeHtml(msg.text)}</span>
        ${msg.otp ? `<span class="message-otp-badge">${msg.otp}</span>` : ''}
      </div>
    `).join('');

    // Auto scroll
    if (state.autoScroll) {
      els.messagesFeed.scrollTop = 0;
    }
  }

  // ==================== Pairing Code ====================
  function showPairingCode(data) {
    // Update session card
    const idx = state.sessions.findIndex(s => s.name === data.name);
    if (idx >= 0) {
      state.sessions[idx].pairingCode = data.code;
      state.sessions[idx].status = 'pairing_code';
      renderSessions();
    }

    // Show modal if it's for current session
    if (state.currentPairingSession === data.name) {
      els.pairingCode.textContent = formatPairingCode(data.code);
      els.pairingSessionName.textContent = `Session: ${data.name}`;
    }
  }

  function formatPairingCode(code) {
    // Format as XXXX-XXXX for readability
    if (code.length === 8) {
      return `${code.substring(0, 4)}-${code.substring(4)}`;
    }
    return code;
  }

  function showPairingModal(sessionName) {
    state.currentPairingSession = sessionName;
    els.pairingSessionName.textContent = `Session: ${sessionName}`;

    // Find existing pairing code
    const session = state.sessions.find(s => s.name === sessionName);
    if (session && session.pairingCode) {
      els.pairingCode.textContent = formatPairingCode(session.pairingCode);
    } else {
      els.pairingCode.textContent = 'Memuat...';
    }

    els.pairingModal.classList.add('show');
  }

  function closePairingModal() {
    els.pairingModal.classList.remove('show');
    state.currentPairingSession = null;
  }

  // ==================== Actions ====================
  async function createSession() {
    const name = els.sessionNameInput.value.trim();
    if (!name) {
      showNotification('Nama session wajib diisi', 'error');
      return;
    }

    try {
      await api('/sessions', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });

      els.addSessionModal.classList.remove('show');
      els.sessionNameInput.value = '';
      showNotification(`Session "${name}" dibuat`, 'success');

      // Auto show pairing modal
      setTimeout(() => showPairingModal(name), 1000);
    } catch (err) {
      showNotification(err.message, 'error');
    }
  }

  async function logoutSession(name) {
    if (!confirm(`Logout session "${name}"? Data session akan dihapus.`)) return;

    try {
      await api(`/sessions/${name}`, { method: 'DELETE' });
      showNotification(`Session "${name}" dihapus`, 'success');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  }

  async function clearLogs() {
    if (!confirm('Hapus semua log OTP?')) return;

    try {
      await api('/otp-logs', { method: 'DELETE' });
      showNotification('Log OTP dihapus', 'success');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  }

  function copyOTP(el, code) {
    navigator.clipboard.writeText(code).then(() => {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1500);
    }).catch(() => {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = code;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1500);
    });
  }

  function copyPairingCode(code) {
    const cleanCode = code.replace('-', '');
    navigator.clipboard.writeText(cleanCode).then(() => {
      showNotification('Pairing code copied!', 'success');
    }).catch(() => {
      showNotification('Gagal copy', 'error');
    });
  }

  function exportOTP() {
    window.open('/api/otp-logs/export', '_blank');
  }

  // ==================== Utilities ====================
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatTimeShort(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }

  function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      padding: 0.75rem 1.25rem;
      background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#3b82f6'};
      color: #fff;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      z-index: 9999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: slideUp 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function playNotificationSound() {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRl9vT19teleXBDAQBAAAA...');
      audio.volume = 0.3;
      audio.play().catch(() => {});
    } catch {}
  }

  function showBrowserNotification(data) {
    if (Notification.permission === 'granted') {
      new Notification(`OTP: ${data.otp}`, {
        body: `${data.app} - ${data.sender}`,
        icon: '📱',
        tag: 'wa-otp',
      });
    }
  }

  function flashTitle(text) {
    const original = document.title;
    document.title = text;
    setTimeout(() => {
      document.title = original;
    }, 5000);
  }

  // ==================== Event Listeners ====================
  function initEventListeners() {
    // Add session
    $('#btnAddSession').addEventListener('click', () => {
      els.addSessionModal.classList.add('show');
      els.sessionNameInput.focus();
    });

    $('#btnCreateSession').addEventListener('click', createSession);
    $('#btnCancelSession').addEventListener('click', () => {
      els.addSessionModal.classList.remove('show');
    });
    $('#btnCloseModal').addEventListener('click', () => {
      els.addSessionModal.classList.remove('show');
    });

    // Pairing modal
    $('#btnClosePairing').addEventListener('click', closePairingModal);
    $('#btnCopyPairingCode').addEventListener('click', () => {
      const code = els.pairingCode.textContent.replace('-', '');
      navigator.clipboard.writeText(code).then(() => {
        showNotification('Pairing code copied!', 'success');
      });
    });

    // Session name input - Enter key
    els.sessionNameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') createSession();
    });

    // OTP actions
    $('#btnClearLogs').addEventListener('click', clearLogs);
    $('#btnRefresh').addEventListener('click', () => {
      api('/sessions').then(data => {
        state.sessions = data.sessions;
        state.maxSessions = data.maxSessions;
        renderSessions();
      });
    });
    $('#btnExport').addEventListener('click', exportOTP);

    // Filter
    els.filterSession.addEventListener('change', renderOTPLogs);

    // Auto-scroll toggle
    $('#toggleAutoScroll').addEventListener('change', (e) => {
      state.autoScroll = e.target.checked;
    });

    // Clear messages
    $('#btnClearMessages').addEventListener('click', () => {
      state.messages = [];
      renderMessages();
    });

    // Logout
    $('#btnLogout').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' });
      localStorage.removeItem('wa_otp_token');
      localStorage.removeItem('wa_otp_user');
      window.location.href = '/login';
    });

    // Close modals on overlay click
    els.addSessionModal.addEventListener('click', (e) => {
      if (e.target === els.addSessionModal) els.addSessionModal.classList.remove('show');
    });
    els.pairingModal.addEventListener('click', (e) => {
      if (e.target === els.pairingModal) closePairingModal();
    });

    // ESC key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        els.addSessionModal.classList.remove('show');
        closePairingModal();
      }
    });

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // ==================== Initialize ====================
  function init() {
    els.userInfo.textContent = state.user;
    initEventListeners();
    connectWS();

    // Load initial OTP logs
    api('/otp-logs?limit=50').then(data => {
      if (data && data.logs) {
        state.otpLogs = data.logs.map(log => ({
          session: log.session_name,
          sender: log.sender,
          otp: log.otp_code,
          app: log.app_name,
          message: log.message,
          timestamp: log.created_at,
        }));
        renderOTPLogs();
      }
    }).catch(() => {});
  }

  // ==================== Global API ====================
  window.app = {
    showPairingModal,
    logoutSession,
    copyOTP,
    copyPairingCode,
  };

  // Start
  init();
})();
