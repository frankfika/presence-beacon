/* 在岗哨 · 员工端 */
(function () {
  'use strict';
  const { api, webauthnRegister, webauthnGet, scanQr, store, fmtMin, el, show, esc } = window.PB;

  let state = {
    bootstrap: null,
    nextAction: 'in',
    employeeId: store.get('employeeId'),
    deviceToken: store.get('deviceToken'),
    pendingSessionId: null,
    stream: null,
    scanner: null,
    rafId: null,
  };

  const $ = (id) => el(id);

  function msg(id, text, kind) {
    const box = $(id);
    if (!box) return;
    box.innerHTML = text ? `<div class="msg ${kind || 'err'}">${esc(text)}</div>` : '';
  }

  /* ── 安全上下文检查 ──
   * 浏览器只在 HTTPS 或 localhost 下启用指纹（WebAuthn）。
   * 用 http://192.168.x.x 打开的话，指纹能力整个不存在，
   * 必须给一句人话提示，而不是让老板以为手机坏了。
   */
  function checkSecureContext() {
    if (window.isSecureContext) return true;
    const banner = document.createElement('div');
    banner.className = 'msg warn';
    banner.style.cssText = 'margin:0 18px 14px';
    banner.innerHTML = '当前不是 <b>HTTPS</b> 环境，浏览器会禁用指纹功能。<br>'
      + '请用 <b>https://</b> 地址打开（局域网部署需要给域名配一张证书），否则只能使用员工码打卡。';
    document.querySelector('.wrap').insertBefore(banner, document.querySelector('.hero').nextSibling);
    const btn = $('btnRegister');
    if (btn) { btn.disabled = true; btn.textContent = '当前环境不支持指纹'; }
    return false;
  }

  /* ── 启动 ── */
  async function boot() {
    checkSecureContext();
    try {
      state.bootstrap = await api('/api/bootstrap');
      store.set('bootstrap', JSON.stringify(state.bootstrap));
      state.offline = false;
    } catch (e) {
      // 断网 / 服务挂了：不要把整个页面换成一行错误 —— 用上次缓存的数据继续显示，
      // 至少让人还能看到自己本周攒了多少小时，并明确标注「离线」
      const cached = store.get('bootstrap');
      if (!cached) {
        document.body.innerHTML = `<div class="wrap"><div class="msg err">连不上服务：${esc(e.message)}<br><br>请检查网络后再打开。</div></div>`;
        return;
      }
      try { state.bootstrap = JSON.parse(cached); } catch { return; }
      state.offline = true;
      showOffline('离线模式：显示的是最后一次同步的数据，暂时不能打卡。');
    }
    const emps = state.bootstrap.employees || [];
    if (!emps.length) {
      $('heroSub').textContent = '还没有员工，请管理员先在后台添加';
      $('setupMsg').innerHTML = '<div class="msg warn">管理员还没有添加任何员工。</div>';
      show('s-setup');
      return;
    }
    const sel = $('selEmp');
    sel.innerHTML = emps.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}${e.seat ? ' · ' + esc(e.seat) : ''}${e.registered ? '（已登记）' : ''}</option>`).join('');

    if (state.employeeId && state.deviceToken) {
      try {
        await loadMe();
        return;
      } catch (e) {
        // 设备令牌失效（清过缓存 / 换过手机）→ 直接把员工送到恢复界面，
        // 而不是甩回「首次激活」让人对着邀请码发呆
        const stale = e.status === 403 || e.status === 404;
        const who = state.lastEmployeeName || '';
        store.del('employeeId');
        store.del('deviceToken');
        state.employeeId = state.deviceToken = null;
        if (stale) {
          $('inpRecName').value = who;
          msg('recoverMsg', '这台手机的激活记录已经失效了（可能清了缓存或换了手机）。重新激活一下就能继续打卡。', 'warn');
          show('s-recover');
          return;
        }
      }
    }
    show('s-setup');
  }

  /* ── 我的状态 ── */
  async function fetchMe() {
    const data = await api(`/api/me?employeeId=${encodeURIComponent(state.employeeId)}&deviceToken=${encodeURIComponent(state.deviceToken)}`);
    store.set('lastMe', JSON.stringify({ at: Date.now(), data }));
    return data;
  }

  /* 离线横幅 */
  function showOffline(text) {
    let b = document.getElementById('offlineBar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'offlineBar';
      b.className = 'msg warn';
      b.style.cssText = 'margin:0 18px 14px';
      document.querySelector('.wrap').insertBefore(b, document.querySelector('.hero').nextSibling);
    }
    b.innerHTML = '⚠️ ' + esc(text);
    b.style.display = '';
  }
  function hideOffline() {
    const b = document.getElementById('offlineBar');
    if (b) b.style.display = 'none';
  }

  function renderMe(data) {
    const emp = data.employee;
    state.lastEmployeeName = emp.name || '';
    $('hAvatar').textContent = (emp.name || '?').slice(0, 1);
    $('hName').textContent = emp.name;
    $('hSub').textContent = `${emp.seat ? emp.seat + ' · ' : ''}目标 ${fmtMin(emp.targetMinutes)} / 周`;

    const w = data.week;
    $('hWeek').textContent = `${fmtMin(w.minutes, 'decimal')} / ${fmtMin(w.effectiveTargetMinutes, 'decimal')} h`;
    const pct = w.effectiveTargetMinutes ? Math.min(100, (w.minutes / w.effectiveTargetMinutes) * 100) : 0;
    const bar = $('hBar');
    bar.style.width = pct + '%';
    bar.classList.toggle('short', !w.met);
    $('hLeft').textContent = w.met ? '本周已达标 🎉' : `还差 ${fmtMin(w.gapMinutes, 'decimal')} h · 剩 ${w.daysLeft} 天`;
    $('hStatus').innerHTML = w.met
      ? '<span class="tag ok">达标</span>'
      : (w.hasTravel ? '<span class="tag warn">含出差</span>' : '<span class="tag warn">未达标</span>');

    const todayKey = new Date(Date.now() + (state.bootstrap.config.timezoneOffsetMinutes || 480) * 60000).toISOString().slice(0, 10);
    const today = w.days.find((d) => d.date === todayKey);
    $('hToday').textContent = today ? `已记录 ${fmtMin(today.minutes, 'decimal')} h` : '今天还没有记录';
    $('hGap').textContent = w.met ? '0 h' : `${fmtMin(w.gapMinutes, 'decimal')} h`;

    // 按钮按当前状态显示「签进 / 签退」——避免员工不知道自己是进还是出
    state.nextAction = data.nextAction || 'in';
    const inOffice = state.nextAction === 'out';
    $('btnCheckin').querySelector('.t').textContent = inOffice ? '签退' : '签进';
    $('btnCheckin').querySelector('.s').textContent = inOffice
      ? '离开时扫一次，把这段时长记上'
      : '扫终端二维码 → 按指纹确认';
    $('btnCheckin').classList.toggle('gray', inOffice);
    return data;
  }

  async function loadMe() {
    let data;
    try {
      data = await fetchMe();
      hideOffline();
      state.offline = false;
    } catch (e) {
      if (state.offline) throw e;
      // 网络临时不通 → 用上次的周报缓存顶一下
      const cached = store.get('lastMe');
      if (!cached) throw e;
      data = JSON.parse(cached).data;
      state.offline = true;
      showOffline('离线模式：显示的是最后一次同步的数据，暂时不能打卡。');
    }
    renderMe(data);
    show('s-home');
  }

  /* ── WebAuthn 错误翻译 ──
   * 浏览器抛的原始错误是给开发者看的（还带一个 W3C 链接），
   * 直接甩给员工等于没说话。翻成一句能行动的中文。
   */
  function friendlyWebauthnError(e, fallback) {
    const name = e && e.name;
    if (name === 'NotAllowedError') {
      return '这台手机上的指纹 / 面容用不了了（可能超时或被拒绝）。'
        + '请改用下面的员工码恢复，或联系管理员重置。';
    }
    if (name === 'InvalidStateError') {
      return '这台手机已经登记过指纹了，不用再登记一次。';
    }
    if (name === 'AbortError') return '验证被中断了，请重新试一次。';
    if (name === 'NotSupportedError') return '这个浏览器不支持指纹验证，请改用员工码。';
    if (name === 'SecurityError') return '当前不是安全环境（HTTPS），浏览器禁用了指纹。请改用员工码。';
    const msg = (e && e.message) || '';
    if (/timed out|not allowed/i.test(msg)) {
      return '指纹验证超时或被拒绝，请再试一次，或改用员工码恢复。';
    }
    return msg || fallback;
  }

  /* ── 注册 ── */
  $('btnRegister').addEventListener('click', async () => {
    msg('setupMsg', '');
    const employeeId = $('selEmp').value;
    const inviteCode = $('inpInvite').value.trim().toUpperCase();
    if (!inviteCode) { msg('setupMsg', '请输入管理员给的 12 位邀请码'); return; }
    if (!window.PB.isWebAuthnAvailable()) { msg('setupMsg', '这个浏览器不支持指纹验证，请改用员工码'); return; }
    const btn = $('btnRegister');
    btn.disabled = true; btn.textContent = '请按指纹…';
    try {
      const opts = await api('/api/auth/register-options', { method: 'POST', body: { employeeId, inviteCode } });
      const resp = await webauthnRegister(opts.options);
      const done = await api('/api/auth/register-verify', {
        method: 'POST', body: { employeeId, inviteCode, challengeId: opts.challengeId, response: resp },
      });
      state.employeeId = done.employeeId;
      state.deviceToken = done.deviceToken;
      store.set('employeeId', state.employeeId);
      store.set('deviceToken', state.deviceToken);
      await loadMe();
    } catch (e) {
      msg('setupMsg', friendlyWebauthnError(e, '注册失败'));
    } finally {
      btn.disabled = false; btn.textContent = '登记指纹 / 面容';
    }
  });

  $('btnUsePin').addEventListener('click', () => { msg('setupMsg', ''); show('s-pin'); });
  $('btnPinBack').addEventListener('click', () => show('s-setup'));

  /* ── 自助恢复 ── */
  $('btnRecover').addEventListener('click', () => { msg('recoverMsg', ''); show('s-recover'); });
  $('btnRecoverBack').addEventListener('click', () => show('s-setup'));

  function saveDevice(employeeId, deviceToken) {
    state.employeeId = employeeId;
    state.deviceToken = deviceToken;
    store.set('employeeId', employeeId);
    store.set('deviceToken', deviceToken);
  }

  $('btnRecoverPin').addEventListener('click', async () => {
    msg('recoverMsg', '');
    const name = $('inpRecName').value.trim();
    const seat = $('inpRecSeat').value.trim();
    const pin = $('inpRecPin').value.trim().toUpperCase();
    if (!name) { msg('recoverMsg', '请填写姓名'); return; }
    if (!pin) { msg('recoverMsg', '请填写员工码'); return; }
    const btn = $('btnRecoverPin');
    btn.disabled = true; btn.textContent = '恢复中…';
    try {
      const r = await api('/api/auth/recover', { method: 'POST', body: { name, seat, pin } });
      saveDevice(r.employeeId, r.deviceToken);
      msg('recoverMsg', r.hint || '已恢复', 'ok');
      await loadMe();
    } catch (e) {
      msg('recoverMsg', e.message || '恢复失败');
    } finally {
      btn.disabled = false; btn.textContent = '用员工码恢复';
    }
  });

  $('btnRecoverBio').addEventListener('click', async () => {
    msg('recoverMsg', '');
    const name = $('inpRecName').value.trim();
    if (!name) { msg('recoverMsg', '请先填写姓名'); return; }
    if (!window.PB.isWebAuthnAvailable()) { msg('recoverMsg', '这个浏览器不支持指纹验证，请改用员工码恢复'); return; }
    const btn = $('btnRecoverBio');
    btn.disabled = true; btn.textContent = '请按指纹…';
    try {
      const opts = await api('/api/auth/assert-options', { method: 'POST', body: { employeeName: name, recover: true } });
      const resp = await webauthnGet(opts.options);
      const done = await api('/api/auth/assert-verify', {
        method: 'POST', body: { challengeId: opts.challengeId, response: resp, recover: true },
      });
      if (!done.deviceToken) throw new Error('这台手机没有登记过指纹，请改用员工码恢复');
      saveDevice(done.employeeId || state.employeeId, done.deviceToken);
      msg('recoverMsg', '指纹验证通过，已恢复。', 'ok');
      await loadMe();
    } catch (e) {
      msg('recoverMsg', friendlyWebauthnError(e, '指纹恢复失败'));
    } finally {
      btn.disabled = false; btn.textContent = '用指纹恢复';
    }
  });

  /* 首页「补卡 / 请假 / 出差 ›」这一行也要能点 */
  const rowBtn = $('btnExceptionRow');
  if (rowBtn) rowBtn.addEventListener('click', () => $('btnException').click());

  /* ── 打卡：扫码 ── */
  $('btnCheckin').addEventListener('click', startScan);
  $('btnBackScan').addEventListener('click', stopScan);
  $('btnBackScan').addEventListener('click', () => show('s-home'));

  async function startScan() {
    msg('scanMsg', '');
    show('s-scan');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg('scanMsg', '这个浏览器没有摄像头权限，请用下面的手动输入码', 'warn');
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
    } catch (e) {
      msg('scanMsg', '打不开摄像头（' + e.name + '）。可以手动输入终端上的 8 位码。', 'warn');
      return;
    }
    const video = $('video');
    video.srcObject = state.stream;
    video.setAttribute('playsinline', '');
    try { await video.play(); } catch { /* 忽略 */ }

    state.scanner = await scanQr(video, (p) => {
      stopScan();
      doCheckin(p.sessionId);
    });
    if (!state.scanner) {
      msg('scanMsg', '这个浏览器没有二维码识别能力，请手动输入码', 'warn');
      return;
    }
    const loop = async () => {
      if (!state.scanner) return;
      const found = await state.scanner.tick();
      if (found) return;
      state.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopScan() {
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    state.scanner = null;
    const v = $('video');
    if (v) v.srcObject = null;
  }

  $('btnManual').addEventListener('click', () => {
    const code = $('inpCode').value.trim().toUpperCase();
    if (!code) { msg('scanMsg', '请输入终端上显示的 8 位码'); return; }
    stopScan();
    doCheckin(code);
  });

  /* ── 打卡：指纹 + 落库 ── */
  async function doCheckin(sessionId) {
    state.pendingSessionId = sessionId;
    const action = state.nextAction;
    show('s-bio');
    try {
      const opts = await api('/api/auth/assert-options', {
        method: 'POST',
        body: { employeeId: state.employeeId, deviceToken: state.deviceToken, sessionId, action },
      });
      // 刚刚已经打过卡了 → 不用再按指纹
      if (opts.duplicate) {
        $('doneTitle').textContent = '刚刚已经打过卡了';
        $('doneSub').innerHTML = `上一次记录时间 ${new Date(opts.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}<br>没有重复记录`;
        show('s-done');
        await fetchMe().then(renderMe).catch(() => {});
        return;
      }
      const resp = await webauthnGet(opts.options);
      const done = await api('/api/auth/assert-verify', {
        method: 'POST',
        body: {
          employeeId: state.employeeId, deviceToken: state.deviceToken,
          sessionId, challengeId: opts.challengeId, response: resp, action,
        },
      });
      const w = done.week;
      $('doneTitle').textContent = done.kind === 'in' ? '已签进' : '已签退';
      $('doneSub').innerHTML = `${new Date(done.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${done.kind === 'in' ? '签进' : '签出'}<br>本周 ${fmtMin(w.minutes, 'decimal')} / ${fmtMin(w.targetMinutes, 'decimal')} h${w.met ? ' · 已达标' : ` · 还差 ${fmtMin(w.gapMinutes, 'decimal')} h`}`;
      show('s-done');
      await fetchMe().then(renderMe).catch(() => {});
    } catch (e) {
      show('s-home');
      msg('hStatus', '');
      const box = document.createElement('div');
      box.className = 'msg err';
      box.textContent = e.message || '打卡失败';
      $('s-home').prepend(box);
    } finally {
      state.pendingSessionId = null;
    }
  }

  $('btnDoneBack').addEventListener('click', () => loadMe().catch(() => show('s-home')));

  /* ── PIN 兜底 ── */
  $('btnPinGo').addEventListener('click', async () => {
    msg('pinMsg', '');
    const pin = $('inpPin').value.trim().toUpperCase();
    if (!pin) { msg('pinMsg', '请输入 8 位员工码'); return; }
    const sid = state.pendingSessionId || null;
    try {
      const done = await api('/api/checkin/pin', {
        method: 'POST',
        body: { employeeId: state.employeeId, pin, sessionId: sid, action: state.nextAction },
      });
      $('doneTitle').textContent = done.kind === 'in' ? '已签进' : '已签退';
      $('doneSub').innerHTML = `${new Date(done.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 员工码打卡（弱验证）<br>本周 ${fmtMin(done.week.minutes, 'decimal')} / ${fmtMin(done.week.targetMinutes, 'decimal')} h`;
      show('s-done');
      await fetchMe().then(renderMe).catch(() => {});
    } catch (e) {
      msg('pinMsg', e.message || '打卡失败');
    }
  });

  /* ── 申请 ── */
  $('btnException').addEventListener('click', () => {
    msg('excMsg', '');
    $('excDate').value = new Date(Date.now() + (state.bootstrap.config.timezoneOffsetMinutes || 480) * 60000).toISOString().slice(0, 10);
    show('s-exception');
  });
  $('btnExcBack').addEventListener('click', () => show('s-home'));
  $('btnExcSubmit').addEventListener('click', async () => {
    msg('excMsg', '');
    try {
      await api('/api/exceptions', {
        method: 'POST',
        body: {
          employeeId: state.employeeId, deviceToken: state.deviceToken,
          type: $('excType').value,
          date: $('excDate').value,
          minutes: Math.round(Number($('excHours').value || 0) * 60),
          note: $('excNote').value,
        },
      });
      msg('excMsg', '已提交，等管理员审批', 'ok');
      $('excNote').value = '';
    } catch (e) {
      msg('excMsg', e.message || '提交失败');
    }
  });

  /* ── 退出 ── */
  $('btnLogout').addEventListener('click', () => {
    store.del('employeeId');
    store.del('deviceToken');
    state.employeeId = state.deviceToken = null;
    show('s-setup');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  boot();
})();
