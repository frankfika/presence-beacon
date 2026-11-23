'use strict';
/**
 * 在岗哨 · 规则引擎
 *
 * 纯函数，不碰数据库、不碰 IO。所有时间戳一律是 UTC 毫秒数，
 * 通过 tzOffsetMinutes 换算成「本地时间」来判定日期/周/午休窗口。
 *
 * 核心规则：
 *  1. 进/出配对      第1次=进 第2次=出 第3次=进…
 *  2. 跨天/跨周切分   按本地自然日切开，再归到自然周
 *  3. 午休扣减        单个在岗区间若覆盖午休窗口 ≥ 阈值，扣 lunchDeductionMinutes
 *  4. 每日封顶        同一自然日累计封顶
 *  5. 假期抵扣        leave / holiday 从周目标中扣除；travel 既不计入也不抵扣
 */

const MINUTE = 60000;
const DEFAULT_TZ_OFFSET = 480; // UTC+8

const DEFAULT_CONFIG = {
  weekStartWd: 1,            // 1=周一
  dailyCapMinutes: 12 * 60,  // 每日封顶
  lunchStartMinute: 12 * 60, // 午休窗口开始（本地时间，分钟）
  lunchWindowMinutes: 60,
  lunchMinOverlapMinutes: 45,// 覆盖午休窗口超过这么多分钟才触发扣减
  lunchDeductionMinutes: 60, // 实际扣掉多少
  timezoneOffsetMinutes: DEFAULT_TZ_OFFSET,
};

/* ──────────────── 时间工具 ──────────────── */

function localParts(ts, off) {
  const d = new Date(ts + off * MINUTE);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKeyOf(ts, off) {
  const p = localParts(ts, off);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

function dateKeyToUtcMidnight(key, off) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - off * MINUTE;
}

/** 某个本地日期所在自然周的第一个日期（weekStartWd: 0=周日 … 6=周六） */
function weekStartKeyOfDateKey(dateKey, weekStartWd) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const ts = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const wd = new Date(ts).getUTCDay(); // 0=周日
  const delta = (wd - weekStartWd + 7) % 7;
  const start = new Date(ts - delta * 86400000);
  return `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}-${pad2(start.getUTCDate())}`;
}

/** 距离 dateKey 还有多少天到下一个周起始（用于「还差几天」） */
function daysUntilWeekEnd(dateKey, weekStartWd) {
  const start = weekStartKeyOfDateKey(dateKey, weekStartWd);
  const endTs = dateKeyToUtcMidnight(start, 0) + 7 * 86400000;
  const curTs = dateKeyToUtcMidnight(dateKey, 0);
  return Math.round((endTs - curTs) / 86400000);
}

/** 把一个时间区间按本地自然日切开 */
function splitByLocalDay(startTs, endTs, off) {
  const parts = [];
  let s = startTs;
  let guard = 0;
  while (s < endTs && guard++ < 1000) {
    const p = localParts(s, off);
    const nextMidnight = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0, 0) - off * MINUTE;
    const e = Math.min(endTs, nextMidnight);
    parts.push({ start: s, end: e, dateKey: dateKeyOf(s, off) });
    s = e;
  }
  return parts;
}

/** 区间与当日午休窗口的重叠分钟数 */
function lunchOverlapMinutes(startTs, endTs, off, cfg) {
  const p = localParts(startTs, off);
  const lunchStart = Date.UTC(p.y, p.m - 1, p.d, 0, cfg.lunchStartMinute, 0, 0) - off * MINUTE;
  const lunchEnd = lunchStart + cfg.lunchWindowMinutes * MINUTE;
  const overlap = Math.min(endTs, lunchEnd) - Math.max(startTs, lunchStart);
  return overlap > 0 ? overlap / MINUTE : 0;
}

/* ──────────────── 主计算 ──────────────── */

/**
 * @param {Array} events  [{ ts, kind:'in'|'out'|'adjust', minutes?, note?, source? }]
 * @param {Array} exceptions [{ date:'YYYY-MM-DD', type:'leave'|'travel'|'holiday'|'adjust', minutes }]
 * @param {Object} options 规则参数
 * @param {number} nowTs    "现在"，用于截断未闭合区间
 */
function computeAttendance(events, exceptions = [], options = {}, nowTs = Date.now()) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const off = cfg.timezoneOffsetMinutes;

  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  /* 1. 配对进/出 */
  const segments = [];
  let open = null;
  for (const ev of sorted) {
    if (ev.kind === 'in') {
      if (open === null) open = { startTs: ev.ts, eventId: ev.id ?? null };
      // 连续两次 in：丢弃前一个未闭合段（视为误操作），重新开段
      else { segments.push({ ...open, closed: false, dropped: true }); open = { startTs: ev.ts, eventId: ev.id ?? null }; }
    } else if (ev.kind === 'out') {
      if (open !== null) {
        segments.push({ startTs: open.startTs, endTs: ev.ts, closed: true });
        open = null;
      }
      // 没有配对的 out：忽略
    }
  }

  /* 2. 尾部未闭合：按封顶截断，标记待确认 */
  const truncated = [];
  if (open !== null) {
    const capMs = cfg.dailyCapMinutes * MINUTE;
    const endTs = Math.min(nowTs, open.startTs + capMs);
    segments.push({
      startTs: open.startTs,
      endTs: Math.max(endTs, open.startTs),
      closed: false,
      truncated: endTs < nowTs,
    });
    truncated.push({ startTs: open.startTs });
  }

  /* 3. 切成天 + 算每天时长 */
  const dayMap = new Map();
  const ensureDay = (key) => {
    if (!dayMap.has(key)) {
      dayMap.set(key, {
        date: key, minutes: 0, segments: [], adjustments: 0, lunchDeducted: 0,
        capped: false, unclosed: false, travel: false,
        baseMinutes: 0, countedMinutes: 0,
      });
    }
    return dayMap.get(key);
  };

  for (const seg of segments) {
    if (seg.dropped) continue;                 // 连按两次 in 时被丢弃的未闭合段
    if (!seg.endTs || seg.endTs <= seg.startTs) continue;
    for (const frag of splitByLocalDay(seg.startTs, seg.endTs, off)) {
      const rawMinutes = (frag.end - frag.start) / MINUTE;
      const day = ensureDay(frag.dateKey);

      const overlap = lunchOverlapMinutes(frag.start, frag.end, off, cfg);
      // 扣减上限：不超过午休扣减时长、不超过实际覆盖的分钟数、
      // 也不超过这段区间时长的一半（否则 12:00–12:50 这种短区间会被整段吃掉）
      const deduct = overlap >= cfg.lunchMinOverlapMinutes
        ? Math.min(cfg.lunchDeductionMinutes, overlap, Math.floor(rawMinutes * 0.5))
        : 0;

      day.segments.push({
        in: frag.start,
        out: frag.end,
        minutes: rawMinutes - deduct,
        lunchDeducted: deduct,
        crossDay: frag.start !== seg.startTs || frag.end !== seg.endTs,
      });
      day.minutes += rawMinutes - deduct;
      day.lunchDeducted += deduct;
      if (!seg.closed) day.unclosed = true;
    }
  }

  /* 4. 补卡（adjust）：直接加时长 */
  for (const ex of exceptions) {
    if (ex.type !== 'adjust') continue;
    const day = ensureDay(ex.date);
    day.adjustments += Math.max(0, ex.minutes || 0);
  }

  /* 5. 每日封顶（只封「打卡时长」，补卡是人工批准的，不参与封顶） */
  for (const day of dayMap.values()) {
    const baseMinutes = day.minutes;
    if (baseMinutes > cfg.dailyCapMinutes) {
      day.capped = true;
      day.minutes = cfg.dailyCapMinutes;
    }
    day.baseMinutes = baseMinutes;
    day.countedMinutes = day.minutes + day.adjustments;
  }

  /* 5b. 出差当天：单独标记，既不计入也不抵扣 */
  for (const ex of exceptions) {
    if (ex.type !== 'travel' || !ex.date) continue;
    const day = dayMap.get(ex.date);
    if (!day) continue;
    day.travel = true;
    day.countedMinutes = 0; // 出差当天不计入周时长
  }

  /* 6. 归到自然周 */
  const weekMap = new Map();
  const getWeek = (wk) => {
    if (!weekMap.has(wk)) {
      weekMap.set(wk, {
        weekStart: wk,
        days: [],
        minutes: 0,
        leaveMinutes: 0,
        travelMinutes: 0,
        holidayMinutes: 0,
        adjustmentMinutes: 0,
        adjustmentCount: 0,
        unclosedDays: 0,
        cappedDays: 0,
        travelDays: 0,
        lunchDeducted: 0,
        exceptions: [],
      });
    }
    return weekMap.get(wk);
  };

  for (const day of [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const wk = weekStartKeyOfDateKey(day.date, cfg.weekStartWd);
    const week = getWeek(wk);
    week.days.push(day);
    week.minutes += day.countedMinutes;
    week.adjustmentMinutes += day.adjustments;
    week.lunchDeducted += day.lunchDeducted;
    if (day.unclosed) week.unclosedDays++;
    if (day.capped) week.cappedDays++;
    if (day.travel) week.travelDays++;
  }

  /* 7. 假期/出差抵扣 */
  for (const ex of exceptions) {
    if (!ex.date) continue;
    const wk = weekStartKeyOfDateKey(ex.date, cfg.weekStartWd);
    const week = getWeek(wk);
    week.exceptions.push(ex);
    const mins = Math.max(0, ex.minutes || 0);
    if (ex.type === 'leave') week.leaveMinutes += mins;
    else if (ex.type === 'holiday') week.holidayMinutes += mins;
    else if (ex.type === 'travel') week.travelMinutes += mins;
    else if (ex.type === 'adjust') { week.adjustmentMinutes += 0; week.adjustmentCount++; }
  }

  const weeks = [...weekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return {
    config: cfg,
    weeks,
    segments,
    truncated,
  };
}

/**
 * 计算某人在某一周的状态
 * @returns {{
 *   weekStart, minutes, targetMinutes, deductedMinutes, effectiveTargetMinutes,
 *   gapMinutes, met, status, daysLeft, days:[], hasTravel, unclosedDays, cappedDays
 * }}
 */
function weekStatus(result, weekStart, targetMinutes, nowTs = Date.now()) {
  const cfg = result.config;
  const week = result.weeks.find((w) => w.weekStart === weekStart);
  const minutes = week ? week.minutes : 0;
  const deducted = week ? week.leaveMinutes + week.holidayMinutes : 0;
  const effectiveTarget = Math.max(0, targetMinutes - deducted);
  const gap = Math.max(0, effectiveTarget - minutes);

  const todayKey = dateKeyOf(nowTs, cfg.timezoneOffsetMinutes);
  const daysLeft = daysUntilWeekEnd(todayKey, cfg.weekStartWd);

  let status;
  if (gap === 0) status = 'met';
  else if (minutes > 0) status = 'behind';
  else status = 'none';

  return {
    weekStart,
    minutes,
    targetMinutes,
    deductedMinutes: deducted,
    effectiveTargetMinutes: effectiveTarget,
    gapMinutes: gap,
    met: gap === 0,
    status,
    daysLeft,
    hasTravel: !!(week && week.travelMinutes > 0),
    travelMinutes: week ? week.travelMinutes : 0,
    travelDays: week ? week.travelDays : 0,
    unclosedDays: week ? week.unclosedDays : 0,
    cappedDays: week ? week.cappedDays : 0,
    lunchDeducted: week ? week.lunchDeducted : 0,
    adjustmentMinutes: week ? week.adjustmentMinutes : 0,
    adjustmentCount: week ? week.adjustmentCount : 0,
    days: week ? week.days : [],
    exceptions: week ? week.exceptions : [],
  };
}

function currentWeekStart(cfg, nowTs = Date.now()) {
  return weekStartKeyOfDateKey(dateKeyOf(nowTs, cfg.timezoneOffsetMinutes), cfg.weekStartWd);
}

/** 格式化分钟数 → "8h35m" / "8.6 h" */
function formatMinutes(minutes, style = 'hm') {
  const mins = Math.round(minutes);
  if (style === 'decimal') return (mins / 60).toFixed(1);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${pad2(m)}m`;
}

module.exports = {
  MINUTE,
  DEFAULT_CONFIG,
  computeAttendance,
  weekStatus,
  currentWeekStart,
  weekStartKeyOfDateKey,
  dateKeyOf,
  dateKeyToUtcMidnight,
  localParts,
  splitByLocalDay,
  formatMinutes,
  daysUntilWeekEnd,
};
