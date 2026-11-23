/* 在岗哨 · 管理端 */
(function () {
  'use strict';
  const { api, fmtMin, esc, el, show } = window.PB;
  const $ = (id) => el(id);

  let token = localStorage.getItem('pb.adminToken') || null;
  let view = null;
  let weekKey = null;

  const EXC_LABEL = { leave: '请假', travel: '出差', adjust: '补卡', holiday: '节假日' };
  const STATUS_LABEL = { pending: '待审批', approved: '已批准', rejected: '已拒绝' };

  // html=true 时按 HTML 插入（调用方自行保证用户数据已转义）
  function msg(id, text, kind, html) {
    const box = $(id);
    if (!box) return;
    if (!text) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="msg ${kind || 'err'}">${html ? text : esc(text)}</div>`;
  }

  function currentWeek() {
    const off = (view && view.config.timezoneOffsetMinutes) || 480;
    const now = new Date(Date.now() + off * 60000);
    const wd = now.getUTCDay();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((wd - 1 + 7) % 7) * 86400000);
    return start.toISOString().slice(0, 10);
  }

  function shiftWeek(key, delta) {
    const d = new Date(key + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta * 7);
    return d.toISOString().slice(0, 10);
  }

  /* ── 登录 ── */
  $('btnLogin').addEventListener('click', async () => {
    msg('loginMsg', '');
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { password: $('admPass').value } });
      token = r.token;
      localStorage.setItem('pb.adminToken', token);
      await load();
    } catch (e) {
      msg('loginMsg', e.message || '登录失败');
    }
  });
  $('btnLogout').addEventListener('click', () => {
    localStorage.removeItem('pb.adminToken');
    token = null;
    show('s-login');
  });

  /* ── 加载 ── */
  async function load() {
    if (!token) { show('s-login'); return; }
    try {
      view = await api(`/api/admin/overview?week=${weekKey || ''}`, { token });
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem('pb.adminToken'); token = null; show('s-login'); return; }
      msg('loginMsg', e.message);
      return;
    }
    weekKey = view.week.weekStart;
    $('btnLogout').style.display = '';
    show('s-main');
    renderWeek();
    renderPeople();
    renderTerminals();
    renderRequests();
    renderSettings();
  }

  /* ── 周报 ── */
  function renderWeek() {
    const w = view.week;
    $('weekLabel').textContent = `${weekKey} 起的一周`;
    $('weekTitle').textContent = `在岗时长 · ${weekKey} ~ ${addDays(weekKey, 6)}`;

    const max = Math.max(30, ...w.rows.map((r) => r.effectiveTargetMinutes / 60));
    const goalPct = ((24 / max) * 100).toFixed(1);
    $('bench').innerHTML = w.rows.map((r) => {
      const h = r.minutes / 60;
      const pct = Math.min(100, (h / max) * 100);
      const cls = r.hasTravel ? 'exc' : (r.met ? '' : 'short');
      const goalLeft = Math.min(100, (r.effectiveTargetMinutes / 60 / max) * 100);
      return `<div class="bench">
        <span>${esc(r.name)}</span>
        <div class="barbg"><i class="${cls}" style="width:${pct}%"></i><span class="goal" style="left:${goalLeft}%"></span></div>
        <span class="val">${h.toFixed(1)} / ${(r.effectiveTargetMinutes / 60).toFixed(1)} h</span>
      </div>`;
    }).join('') || '<p style="color:var(--ink-3);font-size:13px">还没有员工</p>';

    const met = w.rows.filter((r) => r.met).length;
    $('teamSum').innerHTML = `
      <div class="row"><span>达标人数</span><span>${met} / ${w.rows.length}</span></div>
      <div class="row"><span>团队在岗合计</span><span>${fmtMin(w.teamMinutes, 'decimal')} h</span></div>
      <div class="row"><span>团队目标合计</span><span>${fmtMin(w.teamTargetMinutes, 'decimal')} h</span></div>
      <div class="row"><span>未达标</span><span>${w.rows.filter((r) => !r.met && !r.hasTravel).map((r) => esc(r.name)).join('、') || '—'}</span></div>`;

    const days = [...new Set(w.rows.flatMap((r) => r.days.map((d) => d.date)))].sort();
    $('dayDetail').innerHTML = days.length ? `<table class="tbl"><thead><tr><th>日期</th>${w.rows.map((r) => `<th>${esc(r.name)}</th>`).join('')}</tr></thead><tbody>${days.map((d) => `<tr><td>${d.slice(5)}</td>${w.rows.map((r) => {
        const day = r.days.find((x) => x.date === d);
        return `<td>${day ? (day.minutes / 60).toFixed(1) + 'h' : '—'}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>` : '<p style="color:var(--ink-3);font-size:13px">本周还没有记录</p>';
  }

  function addDays(key, n) {
    const d = new Date(key + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  $('btnPrevWeek').addEventListener('click', () => { weekKey = shiftWeek(weekKey, -1); load(); });
  $('btnNextWeek').addEventListener('click', () => { weekKey = shiftWeek(weekKey, 1); load(); });
  $('btnExport').addEventListener('click', async () => {
    // 导出接口需要管理员 token 头，<a href> 直连拿不到 → 用 fetch 取 blob 再触发下载
    try {
      const res = await fetch(`/api/admin/export.csv?week=${encodeURIComponent(weekKey)}`, {
        headers: { 'x-admin-token': token },
      });
      if (!res.ok) {
        const t = await res.text();
        let msg = '导出失败 ' + res.status;
        try { msg = JSON.parse(t).error || msg; } catch { /* 非 JSON 响应 */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance-${weekKey}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(e.message || '导出失败');
    }
  });

  /* ── 员工 ── */
  function renderPeople() {
    $('empList').innerHTML = `<table class="tbl"><thead><tr><th>姓名</th><th>工位</th><th>目标</th><th>状态</th><th>操作</th></tr></thead><tbody>${
      view.employees.map((e) => `<tr>
        <td><strong>${esc(e.name)}</strong></td>
        <td>${esc(e.seat || '—')}</td>
        <td><input type="number" min="0" max="80" step="1" value="${Math.round(e.targetMinutes / 60)}" data-t="${esc(e.id)}" aria-label="${esc(e.name)} 每周目标小时数" style="width:92px;min-height:44px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:14px"> h</td>
        <td>${e.registered ? '<span class="tag ok">已登记指纹</span>' : '<span class="tag warn">未登记</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost inline" data-invite="${esc(e.id)}">重置邀请码</button>
          <button class="btn sm ghost inline" data-del="${esc(e.id)}">删除</button>
        </td></tr>`).join('')
    }</tbody></table>`;

    $('empList').querySelectorAll('[data-invite]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/api/admin/employees/${b.dataset.invite}/invite`, { method: 'POST', token });
      alert(`新的邀请码：${r.inviteCode}\n告诉员工，让他在手机上输入这个码完成登记。`);
      load();
    }));
    $('empList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('离职这个员工？\n\n会停用其打卡权限并清除指纹/邀请码，\n但历史打卡时长会保留在周报里。')) return;
      await api(`/api/admin/employees/${b.dataset.del}`, { method: 'DELETE', token });
      load();
    }));
    $('empList').querySelectorAll('[data-t]').forEach((inp) => inp.addEventListener('change', async () => {
      await api(`/api/admin/employees/${inp.dataset.t}`, { method: 'PATCH', token, body: { targetMinutes: Number(inp.value) * 60 } });
      load();
    }));
  }

  $('btnAddEmp').addEventListener('click', async () => {
    msg('npMsg', '');
    const name = $('npName').value.trim();
    if (!name) { msg('npMsg', '请填写姓名'); return; }
    try {
      const r = await api('/api/admin/employees', {
        method: 'POST', token,
        body: { name, seat: $('npSeat').value.trim(), targetMinutes: Number($('npTarget').value) * 60 },
      });
      msg('npMsg', `已添加。邀请码：<strong>${esc(r.inviteCode)}</strong>　员工码：<strong>${esc(r.pin)}</strong>（员工码是指纹不可用时的兜底）`, 'ok', true);
      $('npName').value = ''; $('npSeat').value = '';
      load();
    } catch (e) { msg('npMsg', e.message); }
  });

  /* ── 终端 ── */
  function renderTerminals() {
    $('termList').innerHTML = view.terminals.length ? view.terminals.map((t) => {
      const off = t.active === 0;
      const seen = t.lastSeen
        ? new Date(t.lastSeen).toLocaleString('zh-CN', { hour12: false })
        : '从未上线';
      const offline = t.offlineMinutes !== null && t.offlineMinutes > 120;
      return `<div style="border-bottom:1px solid var(--line);padding:12px 0">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div>
            <strong>${esc(t.name)}</strong>
            <span style="color:var(--ink-3);font-size:12.5px">${esc(t.location || '')}</span>
            ${off ? '<span class="tag bad" style="margin-left:6px">已停用</span>' : ''}
            ${offline ? '<span class="tag warn" style="margin-left:6px">离线超过 2 小时</span>' : ''}
            <div style="font-size:11.5px;color:var(--ink-3);margin-top:3px">最后上线：${esc(seen)}${t.secretHint ? ' · 密钥尾号 ' + esc(t.secretHint) : ''}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn sm ghost inline" data-reset="${esc(t.id)}">重置密钥 / 看链接</button>
            <button class="btn sm ghost inline" data-toggle="${esc(t.id)}" data-active="${t.active}">${t.active ? '停用' : '启用'}</button>
          </div>
        </div>
      </div>`;
    }).join('') : '<p style="color:var(--ink-3);font-size:13px">还没有终端</p>';

    $('termList').querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('重置后，旧链接会立刻失效，需要用新链接重新打开终端页面。继续？')) return;
      const r = await api(`/api/admin/terminals/${b.dataset.reset}/reset-secret`, { method: 'POST', token });
      const t = view.terminals.find((x) => x.id === b.dataset.reset);
      const url = `${location.origin}/terminal.html?tid=${r.terminal.id}&key=${r.secret}`;
      prompt('复制下面这条链接，在旧安卓机的浏览器里打开（建议加书签并锁定全屏）：\n\n' + url);
      load();
    }));

    $('termList').querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/admin/terminals/${b.dataset.toggle}`, {
        method: 'PATCH', token, body: { active: b.dataset.active !== '1' },
      });
      load();
    }));
  }

  $('btnAddTerm').addEventListener('click', async () => {
    msg('ntMsg', '');
    const name = $('ntName').value.trim();
    if (!name) { msg('ntMsg', '请填写终端名称'); return; }
    try {
      const r = await api('/api/admin/terminals', { method: 'POST', token, body: { name, location: $('ntLoc').value.trim() } });
      const url = `${location.origin}/terminal.html?tid=${r.terminal.id}&key=${r.secret}`;
      msg('ntMsg', `终端已创建。在旧安卓机上打开这个链接：<br><code style="word-break:break-all">${esc(url)}</code>`, 'ok', true);
      $('ntName').value = ''; $('ntLoc').value = '';
      load();
    } catch (e) { msg('ntMsg', e.message); }
  });

  /* ── 审批 ── */
  function renderRequests() {
    const emps = Object.fromEntries(view.employees.map((e) => [e.id, e.name]));
    const row = (x) => `<tr>
      <td>${esc(emps[x.employee_id] || x.employee_id)}</td>
      <td><span class="tag">${esc(EXC_LABEL[x.type] || x.type)}</span></td>
      <td>${esc(x.date)}</td>
      <td>${(x.minutes / 60).toFixed(1)} h</td>
      <td>${esc(x.note || '—')}</td>
      <td><span class="tag ${x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : 'bad'}">${esc(STATUS_LABEL[x.status])}</span></td>
      <td>${x.status === 'pending' ? `<button class="btn sm inline" data-ok="${esc(x.id)}">批准</button> <button class="btn sm ghost inline" data-no="${esc(x.id)}">拒绝</button>` : ''}</td>
    </tr>`;
    const head = '<table class="tbl"><thead><tr><th>员工</th><th>类型</th><th>日期</th><th>时长</th><th>说明</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    $('reqList').innerHTML = view.pendingExceptions.length
      ? head + view.pendingExceptions.map(row).join('') + '</tbody></table>'
      : '<p style="color:var(--ink-3);font-size:13px">没有待审批的申请</p>';
    $('reqAll').innerHTML = head + (view.exceptions || []).map(row).join('') + '</tbody></table>';

    document.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/admin/exceptions/${b.dataset.ok}`, { method: 'PATCH', token, body: { status: 'approved' } });
      load();
    }));
    document.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/admin/exceptions/${b.dataset.no}`, { method: 'PATCH', token, body: { status: 'rejected' } });
      load();
    }));
  }

  /* ── 规则 ── */
  const SET_FIELDS = [
    { k: 'weekStartWd', label: '周起始日', hint: '0=周日 1=周一 … 6=周六', step: 1 },
    { k: 'weeklyTargetMinutes', label: '默认每周目标（分钟）', hint: '24 小时 = 1440', step: 1 },
    { k: 'dailyCapMinutes', label: '每日封顶（分钟）', hint: '12 小时 = 720', step: 1 },
    { k: 'lunchStartMinute', label: '午休窗口开始（分钟）', hint: '12:00 = 720', step: 5 },
    { k: 'lunchWindowMinutes', label: '午休窗口长度（分钟）', hint: '60', step: 5 },
    { k: 'lunchMinOverlapMinutes', label: '触发午休扣减的最小覆盖（分钟）', hint: '在岗区间覆盖午休超过这么多分钟才扣', step: 5 },
    { k: 'lunchDeductionMinutes', label: '午休扣减时长（分钟）', hint: '60', step: 5 },
    { k: 'sessionTtlSeconds', label: '二维码有效期（秒）', hint: '45', step: 5 },
    { k: 'timezoneOffsetMinutes', label: '时区偏移（分钟）', hint: '中国 UTC+8 = 480', step: 30 },
  ];

  function renderSettings() {
    const s = view.settings;
    const cfg = view.config;
    $('setFields').innerHTML = SET_FIELDS.map((f) => {
      const val = f.k in cfg ? cfg[f.k] : s[f.k];
      return `<div class="field"><label>${esc(f.label)}</label>
        <input type="number" data-k="${esc(f.k)}" value="${esc(val)}" step="${f.step}">
        <div class="hint">${esc(f.hint)}</div></div>`;
    }).join('');
  }

  $('btnSaveSet').addEventListener('click', async () => {
    msg('setMsg', '');
    const body = {};
    document.querySelectorAll('[data-k]').forEach((i) => { body[i.dataset.k] = Number(i.value); });
    try {
      await api('/api/admin/settings', { method: 'PATCH', token, body });
      msg('setMsg', '已保存', 'ok');
      load();
    } catch (e) { msg('setMsg', e.message); }
  });

  /* ── tabs ── */
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('on'));
    t.classList.add('on');
    $(t.dataset.tab).classList.add('on');
    // 切 tab 就重新拉一次：否则老板切到「审批」看到的还是打开页面时的旧数据，
    // 员工新提交的申请要等他按 F5 才出现
    if (token) load();
  }));

  if (token) load(); else show('s-login');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
