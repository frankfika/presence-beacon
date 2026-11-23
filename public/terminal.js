/* 在岗哨 · 终端（kiosk） */
(function () {
  'use strict';
  const { api, fmtMin, esc } = window.PB;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const tid = params.get('tid');
  const key = params.get('key');
  const H = { 'x-terminal-key': key || '' };

  let ttl = 45;
  let sessionId = null;
  let sessionExpiresAt = 0;
  let lastEventId = null;
  const loadedAt = Date.now();   // 页面打开时刻：只闪「打开之后才发生」的事件
  let lastState = null;
  let fatal = false;    // 密钥无效 → 停止轮询
  let backoffMs = 1000; // 失败退避，上限 30s

  if (!tid || !key) {
    document.body.innerHTML = '<div class="term"><div class="mid"><div><h1>缺少终端参数</h1><p style="color:#9aa0aa">请用管理员后台给出的终端链接打开本页。<br>格式：/terminal.html?tid=…&amp;key=…</p></div></div></div>';
    return;
  }

  /* 终端密钥无效 → 这不是「离线」，是配置错了，直接停掉并说清楚 */
  function failHard(msg) {
    fatal = true;
    $('qrHolder').textContent = '—';
    $('qrState').innerHTML = `<b style="color:#e0708a">${esc(msg)}</b>`;
    $('footLeft').textContent = '终端未授权';
    $('people').innerHTML = '<span class="person away">终端未授权</span>';
  }

  /* ── 时钟 ── */
  function tickClock() {
    const now = new Date();
    $('clock').textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    $('date').textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${wd}`;
  }
  setInterval(tickClock, 1000);
  tickClock();

  /* ── 二维码 ── */
  async function newSession() {
    if (fatal) return;
    try {
      const s = await api(`/api/terminal/${tid}/session`, { method: 'POST', headers: H });
      sessionId = s.sessionId;
      sessionExpiresAt = s.expiresAt;
      ttl = s.ttlSeconds;
      backoffMs = 1000;
      const svg = await fetch(`/api/terminal/${tid}/qr.svg?session=${encodeURIComponent(sessionId)}&v=${Date.now()}`, { headers: H });
      $('qrHolder').innerHTML = await svg.text();
      $('qrCode').textContent = sessionId;
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        failHard('终端密钥无效，请让管理员重新生成终端链接');
        return;
      }
      if (e.status === 404) {
        failHard('终端不存在或已被删除');
        return;
      }
      $('qrHolder').textContent = '离线';
      $('qrState').innerHTML = `<b style="color:#e0708a">终端离线：${esc(e.message)}</b>`;
      backoffMs = Math.min(30000, backoffMs * 2);   // 退避，别疯狂重试
      sessionExpiresAt = Date.now() + backoffMs;
    }
  }

  setInterval(async () => {
    const left = Math.max(0, Math.round((sessionExpiresAt - Date.now()) / 1000));
    $('qrTtl').textContent = left;
    if (left <= 0) await newSession();
  }, 500);

  /* ── 状态轮询 ── */
  async function poll() {
    try {
      const st = await api(`/api/terminal/${tid}/state`, { headers: H });
      lastState = st;
      $('sPresent').innerHTML = `${st.present.length} <small>/ ${st.totalPeople} 人</small>`;
      $('sTeam').innerHTML = `${fmtMin(st.teamMinutes, 'decimal')} <small>h</small>`;
      $('people').innerHTML = st.present.length
        ? st.present.map((p) => `<span class="person"><span class="dot"></span>${esc(p.name)}<span class="t">${new Date(p.since).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></span>`).join('')
        : '<span class="person away">今天还没有人签到</span>';
      $('footRight').textContent = `${st.totalPeople} 人 · ${st.present.length} 人在场`;
      $('iName').textContent = $('termName').textContent;
      $('iLoc').textContent = $('termLoc').textContent;
      $('iTtl').textContent = ttl + ' 秒';
      $('iPresent').textContent = `${st.present.length} / ${st.totalPeople} 人`;
      $('iTeam').textContent = fmtMin(st.teamMinutes, 'decimal') + ' h';

      // 有新事件 → 闪屏提示。
      // 用「事件 id + 发生时间」判断：条数有 10 条上限（只看条数会漏），
      // 而且只闪页面打开之后才发生的事件（重开页面不会重播旧闪屏）。
      const last = st.recent[st.recent.length - 1];
      if (last && last.id !== lastEventId) {
        if (last.ts > loadedAt) flash(last);   // 只闪页面打开之后才发生的事件
        lastEventId = last.id;
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        failHard('终端密钥无效，请让管理员重新生成终端链接');
        return;
      }
      if (e.status === 404) {
        failHard('终端不存在或已被删除');
        return;
      }
      $('footLeft').textContent = '终端离线';
    }
  }

  let flashTimer = null;
  async function flash(ev) {
    $('flashName').textContent = ev.name;
    $('flashSub').innerHTML = ev.kind === 'in'
      ? '已签进 · 请记得离开时再扫一次'
      : '已签退 · 辛苦啦';
    $('flash').classList.add('on');
    // 必须先清掉上一次的定时器：否则上一次 flash 的 setTimeout
    // 会在新闪屏刚亮起时把它关掉（连续打卡时表现为「闪一下就没了」）
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { $('flash').classList.remove('on'); flashTimer = null; }, 3000);
  }

  /* ── 长按二维码 → 终端信息 ── */
  let pressTimer = null;
  const frame = $('qrFrame');
  const startPress = () => {
    pressTimer = setTimeout(() => { $('sheet').classList.add('on'); pressTimer = null; }, 1200);
  };
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  frame.addEventListener('touchstart', startPress, { passive: true });
  frame.addEventListener('touchend', cancelPress);
  frame.addEventListener('mousedown', startPress);
  frame.addEventListener('mouseup', cancelPress);
  frame.addEventListener('mouseleave', cancelPress);
  $('iClose').addEventListener('click', () => $('sheet').classList.remove('on'));

  /* ── 启动 ── */
  (async () => {
    await newSession();
    await poll();
    setInterval(poll, 3000);
  })();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
