'use strict';

/* Shared helpers for every TempoQuiz screen. Loaded as a plain script, no
   build step, so the app can be started with `npm start` and nothing else. */

const TQ = (() => {
  const CSRF_KEY = 'tq.csrf';

  // --- DOM ------------------------------------------------------------------

  /**
   * Builds an element. Text is always set through textContent, so quiz text,
   * nicknames and topics can never be interpreted as markup.
   */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function show(node, visible = true) {
    if (node) node.classList.toggle('hidden', !visible);
  }

  // --- API ------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  function csrf() {
    try {
      return sessionStorage.getItem(CSRF_KEY) || '';
    } catch {
      return '';
    }
  }

  function setCsrf(token) {
    try {
      if (token) sessionStorage.setItem(CSRF_KEY, token);
      else sessionStorage.removeItem(CSRF_KEY);
    } catch {
      /* private browsing with storage disabled */
    }
  }

  async function api(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
    const token = csrf();
    if (token) headers['x-csrf-token'] = token;
    // Free ngrok tunnels serve an interstitial to browsers; this header opts
    // the XHR out of it so we get JSON back rather than an HTML warning page.
    headers['ngrok-skip-browser-warning'] = 'true';

    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server. Check your connection.');
    }

    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      const text = await response.text();
      if (!response.ok) throw new ApiError(response.status, text.slice(0, 200) || response.statusText);
      return text;
    }

    const data = await response.json();
    if (!response.ok) {
      throw new ApiError(response.status, data.error || response.statusText, data.details);
    }
    return data;
  }

  const get = (path, headers) => api('GET', path, undefined, headers);
  const post = (path, body, headers) => api('POST', path, body ?? {}, headers);
  const patch = (path, body) => api('PATCH', path, body ?? {});
  const del = (path) => api('DELETE', path);

  /** Downloads an export, keeping the host token out of the URL. */
  async function download(path, body, fallbackName) {
    const headers = { 'content-type': 'application/json', 'ngrok-skip-browser-warning': 'true' };
    const token = csrf();
    if (token) headers['x-csrf-token'] = token;
    const response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = (await response.json()).error || message;
      } catch { /* not JSON */ }
      throw new ApiError(response.status, message);
    }
    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: match ? match[1] : fallbackName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- toasts ---------------------------------------------------------------

  function toastHost() {
    let host = $('.toasts');
    if (!host) {
      host = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(host);
    }
    return host;
  }

  function toast(message, kind = '', ms = 4200) {
    const node = el('div', { class: `toast${kind ? ` toast--${kind}` : ''}`, text: message });
    toastHost().append(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .25s';
      setTimeout(() => node.remove(), 260);
    }, ms);
    return node;
  }

  const fail = (error) => toast(error && error.message ? error.message : String(error), 'error', 6000);

  // --- polling --------------------------------------------------------------

  /**
   * Repeatedly calls fn on an interval. On failure the delay backs off up to
   * eight times the base, so a phone that loses signal mid-quiz does not
   * hammer the server, and recovers immediately once a call succeeds.
   */
  function poll(fn, baseMs = 1000) {
    let stopped = false;
    let delay = baseMs;
    let timer = null;

    async function tick() {
      if (stopped) return;
      try {
        await fn();
        delay = baseMs;
      } catch (error) {
        delay = Math.min(delay * 2, baseMs * 8);
        // A network blip is expected and backs off quietly, but a genuine bug
        // in the render path would otherwise vanish here and look like the
        // page had simply frozen. Surface it.
        if (!error || typeof error.status !== 'number') {
          console.error('[poll] update failed:', error);
        }
        if (error && error.status === 403) {
          // The session or player token is gone; retrying cannot fix it.
          stopped = true;
          throw error;
        }
      }
      if (!stopped) timer = setTimeout(tick, delay);
    }

    tick();
    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      now() {
        if (timer) clearTimeout(timer);
        tick();
      },
    };
  }

  // --- formatting -----------------------------------------------------------

  function seconds(value) {
    const total = Math.max(0, Math.ceil(value));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : String(s);
  }

  function dateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function dateOnly(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const letter = (index) => String.fromCharCode(65 + index);

  function bytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // --- clock sync -----------------------------------------------------------

  /**
   * Tracks the offset between this device's clock and the server's, so a phone
   * set to the wrong time still shows the same countdown as everyone else.
   */
  const clock = {
    offset: 0,
    sync(serverTimeIso) {
      if (!serverTimeIso) return;
      const server = new Date(serverTimeIso).getTime();
      if (Number.isNaN(server)) return;
      this.offset = server - Date.now();
    },
    now() {
      return Date.now() + this.offset;
    },
  };

  // --- session storage ------------------------------------------------------

  const store = {
    get(key, fallback = null) {
      try {
        const raw = sessionStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(key, JSON.stringify(value));
      } catch { /* storage unavailable */ }
    },
    remove(key) {
      try {
        sessionStorage.removeItem(key);
      } catch { /* storage unavailable */ }
    },
    // Nickname is remembered across sessions; the student ID deliberately is not.
    getLocal(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    setLocal(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch { /* storage unavailable */ }
    },
  };

  return {
    el, $, $$, clear, show,
    api, get, post, patch, del, download, ApiError,
    csrf, setCsrf,
    toast, fail,
    poll,
    seconds, dateTime, dateOnly, letter, bytes,
    clock, store,
  };
})();
