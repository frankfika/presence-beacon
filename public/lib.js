/* 在岗哨 · 前端公共库 */
(function (global) {
  'use strict';

  /* ── base64url ── */
  function b64urlToBuf(s) {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  function bufToB64url(buf) {
    let s = '';
    const arr = new Uint8Array(buf);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ── API ── */
  const API_TIMEOUT_MS = 20000;
  async function api(path, opts = {}) {
    const init = {
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
      // 服务端卡住 / 网络抖动时不能无限等 —— 超时要变成一句人话，
      // 否则按钮会一直停在「请按指纹…」且没有任何提示
      signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || API_TIMEOUT_MS),
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.token) init.headers['x-admin-token'] = opts.token;
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        const err = new Error('网络太慢了，请检查 Wi-Fi 后重试');
        err.name = 'TimeoutError';
        throw err;
      }
      throw e;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data.error || ('请求失败 ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ── WebAuthn 浏览器端 ── */
  function isWebAuthnAvailable() {
    return !!(global.PublicKeyCredential && global.navigator.credentials);
  }
  function isPlatformAuth() {
    return !!(global.PublicKeyCredential && global.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable);
  }

  async function webauthnRegister(optionsJson) {
    const o = optionsJson.options || optionsJson;
    const cred = await navigator.credentials.create({
      publicKey: {
        ...o,
        challenge: b64urlToBuf(o.challenge),
        user: { ...o.user, id: b64urlToBuf(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
      },
    });
    if (!cred) throw new Error('取消了注册');
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
      },
      transports: cred.response.getTransports ? cred.response.getTransports() : undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
    };
  }

  async function webauthnGet(optionsJson) {
    const o = optionsJson.options || optionsJson;
    const cred = await navigator.credentials.get({
      publicKey: {
        ...o,
        challenge: b64urlToBuf(o.challenge),
        allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
      },
    });
    if (!cred) throw new Error('取消了验证');
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        signature: bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
      },
      clientExtensionResults: cred.getClientExtensionResults(),
    };
  }

  /* ── 二维码扫描：BarcodeDetector 优先，jsQR 兜底 ── */
  function parsePayload(text) {
    if (!text) return null;
    const t = text.trim();
    const m = t.match(/^PB1:([A-Z0-9]{8,32})$/i);
    if (m) return { sessionId: m[1].toUpperCase() };
    if (/^[A-Z0-9]{8,32}$/i.test(t)) return { sessionId: t.toUpperCase() };
    return null;
  }

  async function scanQr(video, onFound) {
    if ('BarcodeDetector' in global) {
      const det = new global.BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        try {
          const codes = await det.detect(video);
          for (const c of codes) {
            const parsed = parsePayload(c.rawValue);
            if (parsed) { onFound(parsed); return true; }
          }
        } catch { /* 忽略单帧错误 */ }
        return false;
      };
      return { tick, stop: () => {} };
    }
    if (global.jsQR) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (!video.videoWidth) return false;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = global.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code) {
          const parsed = parsePayload(code.data);
          if (parsed) { onFound(parsed); return true; }
        }
        return false;
      };
      return { tick, stop: () => {} };
    }
    return null;
  }

  /* ── 本地存储 ── */
  const store = {
    get(k) { try { return localStorage.getItem('pb.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('pb.' + k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem('pb.' + k); } catch { /* ignore */ } },
  };

  function fmtMin(minutes, style) {
    const m = Math.round(minutes);
    if (style === 'decimal') return (m / 60).toFixed(1);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h === 0) return mm + 'm';
    if (mm === 0) return h + 'h';
    return h + 'h' + String(mm).padStart(2, '0') + 'm';
  }

  function el(id) { return document.getElementById(id); }
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
    const t = el(id);
    if (t) t.classList.add('on');
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.PB = { api, b64urlToBuf, bufToB64url, webauthnRegister, webauthnGet, scanQr, parsePayload, store, fmtMin, el, show, esc, isWebAuthnAvailable, isPlatformAuth };
})(window);
