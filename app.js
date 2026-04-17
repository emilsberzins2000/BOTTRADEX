const API_BASE = (() => {
  const saved = localStorage.getItem('bottradex_api_base');
  if (saved && /^https?:\/\//i.test(saved)) return saved.replace(/\/+$/, '');

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000';
  }

  return 'https://bottradex-backendv1.onrender.com';
})();

function setApiBase(url) {
  if (!url) return;
  localStorage.setItem('bottradex_api_base', String(url).trim().replace(/\/+$/, ''));
}

function getApiBase() {
  return (localStorage.getItem('bottradex_api_base') || API_BASE).replace(/\/+$/, '');
}

function getToken() {
  return localStorage.getItem('token') || '';
}

function setToken(token) {
  if (!token) {
    localStorage.removeItem('token');
    return;
  }
  localStorage.setItem('token', token);
}

function clearToken() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

function setUser(user) {
  if (!user) {
    localStorage.removeItem('user');
    return;
  }
  localStorage.setItem('user', JSON.stringify(user));
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setHTML(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = value;
}

function money(value, currency = 'EUR') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '€--';

  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
      minimumFractionDigits: num >= 1000 ? 0 : 2,
      maximumFractionDigits: num >= 1000 ? 0 : 2
    }).format(num);
  } catch {
    return `€${num.toFixed(2)}`;
  }
}

function pct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

function num(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, options = {}, retry = 1) {
  const base = getApiBase();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  const token = getToken();
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers,
      cache: 'no-store'
    });
  } catch (err) {
    if (retry > 0) {
      await sleep(1500);
      return api(path, options, retry - 1);
    }
    throw new Error(`Cannot reach backend at ${base}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let payload = null;

  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    try {
      payload = await response.text();
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      (payload && payload.message) ||
      (payload && payload.error) ||
      (typeof payload === 'string' && payload) ||
      `Request failed: ${response.status}`;

    if ((response.status >= 500 || response.status === 429) && retry > 0) {
      await sleep(1500);
      return api(path, options, retry - 1);
    }

    throw new Error(message);
  }

  return payload;
}

async function authRequest(path, body) {
  const data = await api(path, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (data?.token) setToken(data.token);
  if (data?.user) setUser(data.user);

  return data;
}

async function login(email, password) {
  return authRequest('/api/auth/login', { email, password });
}

async function register(username, email, password) {
  return authRequest('/api/auth/register', { username, email, password });
}

function logout(redirect = true) {
  clearToken();
  if (redirect) {
    window.location.href = 'login.html';
  }
}

function navActive() {
  const links = document.querySelectorAll('.nav-links a');
  const current = window.location.pathname.split('/').pop() || 'index.html';

  links.forEach((link) => {
    const href = link.getAttribute('href');
    if (href === current) {
      link.classList.add('active');
    }
  });

  const navAuth = document.getElementById('nav-auth');
  if (!navAuth) return;

  const user = getUser();
  if (user) {
    navAuth.textContent = 'Logout';
    navAuth.onclick = () => logout(true);
  } else {
    navAuth.textContent = 'Login';
    navAuth.onclick = () => {
      window.location.href = 'login.html';
    };
  }
}

function appendEvent(message, type = 'event') {
  const eventList = document.getElementById('event-list');
  if (!eventList) return;

  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `<strong>${type}</strong><div class="muted small">${new Date().toLocaleTimeString()} · ${message}</div>`;
  eventList.prepend(div);

  while (eventList.children.length > 6) {
    eventList.removeChild(eventList.lastChild);
  }
}

function connectSocket(onMessage) {
  const base = getApiBase();
  if (!base) return null;

  let socketUrl;
  try {
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    socketUrl = url.toString();
  } catch {
    return null;
  }

  let ws;
  let reconnectTimer = null;

  function start() {
    try {
      ws = new WebSocket(socketUrl);
    } catch {
      appendEvent('WebSocket could not start.', 'socket');
      return null;
    }

    ws.addEventListener('open', () => {
      appendEvent('Connected to live updates.', 'socket');
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (typeof onMessage === 'function') onMessage(msg);
      } catch {
        if (typeof onMessage === 'function') {
          onMessage({ type: 'raw', data: event.data });
        }
      }
    });

    ws.addEventListener('close', () => {
      appendEvent('Live connection closed. Retrying soon.', 'socket');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(start, 4000);
    });

    ws.addEventListener('error', () => {
      appendEvent('Live connection error.', 'socket');
    });

    return ws;
  }

  return start();
}

function startKeepAlive() {
  let interval = null;

  async function ping() {
    try {
      await fetch(`${getApiBase()}/api/health`, {
        method: 'GET',
        cache: 'no-store'
      });
    } catch {}
  }

  function begin() {
    if (interval) return;
    ping();
    interval = setInterval(ping, 5000);
  }

  function stop() {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
    } else {
      begin();
    }
  });

  begin();
}

window.API_BASE = API_BASE;
window.setApiBase = setApiBase;
window.getApiBase = getApiBase;
window.getToken = getToken;
window.setToken = setToken;
window.clearToken = clearToken;
window.getUser = getUser;
window.setUser = setUser;
window.setText = setText;
window.setHTML = setHTML;
window.money = money;
window.pct = pct;
window.num = num;
window.qs = qs;
window.sleep = sleep;
window.api = api;
window.login = login;
window.register = register;
window.logout = logout;
window.navActive = navActive;
window.appendEvent = appendEvent;
window.connectSocket = connectSocket;
window.startKeepAlive = startKeepAlive;

startKeepAlive();
