/**
 * Insights - Stash UI plugin
 *
 * A stats dashboard on Stash's Stats page, below Stash's own numbers:
 * You (O's, streaks, a calendar, a day's timeline, watch time, what works
 * for you, your queue), Library (what you have and its records), Files and
 * quality (codecs, resolutions, bitrates, upgrades, space hogs, duplicates),
 * Metadata health (what is filled in, what is probably wrong) and
 * Collection (growth, tags, studio networks, who is in it). Everything is
 * computed in the browser from one paged read of the library plus a few
 * counts; every bar, day and row leads into Stash.
 *
 * Watch time per day is tracked here, while the scene player plays (not
 * card previews), and saved into this plugin's Stash config, so it is the
 * same on every device. History from the O Stats plugin can be imported.
 *
 * Replaces the O Stats and Stats Enhancer plugins; see the README.
 */
(function () {
  "use strict";
  if (window.__InsightsI18nLoaded) return;
  window.__InsightsI18nLoaded = true;

  // ==================== i18n ====================
  var PLUGIN_VERSION = '2.12.0-1';
  var _intlLocale = '';
  function tc(zh, en) {
    if (_intlLocale.indexOf('zh') === 0) return zh;
    return en;
  }
  function isZh() {
    return _intlLocale.indexOf('zh') === 0;
  }
  ;(function initIntlBridge() {
    try {
      var api = window.PluginApi;
      if (!api || !api.React || !api.patch || !api.libraries || !api.libraries.Intl) return;
      var React = api.React;
      function IntlBridge() {
        var intl = api.libraries.Intl.useIntl();
        React.useEffect(function () { _intlLocale = intl.locale || ''; });
        return null;
      }
      api.patch.before('App', function (props) {
        return [{ children: React.createElement(React.Fragment, null, React.createElement(IntlBridge), props.children) }];
      });
    } catch (e) {
      console.warn('[InsightsI18n] i18n bridge failed:', e);
    }
  })();
  console.log('[InsightsI18n] Insights I18n v' + PLUGIN_VERSION + ' loaded');

  const PLUGIN_ID = "InsightsI18n";
  const DATA_KEYS = ["watch", "ostatsImported"];   // in Suite Data's store when it is installed
  const DEBUG = (() => { try { return localStorage.getItem("insightsI18nDebug") === "1"; } catch (_) { return false; } })();
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  const DAY = 86400000;

  // ═══ Pure helpers (tested) ═════════════════════════════════════════════════
  // Every day is a LOCAL calendar day. O Stats parsed "YYYY-MM-DD" with
  // new Date(), which is UTC, and filed O's under the wrong month and year
  // for anyone west of UTC; nothing here does that.

  const pad2 = (n) => String(n).padStart(2, "0");
  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  // "YYYY-MM-DD" as local midnight.
  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
  }
  // Calendar days between two day starts, safe across DST changes.
  function daysBetween(a, b) { return Math.round((dayStart(b) - dayStart(a)) / DAY); }
  function addDays(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  // Monday-start week containing ms.
  function weekStart(ms) { const d = new Date(dayStart(ms)); const wd = (d.getDay() + 6) % 7; return addDays(d.getTime(), -wd); }
  function toMs(t) {
    if (t === null || t === undefined || t === "") return null;
    const v = typeof t === "number" ? t : Date.parse(t);
    return Number.isFinite(v) ? v : null;
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 100) return `${h.toLocaleString()}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  }
  function fmtBytes(b) {
    const u = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = b || 0, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;

  // ── O's over time ─────────────────────────────────────────────────────────

  // Every dated O as { t, scene }, plus the O's Stash counts that have no
  // date (older Stash versions, imports). Those still count in totals and
  // per-scene figures; day-based charts say how many they could not place.
  function collectOs(scenes) { return collectTimes(scenes, "oh", "o"); }
  // The same for plays (2.4): with "Hide O's" on, the You tab's calendar,
  // streaks and charts count plays instead. Stash's play_count can run ahead
  // of play_history the same way o_counter runs ahead of o_history.
  function collectPlays(scenes) { return collectTimes(scenes, "ph", "plays"); }
  function collectTimes(scenes, hist, count) {
    const events = [];
    let undated = 0;
    for (const s of scenes) {
      const times = (s[hist] || []).map(toMs).filter((x) => x !== null);
      for (const t of times) events.push({ t, scene: s.id });
      undated += Math.max(0, (s[count] || 0) - times.length);
    }
    events.sort((a, b) => a.t - b.t);
    return { events, undated };
  }
  // Everything the You tab draws from one kind of event.
  function activity({ events, undated }, now) {
    const byDay = countByDay(events);
    return { events, undated, byDay, st: streaks(byDay, now), record: recordDay(byDay), cal: calendar(byDay, now), wh: weekdayHour(events) };
  }

  function countByDay(events) {
    const m = new Map();
    for (const e of events) { const k = dayKey(e.t); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  }

  // Current streak (consecutive days with an O, ending today, or yesterday
  // if today has none yet: still alive), best streak with its dates, and
  // the longest break between O days.
  function streaks(byDay, now) {
    const days = [...byDay.keys()].map(parseDay).sort((a, b) => a - b);
    let best = { len: 0, from: null, to: null }, run = 0, runFrom = null, prev = null, longestBreak = 0, gaps = [];
    for (const d of days) {
      if (prev !== null && daysBetween(prev, d) === 1) run += 1;
      else {
        if (prev !== null) { const gap = daysBetween(prev, d) - 1; longestBreak = Math.max(longestBreak, gap); gaps.push(gap + 1); }
        run = 1; runFrom = d;
      }
      if (run > best.len) best = { len: run, from: runFrom, to: d };
      prev = d;
    }
    const today = dayStart(now);
    let current = 0;
    if (days.length) {
      const last = days[days.length - 1];
      const since = daysBetween(last, today);
      if (since <= 1) {
        current = 1;
        for (let i = days.length - 2; i >= 0 && daysBetween(days[i], days[i + 1]) === 1; i--) current += 1;
      }
    }
    const lastDay = days.length ? days[days.length - 1] : null;
    return {
      current,
      atRisk: current > 0 && lastDay !== null && daysBetween(lastDay, today) === 1,
      best,
      longestBreak,
      daysSinceLast: lastDay === null ? null : daysBetween(lastDay, today),
      avgGapDays: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    };
  }

  function recordDay(byDay) {
    let best = null;
    for (const [k, n] of byDay) if (!best || n > best.n || (n === best.n && k < best.day)) best = { day: k, n };
    return best;
  }

  // Bars for a period: { label, key, value, from, to } in order. kind:
  // "week" (7 days), "month" (its days), "year" (12 months). offset 0 is the
  // current one, -1 the one before.
  function periodBars(byDay, kind, offset, now) {
    const out = [];
    if (kind === "year") {
      const y = new Date(now).getFullYear() + offset;
      for (let m = 0; m < 12; m++) {
        const from = new Date(y, m, 1).getTime(), to = new Date(y, m + 1, 1).getTime();
        let v = 0;
        for (let d = from; d < to; d = addDays(d, 1)) v += byDay.get(dayKey(d)) || 0;
        out.push({ key: `${y}-${pad2(m + 1)}`, label: new Date(y, m, 1).toLocaleDateString(undefined, { month: "short" }), value: v, from, to });
      }
      return { title: String(y), bars: out };
    }
    if (kind === "month") {
      const base = new Date(now); const y = base.getFullYear(), m = base.getMonth() + offset;
      const first = new Date(y, m, 1).getTime(), next = new Date(y, m + 1, 1).getTime();
      for (let d = first; d < next; d = addDays(d, 1)) {
        out.push({ key: dayKey(d), label: String(new Date(d).getDate()), value: byDay.get(dayKey(d)) || 0, from: d, to: addDays(d, 1) });
      }
      return { title: new Date(first).toLocaleDateString(undefined, { month: "long", year: "numeric" }), bars: out };
    }
    const ws = addDays(weekStart(now), offset * 7);
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      out.push({ key: dayKey(d), label: new Date(d).toLocaleDateString(undefined, { weekday: "short" }), value: byDay.get(dayKey(d)) || 0, from: d, to: addDays(d, 1) });
    }
    const end = addDays(ws, 6);
    const f = (x) => new Date(x).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return { title: `${f(ws)} – ${f(end)}`, bars: out };
  }

  // GitHub-style year: 53 Monday-start columns ending this week.
  function calendar(byDay, now, weeks = 53) {
    const start = addDays(weekStart(now), -(weeks - 1) * 7);
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(start, i);
      cells.push({ key: dayKey(d), value: byDay.get(dayKey(d)) || 0, future: d > dayStart(now), from: d });
    }
    return { start, cells, max: Math.max(1, ...cells.map((c) => c.value)) };
  }

  // 7 x 24: Monday first, local hours.
  function weekdayHour(events) {
    const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const e of events) { const d = new Date(e.t); m[(d.getDay() + 6) % 7][d.getHours()] += 1; }
    return m;
  }

  // A day's events for the timeline: O's, and plays not already explained
  // by an O on the same scene or another play of it within 30 minutes (O
  // Stats' rule, kept). With `noO` (Hide O's) only the plays.
  function dayEvents(scenes, key, noO) {
    const os = [], plays = [];
    for (const s of scenes) {
      if (!noO) for (const t of (s.oh || []).map(toMs)) if (t !== null && dayKey(t) === key) os.push({ t, scene: s, o: true });
      for (const t of (s.ph || []).map(toMs)) if (t !== null && dayKey(t) === key) plays.push({ t, scene: s, o: false });
    }
    const near = (a, b) => Math.abs(a - b) < 30 * 60000;
    const kept = [];
    for (const p of plays.sort((a, b) => a.t - b.t)) {
      if (os.some((o) => o.scene === p.scene && near(o.t, p.t))) continue;
      if (kept.some((k) => k.scene === p.scene && near(k.t, p.t))) continue;
      kept.push(p);
    }
    return os.concat(kept).sort((a, b) => a.t - b.t);
  }

  // ── Traits: what works for you ────────────────────────────────────────────

  // "34C-24-34", "32DD", "34 E" -> cup group. Band-only or nonsense -> null.
  function cupOf(measurements) {
    const m = /\b(\d{2,3})\s*([A-K]{1,3})\b/i.exec(measurements || "");
    if (!m) return null;
    const c = m[2].toUpperCase();
    if (c === "AA" || c === "A") return "A";
    if (c === "B" || c === "C" || c === "D") return c;
    return "DD+";
  }
  function heightGroup(cm) {
    if (!cm) return null;
    if (cm < 155) return "under 155 cm";
    if (cm < 165) return "155–164 cm";
    if (cm < 175) return "165–174 cm";
    return "175 cm and up";
  }
  function weightGroup(kg) {
    if (!kg) return null;
    if (kg < 50) return "under 50 kg";
    if (kg < 60) return "50–59 kg";
    if (kg < 70) return "60–69 kg";
    return "70 kg and up";
  }
  // Whole years old on the day of the scene.
  function ageAt(birth, onDay) {
    const a = rawAge(birth, onDay);
    return a !== null && a >= 16 && a < 100 ? a : null;
  }
  function ageGroup(a) {
    // 2.11: an age under 18 can only be a wrong birthdate; it used to land
    // in "18–21" (ageAt keeps 16 and 17 for the timeline's sake), now it is
    // left out like an unknown one (forum, sashi)
    if (a === null || a === undefined || a < 18) return null;
    if (a < 22) return "18–21";
    if (a < 26) return "22–25";
    if (a < 31) return "26–30";
    if (a < 36) return "31–35";
    if (a < 41) return "36–40";
    if (a < 46) return "41–45";
    if (a < 51) return "46–50";
    return "51 and up";
  }
  // Years into a career when the scene came out.
  function careerGroup(careerStart, onDay) {
    const cs = parseInt(String(careerStart || "").slice(0, 4), 10);
    const y = parseInt(String(onDay || "").slice(0, 4), 10);
    if (!cs || !y || y < cs) return null;
    const n = y - cs;
    if (n < 2) return "first 2 years";
    if (n < 6) return "years 3–5";
    if (n < 11) return "years 6–10";
    return "over 10 years in";
  }
  const yesNo = (s, yes, no) => (s === null || s === undefined ? null : String(s).trim() && !/^(no|none|n\/a)$/i.test(String(s).trim()) ? yes : no);
  function naturalGroup(fake) {
    const f = String(fake || "").trim().toLowerCase();
    if (!f) return null;
    return /^(n|no|natural)/.test(f) ? "natural" : "enhanced";
  }
  // ISO country code -> regional indicator flag. Names stay as they are.
  function flagOf(code) {
    const c = String(code || "").trim().toUpperCase();
    return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0))) : "";
  }
  function lengthGroup(sec) {
    if (!sec) return null;
    if (sec < 600) return "under 10 min";
    if (sec < 1800) return "10–30 min";
    if (sec < 3600) return "30–60 min";
    return "over an hour";
  }
  function resolutionGroup(h) {
    if (!h) return null;
    if (h >= 2000) return "4K and up";
    if (h >= 1000) return "1080p";
    if (h >= 700) return "720p";
    return "SD";
  }
  function eraGroup(date) {
    const y = parseInt(String(date || "").slice(0, 4), 10);
    if (!y) return null;
    if (y < 2005) return "before 2005";
    const from = y - ((y - 2005) % 5);
    return `${from}–${from + 4}`;
  }
  function castGroup(n) {
    if (!n) return null;
    return n === 1 ? "solo" : n === 2 ? "two performers" : "three or more";
  }

  // The trait each performer dimension reads, per (performer, scene).
  const PERFORMER_TRAITS = [
    { id: "country", label: "Nationality", labelZh: "国籍", get: (p) => countryCode(p.country) },
    { id: "ethnicity", label: "Ethnicity", labelZh: "族裔", get: (p) => p.ethnicity || null },
    { id: "hair", label: "Hair", labelZh: "头发", get: (p) => p.hair || null },
    { id: "eyes", label: "Eyes", labelZh: "眼睛", get: (p) => p.eyes || null },
    { id: "height", label: "Height", labelZh: "身高", get: (p) => heightGroup(p.height) },
    { id: "weight", label: "Weight", labelZh: "体重", get: (p) => weightGroup(p.weight) },
    { id: "cup", label: "Cup size", labelZh: "罩杯", get: (p) => cupOf(p.measurements) },
    { id: "natural", label: "Natural or enhanced", labelZh: "天然或隆胸", get: (p) => naturalGroup(p.fake) },
    { id: "tattoos", label: "Tattoos", labelZh: "纹身", get: (p) => yesNo(p.tattoos, "tattoos", "no tattoos") },
    { id: "piercings", label: "Piercings", labelZh: "穿孔", get: (p) => yesNo(p.piercings, "piercings", "no piercings") },
    { id: "age", label: "Age in the scene", labelZh: "场景中的年龄", get: (p, s) => ageGroup(ageAt(p.birth, s.date)) },
    { id: "career", label: "Career stage in the scene", labelZh: "场景中的职业阶段", get: (p, s) => careerGroup(p.careerStart, s.date) },
    { id: "favourite", label: "Favourites", labelZh: "最爱", get: (p) => (p.fav ? "favourites" : "not favourites") },
    { id: "ptags", label: "Performer tags", labelZh: "演员标签", multi: (p) => (p.tags || []).map((t) => t[1]) },
  ];
  const SCENE_TRAITS = [
    { scene: true, id: "tags", label: "Scene tags", labelZh: "场景标签", multi: (s) => (s.tags || []).map((t) => t[1]) },
    { scene: true, id: "studio", label: "Studios", labelZh: "工作室", get: (s) => (s.studio ? s.studio.name : null) },
    { scene: true, id: "cast", label: "Cast", labelZh: "参演人数", get: (s) => castGroup((s.perf || []).length) },
    { scene: true, id: "length", label: "Length", labelZh: "时长", get: (s) => lengthGroup(s.dur) },
    { scene: true, id: "resolution", label: "Resolution", labelZh: "分辨率", get: (s) => resolutionGroup(s.h) },
    { scene: true, id: "era", label: "Released", labelZh: "发行年份", get: (s) => eraGroup(s.date) },
    { scene: true, id: "interactive", label: "Interactive", labelZh: "可交互", get: (s) => (s.interactive ? "interactive" : "not interactive") },
  ];

  // One dimension's rows. A scene counts once per value, however many of
  // its performers share it. Shares are of the library's scenes, O's,
  // plays and watch time; lift = share of O's / share of scenes (and the
  // same for plays). Rows under the sample size are marked `small`.
  // 2.11 opts.gender (a Stash gender, "" for not set): only scenes with a
  // performer of that gender count, and only those performers give the
  // performer traits, so the shares compare like with like (forum: age in
  // the scene for women and men apart; user: trans performers on their own).
  function traitRows(scenes, perfById, dim, opts = {}) {
    const minScenes = opts.minScenes ?? 5;
    const g = opts.gender ?? null;
    const fits = (pid) => { const p = perfById.get(pid); return !!p && (p.gender || "") === g; };
    const tot = { scenes: 0, o: 0, plays: 0, watch: 0 };
    const rows = new Map();
    for (const s of scenes) {
      if (g !== null && !(s.perf || []).some(fits)) continue;
      tot.scenes += 1; tot.o += s.o || 0; tot.plays += s.plays || 0; tot.watch += s.playDur || 0;
      const vals = new Set();
      if (dim.scene) {
        if (dim.multi) for (const v of dim.multi(s)) vals.add(v);
        else { const v = dim.get(s); if (v) vals.add(v); }
      } else {
        for (const pid of s.perf || []) {
          const p = perfById.get(pid);
          if (!p || (g !== null && (p.gender || "") !== g)) continue;
          if (dim.multi) for (const v of dim.multi(p, s)) vals.add(v);
          else { const v = dim.get(p, s); if (v) vals.add(v); }
        }
      }
      for (const v of vals) {
        let r = rows.get(v);
        if (!r) rows.set(v, (r = { value: v, scenes: 0, o: 0, plays: 0, watch: 0 }));
        r.scenes += 1; r.o += s.o || 0; r.plays += s.plays || 0; r.watch += s.playDur || 0;
      }
    }
    const out = [...rows.values()].map((r) => {
      const libShare = tot.scenes ? r.scenes / tot.scenes : 0;
      const oShare = tot.o ? r.o / tot.o : 0;
      const playShare = tot.plays ? r.plays / tot.plays : 0;
      const watchShare = tot.watch ? r.watch / tot.watch : 0;
      return { ...r, libShare, oShare, playShare, watchShare,
               lift: libShare ? oShare / libShare : 0, playLift: libShare ? playShare / libShare : 0,
               small: r.scenes < minScenes || (r.o < 2 && r.plays < 3) };
    });
    return { rows: out, total: tot };
  }

  // Green above 1.25, coral below 0.8, neutral between.
  function liftTone(lift) { return lift >= 1.25 ? "up" : lift <= 0.8 ? "down" : "even"; }

  // ── People and scenes ─────────────────────────────────────────────────────

  function performerTable(scenes, perfById, now) {
    const m = new Map();
    for (const s of scenes) {
      const lastO = Math.max(0, ...(s.oh || []).map(toMs).filter((x) => x !== null));
      for (const pid of s.perf || []) {
        let r = m.get(pid);
        if (!r) m.set(pid, (r = { id: pid, o: 0, scenes: 0, plays: 0, watch: 0, lastO: 0 }));
        r.o += s.o || 0; r.scenes += 1; r.plays += s.plays || 0; r.watch += s.playDur || 0;
        if (lastO > r.lastO) r.lastO = lastO;
      }
    }
    const rows = [...m.values()].map((r) => ({ ...r, p: perfById.get(r.id) || null, perScene: r.scenes ? r.o / r.scenes : 0 }));
    const sixMonths = 182 * DAY;
    return {
      byId: new Map(rows.map((r) => [r.id, r])),
      byO: rows.filter((r) => r.o > 0).sort((a, b) => b.o - a.o || b.scenes - a.scenes),
      byRate: rows.filter((r) => r.scenes >= 3 && r.o > 0).sort((a, b) => b.perScene - a.perScene || b.o - a.o),
      byWatch: rows.filter((r) => r.watch > 0).sort((a, b) => b.watch - a.watch),
      byPlays: rows.filter((r) => r.plays > 0).sort((a, b) => b.plays - a.plays || b.watch - a.watch),
      neglected: rows.filter((r) => r.p && r.p.fav && (r.lastO === 0 || now - r.lastO > sixMonths))
        .sort((a, b) => (a.lastO || 0) - (b.lastO || 0)),
    };
  }

  function topScenes(scenes, now) {
    const lastOf = (s) => Math.max(0, ...(s.oh || []).map(toMs).filter((x) => x !== null));
    return {
      byO: scenes.filter((s) => s.o > 0).sort((a, b) => b.o - a.o).slice(0, 10),
      byPlays: scenes.filter((s) => s.plays > 0).sort((a, b) => b.plays - a.plays || b.playDur - a.playDur).slice(0, 10),
      unvisited: scenes.filter((s) => s.o >= 2 && lastOf(s) && now - lastOf(s) > 90 * DAY)
        .sort((a, b) => b.o - a.o).slice(0, 10).map((s) => ({ ...s, lastO: lastOf(s) })),
    };
  }

  // ── Library ───────────────────────────────────────────────────────────────

  function library(scenes) {
    const t = { scenes: scenes.length, size: 0, secs: 0, rated: 0, organized: 0, played: 0, withO: 0 };
    const released = new Map(), added = new Map();
    for (const s of scenes) {
      t.size += s.size || 0; t.secs += s.dur || 0;
      if (s.rating !== null && s.rating !== undefined) t.rated += 1;
      if (s.organized) t.organized += 1;
      if (s.plays > 0) t.played += 1;
      if (s.o > 0) t.withO += 1;
      const ry = parseInt(String(s.date || "").slice(0, 4), 10);
      if (ry > 1900) released.set(ry, (released.get(ry) || 0) + 1);
      if (s.created) { const ay = new Date(s.created).getFullYear(); added.set(ay, (added.get(ay) || 0) + 1); }
    }
    const years = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n }));
    return { totals: t, released: years(released), added: years(added) };
  }

  // O's per scene and share played, by rating band.
  function ratingBands(scenes) {
    const bands = [
      { label: tc("5 星", "5 stars"), test: (r) => r >= 90 }, { label: tc("4 星", "4 stars"), test: (r) => r >= 70 && r < 90 },
      { label: tc("3 星", "3 stars"), test: (r) => r >= 50 && r < 70 }, { label: tc("2 星及以下", "2 stars and below"), test: (r) => r < 50 },
      { label: tc("未评分", "not rated"), test: (r) => r === null || r === undefined },
    ];
    return bands.map((b) => {
      const ss = scenes.filter((s) => b.test(s.rating));
      const o = ss.reduce((a, s) => a + (s.o || 0), 0);
      return { label: b.label, scenes: ss.length, o, perScene: ss.length ? o / ss.length : 0,
               played: ss.length ? ss.filter((s) => s.plays > 0).length / ss.length : 0 };
    });
  }

  // ── Backlog ───────────────────────────────────────────────────────────────
  // Each row carries the scene-list filter that shows the same scenes, so a
  // click lands on exactly what was counted.
  const BACKLOG = [
    { id: "unwatched", label: "Never watched", icon: "eye-off", test: (s) => !s.plays,
      criteria: [{ type: "play_count", modifier: "EQUALS", value: { value: 0 } }], sort: "created_at" },
    { id: "unrated", label: "Watched, not rated", icon: "star", test: (s) => s.plays > 0 && (s.rating === null || s.rating === undefined),
      criteria: [{ type: "play_count", modifier: "GREATER_THAN", value: { value: 0 } }, { type: "rating100", modifier: "IS_NULL" }], sort: "last_played_at" },
    { id: "started", label: "Started, not finished", icon: "player-pause", test: (s) => s.resume > 0,
      criteria: [{ type: "resume_time", modifier: "GREATER_THAN", value: { value: 0 } }], sort: "last_played_at" },
    { id: "teasers", o: true, label: "Played 3+ times, no O", icon: "drop-off", test: (s) => s.plays >= 3 && !s.o,
      criteria: [{ type: "play_count", modifier: "GREATER_THAN", value: { value: 2 } }, { type: "o_counter", modifier: "EQUALS", value: { value: 0 } }], sort: "play_count" },
    { id: "loved", o: true, label: "Rated 4 stars and up, never an O", icon: "heart", test: (s) => s.rating >= 70 && !s.o,
      criteria: [{ type: "rating100", modifier: "GREATER_THAN", value: { value: 69 } }, { type: "o_counter", modifier: "EQUALS", value: { value: 0 } }], sort: "rating" },
    { id: "unorganized", label: "Not organized", icon: "folder", test: (s) => !s.organized,
      criteria: [{ type: "organized", value: "false" }], sort: "created_at" },
  ];
  // The queue's labels in Chinese, by row id (the array itself is read for
  // its filter and its test, so its labels stay as they are).
  const BACKLOG_ZH = {
    unwatched: "从未观看", unrated: "看过但未评分", started: "看了一半没看完",
    teasers: "播放 3 次以上，却从未有过 O", loved: "评分 4 星及以上，却从未有过 O", unorganized: "未整理",
  };
  // Rows marked `o` are about O's and go with "Hide O's".
  function backlog(scenes, now, noO) {
    return BACKLOG.filter((b) => !(noO && b.o)).map((b) => {
      const hits = scenes.filter(b.test);
      const oldest = hits.reduce((m, s) => (s.created && (!m || s.created < m) ? s.created : m), null);
      return { ...b, label: (isZh() && BACKLOG_ZH[b.id]) || b.label, n: hits.length, oldestDays: oldest ? daysBetween(oldest, now) : null };
    });
  }

  // Stash's list URLs carry each criterion as JSON with { } swapped for ( )
  // outside strings, URL-encoded with ?#&;=+ escaped (the same encoding
  // QuickTools and Collections use).
  function encodeCriterion(obj) {
    let inString = false, escaped = false, out = "";
    for (const ch of JSON.stringify(obj)) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === "\\" && inString) { escaped = true; out += ch; continue; }
      if (ch === '"') inString = !inString;
      out += (!inString && ch === "{") ? "(" : (!inString && ch === "}") ? ")" : ch;
    }
    let s = encodeURI(out);
    for (const c of "?#&;=+") s = s.split(c).join(encodeURIComponent(c));
    return s;
  }
  function listUrl(base, criteria, sort, dir = "desc") {
    return `${base}?${criteria.map((c) => "c=" + encodeCriterion(c)).join("&")}${sort ? `&sortby=${sort}&sortdir=${dir}` : ""}`;
  }

  // Watch per O over the last `days`: tracked seconds / dated O's on the
  // days that have tracking (so days before tracking began do not count).
  function watchPerO(watchByDay, byDay, now, days = 30) {
    let secs = 0, os = 0;
    for (let i = 0; i < days; i++) {
      const k = dayKey(addDays(now, -i));
      if (!watchByDay[k]) continue;
      secs += watchByDay[k];
      os += byDay.get(k) || 0;
    }
    return os ? secs / os : null;
  }

  // Merge O Stats' watch_data.json into ours: per day, the larger of the
  // two (both trackers may have run on the same day; adding would count it
  // twice). Accepts its two formats.
  function mergeOStats(ours, theirs) {
    const out = { ...(ours || {}) };
    const src = theirs && theirs.data && typeof theirs.data === "object" ? theirs.data : theirs || {};
    let days = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const secs = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.split(",")[0]) : v && typeof v.totalTime === "number" ? v.totalTime : NaN;
      if (!Number.isFinite(secs) || secs <= 0) continue;
      if (!out[k] || secs > out[k]) { out[k] = Math.round(secs); days += 1; }
    }
    return { merged: out, days };
  }

  // Add pending seconds per day onto what is stored (read-merge-write: two
  // devices both add, neither overwrites).
  function addWatch(stored, pending) {
    const out = { ...(stored || {}) };
    for (const [k, v] of Object.entries(pending || {})) out[k] = Math.round((out[k] || 0) + v);
    return out;
  }

  // ── Countries ─────────────────────────────────────────────────────────────
  // Stash stores an ISO code, but older data and imports have names
  // ("United States", "czech republic"); both become the code.
  let regionCodes = null;
  function countryCode(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
    if (!regionCodes) {
      regionCodes = new Map();
      try {
        const dn = new Intl.DisplayNames(["en"], { type: "region" });
        for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          let name = null;
          try { name = dn.of(code); } catch (_) {}
          if (name && name !== code) regionCodes.set(name.toLowerCase(), code);
        }
      } catch (_) {}
      for (const [k, v] of [["usa", "US"], ["united states of america", "US"], ["uk", "GB"], ["england", "GB"], ["great britain", "GB"],
                            ["czech republic", "CZ"], ["russian federation", "RU"], ["holland", "NL"]]) regionCodes.set(k, v);
    }
    return regionCodes.get(s.toLowerCase()) || s;
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  // Names as the rest of the suite writes them (Flexoki.js VIDEO_NAME,
  // THEME "Suite conventions"): H264, not H.264; Real, not RealVideo.
  const VCODEC = { h264: "H264", avc1: "H264", hevc: "HEVC", h265: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8",
    vp6: "VP6", vp6f: "VP6", mpeg4: "MPEG-4", msmpeg4: "MPEG-4", msmpeg4v1: "MPEG-4", msmpeg4v2: "MPEG-4", msmpeg4v3: "MPEG-4",
    wmv1: "WMV", wmv2: "WMV", wmv3: "WMV", vc1: "VC-1", mpeg2video: "MPEG-2", mpeg1video: "MPEG-1", prores: "ProRes",
    h263: "H263", flv1: "FLV", theora: "Theora", rv30: "Real", rv40: "Real" };
  const ACODEC = { aac: "AAC", opus: "Opus", ac3: "AC-3", eac3: "E-AC-3", mp3: "MP3", mp2: "MP2", flac: "FLAC",
    vorbis: "Vorbis", wmav1: "WMA", wmav2: "WMA", wmapro: "WMA", dts: "DTS", truehd: "TrueHD", alac: "ALAC" };
  function codecName(raw, audio) {
    const c = String(raw || "").trim().toLowerCase();
    if (!c) return audio ? "none" : "unknown";
    if (audio && c.startsWith("pcm")) return "PCM";
    return (audio ? ACODEC : VCODEC)[c] || c.toUpperCase();
  }
  // The suite's three codec tiers (user: HEVC and AV1 ideal, H264 second,
  // the rest bad; Flexoki.js VIDEO_TIER draws them on scene cards). Up to
  // 2.5 Insights had its own "legacy" list, which left VP9, VP8, ProRes
  // and any codec it did not know out of "Worth upgrading"; they count as
  // poor now. "unknown" (no codec recorded) is no tier: nothing to judge.
  const VIDEO_TIER = { HEVC: "good", AV1: "good", H264: "ok" };
  const codecTier = (name) => (!name || name === "unknown" ? null : VIDEO_TIER[name] || "poor");
  const isPoor = (name) => codecTier(name) === "poor";
  // the tiers' colours, as on Flexoki's cards: the ideal case quiet grey,
  // H264 yellow, poor red; no tier the faint grey
  const TIER_COLOR = { good: "var(--sx-grey)", ok: "var(--sx-ye-l)", poor: "var(--sx-re-l)" };
  const tierColor = (name) => TIER_COLOR[codecTier(name)] || "var(--sx-tx3)";
  // Audio is fine unless it is one of the poor ones (Flexoki.js AUDIO_FINE).
  const AUDIO_FINE = new Set(["AAC", "MP3", "AC-3", "E-AC-3", "Opus", "FLAC", "DTS", "Vorbis", "ALAC", "TrueHD"]);
  const audioColor = (name) => (AUDIO_FINE.has(name) ? TIER_COLOR.good : TIER_COLOR.poor);
  // How well a codec packs a picture, for picking which duplicate to keep:
  // the tiers' order (VP9 sat with HEVC up to 2.5), VP9/VP8 still above
  // the older poor ones.
  const CODEC_RANK = { AV1: 5, HEVC: 4, H264: 3, VP9: 2, VP8: 2 };

  // Stash reports ffprobe's container names; "matroska" is an .mkv.
  function containerName(format, basename) {
    const f = String(format || "").trim().toLowerCase();
    const named = { matroska: "mkv", mpegts: "ts", "matroska,webm": "mkv", "mov,mp4,m4a,3gp,3g2,mj2": "mp4" }[f];
    if (named) return named;
    if (f && f.length <= 5) return f;
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(basename || "") || [])[1];
    return ext ? ext.toLowerCase() : f || "unknown";
  }

  // By the shorter side, or the long side as if it were 16:9, whichever is
  // more: a portrait 1080x1920 is 1080p like its landscape twin, and a
  // 1920x800 cinema crop is 1080p, not 720p.
  const RES_ORDER = ["8K", "5K+", "4K", "1440p", "1080p", "720p", "480p", "below 480p"];
  // The suite's resolution colours, red to magenta (Flexoki's fx-res chips:
  // 480p #F89A8A ... 8K #F4A4C2). Below 480p is the next red down, so the
  // two lowest still tell apart in the ring and the legend.
  const RES_COLOR = { "8K": "var(--sx-ma-l)", "5K+": "var(--sx-pu-l)", "4K": "var(--sx-bl-l)", "1440p": "var(--sx-cy-l)", "1080p": "var(--sx-gr-l)", "720p": "var(--sx-ye-l)",
                      "480p": "var(--sx-re-l)", "below 480p": "var(--sx-re-tx)" };
  function resBucket(w, h) {
    const short = w && h ? Math.min(w, h) : h || w || 0;
    if (!short) return null;
    const s = Math.max(short, w && h ? Math.round(Math.max(w, h) * 9 / 16) : 0);
    if (s >= 4000) return "8K";
    if (s >= 2600) return "5K+";
    if (s >= 2000) return "4K";
    if (s >= 1300) return "1440p";
    if (s >= 1000) return "1080p";
    if (s >= 700) return "720p";
    if (s >= 460) return "480p";
    return "below 480p";
  }
  const FPS_ORDER = ["24/25", "30", "50", "60", "over 60"];
  function fpsBucket(f) {
    if (!f) return null;
    if (f < 26) return "24/25";
    if (f < 40) return "30";
    if (f < 55) return "50";
    if (f < 65) return "60";
    return "over 60";
  }
  // VR is told by shape and size: side-by-side 2:1 at 4K wide or more, or
  // over-under 1:1 at 2.8K or more. Phones make portrait.
  function shapeOf(w, h) {
    if (!w || !h) return null;
    const r = w / h, long = Math.max(w, h);
    if ((r >= 1.9 && r <= 2.1 && long >= 3800) || (r >= 0.95 && r <= 1.05 && long >= 2800)) return "VR";
    if (r < 0.95) return "portrait";
    if (r <= 1.05) return "square";
    return "landscape";
  }
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  }
  // Bits per second, from Stash or worked out from size and length.
  const bitrateOf = (s) => s.br || (s.fsize && s.dur ? (s.fsize * 8) / s.dur : 0);

  function fileStats(scenes) {
    const st = { scenes: scenes.length, files: 0, size: 0, secs: 0, multi: 0, noFile: 0, noPhash: 0, brSum: 0, brN: 0,
      vcodec: new Map(), acodec: new Map(), container: new Map(), res: new Map(), fps: new Map(), shape: new Map(), bitrate: {} };
    const add = (m, key, s, raw) => {
      if (key === null || key === undefined) return;
      let r = m.get(key);
      if (!r) m.set(key, (r = { key, n: 0, size: 0, secs: 0, short: 0, raw: raw || "" }));
      r.n += 1; r.size += s.fsize || 0; r.secs += s.dur || 0; r.short += Math.min(s.w || s.h, s.h || s.w) || 0;
    };
    const brs = new Map(), eff = new Map();
    for (const s of scenes) {
      st.files += s.nfiles || 0; st.size += s.size || 0;
      if (!s.nfiles) { st.noFile += 1; continue; }
      if (s.nfiles > 1) st.multi += 1;
      if (s.phash === false) st.noPhash += 1;
      st.secs += s.dur || 0;
      const vc = codecName(s.vc), res = resBucket(s.w, s.h), br = bitrateOf(s);
      add(st.vcodec, vc, s, s.vc); add(st.acodec, codecName(s.ac, true), s, s.ac); add(st.container, s.fmt || "unknown", s);
      add(st.res, res, s); add(st.fps, fpsBucket(s.fps), s); add(st.shape, shapeOf(s.w, s.h), s);
      if (br && res) {
        st.brSum += br; st.brN += 1;
        if (!brs.has(res)) brs.set(res, []);
        brs.get(res).push(br);
        if (vc === "HEVC" || vc === "AV1") { if (!eff.has(res)) eff.set(res, []); eff.get(res).push(br); }
      }
    }
    for (const [res, list] of brs) {
      list.sort((a, b) => a - b);
      const e = (eff.get(res) || []).sort((a, b) => a - b);
      st.bitrate[res] = { n: list.length, p10: percentile(list, 0.1), p50: percentile(list, 0.5), p90: percentile(list, 0.9),
                          efficient: e.length >= 5 ? percentile(e, 0.5) : percentile(list, 0.5) * 0.5 };
    }
    return st;
  }

  // Worth upgrading: below 720p or a poor codec. The ones you watch come
  // first, since those are the ones a better copy would improve. With `noO`
  // (Hide O's) plays alone decide, so no O ranking shows through the order.
  function upgrades(scenes, noO) {
    const hits = scenes.filter((s) => s.nfiles && (["480p", "below 480p"].includes(resBucket(s.w, s.h)) || isPoor(codecName(s.vc))));
    hits.sort((a, b) => (noO ? 0 : (b.o || 0) - (a.o || 0)) || (b.plays || 0) - (a.plays || 0) || (b.fsize || 0) - (a.fsize || 0));
    return { n: hits.length, size: hits.reduce((a, s) => a + (s.fsize || 0), 0), list: hits };
  }

  // Space hogs: over 2.5x the median bitrate for their resolution and over
  // 1 GB. The saving is what the file would be at the median HEVC/AV1
  // bitrate of that resolution in this library (half the median if there
  // are too few of those to tell).
  function spaceHogs(scenes, fs) {
    const out = [];
    for (const s of scenes) {
      if (!s.nfiles || (s.fsize || 0) < 1e9 || !s.dur) continue;
      const res = resBucket(s.w, s.h), b = fs.bitrate[res], br = bitrateOf(s);
      if (!b || b.n < 10 || br <= b.p50 * 2.5) continue;
      const saving = s.fsize - (s.dur * b.efficient) / 8;
      if (saving > 0) out.push({ s, ratio: br / b.p50, saving });
    }
    out.sort((a, b) => b.saving - a.saving);
    return { n: out.length, saving: out.reduce((a, x) => a + x.saving, 0), list: out };
  }

  const resRank = (s) => { const r = resBucket(s.w, s.h); return r ? RES_ORDER.length - RES_ORDER.indexOf(r) : 0; };

  // ── Metadata health ───────────────────────────────────────────────────────

  // parts: [{ missing, total, weight }] -> 0..1 filled, weighted.
  function healthScore(parts) {
    let w = 0, have = 0;
    for (const p of parts) {
      if (!p.total || p.missing === null || p.missing === undefined) continue;
      w += p.weight; have += p.weight * (1 - Math.min(p.missing, p.total) / p.total);
    }
    return w ? have / w : null;
  }
  function gradeOf(score) {
    if (score === null || score === undefined) return "–";
    const bands = [[0.92, "A"], [0.86, "A-"], [0.8, "B+"], [0.72, "B"], [0.66, "B-"], [0.58, "C+"], [0.5, "C"], [0.4, "D"]];
    for (const [min, g] of bands) if (score >= min) return g;
    return "E";
  }

  // Whole years between a birthdate and a day, unfiltered (ageAt drops
  // implausible ages; the checks want exactly those).
  function rawAge(birth, onDay) {
    const b = parseDay(birth), d = parseDay(onDay);
    if (b === null || d === null) return null;
    const bd = new Date(b), dd = new Date(d);
    let a = dd.getFullYear() - bd.getFullYear();
    if (dd.getMonth() < bd.getMonth() || (dd.getMonth() === bd.getMonth() && dd.getDate() < bd.getDate())) a -= 1;
    return a;
  }
  // Scenes dated before one of their performers turned 18: nearly always a
  // wrong birthdate or a wrong scene date (a re-release, a typo).
  function dateConflicts(scenes, perfById) {
    const out = [];
    for (const s of scenes) {
      if (!s.date) continue;
      for (const pid of s.perf || []) {
        const p = perfById.get(pid);
        const a = p ? rawAge(p.birth, s.date) : null;
        if (a !== null && a < 18) out.push({ s, p, age: a });
      }
    }
    return out;
  }
  // Same name and the same disambiguation (or none): probably one person
  // added twice.
  function sameNames(performers) {
    const m = new Map();
    for (const p of performers) {
      const k = `${String(p.name || "").trim().toLowerCase()}|${String(p.disamb || "").trim().toLowerCase()}`;
      if (!p.name) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return [...m.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name));
  }
  function futureDates(scenes, now) {
    const today = dayKey(now);
    return scenes.filter((s) => s.date && s.date.slice(0, 10) > today);
  }

  // ── Collection ────────────────────────────────────────────────────────────

  // Scenes added per month from the first month to this one, and the
  // running total.
  function growth(scenes, now) {
    const m = new Map();
    let first = null;
    for (const s of scenes) {
      if (!s.created) continue;
      const d = new Date(s.created), k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const r = m.get(k) || { added: 0, size: 0 };
      r.added += 1; r.size += s.size || 0; m.set(k, r);
      if (first === null || s.created < first) first = s.created;
    }
    if (first === null) return [];
    const out = [];
    const end = new Date(now);
    let total = 0, size = 0;
    for (let d = new Date(new Date(first).getFullYear(), new Date(first).getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const r = m.get(k) || { added: 0, size: 0 };
      total += r.added; size += r.size;
      out.push({ key: k, from: d.getTime(), added: r.added, total, size });
    }
    return out;
  }

  function tagCounts(scenes) {
    const m = new Map();
    for (const s of scenes) for (const [id, name] of s.tags || []) {
      const r = m.get(id) || { id, name, n: 0 };
      r.n += 1; m.set(id, r);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }
  // What else turns up with a tag: lift = how often B is on A's scenes,
  // over how often B is on any scene. Pairs seen fewer than `min` times say
  // nothing and are left out.
  function coTags(scenes, tagId, min = 3) {
    const n = scenes.length;
    const all = new Map(), withA = new Map();
    let a = 0;
    for (const s of scenes) {
      const ids = (s.tags || []).map((t) => t[0]);
      const has = ids.includes(tagId);
      if (has) a += 1;
      for (const [id, name] of s.tags || []) {
        if (id === tagId) continue;
        const r = all.get(id) || { id, name, n: 0 };
        r.n += 1; all.set(id, r);
        if (has) withA.set(id, (withA.get(id) || 0) + 1);
      }
    }
    if (!a) return { n: 0, rows: [] };
    const rows = [...withA.entries()].filter(([, t]) => t >= min).map(([id, together]) => {
      const b = all.get(id);
      return { id, name: b.name, together, share: together / a, lift: (together / a) / (b.n / n) };
    });
    rows.sort((x, y) => y.lift - x.lift || y.together - x.together);
    return { n: a, rows };
  }

  // Studios grouped under their top parent. A network is a parent with at
  // least one child that has scenes; everything else is independent.
  function networks(studios, scenes) {
    const byId = new Map(studios.map((s) => [s.id, s]));
    const rootOf = (id) => {
      let cur = byId.get(id), guard = 0;
      while (cur && cur.parent && byId.has(cur.parent) && guard++ < 12) cur = byId.get(cur.parent);
      return cur ? cur.id : id;
    };
    const per = new Map();
    for (const s of scenes) {
      if (!s.studio) continue;
      const r = per.get(s.studio.id) || { n: 0, size: 0, name: s.studio.name };
      r.n += 1; r.size += s.size || 0; per.set(s.studio.id, r);
    }
    const nets = new Map();
    for (const [id, r] of per) {
      const root = rootOf(id);
      const net = nets.get(root) || { id: root, name: (byId.get(root) || {}).name || r.name, sites: new Set(), scenes: 0, size: 0 };
      if (id !== root) net.sites.add(id);
      net.scenes += r.n; net.size += r.size; nets.set(root, net);
    }
    const list = [...nets.values()].map((x) => ({ ...x, sites: x.sites.size }));
    const groups = list.filter((x) => x.sites > 0).sort((a, b) => b.scenes - a.scenes);
    const indep = list.filter((x) => x.sites === 0);
    const studiosOut = [...per.entries()].map(([id, r]) => ({ id, name: r.name, scenes: r.n, size: r.size })).sort((a, b) => b.scenes - a.scenes);
    return { networks: groups, studios: studiosOut,
             independent: { studios: indep.length, scenes: indep.reduce((a, x) => a + x.scenes, 0), list: indep.sort((a, b) => b.scenes - a.scenes) } };
  }

  // Performers who share scenes. Scenes with more than six performers are
  // left out: one big cast would otherwise make dozens of "pairs".
  function pairs(scenes) {
    const m = new Map();
    for (const s of scenes) {
      const p = [...new Set(s.perf || [])].sort();
      if (p.length < 2 || p.length > 6) continue;
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
        const k = `${p[i]}|${p[j]}`;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return [...m.entries()].map(([k, n]) => ({ a: k.split("|")[0], b: k.split("|")[1], n })).sort((x, y) => y.n - x.n);
  }

  // The year of each performer's first scene here (by release date).
  function newFaces(scenes) {
    const first = new Map();
    for (const s of scenes) {
      const y = parseInt(String(s.date || "").slice(0, 4), 10);
      if (!y) continue;
      for (const pid of s.perf || []) if (!first.has(pid) || y < first.get(pid)) first.set(pid, y);
    }
    const m = new Map();
    for (const y of first.values()) m.set(y, (m.get(y) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n }));
  }

  // Each performer in each scene, by age on the scene's date (18 to 50).
  function ageCounts(scenes, perfById) {
    const m = new Map();
    for (const s of scenes) for (const pid of s.perf || []) {
      const a = ageAt(perfById.get(pid)?.birth, s.date);
      if (a === null || a < 18 || a > 50) continue;
      const r = m.get(a) || { n: 0, o: 0 };
      r.n += 1; r.o += s.o || 0; m.set(a, r);
    }
    return m;
  }

  // The records: longest, biggest and so on. Each points at a scene,
  // performer or studio.
  function notable(scenes, perfById) {
    const best = (f, ok = () => true) => scenes.reduce((m, s) => (ok(s) && (m === null || f(s) > f(m)) ? s : m), null);
    const perfN = new Map(), studioN = new Map();
    for (const s of scenes) {
      for (const pid of s.perf || []) perfN.set(pid, (perfN.get(pid) || 0) + 1);
      if (s.studio) { const r = studioN.get(s.studio.id) || { ...s.studio, n: 0 }; r.n += 1; studioN.set(s.studio.id, r); }
    }
    const topPerf = [...perfN.entries()].sort((a, b) => b[1] - a[1])[0];
    const topStudio = [...studioN.values()].sort((a, b) => b.n - a.n)[0];
    return {
      longest: best((s) => s.dur || 0, (s) => s.dur > 0),
      // 2.11: 10 s and up; DVD rips have menu VOBs a fraction of a second
      // long, which showed as "0s" (forum, sashi)
      shortest: best((s) => -(s.dur || 0), (s) => s.dur >= 10),
      biggest: best((s) => s.fsize || 0, (s) => s.fsize > 0),
      oldest: best((s) => -(parseDay(s.date) || 0), (s) => parseDay(s.date) !== null),
      newest: best((s) => s.created || 0, (s) => !!s.created),
      cast: best((s) => (s.perf || []).length, (s) => (s.perf || []).length > 1),
      played: best((s) => s.plays || 0, (s) => s.plays > 0),
      tagged: best((s) => (s.tags || []).length, (s) => (s.tags || []).length > 0),
      performer: topPerf ? { p: perfById.get(topPerf[0]) || { id: topPerf[0], name: tc(`演员 ${topPerf[0]}`, `Performer ${topPerf[0]}`) }, n: topPerf[1] } : null,
      studio: topStudio || null,
    };
  }

  // "4 months and 10 days": how long the library would take to watch.
  function nonstop(secs) {
    const days = (secs || 0) / 86400;
    const link = () => (isZh() ? "零" : " and ");
    if (days < 1) return plural(Math.round(secs / 3600), "hour");
    if (days < 60) { const d = Math.floor(days), h = Math.round((days - d) * 24); return h ? `${plural(d, "day")}${link()}${plural(h, "hour")}` : plural(d, "day"); }
    if (days < 365) { const mo = Math.floor(days / 30.44), d = Math.round(days - mo * 30.44); return d ? `${plural(mo, "month")}${link()}${plural(d, "day")}` : plural(mo, "month"); }
    const y = Math.floor(days / 365.25), mo = Math.round((days - y * 365.25) / 30.44);
    return mo ? `${plural(y, "year")}${link()}${plural(mo, "month")}` : plural(y, "year");
  }

  // ── 2.2: actions ──────────────────────────────────────────────────────────

  // HEVC and AV1 are both the target: either is a copy worth keeping.
  const isEfficient = (vc) => { const n = codecName(vc); return n === "HEVC" || n === "AV1"; };

  // Which copies of a duplicate group to keep and which to remove.
  // mode "hevc": keep the sharpest HEVC/AV1 copy; remove the others, but
  //   with `sharp` on, never one sharper than what is kept, and a group with
  //   no HEVC/AV1 copy at all is left for a look, nothing ticked.
  // mode "best": keep the sharpest, then the better codec, then more history.
  // mode "smallest": keep the smallest file among the sharpest copies.
  // Returns { keep, items: [{ s, remove, why }], review, reason }.
  function dupChoose(group, mode = "hevc", opts = {}) {
    const sharp = opts.sharp !== false;
    const hist = (s) => (s.o || 0) + (s.plays || 0);
    const byQuality = (a, b) => resRank(b) - resRank(a) || (CODEC_RANK[codecName(b.vc)] || 1) - (CODEC_RANK[codecName(a.vc)] || 1) ||
      (b.br || 0) - (a.br || 0) || hist(b) - hist(a) || (Number(a.id) || 0) - (Number(b.id) || 0);
    let keep, review = false, reason = "";
    if (mode === "smallest") {
      const top = Math.max(...group.map(resRank));
      keep = group.filter((s) => resRank(s) === top).sort((a, b) => (a.fsize || 0) - (b.fsize || 0) || byQuality(a, b))[0];
    } else if (mode === "best") {
      keep = group.slice().sort(byQuality)[0];
    } else {
      const eff = group.filter((s) => isEfficient(s.vc)).sort(byQuality);
      if (!eff.length) {
        keep = group.slice().sort(byQuality)[0];
        return { keep, items: group.filter((s) => s !== keep).map((s) => ({ s, remove: false, why: tc("没有 HEVC 或 AV1 副本", "no HEVC or AV1 copy") })),
                 review: true, reason: tc("这一组里没有 HEVC 或 AV1 副本", "No HEVC or AV1 copy in this group") };
      }
      keep = eff[0];
    }
    const items = group.filter((s) => s !== keep).map((s) => {
      if (mode === "hevc" && sharp && resRank(s) > resRank(keep)) {
        review = true;
        reason = tc(`${resBucket(s.w, s.h)} 的副本比保留的 ${resBucket(keep.w, keep.h)} ${codecName(keep.vc)} 那份更清晰`, `A ${resBucket(s.w, s.h)} copy is sharper than the ${resBucket(keep.w, keep.h)} ${codecName(keep.vc)} one`);
        return { s, remove: false, why: tc("比保留的那份更清晰", "sharper than the kept copy") };
      }
      return { s, remove: true, why: "" };
    });
    return { keep, items, review, reason };
  }

  // What the kept scene should look like after a merge: its own fields win;
  // empty ones are filled from the copies; lists (tags, performers,
  // galleries, groups, URLs, StashDB ids) are the union, so removing a copy
  // never loses anything set on it (rule 5). `have` is the set of
  // SceneUpdateInput fields this Stash accepts.
  function mergeValues(keep, drops, have) {
    const all = [keep].concat(drops);
    const ok = (f) => !have || have.has(f);
    const v = { id: keep.id };
    const first = (get) => { for (const s of all) { const x = get(s); if (x !== null && x !== undefined && x !== "") return x; } return undefined; };
    const uniq = (list) => [...new Set(list.map(String))];
    if (ok("title")) { const x = first((s) => s.title); if (x !== undefined) v.title = x; }
    if (ok("code")) { const x = first((s) => s.code); if (x !== undefined) v.code = x; }
    if (ok("details")) { const x = first((s) => s.details); if (x !== undefined) v.details = x; }
    if (ok("director")) { const x = first((s) => s.director); if (x !== undefined) v.director = x; }
    if (ok("date")) { const x = first((s) => s.date); if (x !== undefined) v.date = x; }
    if (ok("rating100")) { const x = first((s) => s.rating100); if (x !== undefined) v.rating100 = x; }
    if (ok("studio_id")) { const x = first((s) => s.studio && s.studio.id); if (x !== undefined) v.studio_id = String(x); }
    if (ok("organized")) v.organized = all.some((s) => s.organized);
    if (ok("tag_ids")) v.tag_ids = uniq(all.flatMap((s) => (s.tags || []).map((t) => t.id)));
    if (ok("performer_ids")) v.performer_ids = uniq(all.flatMap((s) => (s.performers || []).map((p) => p.id)));
    if (ok("gallery_ids")) v.gallery_ids = uniq(all.flatMap((s) => (s.galleries || []).map((g) => g.id)));
    if (ok("urls")) v.urls = [...new Set(all.flatMap((s) => s.urls || []))];
    if (ok("groups")) {
      const seen = new Map();
      for (const s of all) for (const g of s.groups || []) {
        const id = String(g.group ? g.group.id : g.group_id);
        if (!seen.has(id)) seen.set(id, { group_id: id, ...(g.scene_index !== null && g.scene_index !== undefined ? { scene_index: g.scene_index } : {}) });
      }
      v.groups = [...seen.values()];
    }
    if (ok("stash_ids")) {
      const seen = new Map();
      for (const s of all) for (const x of s.stash_ids || []) {
        const k = `${x.endpoint}|${x.stash_id}`;
        if (!seen.has(k)) seen.set(k, { endpoint: x.endpoint, stash_id: x.stash_id });
      }
      v.stash_ids = [...seen.values()];
    }
    return v;
  }

  // Files not in HEVC or AV1 yet, with what they would take at this
  // library's usual HEVC/AV1 bitrate for their resolution. Biggest gain first.
  function notEfficient(scenes, fs) {
    const out = [];
    for (const s of scenes) {
      if (!s.nfiles || !s.dur || isEfficient(s.vc)) continue;
      const b = fs.bitrate[resBucket(s.w, s.h)];
      const gain = b ? Math.max(0, (s.fsize || 0) - (s.dur * b.efficient) / 8) : 0;
      out.push({ s, gain });
    }
    out.sort((a, b) => b.gain - a.gain);
    return { n: out.length, gain: out.reduce((a, x) => a + x.gain, 0), size: out.reduce((a, x) => a + (x.s.fsize || 0), 0), list: out };
  }

  // ── 2.2: what works for you, read better ──────────────────────────────────

  // Dimensions with a natural order keep it (height runs short to tall);
  // the rest sort strongest first.
  const ORDER = {
    height: ["under 155 cm", "155–164 cm", "165–174 cm", "175 cm and up"],
    weight: ["under 50 kg", "50–59 kg", "60–69 kg", "70 kg and up"],
    cup: ["A", "B", "C", "D", "DD+"],
    age: ["18–21", "22–25", "26–30", "31–35", "36–40", "41–45", "46–50", "51 and up"],
    career: ["first 2 years", "years 3–5", "years 6–10", "over 10 years in"],
    length: ["under 10 min", "10–30 min", "30–60 min", "over an hour"],
    resolution: ["SD", "720p", "1080p", "4K and up"],
    cast: ["solo", "two performers", "three or more"],
  };
  const isOrdinal = (dimId) => !!ORDER[dimId] || dimId === "era";
  function ordinalKey(dimId, value) {
    if (dimId === "era") return value === "before 2005" ? 0 : parseInt(value, 10) || 0;
    const i = (ORDER[dimId] || []).indexOf(value);
    return i < 0 ? 999 : i;
  }

  // Strength: how far above its share a group is, on a log scale (2x and
  // 0.5x are equally far from even), weighted by how many scenes back it,
  // so six scenes at 12x do not outrank 600 at 1.7x.
  const strength = (lift, scenes) => (lift > 0 ? Math.log(lift) : -5) * Math.sqrt(scenes);

  // rows from traitRows plus the metric ("o", "plays" or "watch") -> rows
  // with lift, score and rank (1 = strongest), the top three flagged, in
  // display order. Small groups: under max(5, 0.1% of the library) scenes,
  // or too little activity to say anything.
  function rankTraits(T, dimId, metric = "o", opts = {}) {
    const minScenes = Math.max(5, Math.round((T.total.scenes || 0) * 0.001));
    const share = (r) => (metric === "watch" ? r.watchShare : metric === "plays" ? r.playShare : r.oShare);
    const rows = T.rows.map((r) => {
      const lift = r.libShare ? share(r) / r.libShare : 0;
      return { ...r, mShare: share(r), mLift: lift, score: strength(lift, r.scenes),
               small: r.scenes < minScenes || (r.o < 2 && r.plays < 3) };
    });
    const shown = rows.filter((r) => opts.small || !r.small);
    const byScore = shown.slice().sort((a, b) => b.score - a.score || b.scenes - a.scenes);
    byScore.forEach((r, i) => { r.rank = i + 1; r.top = i < 3 && r.mLift >= 1.25; });
    let ordered;
    if (opts.sort === "size") ordered = shown.slice().sort((a, b) => b.scenes - a.scenes);
    else if (isOrdinal(dimId) && opts.sort !== "pull") ordered = shown.slice().sort((a, b) => ordinalKey(dimId, a.value) - ordinalKey(dimId, b.value));
    else ordered = byScore;
    return { rows: ordered, hidden: rows.length - shown.length, minScenes };
  }

  // Position on a log scale centred on 1x: 1/4x is -1, 4x is +1.
  const liftPos = (lift) => (lift > 0 ? Math.max(-1, Math.min(1, Math.log(lift) / Math.log(4))) : -1);

  // ── 2.3: reading only what changed ────────────────────────────────────────
  // What the cached scenes add up to, to hold against Stash's own totals.
  function sceneTotals(scenes) {
    let o = 0, plays = 0, dur = 0;
    for (const s of scenes) { o += s.o || 0; plays += s.plays || 0; dur += s.playDur || 0; }
    return { scenes: scenes.length, o, plays, dur };
  }
  // A total this Stash does not report is not held against the cache.
  function totalsMatch(t, stats) {
    const st = stats || {};
    return st.scene_count === t.scenes && (st.total_o_count ?? t.o) === t.o &&
      (st.total_play_count ?? t.plays) === t.plays && Math.abs((st.total_play_duration ?? t.dur) - t.dur) < 1;
  }
  // Light rows ({id, o, plays, playDur, resume}) against the cache: the
  // scenes to read again (new, or played or O'd since) and the ones gone.
  function activityDiff(cached, light) {
    const byId = new Map(cached.map((x) => [x.id, x]));
    const seen = new Set(), changed = [];
    for (const r of light) {
      seen.add(r.id);
      const c = byId.get(r.id);
      if (!c || c.o !== r.o || c.plays !== r.plays || Math.abs((c.playDur || 0) - (r.playDur || 0)) >= 1 ||
          Math.abs((c.resume || 0) - (r.resume || 0)) >= 1) changed.push(r.id);
    }
    return { changed, gone: cached.filter((x) => !seen.has(x.id)).map((x) => x.id) };
  }
  // The cache with fresh scenes put in by id and gone ones taken out, in id
  // order like a full read.
  function mergeScenes(cached, fresh, gone) {
    const m = new Map(cached.map((x) => [x.id, x]));
    for (const id of gone || []) m.delete(id);
    for (const x of fresh) m.set(x.id, x);
    return [...m.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  // ── 2.3: Lockdown, when that plugin is used ───────────────────────────────
  // Its config keeps `history` (the latest 200 runs) and `stats` (totals for
  // every run ever) as JSON. Read only. Nothing there: no Lockdown parts.
  function parseLockdown(cfg) {
    if (!cfg || !cfg.history) return null;
    let list, stats = {};
    try { list = JSON.parse(cfg.history); } catch (_) { return null; }
    if (!Array.isArray(list) || !list.length) return null;
    try { stats = JSON.parse(cfg.stats || "{}") || {}; } catch (_) {}
    return { list, stats };
  }
  // Watched time exists from Lockdown 2.1 (v 3); 2.0 kept it for Edge only.
  const ldHasWatch = (e) => e.v >= 3 || (!!e.goal && e.goal.type === "edge" && e.watchedMs > 0);
  function lockdownModel(ld, now) {
    if (!ld) return null;
    const runs = ld.list.filter((e) => e && e.at && (e.result === "done" || e.result === "gaveup"));
    if (!runs.length) return null;
    let done = 0, gaveUp = 0, lockedMs = 0, watchedMs = 0, watchLockedMs = 0, bestHeat = 0, best = null;
    const targets = new Map(), perf = new Map(), weeks = new Map(), byDay = new Map();
    for (const e of runs) {
      const ok = e.result === "done", ms = e.ms || 0, w = ldHasWatch(e) ? e.watchedMs || 0 : 0;
      if (ok) done += 1; else gaveUp += 1;
      lockedMs += ms;
      if (ldHasWatch(e)) { watchedMs += w; watchLockedMs += ms; }
      if (ok && typeof e.heat === "number" && e.heat > bestHeat) bestHeat = e.heat;
      if (ok && e.score > 0 && (!best || e.score > best.score)) best = e;
      const kind = e.kind || "performer", id = String(e.tid || e.pid || "");
      // several tags (Lockdown 2.2) are their own target; the link goes to the first
      const key = e.tags && e.tags.length > 1 ? `${kind}:${e.tags.map((x) => x.id).join(e.mode === "or" ? "|" : "+")}` : `${kind}:${id}`;
      const t = targets.get(key) || { kind, id, name: e.name || "?", image: e.image || "", runs: 0, done: 0, ms: 0, watched: 0 };
      t.runs += 1; if (ok) t.done += 1; t.ms += ms; t.watched += w;
      targets.set(key, t);
      if (kind === "performer" && id) {
        const x = perf.get(id) || { runs: 0, ms: 0, watched: 0 };
        x.runs += 1; x.ms += ms; x.watched += w;
        perf.set(id, x);
      }
      const wk = dayKey(weekStart(e.at)), b = weeks.get(wk) || { done: 0, gaveUp: 0 };
      if (ok) b.done += 1; else b.gaveUp += 1;
      weeks.set(wk, b);
      // every day the run was on, so a run past midnight shows on both
      for (let d = dayStart(e.at); d <= e.at + ms; d = addDays(d, 1)) {
        const k = dayKey(d);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(e);
      }
    }
    // the totals cover runs the 200-run list has dropped
    const st = ld.stats || {};
    const ws = weekStart(now), wk = runs.filter((e) => e.at >= ws);
    return {
      runs: Math.max(runs.length, (st.done || 0) + (st.gaveUp || 0)), done: Math.max(done, st.done || 0), gaveUp: Math.max(gaveUp, st.gaveUp || 0),
      lockedMs: Math.max(lockedMs, st.totalMs || 0), watchedMs, watchLockedMs, bestHeat: Math.max(bestHeat, st.bestHeat || 0), best,
      targets: [...targets.values()].sort((a, b) => b.runs - a.runs || b.ms - a.ms),
      perf, weeks, byDay, week: { runs: wk.length, done: wk.filter((e) => e.result === "done").length },
    };
  }

  // ── 2.4: settings, choices without O's, who is in the library ────────────
  // Stash saves a BOOLEAN setting as true or false, but a value written any
  // other way (a config import, a plugin writing its own map) can be the
  // string "true"; both mean on. Anything else, missing included, is off.
  const isOn = (v) => v === true || v === "true";
  function parseSettings(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    return { showNative: isOn(c.showStashNumbers), hideO: isOn(c.hideO), imagePerformers: isOn(c.imagePerformers) };
  }

  // The You tab's choices as [value, label, when]: "o" only while O's show,
  // "noO" only with "Hide O's" on (plays stand in for O's), none: always.
  // A choice that is not shown cannot be in effect, so a remembered "O's"
  // falls back to the first one shown rather than drawing O's anyway.
  const CHOICES = {
    metric: [["o", "O's", "o"], ["plays", "Plays", "noO"], ["watch", "Watch time"]],
    wmetric: [["o", "O's", "o"], ["plays", "Played", "noO"], ["watch", "Watched"]],
    mode: [["byO", "O's", "o"], ["byRate", "Per scene", "o"], ["byPlays", "Played", "noO"], ["byWatch", "Watched"],
           ["lockdown", "Lockdown", "o"], ["neglected", "Gone quiet", "o"]],
    top: [["byO", "Most O's", "o"], ["byPlays", "Most played"], ["unvisited", "Not revisited", "o"]],
  };
  const CHOICES_ZH = {
    metric: [["o", "O 次数", "o"], ["plays", "播放次数", "noO"], ["watch", "观看时长"]],
    wmetric: [["o", "O 次数", "o"], ["plays", "播放", "noO"], ["watch", "观看"]],
    mode: [["byO", "O 次数", "o"], ["byRate", "每次 O", "o"], ["byPlays", "播放次数", "noO"], ["byWatch", "观看时长"],
           ["lockdown", "Lockdown", "o"], ["neglected", "沉寂已久", "o"]],
    top: [["byO", "O 最多", "o"], ["byPlays", "播放最多"], ["unvisited", "未重温", "o"]],
  };
  // `table`: another set of choices worked the same way (the Movies tab's).
  const choiceTable = (table) => table || (isZh() ? CHOICES_ZH : CHOICES);
  const choices = (key, noO, table) => choiceTable(table)[key].filter(([, , when]) => !when || (when === "noO") === !!noO);
  function choice(key, value, noO, table) {
    const list = choices(key, noO, table);
    return (list.find((c) => c[0] === value) || list[0])[0];
  }

  // Who counts as in the library. Off: performers in a scene here. With
  // `withImages`: also performers Stash counts in an image or a gallery
  // (their own image_count and gallery_count, read with the performers, so
  // no image has to be downloaded). imageOnly: performers with images or
  // galleries and no scene; idle: performers with nothing at all, with
  // `withImages` meaning no image or gallery either. Both are null when this
  // Stash gave no image counts (an older one, or a cache from before 2.4).
  function performerReach(scenes, performers, withImages) {
    const ids = new Set();
    for (const s of scenes) for (const pid of s.perf || []) ids.add(pid);
    const list = performers || [];
    const counted = list.some((p) => typeof p.images === "number");
    let imageOnly = 0, idle = 0;
    for (const p of list) {
      const pics = (p.images || 0) + (p.galleries || 0) > 0;
      if (withImages && pics) ids.add(p.id);
      if (pics && !p.sceneCount) imageOnly += 1;
      if (!p.sceneCount && !(withImages && pics)) idle += 1;
    }
    return { ids, imageOnly: counted ? imageOnly : null, idle: counted ? idle : null };
  }

  // ── 2.5: Movies, with the Movies Toolkit plugin ──────────────────────────
  // Stash calls them groups; Movies Toolkit (plugin id "Movies") turns
  // scenes into movies with them, so the tab is only there with that plugin
  // installed and enabled, and says "movies" throughout. Read only.
  const MOVIES_ID = "Movies";
  // Stash's `plugins` list, as [{id, enabled}]. A Stash too old to report
  // `enabled` lists only what it loaded, so a missing flag counts as on.
  function moviesInstalled(list) {
    return Array.isArray(list) && list.some((p) => p && String(p.id) === MOVIES_ID && p.enabled !== false);
  }
  // Kept apart from parseSettings so the three 2.4 settings read as before.
  function parseMovieSetting(cfg) { return { hideMovies: isOn(cfg && typeof cfg === "object" ? cfg.hideMovies : undefined) }; }
  const moviesShown = (set) => !!(set && set.movies && !set.hideMovies);
  // Movies Toolkit renames Stash's Groups to Movies in Stash's menus and
  // tabs unless its own setting keepGroupsName is on; Insights' Library
  // tile follows, so one page does not say both (audit C11). Read only.
  function moviesRenamed(installed, plugins) {
    const cfg = plugins && typeof plugins === "object" ? plugins[MOVIES_ID] : null;
    return moviesInstalled(installed) && !isOn(cfg && typeof cfg === "object" ? cfg.keepGroupsName : undefined);
  }

  // Movies Toolkit 1.1 keeps chapters in the scene custom field "chapters",
  // a JSON string of [{t, s}]. Counted the way its own parseChapters reads
  // them: malformed rows are dropped, not fatal.
  function chapterCount(customFields) {
    let v = customFields && customFields.chapters;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { return 0; } }
    if (!Array.isArray(v)) return 0;
    return v.filter((x) => {
      const t = String((x && (x.t ?? x.title)) || "").trim(), s = Number(x && (x.s ?? x.seconds));
      return !!t && Number.isFinite(s) && s >= 0;
    }).length;
  }

  // A file that is the whole movie: Movies Toolkit's own rule (its
  // `wholeMovie`), so this tab and its Chapters tab count the same files.
  // A file named "... Scene 5" is a scene; a whole movie runs an hour or
  // more; then at least 70% of the movie's length when Stash has one, else
  // only as the movie's only scene of 70 minutes or more.
  const FULL_MOVIE_SEC = 3600, ONLY_SCENE_SEC = 70 * 60;
  // Movies Toolkit's "Title - Scene 3" pattern (SCENE_RX in Movies.js)
  const SCENE_NO_RX = /^(.*?[a-z0-9)\]!?'])\s*(?:[-_.,:|~]+\s*|\s+)(?:scene|sc|szene|escena)\s*[-_.#]?\s*0*(\d{1,2})(?!\d)/i;
  function numberedScene(...names) {
    return names.some((t) => {
      const x = String(t || "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
      const m = x.match(SCENE_NO_RX);
      return !!m && Number(m[2]) > 0 && m[1].replace(/[^a-z0-9]/gi, "").length >= 2;
    });
  }
  function isFullMovieFile(fileSec, groupScenes, groupSec, numbered) {
    if (!(fileSec >= FULL_MOVIE_SEC) || numbered) return false;
    if (groupSec > 0) return fileSec >= groupSec * 0.7;
    return groupScenes === 1 && fileSec >= ONLY_SCENE_SEC;
  }

  // Scene numbers in a movie: the ones missing below the highest. Numbers
  // start at 1 (as Movies Toolkit numbers them); a movie with none is "not
  // numbered", neither complete nor not. A typo like 2007 would list two
  // thousand gaps, so the list is cut at 50 and `n` keeps the true count.
  function indexGaps(indexes) {
    const have = new Set((indexes || []).filter((n) => Number.isInteger(n) && n >= 1));
    if (!have.size) return { numbered: false, max: 0, n: 0, missing: [] };
    const max = Math.max(...have), missing = [];
    for (let i = 1; i < max && missing.length < 50; i++) if (!have.has(i)) missing.push(i);
    return { numbered: true, max, n: max - have.size, missing };
  }

  // One group from Stash, small enough to keep: what each section needs, the
  // scene's place in this movie and its chapter count, and no synopsis text.
  function compactGroup(g) {
    const id = String(g.id), img = g.front_image_path || "";
    const cover = !!img && !/default=true/.test(img);
    return {
      id, name: g.name || `Movie ${id}`, date: g.date || null, dur: g.duration || 0, director: !!String(g.director || "").trim(),
      synopsis: !!String(g.synopsis || "").trim(), cover, poster: cover ? img : null, created: toMs(g.created_at),
      studio: g.studio ? { id: String(g.studio.id), name: g.studio.name } : null,
      scenes: (g.scenes || []).map((s) => {
        const link = (s.groups || []).find((x) => x && x.group && String(x.group.id) === id);
        const idx = link && link.scene_index !== null && link.scene_index !== undefined ? Number(link.scene_index) : null;
        return { id: String(s.id), idx, ch: chapterCount(s.custom_fields),
                 num: numberedScene(s.title, ...((s.files || []).map((f) => f && f.basename))) };
      }),
    };
  }

  // Movies joined with Insights' scenes by id: what each owns, plays, watch
  // time, O's, how far it has been watched, its numbering, its full-movie
  // files and their chapters. `legacy` maps a scene to its old [Chapter]
  // markers (Movies Toolkit 1.0), counted when there are more of them.
  const MOVIE_META = [["cover", "Cover", (g) => g.cover], ["date", "Release date", (g) => !!g.date], ["studio", "Studio", (g) => !!g.studio],
                      ["synopsis", "Synopsis", (g) => g.synopsis], ["director", "Director", (g) => g.director]];
  const MOVIE_META_ZH = { cover: "封面", date: "发行日期", studio: "工作室", synopsis: "简介", director: "导演" };
  function movieModel(groups, scenes, opts = {}) {
    const byId = scenes instanceof Map ? scenes : new Map((scenes || []).map((s) => [s.id, s]));
    const legacy = opts.legacy || new Map();
    const movies = [], inMovie = new Set(), full = new Map();
    for (const g of groups || []) {
      const own = g.scenes || [];
      let plays = 0, watch = 0, o = 0, last = 0, played = 0, started = 0, sum = 0, longest = 0;
      const files = [];
      for (const x of own) {
        inMovie.add(x.id);
        const s = byId.get(x.id), dur = s ? s.dur || 0 : 0;
        if (s) {
          plays += s.plays || 0; watch += s.playDur || 0; o += s.o || 0;
          if ((s.last || 0) > last) last = s.last;
          if (s.plays > 0) played += 1;
          if (s.plays > 0 || s.playDur > 0 || s.resume > 0) started += 1;
        }
        sum += dur; if (dur > longest) longest = dur;
        if (isFullMovieFile(dur, own.length, g.dur || 0, !!x.num)) {
          const f = { id: x.id, dur, ch: Math.max(x.ch || 0, legacy.get(x.id) || 0), old: legacy.get(x.id) || 0, movie: g.id };
          files.push(f);
          if (!full.has(x.id) || f.ch > full.get(x.id).ch) full.set(x.id, f);
        }
      }
      // the movie's length when Stash has it; else its full file, or its
      // scenes added up (a full file and its scenes would count twice)
      const runtime = g.dur || (files.length ? longest : sum);
      const year = parseInt(String(g.date || "").slice(0, 4), 10) || null;
      movies.push({ ...g, owned: own.length, plays, watch, o, last: last || null, played, started, runtime, year, files,
        state: !own.length ? "empty" : played === own.length ? "finished" : started ? "part" : "never",
        gaps: indexGaps(own.map((x) => x.idx)) });
    }
    const by = (state) => movies.filter((x) => x.state === state);
    const fullList = [...full.values()];
    const studios = new Map();
    for (const x of movies) if (x.studio) { const r = studios.get(x.studio.id) || { ...x.studio, n: 0 }; r.n += 1; studios.set(x.studio.id, r); }
    return {
      movies,
      totals: { movies: movies.length, inMovie: inMovie.size, runtime: movies.reduce((a, x) => a + x.runtime, 0),
                fullFiles: fullList.length, withChapters: fullList.filter((f) => f.ch > 0).length },
      watching: {
        finished: by("finished").sort((a, b) => (b.last || 0) - (a.last || 0)),
        part: by("part").sort((a, b) => b.played / b.owned - a.played / a.owned || (b.last || 0) - (a.last || 0)),
        never: by("never").sort((a, b) => (b.created || 0) - (a.created || 0) || a.name.localeCompare(b.name)),
        empty: by("empty"),
      },
      complete: movies.filter((x) => x.gaps.numbered && !x.gaps.n).length,
      // closest to complete first: one missing scene is the one worth finding
      incomplete: movies.filter((x) => x.gaps.n > 0).sort((a, b) => a.gaps.n - b.gaps.n || a.name.localeCompare(b.name)),
      unnumbered: movies.filter((x) => x.owned && !x.gaps.numbered).length,
      meta: MOVIE_META.map(([key, label, has]) => ({ key, label, n: movies.filter((x) => !has(x)).length })),
      studios: [...studios.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
      noStudio: movies.filter((x) => !x.studio).length,
      chapters: { files: fullList, with: fullList.filter((f) => f.ch > 0), without: fullList.filter((f) => !f.ch).sort((a, b) => b.dur - a.dur),
                  old: fullList.filter((f) => f.old > 0).length },
    };
  }

  // Your movies, ranked: plays, watch time or O's added up over their
  // scenes. Movies with nothing to rank by are left out.
  const MOVIE_CHOICES = { mrank: [["plays", "Plays"], ["watch", "Watch time"], ["o", "O's", "o"]] };
  const MOVIE_CHOICES_ZH = { mrank: [["plays", "播放次数"], ["watch", "观看时长"], ["o", "O 次数", "o"]] };
  const movieValue = (x, by) => (by === "watch" ? x.watch : by === "o" ? x.o : x.plays);
  function rankMovies(movies, by) {
    return movies.filter((x) => movieValue(x, by) > 0)
      .sort((a, b) => movieValue(b, by) - movieValue(a, by) || (b.watch - a.watch) || a.name.localeCompare(b.name));
  }

  // Movies by release year, every year from the first to the last; past 40
  // years, by decade, so the bars stay readable.
  function movieYears(movies) {
    const years = movies.map((x) => x.year).filter((y) => y > 1900);
    const undated = movies.length - years.length;
    if (!years.length) return { unit: "year", bars: [], undated };
    const lo = Math.min(...years), hi = Math.max(...years), decade = hi - lo > 40;
    const step = decade ? 10 : 1, from = decade ? lo - (lo % 10) : lo;
    const bars = [];
    for (let y = from; y <= hi; y += step) {
      const n = years.filter((v) => v >= y && v < y + step).length;
      bars.push({ label: decade ? `${y}s` : String(y), from: y, to: y + step - 1, n });
    }
    return { unit: decade ? "decade" : "year", bars, undated };
  }

  // ── 2.7: Pictures, with the Slideshow plugin ─────────────────────────────
  // Slideshow keeps in its own config, as JSON, `days` ({day: {s, n, p:
  // {performer id: [s, n]}}}, its last 120 days) and `tot` (the same for
  // all time): seconds pictures were on screen and pictures seen for the
  // first time. Read only. The card is there while Slideshow is installed
  // and enabled.
  const SLIDESHOW_ID = "Slideshow";
  function slideshowInstalled(list) {
    return Array.isArray(list) && list.some((p) => p && String(p.id) === SLIDESHOW_ID && p.enabled !== false);
  }
  // `bad`: a stored value that does not read (the card says so and shows
  // the rest); a missing one is nothing yet.
  function parseSlideshow(cfg) {
    const read = (raw) => {
      if (raw === undefined || raw === null || raw === "") return {};
      if (typeof raw === "object" && !Array.isArray(raw)) return raw;
      try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (_) { return null; }
    };
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const days = read(c.days), tot = read(c.tot);
    return { days: days || {}, tot: tot || {}, bad: days === null || tot === null };
  }
  const posNum = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
  // What the Pictures card shows: totals, this week, today, the last 30 days
  // as bars, and performers by time on their pictures, each with how many
  // of theirs were seen (counted as each was first seen) out of their image
  // count now ("340 of 1,200").
  function picturesModel(ss, now, perfById) {
    if (!ss) return null;
    const tot = ss.tot && typeof ss.tot === "object" ? ss.tot : {}, days = ss.days && typeof ss.days === "object" ? ss.days : {};
    const day = (k) => (days[k] && typeof days[k] === "object" ? days[k] : {});
    const bars = [];
    for (let i = 29; i >= 0; i--) {
      const t = addDays(dayStart(now), -i), k = dayKey(t), d = day(k);
      bars.push({ key: k, from: t, value: posNum(d.s), n: posNum(d.n) });
    }
    let week = 0, weekN = 0;
    const ws = weekStart(now);
    for (let i = 0; i < 7; i++) { const d = day(dayKey(addDays(ws, i))); week += posNum(d.s); weekN += posNum(d.n); }
    const daysViewed = Object.keys(days).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && (posNum(day(k).s) > 0 || posNum(day(k).n) > 0)).length;
    const top = Object.entries(tot.p && typeof tot.p === "object" ? tot.p : {})
      .map(([id, v]) => {
        const p = perfById ? perfById.get(String(id)) || null : null;
        return { id: String(id), s: posNum(Array.isArray(v) ? v[0] : 0), n: posNum(Array.isArray(v) ? v[1] : 0), p,
                 total: p && typeof p.images === "number" ? p.images : null };
      })
      .filter((r) => r.s > 0 || r.n > 0)
      .sort((a, b) => b.s - a.s || b.n - a.n);
    return { secs: posNum(tot.s), seen: posNum(tot.n), week, weekN, today: posNum(day(dayKey(now)).s), bars, daysViewed, top, bad: !!ss.bad };
  }

  // ── 2.8: Library to-do, the suite's hub (audit D1) ─────────────────────────
  // Each toolkit registers a connector on load, window.StashSuite.toolkits[id]
  // (every plugin script loads on every Stash page): summary() from what its
  // last scan stored, status() of its background job, scan(), run(key). The
  // hub shows one card per toolkit that is installed, enabled and has one.
  // Known ones are listed for the quiet "not installed" line; any other
  // plugin that registers shows too.
  const HUB_KNOWN = [
    ["SceneToolkit", "Scenes Toolkit", "finds details for scenes without a match"],
    ["Movies", "Movies Toolkit", "turns scenes into movies"],
    ["PerformersToolkit", "Performers Toolkit", "links performers and fills in their details"],
    ["StudiosToolkit", "Studios Toolkit", "fills in studios"],
    ["GalleriesToolkit", "Galleries Toolkit", "fills in image galleries"],
    ["TagAtlas", "Tags Toolkit", "tidies up tags"],
  ];
  // Display-only Chinese for what each toolkit does (names stay as they are:
  // they are the plugins' own).
  const HUB_KNOWN_DOES_ZH = {
    SceneToolkit: "为没有匹配的场景查找详情",
    Movies: "把场景整理成影片",
    PerformersToolkit: "关联演员并补全他们的资料",
    StudiosToolkit: "补全工作室",
    GalleriesToolkit: "补全图库",
    TagAtlas: "整理标签",
  };
  const HUB_TONES = ["ready", "look", "info"];
  // 2.8.1 (user: "toolkits need their own icons so they are easier to
  // spot"): each toolkit's own page icon (the one in its page title, copied
  // from its source) and a colour of its own. A connector may bring `icon`
  // (SVG markup, inner paths or a whole <svg>) and `color` (a palette key or
  // #rrggbb) instead; these are for today's connectors, which do not.
  const HUB_LOOK = {
    SceneToolkit: ['<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M6.5 6.2v3.6L9.7 8z"/>', "bl"],
    Movies: ['<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5 3v10M11 3v10M2.5 6h2.5M2.5 10h2.5M11 6h2.5M11 10h2.5"/>', "pu"],
    PerformersToolkit: ['<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6"/><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4.2M12 9.6c1.2.5 2 1.6 2.3 3.2"/>', "ma"],
    StudiosToolkit: ['<path d="M2.5 13.5h11M3.5 13.5V6l4.5-3 4.5 3v7.5"/><path d="M6.5 13.5V10h3v3.5"/>', "or"],
    GalleriesToolkit: ['<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 11.5l3.5-3.5 3 3 2-2 2.5 2.5"/>', "cy"],
    TagAtlas: ['<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r="1"/>', "gr"],
  };
  const HUB_DEFAULT = ['<path d="M3 4.5h10M3 8h10M3 11.5h7"/>', "ye"];
  const PALETTE = { re: "var(--sx-re)", or: "var(--sx-or)", ye: "var(--sx-ye)", gr: "var(--sx-gr)", cy: "var(--sx-cy)", bl: "var(--sx-bl)", pu: "var(--sx-pu)", ma: "var(--sx-ma)" };
  // -> { svg: the inside of a 16-grid <svg>, or a whole <svg>; color: a theme token var() or a connector's #rrggbb }
  function hubLook(id, conn) {
    const [svg0, c0] = HUB_LOOK[id] || HUB_DEFAULT;
    const own = conn && typeof conn.icon === "string" && /^\s*<(svg|path|rect|circle|g|polyline|line|ellipse|polygon)\b/i.test(conn.icon) && !/<script|\son\w+\s*=/i.test(conn.icon) ? conn.icon.trim() : "";
    const c = conn && typeof conn.color === "string" ? conn.color.trim() : "";
    const color = PALETTE[c] || (/^#[0-9a-f]{6}$/i.test(c) ? c : PALETTE[c0] || PALETTE.ye);
    return { svg: own || svg0, color };
  }
  // Which toolkits get a card. `list` is Stash's plugins [{id, enabled}]
  // (null when that read failed: then a connector alone counts, since Stash
  // loads only enabled plugins' scripts); `conns` the registered connectors.
  // Installed and on without a connector: a version older than the hub.
  function hubPresent(list, conns) {
    const has = (id) => !!(conns && conns[id] && typeof conns[id].summary === "function");
    const on = new Set(Array.isArray(list) ? list.filter((p) => p && p.enabled !== false).map((p) => String(p.id)) : []);
    const known = HUB_KNOWN.map((k) => k[0]);
    const ids = [...known, ...Object.keys(conns || {}).filter((id) => !known.includes(id)).sort()]
      .filter((id) => has(id) && (!Array.isArray(list) || on.has(id)));
    const missing = Array.isArray(list) ? HUB_KNOWN.filter(([id]) => !on.has(id)).map(([id, name, does]) => ({ id, name, does })) : [];
    const stale = Array.isArray(list) ? HUB_KNOWN.filter(([id]) => on.has(id) && !has(id)).map(([id, name]) => ({ id, name })) : [];
    return { ids, missing, stale };
  }
  // A connector's summary made safe to draw: only items with a count and a
  // known tone, ready first, then needing a look, then information; quick
  // actions first within a tone, then by count. `fix` counts what can be
  // done (ready and look), `oneClick` what a quick action does.
  function hubNorm(sum) {
    const s = sum && typeof sum === "object" ? sum : {};
    const items = (Array.isArray(s.items) ? s.items : [])
      .filter((x) => x && x.key != null && Number(x.count) > 0)
      .map((x) => {
        const a = x.action && typeof x.action === "object" ? x.action : null;
        const action = a && a.kind === "run" ? { kind: "run", label: String(a.label || tc("执行", "Do it")), confirm: String(a.confirm || "") }
          : a && a.kind === "open" && a.url ? { kind: "open", url: String(a.url) } : null;
        return { key: String(x.key), label: String(x.label || ""), count: Math.floor(Number(x.count)), tone: HUB_TONES.includes(x.tone) ? x.tone : "info",
                 action, url: x.url ? String(x.url) : action && action.kind === "open" ? action.url : "" };
      })
      .sort((a, b) => HUB_TONES.indexOf(a.tone) - HUB_TONES.indexOf(b.tone)
        || (b.action && b.action.kind === "run" ? 1 : 0) - (a.action && a.action.kind === "run" ? 1 : 0) || b.count - a.count);
    const fix = items.filter((x) => x.tone !== "info").reduce((n, x) => n + x.count, 0);
    const oneClick = items.filter((x) => x.action && x.action.kind === "run").reduce((n, x) => n + x.count, 0);
    const job = s.job && typeof s.job === "object" ? s.job : null;
    return { scannedAt: Number(s.scannedAt) || null, scanning: !!s.scanning, job, items, fix, oneClick };
  }
  function hubTotals(cards) {
    let fix = 0, oneClick = 0;
    for (const c of cards || []) if (c && c.sum) { fix += c.sum.fix; oneClick += c.sum.oneClick; }
    return { fix, oneClick };
  }
  // Cards with the most to do in one click first, then the most to do;
  // ties keep the suite's order. Cards that could not be read go last.
  function hubOrder(cards) {
    const rank = (id) => { const i = HUB_KNOWN.findIndex((k) => k[0] === id); return i < 0 ? HUB_KNOWN.length : i; };
    return (cards || []).slice().sort((a, b) => (a.sum ? 0 : 1) - (b.sum ? 0 : 1)
      || (b.sum ? b.sum.oneClick : 0) - (a.sum ? a.sum.oneClick : 0) || (b.sum ? b.sum.fix : 0) - (a.sum ? a.sum.fix : 0)
      || rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)));
  }
  // "Scan all": the toolkits picked (the picker remembers the ones left
  // out, so a toolkit installed later is in), in the order shown.
  const hubKeepLost = (was, now) => (was && was.lost && now && !now.finished && now.kind === was.kind && now.label === was.label && now.total === was.total ? was : now);
  // A toolkit busy with a job of its own is skipped (it would refuse).
  const hubQueue = (ids, skip, busy) => (ids || []).filter((id) => !(skip || []).includes(id) && !(busy || []).includes(id));
  // The chips under Scan all (2.8.1; was a "Choose" popover the user found
  // finicky): each on unless left out, busy ones shown and skipped, and the
  // button's words follow what a click would scan.
  function hubPick(ids, skip, busy) {
    const all = ids || [], scan = hubQueue(all, skip, busy);
    const rows = all.map((id) => ({ id, on: !(skip || []).includes(id), busy: (busy || []).includes(id) }));
    const label = !scan.length ? tc("选择要扫描的工具箱", "Pick a toolkit to scan") : scan.length === all.length ? tc("全部扫描", "Scan all")
      : tc(`扫描 ${fmtN(scan.length)} 个工具箱`, `Scan ${scan.length} toolkit${scan.length === 1 ? "" : "s"}`);
    return { rows, scan, label };
  }
  // Where each scan in a "Scan all" is. Entries: {id, state} with state
  // waiting (not asked yet), starting, started (its job is `job`),
  // nothing (no job: nothing to scan, or a toolkit without background
  // scans) or error. Stash runs its tasks one after another in the order
  // they were queued, so the first started scan not finished is running
  // and the rest wait in Stash's queue.
  function hubQueueView(queue) {
    let running = false, done = 0;
    const rows = (queue || []).map((e) => {
      let st = e.state;
      if (st === "started") {
        if (e.job && e.job.finished) st = e.job.lost ? "lost" : "done";
        else if (!running) { st = "running"; running = true; }
        else st = "queued";
      }
      if (["done", "lost", "nothing", "error"].includes(st)) done += 1;
      return { id: e.id, state: st, job: e.job || null, msg: e.msg || "" };
    });
    const current = rows.find((r) => r.state === "running" || r.state === "starting") || null;
    return { rows, done, total: rows.length, active: done < rows.length, current: current ? current.id : null };
  }

  if (window.__INSIGHTS_I18N_TEST__) {
    window.__InsightsI18nTest = { suiteData, DATA_KEYS, slideshowInstalled, parseSlideshow, picturesModel, moviesInstalled, parseMovieSetting, moviesShown, chapterCount, isFullMovieFile, numberedScene, indexGaps,
      compactGroup, movieModel, MOVIE_CHOICES, rankMovies, movieYears, FULL_MOVIE_SEC,
      parseSettings, CHOICES, choices, choice, performerReach, collectPlays, activity,
      dayKey, parseDay, daysBetween, weekStart, toMs, fmtDur, fmtBytes, collectOs, countByDay,
      streaks, recordDay, periodBars, calendar, weekdayHour, dayEvents, cupOf, heightGroup, weightGroup, ageAt,
      ageGroup, careerGroup, naturalGroup, flagOf, lengthGroup, resolutionGroup, eraGroup, castGroup,
      PERFORMER_TRAITS, SCENE_TRAITS, traitRows, liftTone, performerTable, topScenes, library, ratingBands,
      backlog, BACKLOG, encodeCriterion, listUrl, watchPerO, mergeOStats, addWatch, yesNo,
      countryCode, codecName, containerName, resBucket, fpsBucket, shapeOf, percentile, fileStats, upgrades, spaceHogs,
      healthScore, gradeOf, rawAge, dateConflicts, sameNames, futureDates, growth, tagCounts, coTags, networks,
      pairs, newFaces, ageCounts, notable, nonstop,
      isEfficient, dupChoose, mergeValues, notEfficient, isOrdinal, ordinalKey, strength, rankTraits, liftPos,
      sceneTotals, totalsMatch, activityDiff, mergeScenes, parseLockdown, lockdownModel,
      codecTier, isPoor, tierColor, TIER_COLOR, audioColor, RES_COLOR, CODEC_RANK, nextConfig, withWatch, moviesRenamed,
      mvUrl, toolkitTab, refreshStash,
      HUB_KNOWN, hubPresent, hubNorm, hubTotals, hubOrder, hubQueue, hubQueueView, hubKeepLost, HUB_LOOK, hubLook, hubPick };
    return;
  }

  // ═══ Stash ═════════════════════════════════════════════════════════════════

  async function gql(query, variables, keepalive) {
    const res = await fetch("/graphql", {
      method: "POST", credentials: "same-origin", keepalive: !!keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`Stash returned ${res.status}${res.status === 401 ? ": logged out?" : ""}`); }
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    return json?.data ?? null;
  }

  // Ask Stash which fields it has and request only those, so an older or
  // newer Stash without, say, career_start still loads.
  const typeFields = new Map();
  async function fieldsOf(type) {
    if (typeFields.has(type)) return typeFields.get(type);
    let names = new Set();
    try {
      const d = await gql(`query ($t: String!) { __type(name: $t) { fields { name } } }`, { t: type });
      names = new Set((d?.__type?.fields || []).map((f) => f.name));
    } catch (e) { log(`Schema read failed for ${type}: ${e.message}`); }
    typeFields.set(type, names);
    return names;
  }
  const pick = (have, list) => list.filter((f) => have.has(f.split(/[\s{]/)[0])).join(" ");

  const SCENE_WANT = ["id", "title", "date", "created_at", "rating100", "organized", "o_counter", "o_history",
    "play_count", "play_duration", "play_history", "last_played_at", "resume_time", "interactive",
    "paths { screenshot }", "studio { id name }", "tags { id name }", "performers { id }"];
  // Files are asked for field by field too: frame_rate, bit_rate and
  // fingerprints are not in every Stash.
  const FILE_WANT = ["duration", "size", "width", "height", "video_codec", "audio_codec", "frame_rate", "bit_rate", "format",
    "basename", "fingerprints { type }"];
  const PERF_WANT = ["id", "name", "disambiguation", "gender", "birthdate", "country", "ethnicity", "hair_color", "eye_color",
    "height_cm", "weight", "measurements", "fake_tits", "tattoos", "piercings", "career_start", "career_length",
    "favorite", "rating100", "image_path", "scene_count", "image_count", "gallery_count", "tags { id name }"];
  // Bumped when a performer gains a field (2: image and gallery counts), so
  // the next check reads the performers again rather than waiting for one
  // of them to be edited.
  const PERF_V = 2;

  function compactScene(s) {
    const files = s.files || [];
    const f = files[0] || {};
    return {
      id: String(s.id), title: s.title || f.basename || tc(`场景 ${s.id}`, `Scene ${s.id}`), date: s.date || null,
      created: toMs(s.created_at), rating: s.rating100 ?? null, organized: !!s.organized, o: s.o_counter || 0,
      oh: s.o_history || [], plays: s.play_count || 0, playDur: s.play_duration || 0, ph: s.play_history || [],
      last: toMs(s.last_played_at), resume: s.resume_time || 0, interactive: !!s.interactive,
      dur: f.duration || 0, shot: s.paths?.screenshot || null,
      // size is every file (what the scene takes on disk); fsize and the
      // rest describe the first file, the one Stash plays.
      size: files.reduce((a, x) => a + (x.size || 0), 0), fsize: f.size || 0, nfiles: files.length,
      w: f.width || 0, h: f.height || 0, vc: f.video_codec || "", ac: f.audio_codec || "", fps: f.frame_rate || 0,
      br: f.bit_rate || 0, fmt: files.length ? containerName(f.format, f.basename) : "",
      phash: f.fingerprints ? f.fingerprints.some((x) => x.type === "phash") : null,
      studio: s.studio ? { id: String(s.studio.id), name: s.studio.name } : null,
      tags: (s.tags || []).map((t) => [String(t.id), t.name]), perf: (s.performers || []).map((p) => String(p.id)),
    };
  }
  function compactPerformer(p) {
    return {
      id: String(p.id), name: p.name, disamb: p.disambiguation || "", gender: p.gender || null, birth: p.birthdate || null,
      country: p.country || null, ethnicity: p.ethnicity || null, hair: p.hair_color || null, eyes: p.eye_color || null,
      height: p.height_cm || null, weight: p.weight || null, measurements: p.measurements || null,
      fake: p.fake_tits || null, tattoos: p.tattoos ?? null, piercings: p.piercings ?? null,
      careerStart: p.career_start || (p.career_length ? String(p.career_length).slice(0, 4) : null),
      fav: !!p.favorite, rating: p.rating100 ?? null, image: p.image_path || null, sceneCount: p.scene_count || 0,
      images: p.image_count ?? null, galleries: p.gallery_count ?? null,
      tags: (p.tags || []).map((t) => [String(t.id), t.name]),
    };
  }

  // The scene fields this Stash has: everything Insights uses, and the few
  // that say a scene was played or O'd since the last read.
  let sceneSel = null;
  async function sceneFields() {
    if (sceneSel) return sceneSel;
    const have = await fieldsOf("Scene");
    const ff = pick(await fieldsOf("VideoFile"), FILE_WANT);
    sceneSel = { full: pick(have, SCENE_WANT) + (have.has("files") && ff ? ` files { ${ff} }` : ""),
                 light: pick(have, ["id", "o_counter", "play_count", "play_duration", "resume_time"]) };
    return sceneSel;
  }
  // Scenes in full: all of them, the ones a scene filter picks, or a list of
  // ids. Pages of 500 keep each response modest even with long histories.
  async function readScenes(where, progress) {
    const { full } = await sceneFields();
    const out = [];
    if (where && where.ids) {
      for (let i = 0; i < where.ids.length; i += 500) {
        const d = await gql(`query ($ids: [ID!], $f: FindFilterType) { findScenes(ids: $ids, filter: $f) { scenes { ${full} } } }`,
                            { ids: where.ids.slice(i, i + 500), f: { per_page: -1 } });
        for (const x of d?.findScenes?.scenes || []) out.push(compactScene(x));
        if (progress) progress(tc(`正在读取改动的场景… ${fmtN(out.length)} / ${fmtN(where.ids.length)}`, `reading changed scenes… ${fmtN(out.length)} of ${fmtN(where.ids.length)}`));
      }
      return out;
    }
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType, $sf: SceneFilterType) { findScenes(filter: $f, scene_filter: $sf) { count scenes { ${full} } } }`,
                          { f: { page, per_page: 500, sort: "id", direction: "ASC" }, sf: where || null });
      const r = d?.findScenes;
      for (const x of r?.scenes || []) out.push(compactScene(x));
      if (progress) progress(tc(`${where ? "正在读取改动的场景" : "正在读取你的场景"}… ${fmtN(out.length)} / ${fmtN(r?.count || 0)}`, `${where ? "reading changed scenes" : "Reading your scenes"}… ${fmtN(out.length)} of ${fmtN(r?.count || 0)}`));
      if (!r || !r.scenes.length || out.length >= r.count) break;
    }
    return out;
  }
  // Every scene, but only what moves when it is played or O'd: about a tenth
  // of a full read.
  async function readLight(progress) {
    const { light } = await sceneFields();
    const out = [];
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType) { findScenes(filter: $f) { count scenes { ${light} } } }`,
                          { f: { page, per_page: 5000, sort: "id", direction: "ASC" } });
      const r = d?.findScenes;
      for (const x of r?.scenes || []) out.push({ id: String(x.id), o: x.o_counter || 0, plays: x.play_count || 0, playDur: x.play_duration || 0, resume: x.resume_time || 0 });
      if (progress) progress(tc(`正在核对播放与 O… ${fmtN(out.length)} / ${fmtN(r?.count || 0)}`, `checking plays and O's… ${fmtN(out.length)} of ${fmtN(r?.count || 0)}`));
      if (!r || !r.scenes.length || out.length >= r.count) break;
    }
    return out;
  }
  async function readPerformers(progress) {
    const pf = pick(await fieldsOf("Performer"), PERF_WANT);
    const out = [];
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType) { findPerformers(filter: $f) { count performers { ${pf} } } }`,
                          { f: { page, per_page: 1000, sort: "id", direction: "ASC" } });
      const r = d?.findPerformers;
      for (const x of r?.performers || []) out.push(compactPerformer(x));
      if (progress) progress(tc(`正在读取演员… ${fmtN(out.length)} / ${fmtN(r?.count || 0)}`, `Reading performers… ${fmtN(out.length)} of ${fmtN(r?.count || 0)}`));
      if (!r || !r.performers.length || out.length >= r.count) break;
    }
    return out;
  }
  async function readStudios() {
    const stf = pick(await fieldsOf("Studio"), ["id", "name", "parent_studio { id }"]);
    const out = [];
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType) { findStudios(filter: $f) { count studios { ${stf} } } }`,
                          { f: { page, per_page: 1000, sort: "id", direction: "ASC" } });
      const r = d?.findStudios;
      for (const x of r?.studios || []) out.push({ id: String(x.id), name: x.name, parent: x.parent_studio ? String(x.parent_studio.id) : null });
      if (!r || !r.studios.length || out.length >= r.count) break;
    }
    return out;
  }

  // Movies (2.5): every group in one read, with each scene's id, its place
  // in the movie and its chapters field; plays, O's and lengths come from
  // the scenes Insights already has. About 500 groups read in under a second
  // on the user's Stash, so this is read again on every check rather than
  // worked into the scene sync (whose updated_at test cannot see a scene
  // being added to a group from the group's side). null: no groups here.
  const GROUP_WANT = ["id", "name", "date", "duration", "director", "synopsis", "created_at", "front_image_path", "studio { id name }"];
  async function readMovies() {
    const gf = await fieldsOf("Group");
    if (!gf.has("scenes")) return null;
    const sf = await fieldsOf("Scene");
    const inner = pick(sf, ["id", "title", "files { basename }", "custom_fields", "groups { group { id } scene_index }"]);
    const d = await gql(`query { findGroups(filter: {per_page: -1, sort: "name", direction: ASC}) { groups { ${pick(gf, GROUP_WANT)} scenes { ${inner} } } } }`);
    return { at: Date.now(), groups: (d?.findGroups?.groups || []).map(compactGroup), legacy: await readChapterMarkers() };
  }
  // Movies Toolkit 1.0 kept chapters as scene markers tagged "[Chapter]";
  // 1.1 moves them into the field. Until that move is made they still count:
  // two small reads, nothing when the tag is not there.
  async function readChapterMarkers() {
    try {
      const t = await gql(`query { findTags(tag_filter: {name: {value: "[Chapter]", modifier: EQUALS}}, filter: {per_page: 5}) { tags { id name } } }`);
      const tag = (t?.findTags?.tags || []).find((x) => String(x.name).toLowerCase() === "[chapter]");
      if (!tag) return {};
      const d = await gql(`query ($t: [ID!]) { findSceneMarkers(scene_marker_filter: {tags: {value: $t, modifier: INCLUDES}}, filter: {per_page: -1}) { scene_markers { scene { id } } } }`,
                          { t: [String(tag.id)] });
      const out = {};
      for (const x of d?.findSceneMarkers?.scene_markers || []) { const id = String(x.scene.id); out[id] = (out[id] || 0) + 1; }
      return out;
    } catch (_) { return {}; }
  }
  // Which plugins Stash has, to know whether Movies Toolkit is there. null
  // on failure, so a hiccup never hides the tab. An older Stash without
  // `enabled` is asked for ids alone.
  async function readInstalled() {
    for (const q of ["query { plugins { id enabled } }", "query { plugins { id } }"]) {
      try { const d = await gql(q); if (Array.isArray(d?.plugins)) return d.plugins; } catch (_) {}
    }
    return null;
  }

  // Everything, once: the first visit, or Refresh. `at` is when it finished
  // (what the header shows); `since` when it began, so the next check asks
  // for anything changed after that.
  async function loadLibrary(progress) {
    const started = Date.now();
    const scenes = await readScenes(null, progress);
    const performers = await readPerformers(progress);
    const studios = await readStudios();
    progress(tc("正在统计已填写的项目…", "Counting what is filled in…"));
    const [counts, stats] = await Promise.all([loadCounts(), loadStats()]);
    return { at: Date.now(), since: started, pv: PERF_V, scenes, performers, studios, counts, stats };
  }

  // Brings a cached read up to date by reading only what changed (2.3). Plays
  // and O's do not move a scene's updated_at (checked on a real Stash: a scene
  // with an O on Oct 11 still said May), so: Stash's totals and what was
  // edited since are asked first, and when nothing moved that is the whole
  // check. Otherwise the scenes edited or played since are read in full; if
  // the totals still disagree (an O without a play, time watched without a
  // new play, a deleted scene) a light pass over every scene finds the rest.
  // Performers, studios and the health counts are small and read again.
  // Clocks: `since` is the browser's, updated_at the server's; the margin
  // covers a few minutes between them (reading a scene twice costs nothing).
  const SINCE_MARGIN = 10 * 60000;
  async function syncLibrary(data, progress) {
    const started = Date.now();
    const since = new Date((data.since || data.at || 0) - SINCE_MARGIN).toISOString();
    const after = { value: since, modifier: "GREATER_THAN" };
    const [stats, probe] = await Promise.all([loadStats(), gql(`query ($t: TimestampCriterionInput) {
      s: findScenes(scene_filter: {updated_at: $t}, filter: {per_page: 0}) { count }
      p: findPerformers(performer_filter: {updated_at: $t}, filter: {per_page: 0}) { count }
      st: findStudios(studio_filter: {updated_at: $t}, filter: {per_page: 0}) { count } }`, { t: after })]);
    const people = (probe?.p?.count || 0) + (probe?.st?.count || 0) || stats.performer_count !== data.performers.length ||
      stats.studio_count !== (data.studios || []).length || data.pv !== PERF_V;
    if (!probe?.s?.count && !people && totalsMatch(sceneTotals(data.scenes), stats)) {
      return { data: { ...data, at: Date.now(), since: started, stats }, changed: 0 };
    }
    let scenes = data.scenes;
    const changed = new Set();
    if (probe?.s?.count || !totalsMatch(sceneTotals(scenes), stats)) {
      const fresh = (await readScenes({ updated_at: after }, progress)).concat(await readScenes({ last_played_at: after }, progress));
      fresh.forEach((x) => changed.add(x.id));
      scenes = mergeScenes(scenes, fresh, []);
      if (!totalsMatch(sceneTotals(scenes), stats)) {
        const { changed: more, gone } = activityDiff(scenes, await readLight(progress));
        more.forEach((id) => changed.add(id));
        gone.forEach((id) => changed.add(id));
        scenes = mergeScenes(scenes, more.length ? await readScenes({ ids: more }, progress) : [], gone);
      }
    }
    progress(tc("正在读取演员和工作室…", "reading performers and studios…"));
    const [performers, studios, counts] = await Promise.all([readPerformers(), readStudios(), loadCounts()]);
    return { data: { at: Date.now(), since: started, pv: PERF_V, scenes, performers, studios, counts, stats }, changed: changed.size };
  }

  // Metadata health is counted by Stash itself, with the same "is missing"
  // filters the rows link to, so a number and the list it opens always
  // agree, and nothing like scene details has to be downloaded to count it.
  // A filter an older Stash does not know just leaves its row out.
  const COUNTS = [
    ["s.title", "Scene", '{is_missing: "title"}'], ["s.date", "Scene", '{is_missing: "date"}'],
    ["s.studio", "Scene", '{is_missing: "studio"}'], ["s.performers", "Scene", '{is_missing: "performers"}'],
    ["s.tags", "Scene", '{is_missing: "tags"}'], ["s.details", "Scene", '{is_missing: "details"}'],
    ["s.url", "Scene", '{is_missing: "url"}'], ["s.stash_id", "Scene", '{is_missing: "stash_id"}'],
    ["s.cover", "Scene", '{is_missing: "cover"}'], ["s.organized", "Scene", "{organized: false}"],
    ["s.markers", "Scene", '{has_markers: "true"}'], ["s.group", "Scene", '{is_missing: "group"}'],
    ["p.image", "Performer", '{is_missing: "image"}'], ["p.gender", "Performer", '{is_missing: "gender"}'],
    ["p.birthdate", "Performer", '{is_missing: "birthdate"}'], ["p.country", "Performer", '{is_missing: "country"}'],
    ["p.height", "Performer", '{is_missing: "height"}'], ["p.measurements", "Performer", '{is_missing: "measurements"}'],
    ["p.stash_id", "Performer", '{is_missing: "stash_id"}'], ["p.url", "Performer", '{is_missing: "url"}'],
    ["p.noscenes", "Performer", "{scene_count: {value: 0, modifier: EQUALS}}"],
    ["st.image", "Studio", '{is_missing: "image"}'], ["st.stash_id", "Studio", '{is_missing: "stash_id"}'],
    ["st.url", "Studio", '{is_missing: "url"}'], ["st.noscenes", "Studio", "{scene_count: {value: 0, modifier: EQUALS}}"],
  ];
  // Tags used on one scene are counted from the scenes instead (`buildModel`):
  // Stash took 17 s for that one filter on 21,000 scenes, the rest under 1 s.
  const FIND = { Scene: ["findScenes", "scene_filter"], Performer: ["findPerformers", "performer_filter"],
                 Studio: ["findStudios", "studio_filter"], Tag: ["findTags", "tag_filter"] };
  async function loadCounts() {
    const field = ([, type, f], i) => `c${i}: ${FIND[type][0]}(${FIND[type][1]}: ${f}, filter: {per_page: 1}) { count }`;
    const out = {};
    try {
      const d = await gql(`query { ${COUNTS.map(field).join(" ")} }`);
      COUNTS.forEach(([k], i) => { out[k] = d?.[`c${i}`]?.count ?? null; });
      return out;
    } catch (e) {
      log(`Counts in one go failed (${e.message}); one at a time`);
    }
    await Promise.all(COUNTS.map(async (c, i) => {
      try { out[c[0]] = (await gql(`query { ${field(c, i)} }`))?.[`c${i}`]?.count ?? null; }
      catch (_) { out[c[0]] = null; }
    }));
    return out;
  }
  async function loadStats() {
    const f = pick(await fieldsOf("StatsResultType"), ["scene_count", "scenes_size", "scenes_duration", "image_count", "images_size",
      "gallery_count", "performer_count", "studio_count", "group_count", "movie_count", "tag_count",
      "total_o_count", "total_play_count", "total_play_duration"]);
    if (!f) return {};
    try { return (await gql(`query { stats { ${f} } }`))?.stats || {}; } catch (_) { return {}; }
  }

  // Stash's own phash match, exact, run only when asked: it is the one
  // heavy query here. duration_diff is newer than findDuplicateScenes.
  async function loadDuplicates() {
    const ff = pick(await fieldsOf("VideoFile"), ["id", "size", "width", "height", "video_codec", "bit_rate", "duration", "basename"]);
    const q = (diff) => `query { findDuplicateScenes(distance: 0${diff ? ", duration_diff: 1" : ""}) { id title o_counter play_count paths { screenshot } files { ${ff} } } }`;
    let d;
    try { d = await gql(q(true)); } catch (_) { d = await gql(q(false)); }
    return (d?.findDuplicateScenes || []).map((g) => g.map((s) => {
      const f = (s.files || [])[0] || {};
      return { id: String(s.id), title: s.title || f.basename || tc(`场景 ${s.id}`, `Scene ${s.id}`), o: s.o_counter || 0, plays: s.play_count || 0,
               shot: s.paths?.screenshot || null, fsize: (s.files || []).reduce((a, x) => a + (x.size || 0), 0),
               w: f.width || 0, h: f.height || 0, vc: f.video_codec || "", br: f.bit_rate || 0, dur: f.duration || 0,
               fid: f.id ? String(f.id) : null, nfiles: (s.files || []).length };
    }));
  }

  // ═══ Writes (Actions tab only, each one on a click) ═══════════════════════

  // Input types list inputFields, not fields.
  const inputFields = new Map();
  async function inputFieldsOf(type) {
    if (inputFields.has(type)) return inputFields.get(type);
    let names = new Set();
    try {
      const d = await gql(`query ($t: String!) { __type(name: $t) { inputFields { name } } }`, { t: type });
      names = new Set((d?.__type?.inputFields || []).map((f) => f.name));
    } catch (e) { log(`Schema read failed for ${type}: ${e.message}`); }
    inputFields.set(type, names);
    return names;
  }

  const MERGE_WANT = ["id", "title", "code", "details", "director", "date", "rating100", "organized", "urls", "studio { id }",
    "tags { id }", "performers { id }", "galleries { id }", "groups { group { id } scene_index }", "stash_ids { endpoint stash_id }",
    "files { id }"];
  // Everything a merge carries over, read fresh at the moment of the merge
  // (not from the scan, which may be minutes old).
  async function loadForMerge(ids) {
    const sf = pick(await fieldsOf("Scene"), MERGE_WANT);
    const d = await gql(`query { ${ids.map((id, i) => `s${i}: findScene(id: ${JSON.stringify(String(id))}) { ${sf} }`).join(" ")} }`);
    return ids.map((_, i) => d?.[`s${i}`] || null);
  }

  // One duplicate group. With `merge`, the copies are merged into the kept
  // scene first (Stash's sceneMerge: their files, markers, O and play
  // history move over, the copy scenes go; tags, performers and the rest are
  // carried in `values`), then exactly the files that came from the copies
  // are deleted from disk. Without it, the copy scenes and their files are
  // deleted outright. Refuses if anything changed since the scan.
  async function removeCopies(keep, drops, merge) {
    const fresh = await loadForMerge([keep.id].concat(drops.map((s) => s.id)));
    const [k, ...ds] = fresh;
    if (!k) throw new Error(tc("要保留的场景已经不在了", "the scene to keep is gone"));
    if (ds.some((x) => !x)) throw new Error(tc("有一份副本已经不在了", "a copy is already gone"));
    if (keep.fid && String((k.files || [])[0]?.id) !== keep.fid) throw new Error(tc("要保留的场景，其文件在扫描之后变过了", "the kept scene's file changed since the scan"));
    const fileIds = ds.flatMap((x) => (x.files || []).map((f) => String(f.id)));
    if (!merge) {
      await gql(`mutation ($i: ScenesDestroyInput!) { scenesDestroy(input: $i) }`,
                { i: { ids: ds.map((x) => String(x.id)), delete_file: true, delete_generated: true } });
      return fileIds.length;
    }
    const have = await inputFieldsOf("SceneUpdateInput");
    const values = mergeValues(k, ds, have.size ? have : null);
    await gql(`mutation ($i: SceneMergeInput!) { sceneMerge(input: $i) { id } }`,
              { i: { source: ds.map((x) => String(x.id)), destination: String(k.id), values, play_history: true, o_history: true } });
    if (fileIds.length) await gql(`mutation ($ids: [ID!]!) { deleteFiles(ids: $ids) }`, { ids: fileIds });
    return fileIds.length;
  }

  // After a write that changes what Stash shows, Stash's own pages refetch
  // what they have on screen (Apollo's active queries, QuickTools'
  // refetch()), and scenes merged or deleted away leave its cache, or its
  // lists kept showing them until a reload (MAINTENANCE §3.2, audit A9).
  // Never fatal: without a client Stash shows the change on the next load.
  function apolloClient() {
    try {
      const api = window.PluginApi;
      const svc = api?.utils?.StashService;
      if (typeof svc?.getClient === "function") return svc.getClient();
      if (typeof api?.utils?.getClient === "function") return api.utils.getClient();
      if (svc?.client) return svc.client;
    } catch (e) { log(`Apollo lookup failed: ${e.message}`); }
    return null;
  }
  function refreshStash(goneSceneIds = []) {
    const client = apolloClient();
    if (!client) { log("No Apollo client exposed; Stash's pages update on reload"); return false; }
    try {
      if (goneSceneIds.length && client.cache) {
        for (const id of goneSceneIds) client.cache.evict({ id: client.cache.identify({ __typename: "Scene", id: String(id) }) });
        client.cache.gc();
      }
    } catch (e) { log(`Cache evict failed: ${e.message}`); }
    try {
      const r = client.refetchQueries({ include: "active" });
      if (r && typeof r.catch === "function") r.catch((e) => log(`refetchQueries failed: ${e.message}`));
    } catch (e) { log(`refetchQueries failed: ${e.message}`); }
    return true;
  }

  // QuickTools' D tag, so "Marked for Delete" here is the same tag there.
  async function deleteTagName() {
    try {
      const p = (await gql(`query { configuration { plugins } }`))?.configuration?.plugins || {};
      return (p.QuickTools && String(p.QuickTools.deleteTagName || "").trim()) || "Marked for Delete";
    } catch (_) { return "Marked for Delete"; }
  }
  async function tagId(name) {
    const d = await gql(`query ($f: TagFilterType) { findTags(tag_filter: $f, filter: {per_page: 5}) { tags { id name } } }`,
                        { f: { name: { value: name, modifier: "EQUALS" } } });
    const hit = (d?.findTags?.tags || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit) return String(hit.id);
    const c = await gql(`mutation ($i: TagCreateInput!) { tagCreate(input: $i) { id } }`, { i: { name } });
    return String(c.tagCreate.id);
  }
  // ADD mode: every other tag on these scenes rides through (rule 5).
  async function tagScenes(ids, name) {
    const id = await tagId(name);
    try {
      for (let i = 0; i < ids.length; i += 500) {
        await gql(`mutation ($i: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $i) { id } }`,
                  { i: { ids: ids.slice(i, i + 500).map(String), tag_ids: { mode: "ADD", ids: [id] } } });
      }
    } finally { refreshStash(); }   // also after a part went through (and the tag may be new)
  }
  async function generatePhashes(ids) {
    const d = await gql(`mutation ($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }`,
                        { i: { phashes: true, sceneIDs: ids.map(String) } });
    return d?.metadataGenerate || null;
  }

  // ── Cache: IndexedDB, shown at once and then brought up to date ──────────
  // localStorage is too small for a library with its histories (O Stats hit
  // the quota); IndexedDB is not. Any failure just means no cache. Up to 2.2
  // an entry older than 30 minutes was thrown away and the whole library read
  // again before anything showed; since 2.3 any entry is shown and synced.
  // v2 added files, studios and counts; a v1 entry would load without them.
  const CACHE_KEY = "v2";
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("insightsI18n", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("lib");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  // The movies (2.5) are kept beside it under their own key, so the Movies
  // tab opens at once too.
  const MOVIES_KEY = "movies1";
  async function cacheGet(key = CACHE_KEY) {
    try {
      const db = await idb();
      return await new Promise((resolve) => {
        const r = db.transaction("lib").objectStore("lib").get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }
  async function cachePut(v, key = CACHE_KEY) {
    try {
      const db = await idb();
      db.transaction("lib", "readwrite").objectStore("lib").put(v, key);
    } catch (e) { log(`Cache write failed: ${e.message}`); }
  }

  // ── Suite Data client: the same in every plugin that keeps data (checked
  // by scripts/check_shared.py; MAINTENANCE §4.24) ────────────────────────
  // Stash's Settings page re-saves every plugin's config from the copy it
  // loaded when it opened, so data written since can be rolled back (§6
  // "All"). With the Suite Data plugin installed and enabled the data keys
  // (o.keys) live in its store instead: files outside every plugin folder, a
  // revision per key, a write based on an old revision refused so the change
  // is run again on what is there now. Settings stay in the plugin config.
  // Without Suite Data everything stays in the config, as before.
  //   o: { id, keys, gql, readConfig(), writeConfig(map, opt), notify(text), label }
  //   read(map?)           the plugin's map: its config (or the one given, read
  //                        with other things), the stored keys over it
  //   update(fn, opt)      one at a time; fn(copy) returns the whole new map
  //                        (null: nothing to write; throw: refuse), as before;
  //                        opt.mirror: rewrite the copy now; opt reaches writeConfig
  //                        (the copy itself is written with {copy: true})
  //   overlay(id, map)     another plugin's map with its stored keys over it
  //   mode()               "store", "config", or "mirror" (Suite Data off or
  //                        not answering after it held this plugin's data)
  // The first time a plugin sees Suite Data its data keys are copied in
  // (base revision 0: never over something already there; the config keeps
  // its copy, rule 5). From then on the store is the original and the config
  // a copy (the mirror), rewritten when the store is ahead of it, at most
  // every MIRROR_MS or at once with {mirror: true}: uninstalling Suite Data
  // still leaves a recent copy. A change made in the config while Suite Data
  // was off is marked and taken back into the store when it answers again;
  // if the store moved on too, the store's version stays and the other
  // becomes one of its backups (Your data restores it).
  function suiteData(o) {
    const MARK = "suiteDataMirror", MIRROR_MS = o.mirrorMs || 5 * 60 * 1000, TRIES = 6;
    const name = o.label || o.id;
    const S = { inst: null, err: false, syncing: null, revs: {}, vals: {}, loaded: false, at: 0, mrevs: {}, timer: 0, told: "", chain: Promise.resolve() };
    const own = (k) => o.keys.indexOf(k) >= 0;
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    const mark = (m) => { try { const v = JSON.parse((m && m[MARK]) || "null"); return v && typeof v === "object" ? v : null; } catch (_) { return null; } };
    const tell = (text) => { if (S.told !== text) { S.told = text; try { if (o.notify) o.notify(text); } catch (_) {} } };
    async function op(args) {
      const d = await o.gql(`mutation ($a: Map) { runPluginOperation(plugin_id: "SuiteData", args: $a) }`, { a: args });
      const r = d && d.runPluginOperation;
      if (!r || typeof r !== "object") throw new Error("Suite Data did not answer");
      return r;
    }
    // Installed and enabled? Asked once per page for every plugin; a failed
    // ask counts as "not installed" and is asked again after a minute.
    function installed() {
      const w = typeof window !== "undefined" ? window : {};
      const p = w.__suiteDataProbe;
      if (p && (p.ok || Date.now() - p.at < 60000)) return p.promise;
      const rec = { at: Date.now(), ok: false, promise: null };
      rec.promise = Promise.resolve().then(() => o.gql(`query { plugins { id enabled } }`)).then((d) => {
        rec.ok = true;
        const me = ((d && d.plugins) || []).find((x) => x && x.id === "SuiteData");
        return !!(me && me.enabled !== false);
      }).catch(() => false);
      w.__suiteDataProbe = rec;
      return rec.promise;
    }
    function absorb(items) {
      Object.keys(items || {}).forEach((k) => {
        if (!own(k)) return;
        const it = items[k];
        if (it && typeof it.rev === "number") { S.revs[k] = it.rev; S.vals[k] = it.value; }
        else { delete S.revs[k]; delete S.vals[k]; }
      });
    }
    function over(mine) {
      const m = { ...mine };
      o.keys.forEach((k) => {
        if (!S.revs[k]) return;
        if (S.vals[k] === null || S.vals[k] === undefined) delete m[k]; else m[k] = S.vals[k];
      });
      return m;
    }
    async function put(items, by) {
      const r = await op({ mode: "put", plugin: o.id, items: JSON.stringify(items), by: by || name });
      if (r.ok) Object.keys(items).forEach((k) => { S.revs[k] = r.revs[k]; S.vals[k] = items[k].value; });
      else absorb(r.conflict);
      return !!r.ok;
    }
    // First contact: read the store, copy in what it lacks, take back what
    // was changed in the config while Suite Data was off.
    async function sync(mine) {
      absorb((await op({ mode: "get", plugin: o.id, keys: JSON.stringify(o.keys) })).items);
      const mk = mark(mine), fresh = {}, back = [];
      o.keys.forEach((k) => {
        if (mine[k] === undefined) return;
        if (!S.revs[k]) fresh[k] = { value: mine[k], base: 0 };
        else if (mk && mk.dirty && !same(mine[k], S.vals[k])) back.push(k);
      });
      if (Object.keys(fresh).length && !(await put(fresh, "copied from the plugin settings"))) {
        // another tab copied first: what it wrote stands, the rest goes in
        const left = {};
        Object.keys(fresh).forEach((k) => { if (!S.revs[k]) left[k] = fresh[k]; });
        if (Object.keys(left).length) await put(left, "copied from the plugin settings");
      }
      for (const k of back) {
        const base = S.revs[k], theirs = S.vals[k];
        if (mk.revs && mk.revs[k] === base) {
          await put({ [k]: { value: mine[k], base } }, "changed while Suite Data was off");
        } else {
          // both moved on: the store's version stays, the other is a backup
          if (await put({ [k]: { value: mine[k], base } }, "kept from the plugin settings"))
            await put({ [k]: { value: theirs, base: S.revs[k] } }, "store version kept");
          tell(`${name}: ${tc("在 Suite Data 关闭期间所做的更改已作为备份保留（Suite Data，Your data）。", "changes made while Suite Data was off were kept as a backup (Suite Data, Your data).")}`);
        }
      }
      S.at = (mk && !mk.dirty && mk.at) || 0;
      S.mrevs = (mk && !mk.dirty && mk.revs) || {};
      S.loaded = true;
    }
    // one first contact at a time (a page reads several things at once)
    function ensure(mine) {
      if (!S.syncing) S.syncing = sync(mine).then(() => { S.syncing = null; }, (e) => { S.syncing = null; throw e; });
      return S.syncing;
    }
    // Rewrite the copy in the config when the store is ahead of it.
    function plan(now) {
      if (!o.keys.some((k) => S.revs[k] && S.revs[k] !== S.mrevs[k])) return;
      const due = S.at + MIRROR_MS - Date.now();
      if (now || due <= 0) { if (S.timer) clearTimeout(S.timer); S.timer = 0; Promise.resolve().then(mirror); }
      else if (!S.timer) S.timer = setTimeout(() => { S.timer = 0; mirror(); }, due);
    }
    function mirror() {
      const run = S.chain.then(async () => {
        if (!S.loaded || S.err) return;
        const next = over(await o.readConfig());
        const revs = { ...S.revs };
        next[MARK] = JSON.stringify({ at: Date.now(), revs });
        await o.writeConfig(next, { copy: true });   // the mirror itself: a plugin may skip its refetch
        S.at = Date.now();
        S.mrevs = revs;
      });
      S.chain = run.catch(() => {});
      return S.chain;
    }
    function failed(mine, e) {
      S.err = true;
      S.loaded = false;          // the next answer syncs again, taking back changes made meanwhile
      tell(`${name}: ${tc("Suite Data 没有响应", "Suite Data did not answer")} (${(e && e.message) || e}); ${tc("暂时使用插件设置里的副本。", "using the copy in the plugin settings for now.")}`);
    }
    // Said once per page, and "off" at most every 12 hours per plugin
    // (localStorage SuiteDataPrefs): it is true on every page until the user
    // acts, and a dozen plugins would say it at once.
    function off(mine) {
      const mk = mark(mine);
      if (!mk) return;
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem("SuiteDataPrefs") || "{}").off || {}; } catch (_) {}
      if (Date.now() - (seen[o.id] || 0) < 12 * 3600 * 1000) { S.told = S.told || "off"; return; }
      try { seen[o.id] = Date.now(); localStorage.setItem("SuiteDataPrefs", JSON.stringify({ off: seen })); } catch (_) {}
      tell(`${name}: ${tc("Suite Data 已关闭", "Suite Data is off")}; ${tc("使用插件设置里的副本", "using the copy in the plugin settings")}${mk.at ? " from " + new Date(mk.at).toLocaleString() : ""}.`);
    }
    // The config alone, as before Suite Data. Once Suite Data held this
    // plugin's data, a changed data key is marked for taking back.
    async function configUpdate(mine, fn, cur, opt) {
      const base = cur || mine;
      const next = fn({ ...base });
      if (next === null || next === undefined) return next;
      const mk = mark(mine);
      if ((mk || cur) && o.keys.some((k) => !same(base[k], next[k])))
        next[MARK] = JSON.stringify({ ...(mk || {}), dirty: Date.now(), revs: cur ? { ...S.revs } : ((mk && mk.revs) || {}) });
      await o.writeConfig(next, opt || {});
      return next;
    }
    async function useStore() {
      if (S.inst === null) S.inst = await installed();
      return S.inst;
    }
    async function read(given) {
      const mine = given || await o.readConfig();
      if (!(await useStore())) { off(mine); return mine; }
      try {
        if (!S.loaded) await ensure(mine);
        else absorb((await op({ mode: "get", plugin: o.id, keys: JSON.stringify(o.keys) })).items);
        S.err = false;
        plan(false);
        return over(mine);
      } catch (e) {
        const had = Object.keys(S.revs).length > 0;
        failed(mine, e);
        return had ? over(mine) : mine;
      }
    }
    function update(fn, opt) {
      const run = S.chain.then(async () => {
        const mine = await o.readConfig();
        if (!(await useStore())) { off(mine); return configUpdate(mine, fn, null, opt); }
        try {
          if (!S.loaded) await ensure(mine);
        } catch (e) { failed(mine, e); return configUpdate(mine, fn, Object.keys(S.revs).length ? over(mine) : null, opt); }
        for (let i = 0; i < TRIES; i++) {
          const cur = over(mine);
          const next = fn({ ...cur });
          if (next === null || next === undefined) return next;
          const items = {};
          o.keys.forEach((k) => {
            if (S.revs[k] ? !same(S.vals[k], next[k]) : next[k] !== undefined)
              items[k] = { value: next[k] === undefined ? null : next[k], base: S.revs[k] || 0 };
          });
          if (Object.keys(items).length) {
            let ok;
            try { ok = await put(items); }
            catch (e) { failed(mine, e); return configUpdate(mine, fn, cur, opt); }
            if (!ok) continue;      // someone else wrote first: run fn again on theirs
          }
          S.err = false;
          // a setting the plugin's own UI changed goes to the config as before
          const changed = Object.keys({ ...mine, ...next }).filter((k) => !own(k) && k !== MARK && !same(mine[k], next[k]));
          if (changed.length) {
            const fresh = { ...(await o.readConfig()) };
            changed.forEach((k) => { if (next[k] === undefined) delete fresh[k]; else fresh[k] = next[k]; });
            await o.writeConfig(fresh, opt || {});
          }
          plan(!!(opt && opt.mirror));
          return { ...next };
        }
        throw new Error(tc("Suite Data：其他写入总是抢先；什么也没保存，请重试", "Suite Data: other writes kept getting in first; nothing was saved, try again"));
      });
      S.chain = run.catch(() => {});
      return run;
    }
    async function overlay(id, map) {
      try {
        if (!(await useStore())) return map;
        const r = await op({ mode: "get", plugin: id });
        const m = { ...(map || {}) };
        Object.keys(r.items || {}).forEach((k) => {
          const v = r.items[k] && r.items[k].value;
          if (v === null || v === undefined) delete m[k]; else m[k] = v;
        });
        return m;
      } catch (_) { return map; }
    }
    return {
      read, update, overlay,
      mirror: () => (S.inst && S.loaded ? mirror() : Promise.resolve()),
      mode: () => (S.inst ? (S.err ? "mirror" : "store") : S.told ? "mirror" : "config"),
    };
  }

  // ── Plugin config: watch time and flags ───────────────────────────────────
  // configurePlugin replaces the plugin's whole map: read, change, write back
  // with every other key (rule 5). A stored watch map that does not parse
  // stops the write.
  function parseWatch(raw) {
    if (raw === undefined || raw === null || raw === "") return {};
    try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (_) { return null; }
  }
  // The suite's contract (THEME "Saving", audit C3; up to 2.5 Insights
  // merged what `fn` returned): `fn` gets a copy of the stored map and
  // returns the whole new one, every key it does not mean to change kept
  // as it was. It throws to refuse (a stored value that does not parse)
  // and returns null to write nothing; anything that is not a map is
  // refused rather than written.
  function nextConfig(mine, fn) {
    const next = fn({ ...(mine || {}) });
    if (next === null || next === undefined) return null;
    if (typeof next !== "object" || Array.isArray(next)) throw new Error(tc("新的设置不是一份映射；没有写入任何内容", "the new settings are not a map; nothing was written"));
    return next;
  }
  // Seconds watched added onto the stored map, every other key kept.
  function withWatch(mine, batch) {
    const stored = parseWatch(mine.watch);
    if (stored === null) throw new Error(tc("已保存的观看时间无法读取，保持原样", "stored watch time could not be read; left as it was"));
    return { ...mine, watch: JSON.stringify(addWatch(stored, batch)) };
  }
  // 2.9.0: with the Suite Data plugin installed DATA_KEYS live in its store,
  // where Stash's Settings page cannot roll them back (MAINTENANCE §4.24);
  // the client (SD) runs the chain and keeps a copy in the config.
  async function readOwnConfig() {
    const d = await gql(`query { configuration { plugins } }`);
    const plugins = d?.configuration?.plugins;
    if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
    return plugins[PLUGIN_ID] || {};
  }
  async function writeOwnConfig(next) {
    await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
              { id: PLUGIN_ID, input: next });
  }
  let sdNote = "";                     // Suite Data's notice, on the Actions tab
  const SD = suiteData({ id: PLUGIN_ID, keys: DATA_KEYS, gql, label: "Insights", readConfig: readOwnConfig, writeConfig: writeOwnConfig,
                         notify: (t) => { sdNote = t; } });
  function updateConfig(fn) {
    let seen = null;
    const run = SD.update((mine) => { seen = mine; return nextConfig(mine, fn); }).then((next) => next || seen);
    run.catch((e) => log(`Config write failed: ${e.message}`, "error"));
    return run;
  }
  // `null` when the read failed, so a network hiccup is never taken for
  // "every setting off" (and cached as that). Data kept in Suite Data's
  // store (this plugin's, and Lockdown's and Slideshow's that the
  // dashboard reads) comes over the config's copies.
  async function readPlugins() {
    let p;
    try { p = (await gql(`query { configuration { plugins } }`))?.configuration?.plugins || {}; }
    catch (_) { return null; }
    const [mine, ld, ss] = await Promise.all([SD.read(p[PLUGIN_ID] || {}),
      p.Lockdown ? SD.overlay("Lockdown", p.Lockdown) : null, p.Slideshow ? SD.overlay("Slideshow", p.Slideshow) : null]);
    const out = { ...p, [PLUGIN_ID]: mine };
    if (ld) out.Lockdown = ld;
    if (ss) out.Slideshow = ss;
    return out;
  }

  // ═══ Watch-time tracker ════════════════════════════════════════════════════
  // Counts a second for each second the scene page's own player is playing:
  // not card hover previews, not a wall (O Stats counted every <video> on
  // the page, multiplied by how many played). Seconds wait in localStorage,
  // per tab, so a closed tab loses nothing, and go to Stash once a minute
  // added onto what is stored (never a whole-map overwrite).

  const TAB = Math.random().toString(36).slice(2, 10);
  const PENDING = `insightsI18nWatch:${TAB}`;
  let pending = {};

  function mainVideo() {
    if (!/^\/scenes\/\d+/.test(location.pathname)) return null;
    return document.querySelector("#VideoJsPlayer video, .video-js video.vjs-tech");
  }

  function trackTick() {
    const v = mainVideo();
    if (!v || v.paused || v.ended || v.readyState < 3 || v.playbackRate === 0) return;
    const k = dayKey(Date.now());
    pending[k] = (pending[k] || 0) + 1;
    try { localStorage.setItem(PENDING, JSON.stringify(pending)); } catch (_) {}
  }

  // Sends this tab's seconds, and any left by tabs that closed before they
  // could (their keys are claimed by deleting them first).
  async function flushWatch() {
    const batch = {};
    const take = (key) => {
      try {
        const v = JSON.parse(localStorage.getItem(key) || "{}");
        for (const [k, n] of Object.entries(v)) batch[k] = (batch[k] || 0) + n;
        localStorage.removeItem(key);
      } catch (_) {}
    };
    take(PENDING);
    pending = {};
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith("insightsI18nWatch:") && key !== PENDING && orphan(key)) take(key);
      }
    } catch (_) {}
    if (!Object.keys(batch).length) return;
    try {
      await updateConfig((mine) => withWatch(mine, batch));
    } catch (e) {
      // Put it back for the next try rather than lose it.
      for (const [k, n] of Object.entries(batch)) pending[k] = (pending[k] || 0) + n;
      try { localStorage.setItem(PENDING, JSON.stringify(pending)); } catch (_) {}
    }
  }

  // Another tab's key is an orphan once that tab stops refreshing it.
  const ALIVE = `insightsI18nAlive:${TAB}`;
  function orphan(key) {
    const tab = key.split(":")[1];
    try { return Date.now() - (parseInt(localStorage.getItem(`insightsI18nAlive:${tab}`) || "0", 10)) > 3 * 60000; }
    catch (_) { return false; }
  }

  // ═══ UI ════════════════════════════════════════════════════════════════════

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function navigate(url) {
    // React Router listens for popstate; a full reload would lose the SPA.
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  // 16px line icons. Filled shapes say so; everything else is a stroke.
  const F = 'fill="currentColor" stroke="none"';
  const ICON = {
    drop: `<path ${F} d="M8 1.5C8 1.5 3.3 6.8 3.3 10.2a4.7 4.7 0 0 0 9.4 0C12.7 6.8 8 1.5 8 1.5z"/>`,
    flame: `<path ${F} d="M8 1.5c.5 2.5 3.8 4 3.8 7.6A3.8 3.8 0 0 1 4.2 9.1c0-1.8 1-2.8 1.8-3.6.1 1.3.7 2.1 1.4 2.4C7.2 5.6 7.6 3.5 8 1.5z"/>`,
    play: `<path ${F} d="M5.5 3.8v8.4l6.5-4.2z"/>`,
    trophy: '<path d="M4.5 2.5h7v3a3.5 3.5 0 0 1-7 0zM4.5 3.5H2.5a2 2 0 0 0 2 2.5M11.5 3.5h2a2 2 0 0 1-2 2.5M8 9v2.5M5.5 13.5h5M6.5 11.5h3v2h-3z"/>',
    clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
    eyeoff: '<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM2.5 2.5l11 11"/><circle cx="8" cy="8" r="1.8"/>',
    star: '<path d="M8 2l1.8 3.8 4.1.5-3 2.8.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.8 4.1-.5z"/>',
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    dropoff: '<path d="M8 1.5C8 1.5 3.3 6.8 3.3 10.2a4.7 4.7 0 0 0 9.4 0C12.7 6.8 8 1.5 8 1.5zM2.5 2.5l11 11"/>',
    heart: '<path d="M8 13.5S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3c0 3.9-5.5 7.2-5.5 7.2z"/>',
    folder: '<path d="M2 4.5h4l1.2 1.5H14v6.5H2z"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
    user: '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3"/>',
    users: '<circle cx="6" cy="6" r="2.4"/><path d="M1.8 13.5c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6M10.5 3.8a2.4 2.4 0 0 1 0 4.5M12 9.9c1.2.5 2 1.6 2.3 3.1"/>',
    film: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 2.5v11M11 2.5v11M2 6h3M2 10h3M11 6h3M11 10h3"/>',
    chip: '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>',
    pulse: '<path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4"/>',
    layers: '<path d="M8 2 1.8 5.2 8 8.4l6.2-3.2zM1.8 8 8 11.2 14.2 8M1.8 10.8 8 14l6.2-3.2"/>',
    disk: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.5"/><path d="M4.5 9.5h4"/><circle cx="11.5" cy="9.5" r=".6"/>',
    tag: '<path d="M2 2.5h5.3l6.7 6.7-5 4.8-7-6.7z"/><circle cx="5.2" cy="5.6" r=".9"/>',
    studio: '<path d="M2.5 14V3.5l6-1.5V14M8.5 6h5v8M1.5 14h13M4.5 6h1.5M4.5 9h1.5M10.5 9h1M10.5 11.5h1"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="m2.5 12 3.8-3.6 2.7 2.4 2-1.8 2.5 2.4"/>',
    alert: '<path d="M8 2.2 14.3 13.3H1.7zM8 6.5v3.2M8 11.6v.1"/>',
    check: '<path d="m3 8.5 3.2 3 6.8-7"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8c0-.5.3-.8.8-.8h6.7"/>',
    up: '<path d="M8 13.5V3M3.5 7.5 8 3l4.5 4.5"/>',
    box: '<path d="M2 5 8 2l6 3v6.5L8 14.5 2 11.5zM2 5l6 3 6-3M8 8v6.5"/>',
    globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14C6.2 12.3 5.3 10.3 5.3 8S6.2 3.7 8 2z"/>',
    link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8"/>',
    spark: '<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8l4.8-1.4z"/>',
    trend: '<path d="M1.5 12 6 7.5l3 3 5.5-6M10.5 4.5h4v4"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
    gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l3-4"/>',
    audio: '<path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',
    frame: '<path d="M2 5.5V3h2.5M11.5 3H14v2.5M14 10.5V13h-2.5M4.5 13H2v-2.5"/>',
    expand: '<path d="M3 6.5V3h3.5M13 6.5V3H9.5M3 9.5V13h3.5M13 9.5V13H9.5"/>',
    ruler: '<path d="M2 10.5 10.5 2 14 5.5 5.5 14zM5 7.5l1.5 1.5M7 5.5l1 1M9 3.5l1.5 1.5M3 9.5l1 1"/>',
    arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
    movie: '<rect x="2" y="6.5" width="12" height="7" rx="1.2"/><path d="m2.2 6.3 11-3 .6 2.1-11 3zM5.6 4.4l1.5 2.3M9.2 3.4l1.5 2.3"/>',
    flag: '<path d="M3.5 14.5V2M3.5 2.5h8.5l-2 3 2 3H3.5"/>',
    gap: '<rect x="2" y="4.5" width="3" height="7" rx=".8"/><rect x="11" y="4.5" width="3" height="7" rx=".8"/><path d="M6.8 8h.4M8.8 8h.4"/>',
  };
  const ic = (name, cls = "") => `<svg class="ins-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] || ""}</svg>`;

  // Flexoki (Steph Ango's ink-and-paper palette), dark. Each tab has its
  // own accent; cards are raised (lit top edge, shadow below), data wells
  // are sunk (dark top edge, inner shadow), so the page reads in layers.
  // ═══ Theme tokens (suiteTheme) ═════════════════════════════════════════════
  // The suite's colours, taken from whatever theme Stash shows (docs/THEME.md
  // "Theme tokens", MAINTENANCE §4.25). With the Flexoki theme plugin on, the
  // tokens are Flexoki's exact values, so nothing changes for its users.
  // Without it they are worked out from the page: its background, a card,
  // the text, muted text and the primary button, so panels sit in Stash's
  // own dark look, a light theme or custom CSS. Colours that mean something
  // (green done, red delete, yellow warning, blue O's and links, the codec
  // and resolution tints) keep their Flexoki hue and are made lighter or
  // darker until they read there: 3:1 for shapes, 4.5:1 for text.
  // Copied identically into every plugin (scripts/check_shared.py); its
  // state is all in the closure.
  //   T = suiteTheme({ id, scope, extra })  scope: the plugin's root selectors
  //   T.start()   writes `scope { --sx-*: ... }` once and again when the theme changes
  //   T.t         the tokens now, as "#RRGGBB" (k and the shadows are not colours)
  //   T.mode      "flexoki", "dark" or "light"
  //   T.on(fn)    fn(T) after a change, for a canvas or a colour set from JS
  //   extra(T)    more CSS the plugin works out from the tokens, rewritten with them
  //   T.parse / hex / lum / contrast / mix / fit / derive / tokensCss: the pure parts
  function suiteTheme(o) {
    o = o || {};
    // Flexoki dark as the plugins have always used it (docs/THEME.md); the
    // plugins' muted text is #878580, not the theme plugin's #9F9D96 (grey)
    const FLEX = {
      bg: "#100F0F", bg2: "#1C1B1A", ui: "#282726", ui2: "#343331", ui3: "#403E3C", raise: "#2D2C2A", edge: "#48463F",
      line: "#0D0C0C", line2: "#0B0A0A", deep: "#000000", slab: "#232120",
      tx3: "#575653", tx2b: "#6F6E69", tx2: "#878580", tx1b: "#B7B5AC", tx: "#CECDC3", hi: "#E6E4D9", grey: "#9F9D96",
      paper: "#FFFCF0", on: "#100F0F", acc: "#DA702C", "acc-tx": "#100F0F",
    };
    // each hue: [base 400, pressed 600, text 300, tint 200, deep 700]
    const HUES = {
      re: ["#D14D41", "#AF3029", "#E8705F", "#F89A8A", "#942822"], or: ["#DA702C", "#BC5215", "#EC8B49", "#F9AE77", "#9D4310"],
      ye: ["#D0A215", "#AD8301", "#DFB431", "#ECCB60", "#8E6B01"], gr: ["#879A39", "#66800B", "#A9BA5A", "#BEC97E", "#536907"],
      cy: ["#3AA99F", "#24837B", "#5ABDAC", "#87D3C3", "#1C6C66"], bl: ["#4385BE", "#205EA6", "#66A0C8", "#92BFDB", "#1A4F8C"],
      pu: ["#8B7EC8", "#5E409D", "#A699D0", "#C4B9E0", "#4F3685"], ma: ["#CE5D97", "#A02F6F", "#E47DA8", "#F4A4C2", "#87285E"],
    };
    Object.keys(HUES).forEach((h) => { const v = HUES[h]; FLEX[h] = v[0]; FLEX[h + "-d"] = v[1]; FLEX[h + "-tx"] = v[2]; FLEX[h + "-l"] = v[3]; });
    // Stash's own dark look, for when nothing can be read
    const STASH = { bg: "#202B33", surface: "#30404D", text: "#F5F8FA", muted: "#BFCCD6", primary: "#137CBD" };
    const SHADOW = (k) => {
      const a = (x) => "rgba(0,0,0," + +(x * k).toFixed(3) + ")";
      return { sh: "0 1px 0 " + a(0.7) + ", 0 12px 24px -10px " + a(0.65), float: "0 1px 0 " + a(0.7) + ", 0 20px 50px -12px " + a(0.75),
               well: "inset 0 2px 5px " + a(0.5) };
    };

    // "#abc", "#aabbcc(dd)", rgb()/rgba() in either syntax, color(srgb ...),
    // "transparent": [r, g, b, a] with r g b 0..255, or null
    function parse(s) {
      if (Array.isArray(s)) return s;
      s = String(s || "").trim().toLowerCase();
      if (s === "transparent") return [0, 0, 0, 0];
      let m = /^#([0-9a-f]{3,8})$/.exec(s);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
        if (h.length !== 6 && h.length !== 8) return null;
        const n = (i) => parseInt(h.slice(i, i + 2), 16);
        return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
      }
      m = /^rgba?\(([^)]*)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean);
        if (p.length < 3) return null;
        const ch = (v) => (/%$/.test(v) ? parseFloat(v) * 2.55 : parseFloat(v));
        const al = p[3] === undefined ? 1 : /%$/.test(p[3]) ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
        const out = [ch(p[0]), ch(p[1]), ch(p[2]), al];
        return out.some((x) => isNaN(x)) ? null : out;
      }
      m = /^color\(srgb\s+([^)]*)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
        return p.length >= 3 && !p.some(isNaN) ? [p[0] * 255, p[1] * 255, p[2] * 255, p[3] === undefined ? 1 : p[3]] : null;
      }
      return null;
    }
    const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
    const hex = (c) => { c = parse(c); return c ? "#" + c.slice(0, 3).map((x) => clamp(x).toString(16).padStart(2, "0")).join("").toUpperCase() : null; };
    // c with alpha laid over an opaque base
    const over = (c, base) => { c = parse(c); base = parse(base); const a = c[3]; return [0, 1, 2].map((i) => c[i] * a + base[i] * (1 - a)).concat(1); };
    // a weight w of b mixed into a (w 0 is a), as color-mix in srgb
    const mix = (a, b, w) => { a = parse(a); b = parse(b); return hex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * w)); };
    function lum(c) {
      c = parse(c);
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    // c moved toward white (on a dark page) or black (on a light one) in 4%
    // steps until it reaches `ratio` against every colour in `against`
    function fit(c, against, ratio, dark) {
      const to = dark ? "#FFFFFF" : "#000000", worst = (x) => Math.min.apply(null, against.map((b) => contrast(x, b)));
      let out = hex(c);
      for (let i = 1; i <= 25 && worst(out) < ratio; i++) out = mix(c, to, i * 0.04);
      return out;
    }

    // tokens from samples of the page ({ bg, surface, text, muted, border,
    // primary }, any CSS colour; missing ones fall back to Stash's dark look)
    function derive(s) {
      s = s || {};
      const pick = (v, d) => { const c = parse(v); return c && c[3] > 0 ? c : parse(d); };
      const bg = hex(over(pick(s.bg, STASH.bg), "#000000"));
      let tx = hex(over(pick(s.text, STASH.text), bg));
      const dark = lum(bg) < lum(tx) || (lum(bg) < 0.18 && contrast(bg, tx) < 3);
      if (contrast(tx, bg) < 4.5) tx = dark ? "#F5F8FA" : "#1C2127";
      let ui = hex(over(pick(s.surface, parse(s.bg) ? bg : STASH.surface), bg));
      // a card no different from the page (or wildly different) still needs a raised step
      if (contrast(ui, bg) < 1.04 || contrast(ui, bg) > 3 || (dark ? lum(ui) < lum(bg) : false)) ui = mix(bg, tx, dark ? 0.07 : 0.035);
      if (!dark && contrast(ui, bg) < 1.04) ui = bg;
      const t = { bg, ui, tx };
      t.bg2 = dark ? mix(bg, ui, 0.5) : mix(ui, tx, 0.04);
      t.ui2 = mix(ui, tx, dark ? 0.075 : 0.06);
      t.ui3 = mix(ui, tx, dark ? 0.145 : 0.13);
      const bd = parse(s.border);
      if (bd && bd[3] > 0) { const b = hex(over(bd, ui)), r = contrast(b, ui); if (r > 1.1 && r < 3) t.ui3 = b; }
      t.raise = dark ? mix(ui, tx, 0.03) : mix(ui, "#FFFFFF", 0.5);
      t.edge = dark ? mix(ui, tx, 0.19) : mix(ui, "#FFFFFF", 0.7);
      t.line = dark ? mix(bg, "#000000", 0.19) : mix(ui, tx, 0.2);
      t.line2 = dark ? mix(bg, "#000000", 0.31) : mix(ui, tx, 0.22);
      t.deep = dark ? "#000000" : mix(ui, tx, 0.25);
      t.slab = dark ? mix(bg, tx, 0.07) : mix(bg, tx, 0.1);
      t.hi = mix(tx, dark ? "#FFFFFF" : "#000000", 0.45);
      t.tx1b = mix(tx, ui, 0.14);
      const mu = parse(s.muted);
      let tx2 = mix(tx, ui, 0.43);
      if (mu && mu[3] > 0) { const m = hex(over(mu, ui)); if (contrast(m, ui) < contrast(tx, ui) * 0.92) tx2 = m; }
      t.tx2 = fit(tx2, [ui, bg], 4.5, dark);
      t.tx2b = mix(tx, ui, 0.57);
      t.tx3 = mix(tx, ui, 0.66);
      t.grey = fit(mix(tx, ui, 0.3), [ui, bg], 4.5, dark);
      t.paper = FLEX.paper;
      // text on a filled meaning colour: dark ink on Flexoki's 400s, white on the darker light-theme ones
      t.on = dark ? mix(bg, "#000000", 0.4) : "#FFFFFF";
      Object.keys(HUES).forEach((h) => {
        const v = HUES[h];
        t[h] = fit(dark ? v[0] : v[1], [ui, bg], 3, dark);
        t[h + "-d"] = dark ? v[1] : mix(t[h], "#000000", 0.2);
        t[h + "-tx"] = fit(dark ? v[2] : v[1], [ui, bg], 4.5, dark);
        t[h + "-l"] = fit(dark ? v[3] : v[4], [ui, bg], 4.5, dark);
      });
      const pr = parse(s.primary);
      t.acc = pr && pr[3] > 0 ? fit(hex(over(pr, ui)), [ui], 3, dark) : t.or;
      t["acc-tx"] = contrast(t.acc, "#FFFFFF") >= contrast(t.acc, t.on) ? "#FFFFFF" : t.on;
      return t;
    }

    // the CSS for a token set: scope { --sx-name: value; ... }
    function tokensCss(t, mode, scope) {
      const k = mode === "light" ? 0.3 : 1, sh = SHADOW(k);
      const lines = Object.keys(t).map((n) => "--sx-" + n + ": " + t[n] + ";");
      lines.push("--sx-k: " + k + ";", "--sx-sh: " + sh.sh + ";", "--sx-float: " + sh.float + ";", "--sx-well: " + sh.well + ";",
                 "--sx-scheme: " + (mode === "light" ? "light" : "dark") + ";");
      return (scope || ":root") + " {\n  " + lines.join("\n  ") + "\n}";
    }

    const T = { t: Object.assign({}, FLEX), mode: "flexoki", FLEX, HUES, STASH, parse, hex, over, mix, lum, contrast, fit, derive, tokensCss };
    const subs = [];
    let el = null, timer = 0, started = false, css = "";
    T.on = (fn) => { subs.push(fn); return T; };

    // Flexoki's stylesheet defines --fx-bg on <html>; its accent setting is --fx-acc
    function flexokiOn() {
      try { return !!getComputedStyle(document.documentElement).getPropertyValue("--fx-bg").trim(); } catch (_) { return false; }
    }
    // what the page looks like: probes with Stash's (Bootstrap's) classes, so
    // a theme that styles them is read even where no card is on screen
    function sample() {
      const out = {};
      const cs = (e) => getComputedStyle(e);
      const b = document.body, h = document.documentElement;
      const hb = parse(cs(h).backgroundColor), bb = b ? parse(cs(b).backgroundColor) : null;
      let page = hb && hb[3] > 0 ? over(hb, STASH.bg) : null;
      if (bb && bb[3] > 0) page = over(bb, page || STASH.bg);
      if (page) out.bg = page;
      if (b) out.text = cs(b).color;
      if (!b) return out;
      const box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;pointer-events:none";
      box.innerHTML = '<div class="card"><span class="text-muted">x</span><button type="button" class="btn btn-primary">x</button></div>';
      b.appendChild(box);
      try {
        const card = box.firstChild, c = cs(card);
        out.surface = c.backgroundColor;
        if (parseFloat(c.borderTopWidth) > 0) out.border = c.borderTopColor;
        out.muted = cs(card.firstChild).color;
        out.primary = cs(card.lastChild).backgroundColor;
        if (c.color) out.text = c.color;
      } finally { box.remove(); }
      return out;
    }
    function compute() {
      if (flexokiOn()) {
        const t = Object.assign({}, FLEX);
        // the accent follows the theme plugin's setting (plugins keep their own colours)
        try {
          const a = parse(getComputedStyle(document.documentElement).getPropertyValue("--fx-acc").trim());
          if (a) t.acc = hex(a);
        } catch (_) {}
        return { t, mode: "flexoki" };
      }
      const t = derive(sample());
      return { t, mode: lum(t.bg) < lum(t.tx) ? "dark" : "light" };
    }
    function apply() {
      timer = 0;
      let r;
      try { r = compute(); } catch (e) { return; }
      const next = tokensCss(r.t, r.mode, o.scope) + (o.extra ? "\n" + o.extra({ t: r.t, mode: r.mode, mix, fit, contrast }) : "");
      T.t = r.t; T.mode = r.mode;
      if (next === css && el && el.isConnected) return;
      css = next;
      if (!el || !el.isConnected) {
        el = document.getElementById((o.id || "suite") + "-sx") || document.createElement("style");
        el.id = (o.id || "suite") + "-sx";
        document.head.appendChild(el);
      }
      el.textContent = css;
      subs.forEach((fn) => { try { fn(T); } catch (_) {} });
    }
    const soon = () => { if (!timer) timer = setTimeout(apply, 120); };
    T.refresh = apply;
    T.start = () => {
      if (started) return T;
      started = true;
      apply();
      try {
        // a theme arrives as a stylesheet (Stash adds plugin CSS as <link>s,
        // so also wait for each one to load), a class or style on <html> or
        // <body>, or the system's light/dark switch
        const watchLink = (n) => { if (n && n.tagName === "LINK") n.addEventListener("load", soon, { once: true }); };
        const mo = new MutationObserver((list) => {
          for (const m of list) {
            if (m.target === el || (el && el.contains(m.target))) continue;
            if (m.addedNodes) m.addedNodes.forEach(watchLink);
            soon();
          }
        });
        mo.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "media", "href", "rel"] });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme", "data-fx-accent"] });
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme"] });
        document.querySelectorAll('link[rel~="stylesheet"]').forEach((n) => { if (!n.sheet) watchLink(n); });
        const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
        if (mq && mq.addEventListener) mq.addEventListener("change", soon);
      } catch (_) {}
      return T;
    };
    return T;
  }
  // Insights draws into #insights and its one tooltip. Its own in-between
  // shades (the error box, row dividers, tinted verdicts, the calendar
  // ramps) are exact Flexoki values with Flexoki on; without it they are
  // mixed from the tokens the same way (a tint of the hue on the surface).
  const THEME = suiteTheme({ id: "insights", scope: "#insights, #ins-tip", extra: (X) => {
    const t = X.t, m = X.mix, fx = X.mode === "flexoki", light = X.mode === "light";
    const v = {
      "err-bd": fx ? "#6B2620" : m(t.ui, t.re, 0.45), "err-bg": fx ? "#2A1513" : m(t.ui, t.re, 0.12), "err-tx": fx ? "#F0C9C3" : t["re-l"],
      "div1": fx ? "#262524" : m(t.ui, light ? t.tx : t.bg, light ? 0.1 : 0.12), "div2": fx ? "#222120" : m(t.ui, light ? t.tx : t.bg, light ? 0.14 : 0.33),
      "up-bg": fx ? "#2B3016" : m(t.ui, t.gr, 0.18), "down-bg": fx ? "#3A1C19" : m(t.ui, t.re, 0.18), "warn-bg": fx ? "#3A3014" : m(t.ui, t.ye, 0.18),
    };
    Object.keys(RAMP_STEPS).forEach((k) => {
      const h = RAMP_HUE[k], steps = fx ? RAMP_STEPS[k] : [m(t.ui, t[h + "-d"], 0.3), m(t.ui, t[h + "-d"], 0.65), t[h + "-d"], t[h], t[h + "-l"]];
      steps.forEach((c, i) => { v[k + (i + 1)] = c; });
    });
    return "#insights, #ins-tip { " + Object.keys(v).map((k) => "--ins-" + k + ": " + v[k] + ";").join(" ") + " }";
  } });

  function injectStyles() {
    if (document.getElementById("insights-styles")) return;
    THEME.start();
    const s = document.createElement("style");
    s.id = "insights-styles";
    s.textContent = `
#insights { --bg: var(--sx-bg); --bg2: var(--sx-bg2); --ui: var(--sx-ui); --ui2: var(--sx-ui2); --ui3: var(--sx-ui3); --tx3: var(--sx-tx3); --tx2b: var(--sx-tx2b);
  --tx2: var(--sx-tx2); --tx1b: var(--sx-tx1b); --tx: var(--sx-tx); --hi: var(--sx-hi);
  --re: var(--sx-re); --or: var(--sx-or); --ye: var(--sx-ye); --gr: var(--sx-gr); --cy: var(--sx-cy); --bl: var(--sx-bl); --pu: var(--sx-pu); --ma: var(--sx-ma);
  --up: var(--sx-gr-tx); --down: var(--sx-re-tx); --acc: var(--ma);
  /* O's are blue across the suite (Flexoki's O badge, Lockdown); magenta up to 2.5 */
  --o: var(--sx-bl); --otx: var(--sx-bl-tx);
  max-width: 1400px; margin: 28px auto 40px; padding: 18px 18px 8px; color: var(--tx); font-size: 14px; text-align: left;
  background: var(--bg); border-radius: 16px; border: 1px solid var(--sx-deep); border-top-color: var(--sx-slab);
  box-shadow: 0 20px 50px -20px rgba(0,0,0,calc(.7*var(--sx-k))); }
#insights[data-tab="library"] { --acc: var(--or); } #insights[data-tab="files"] { --acc: var(--cy); }
#insights[data-tab="health"] { --acc: var(--ye); } #insights[data-tab="collection"] { --acc: var(--gr); }
#insights[data-tab="actions"] { --acc: var(--re); } #insights[data-tab="movies"] { --acc: var(--pu); }
#insights * { box-sizing: border-box; }
#insights button { font: inherit; }
#insights a { color: inherit; }
/* the suite's page head (Movies Toolkit's .mv-head): icon and title, the
   muted status line beside them, the tab strip on the right */
.ins-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.ins-title { font-size: 22px; font-weight: 700; color: var(--hi); display: flex; align-items: center; gap: 8px; letter-spacing: -.01em; }
.ins-title .ins-ic { width: 20px; height: 20px; color: var(--acc); }
.ins-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; padding: 4px; border-radius: 11px; background: var(--bg2);
  border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2); box-shadow: inset 0 2px 4px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-tab { display: inline-flex; align-items: center; gap: 7px; background: none; border: 1px solid transparent; color: var(--tx1b);
  border-radius: 8px; padding: 6px 13px; cursor: pointer; transition: background .12s, color .12s; }
.ins-tab .ins-ic { color: var(--tc); opacity: .75; }
.ins-tab:hover { color: var(--hi); background: rgba(255,255,255,.03); }
.ins-tab.on { color: var(--hi); background: var(--ui2); background: color-mix(in srgb, var(--tc) 24%, var(--ui));
  border-color: color-mix(in srgb, var(--tc) 55%, transparent); border-bottom-color: rgba(0,0,0,calc(.6*var(--sx-k)));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,calc(.4*var(--sx-k))); }
.ins-tab.on .ins-ic { opacity: 1; }
.ins-meta { color: var(--tx2); font-size: 12px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.ins-btn { display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(180deg, var(--ui2), var(--ui)); color: var(--tx);
  border: 1px solid var(--sx-line2); border-top-color: var(--ui3); border-radius: 8px; padding: 5px 11px; cursor: pointer;
  box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-btn:hover { color: var(--hi); border-top-color: var(--tx3); }
.ins-btn:disabled { opacity: .6; cursor: default; }
.ins-btn.big { padding: 8px 16px; font-size: 14px; }
.ins-databtn .ins-ic { color: var(--bl); } .ins-databtn.warn, .ins-databtn.warn .ins-ic { color: var(--ye); }
.ins-ic { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.ins-progress { padding: 50px 0; text-align: center; color: var(--tx2); }
.ins-progress .bar { width: 260px; max-width: 80%; height: 6px; margin: 14px auto 0; background: var(--bg2); border-radius: 3px; overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
.ins-upd.busy { color: var(--cy); }
.ins-upd.busy::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--cy);
  vertical-align: 1px; animation: insPulse 1s ease-in-out infinite alternate; }
@keyframes insPulse { from { opacity: .25; } to { opacity: 1; } }
.ins-progress .bar i { display: block; width: 40%; height: 100%; background: var(--acc); border-radius: 3px; animation: insSlide 1.1s ease-in-out infinite; }
@keyframes insSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.ins-error { padding: 14px 16px; border: 1px solid var(--ins-err-bd); background: var(--ins-err-bg); border-radius: 10px; color: var(--ins-err-tx); }

.ins-card { position: relative; background: linear-gradient(180deg, var(--sx-raise) 0, var(--ui) 64px); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge);
  border-radius: 12px; padding: 14px 16px 15px; min-width: 0; margin-bottom: 14px;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 12px 24px -10px rgba(0,0,0,calc(.65*var(--sx-k))); }
.ins-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; margin-bottom: 14px; }
.ins-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; margin-bottom: 14px; }
.ins-grid > .ins-card, .ins-grid3 > .ins-card, .ins-grid > div > .ins-card:last-child { margin-bottom: 0; }
.ins-ch { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.ins-ch b { font-size: 15px; color: var(--hi); font-weight: 600; }
.ins-ch .r { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--tx2); font-size: 12px; flex-wrap: wrap; }
.ins-badge { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--c, var(--acc)); background: var(--ui2); background: color-mix(in srgb, var(--c, var(--acc)) 17%, var(--ui));
  border: 1px solid color-mix(in srgb, var(--c, var(--acc)) 30%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.07); }
.ins-sub { color: var(--tx2); font-size: 12px; margin: 0 0 12px 38px; line-height: 1.45; }
.ins-note { color: var(--tx2); font-size: 12px; margin-top: 10px; line-height: 1.5; }
.ins-empty { color: var(--tx2); padding: 10px 0; }

.ins-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 22px; align-items: center; padding: 20px 22px; }
.ins-hero .k { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; letter-spacing: .08em; color: var(--c, var(--acc)); }
.ins-hero .big { font-size: 40px; font-weight: 700; line-height: 1.05; margin: 6px 0 6px; color: var(--hi); letter-spacing: -.02em; }
.ins-hero .s { color: var(--tx1b); line-height: 1.55; max-width: 720px; }
.ins-hero .s b { color: var(--hi); font-weight: 600; }
.ins-legend2 { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; font-size: 12px; color: var(--tx1b); }
.ins-legend2 i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }

.ins-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 14px; }
.ins-tile { position: relative; overflow: hidden; padding: 12px 14px 12px 18px; margin: 0; }
.ins-tile::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--c); box-shadow: 0 0 12px var(--c); }
.ins-tile .l { display: flex; align-items: center; gap: 7px; color: var(--tx2); font-size: 12px; }
.ins-tile .l .ins-ic { color: var(--c); }
.ins-tile .v { font-size: 25px; font-weight: 700; line-height: 1.2; margin: 4px 0 2px; color: var(--hi); font-variant-numeric: tabular-nums; }
.ins-tile .s { color: var(--tx1b); font-size: 12px; }
.ins-tile .s .warn { color: var(--ye); }
.ins-tile.click { cursor: pointer; } .ins-tile.click:hover { border-top-color: var(--tx3); }

.ins-well { background: var(--bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2); border-radius: 10px; padding: 10px 12px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-chip { background: var(--bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2); color: var(--tx1b); border-radius: 8px;
  padding: 3px 10px; font-size: 12px; cursor: pointer; }
.ins-chip:hover { color: var(--hi); }
.ins-chip.on { color: var(--hi); background: color-mix(in srgb, var(--c, var(--acc)) 22%, var(--ui2)); border-color: color-mix(in srgb, var(--c, var(--acc)) 50%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.ins-nav { background: var(--bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2); color: var(--tx1b); border-radius: 8px; width: 28px; height: 26px; cursor: pointer; line-height: 1; }
.ins-nav:disabled { opacity: .35; cursor: default; }

/* bar charts: every bar carries its value and its label */
.ins-chart { padding: 10px 10px 6px; }
.ins-bars { display: flex; align-items: flex-end; gap: 3px; border-bottom: 1px solid var(--ui3); }
.ins-bar { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; position: relative; }
.ins-bar i { display: block; width: 100%; max-width: 46px; border-radius: 3px 3px 0 0; background: var(--c, var(--acc)); min-height: 2px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -6px 10px -6px rgba(0,0,0,calc(.35*var(--sx-k))); transition: filter .12s; }
.ins-bar.zero i { background: var(--ui3); box-shadow: none; }
.ins-bar.hi i { background: var(--sx-ma-l); background: color-mix(in srgb, var(--c, var(--acc)) 55%, var(--sx-paper)); }
.ins-bar.click { cursor: pointer; } .ins-bar.click:hover i { filter: brightness(1.22); }
.ins-bar em { font-style: normal; font-size: 10.5px; color: var(--tx1b); margin-bottom: 3px; white-space: nowrap; font-variant-numeric: tabular-nums; line-height: 1; }
.ins-bar.zero em { color: var(--tx3); }
.ins-bar.future i { background: transparent; } .ins-bar.future em { visibility: hidden; }
.ins-xl { display: flex; gap: 3px; margin-top: 5px; }
.ins-xl span { flex: 1; min-width: 0; text-align: center; font-size: 10.5px; color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: clip; }
.ins-chart.dense .ins-bar em { writing-mode: vertical-rl; transform: rotate(180deg); margin-bottom: 4px; font-size: 10px; }
.ins-chart.dense .ins-xl span { writing-mode: vertical-rl; transform: rotate(180deg); height: 34px; text-align: right; font-size: 10px; overflow: visible; }

/* horizontal rows: label, bar, value */
.ins-row { display: grid; grid-template-columns: var(--lw, minmax(90px, 160px)) minmax(0, 1fr) var(--vw, 72px); gap: 10px; align-items: center;
  min-height: 30px; padding: 2px 8px; margin: 0 -8px; border-radius: 7px; font-size: 13px; }
.ins-row.has-ic { grid-template-columns: 26px var(--lw, minmax(90px, 160px)) minmax(0, 1fr) var(--vw, 72px); }
.ins-row.click { cursor: pointer; } .ins-row.click:hover { background: rgba(255,255,255,.04); }
.ins-row .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 7px; min-width: 0; }
.ins-row .l span { overflow: hidden; text-overflow: ellipsis; }
.ins-row .v { text-align: right; color: var(--tx); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ins-row .v small { color: var(--tx2); font-size: 11px; margin-left: 4px; }
.ins-trk { height: 9px; border-radius: 5px; background: var(--bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); overflow: hidden; }
.ins-trk i { display: block; height: 100%; border-radius: 5px; background: var(--c, var(--acc)); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ins-dual { display: flex; flex-direction: column; gap: 3px; }
.ins-dual .ins-trk:first-child { height: 6px; } .ins-dual .ins-trk:first-child i { background: var(--tx3); box-shadow: none; }

/* the Files tab reads like a console */
.ins-con { font-family: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
.ins-con .ins-row { font-size: 12px; min-height: 26px; }
.ins-con .hd { display: flex; justify-content: space-between; color: var(--tx2b); letter-spacing: .08em; font-size: 11px; margin-bottom: 4px; }
.ins-con table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.ins-con th, .ins-con td { padding: 4px 6px; text-align: right; font-weight: 400; white-space: nowrap; }
.ins-con th { color: var(--tx2b); font-size: 11px; letter-spacing: .06em; }
.ins-con td:first-child, .ins-con th:first-child { text-align: left; }
.ins-con tr + tr td { border-top: 1px solid var(--ins-div1); }
.ins-con tr.click { cursor: pointer; } .ins-con tr.click:hover td { background: rgba(255,255,255,.03); }
.ins-strip { display: flex; flex-wrap: wrap; gap: 8px 26px; margin-bottom: 14px; padding: 12px 16px; }
.ins-strip span { color: var(--tx2b); margin-right: 6px; letter-spacing: .06em; font-size: 11px; }
.ins-strip b { color: var(--hi); font-weight: 500; }
.ins-strip .warn b { color: var(--ye); }
.ins-li { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 8px; margin: 0 -8px;
  border-radius: 7px; min-height: 40px; }
.ins-li + .ins-li { border-top: 1px solid var(--ins-div2); }
.ins-li.click { cursor: pointer; } .ins-li.click:hover { background: rgba(255,255,255,.04); }
.ins-li .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tx); }
.ins-li .sub { color: var(--tx2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-li .v { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ins-li.av { grid-template-columns: 36px minmax(0, 1fr) auto; }
.ins-th { width: 48px; height: 28px; border-radius: 5px; object-fit: cover; background: var(--ui2); display: block; box-shadow: 0 1px 3px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-av { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--ui3); display: flex; align-items: center; object-position: top;
  justify-content: center; font-size: 11px; font-weight: 700; color: var(--tx); overflow: hidden; box-shadow: 0 0 0 2px var(--ui), 0 0 0 3px var(--c, var(--ui3)); }
.ins-av.sm { width: 24px; height: 24px; font-size: 9px; }
.ins-sq { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--c, var(--tx1b));
  background: color-mix(in srgb, var(--c, var(--tx2)) 15%, var(--bg2)); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.4*var(--sx-k))); }

.ins-lift { display: inline-block; min-width: 48px; text-align: center; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ins-lift.up { background: var(--ins-up-bg); color: var(--up); } .ins-lift.down { background: var(--ins-down-bg); color: var(--down); }
.ins-lift.even { background: var(--ui2); color: var(--tx1b); }
.ins-pulls { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 14px; }
.ins-pull { padding: 10px 12px; cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; }
.ins-pull:hover { border-bottom-color: var(--tx3); }
.ins-pull .k { color: var(--tx2b); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; grid-column: 1 / -1; }
.ins-pull .n { font-size: 14px; font-weight: 600; color: var(--hi); display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ins-pull .d { color: var(--tx2); font-size: 12px; grid-column: 1 / -1; }
.ins-dims { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; align-items: center; }
.ins-gchips { margin: 0 0 10px; }
.ins-dims .g { color: var(--tx2b); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; margin-right: 4px; min-width: 76px; }

.ins-cal { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 1fr); gap: 3px; }
.ins-cal i { display: block; aspect-ratio: 1; border-radius: 3px; background: var(--h0); cursor: pointer; }
.ins-cal i.f { background: transparent; cursor: default; }
.ins-cal i.today { outline: 1.5px solid var(--hi); outline-offset: -1.5px; }
.ins-cal i:hover:not(.f) { outline: 1.5px solid var(--sx-bl-l); outline-offset: -1.5px; }
.ins-calm { display: grid; gap: 3px; font-size: 10.5px; color: var(--tx2); margin-bottom: 4px; }
.ins-calm span { white-space: nowrap; overflow: visible; }
.ins-calm b { color: var(--tx); font-weight: 600; margin-left: 3px; }
.ins-legend { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--tx2); }
.ins-legend i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.ins-hm { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)) 34px; gap: 2px; align-items: center; font-size: 10px; color: var(--tx2); }
.ins-hm i { display: block; height: 16px; border-radius: 3px; background: var(--h0); }
.ins-hm .t { text-align: right; color: var(--tx); font-variant-numeric: tabular-nums; }
.ins-hm .c { text-align: center; color: var(--tx1b); font-variant-numeric: tabular-nums; }
.ins-day { position: relative; height: 36px; margin: 10px 0 4px; }
.ins-day .axis { position: absolute; left: 0; right: 0; top: 16px; height: 4px; border-radius: 2px; background: var(--bg2); box-shadow: inset 0 1px 1px rgba(0,0,0,calc(.6*var(--sx-k))); }
.ins-day .dot { position: absolute; top: 10px; width: 16px; height: 16px; margin-left: -8px; border-radius: 50%; border: 2px solid var(--ui); cursor: pointer; }
.ins-day .dot.o { background: var(--o); } .ins-day .dot.p { background: var(--cy); width: 12px; height: 12px; top: 12px; margin-left: -6px; }
.ins-hours { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--tx2); }
.ins-stats { display: flex; gap: 22px; flex-wrap: wrap; margin: 6px 0 0 38px; }
.ins-stats span { color: var(--tx2); font-size: 12px; } .ins-stats b { display: block; color: var(--hi); font-size: 19px; font-weight: 700; }
.ins-week { display: flex; align-items: flex-end; gap: 6px; height: 112px; }
.ins-week div { width: 26px; text-align: center; font-size: 11px; color: var(--tx2); display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.ins-week i { display: block; border-radius: 5px; background: var(--c, var(--ma)); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); margin: 3px 0 4px; }
.ins-week i.z { background: var(--ui3); box-shadow: none; }
.ins-week b { color: var(--hi); font-weight: 600; }
.ins-week .today { color: var(--hi); }
.ins-ring { position: relative; flex: none; border-radius: 50%; background: var(--bg2); box-shadow: inset 0 3px 8px rgba(0,0,0,calc(.6*var(--sx-k))), 0 1px 0 rgba(255,255,255,.05); }
.ins-ring svg { position: absolute; inset: 0; }
.ins-ring .mid { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ins-ring .mid b { font-size: 26px; color: var(--hi); line-height: 1.05; }
.ins-ring .mid span { font-size: 11px; color: var(--tx2); }
.ins-notable { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
.ins-nb { margin: 0; padding: 11px 13px; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 2px 10px; align-items: center; }
.ins-nb .ins-sq { grid-row: span 3; align-self: start; }
.ins-nb .l { font-size: 11px; color: var(--tx2); text-transform: uppercase; letter-spacing: .06em; }
.ins-nb .v { font-size: 17px; font-weight: 700; color: var(--hi); }
.ins-nb .s { font-size: 12px; color: var(--tx1b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-tm { display: flex; flex-wrap: wrap; gap: 4px; height: 168px; align-content: stretch; }
.ins-tm div { border-radius: 7px; padding: 7px 9px; font-size: 12px; color: var(--sx-on); overflow: hidden; cursor: pointer; min-width: 60px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.25), inset 0 -2px 0 rgba(0,0,0,calc(.2*var(--sx-k))); }
.ins-tm div:hover { filter: brightness(1.12); }
.ins-tm b { display: block; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ins-chk { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 9px 8px; margin: 0 -8px; border-radius: 7px; }
.ins-chk + .ins-chk { border-top: 1px solid var(--ins-div2); }
.ins-chk.click { cursor: pointer; } .ins-chk.click:hover { background: rgba(255,255,255,.04); }
.ins-chk .n { color: var(--tx); } .ins-chk .sub { color: var(--tx2); font-size: 12px; margin-top: 1px; }
.ins-chk .v { font-variant-numeric: tabular-nums; color: var(--hi); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ins-chk .more { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 5px; }
.ins-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: var(--bg2);
  border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2); color: var(--tx1b); cursor: pointer; }
.ins-pill:hover { color: var(--hi); }
.ins-go { color: var(--bl); font-size: 12px; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.ins-go .ins-ic { width: 13px; height: 13px; }
.ins-go:hover { color: var(--sx-bl-tx); }
.ins-cc { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 18px; padding: 0 4px; border-radius: 3px;
  background: var(--ui3); color: var(--tx); font-size: 10px; font-weight: 700; letter-spacing: .05em; flex: none; }
/* Stash positions .fi absolutely inside its own cards; ours sit in the text */
.ins-flag { position: static !important; display: inline-block !important; width: 22px !important; height: 16px !important; margin: 0 !important;
  line-height: 16px; border-radius: 3px; flex: none; background-size: cover !important; filter: none !important;
  box-shadow: 0 0 0 1px rgba(0,0,0,calc(.4*var(--sx-k))), 0 1px 2px rgba(0,0,0,calc(.4*var(--sx-k))); }
.ins-split { display: flex; height: 14px; border-radius: 7px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); margin: 4px 0 8px; }
.ins-split i { display: block; height: 100%; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ins-banner { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 14px; --c: var(--cy); }
.ins-banner .ins-btn { margin-left: auto; }
.ins-scroll { max-height: 420px; overflow-y: auto; overflow-x: hidden; padding: 0 8px; margin: 0 -8px;
  scrollbar-width: thin; scrollbar-color: var(--ui3) transparent; }
.ins-scroll::-webkit-scrollbar { width: 8px; } .ins-scroll::-webkit-scrollbar-thumb { background: var(--ui3); border-radius: 4px; }
/* 2.2 What works: a sidebar of dimensions, rows with a bar centred on 1x */
.ins-ww { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 16px; align-items: start; }
.ins-side { display: flex; flex-direction: column; gap: 1px; position: sticky; top: 60px; }
.ins-side .h { font-size: 10.5px; color: var(--tx2b); letter-spacing: .09em; margin: 8px 8px 4px; }
.ins-side .h:first-child { margin-top: 0; }
.ins-side-b { text-align: left; background: none; border: 0; color: var(--tx1b); padding: 5px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.ins-side-b:hover { color: var(--hi); background: rgba(255,255,255,.03); }
.ins-side-b.on { color: var(--hi); background: color-mix(in srgb, var(--gr) 18%, var(--ui)); box-shadow: inset 3px 0 0 var(--gr); }
.ins-wbody { min-width: 0; max-width: 980px; }
.ins-lr { display: grid; grid-template-columns: 26px minmax(110px, 210px) minmax(140px, 1fr) 170px 52px; gap: 12px; align-items: center;
  min-height: 32px; padding: 2px 8px; border-radius: 7px; font-size: 13px; }
.ins-lr.click { cursor: pointer; } .ins-lr.click:hover { background: rgba(255,255,255,.04); }
.ins-lr .rk { text-align: right; color: var(--tx3); font-size: 11px; font-variant-numeric: tabular-nums; }
.ins-lr .l { display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; white-space: nowrap; }
.ins-lr .l span { overflow: hidden; text-overflow: ellipsis; }
.ins-lr .nums { color: var(--tx2); font-size: 12px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ins-lr.top { background: color-mix(in srgb, var(--gr) 12%, transparent); box-shadow: inset 3px 0 0 var(--gr); }
.ins-lr.top .rk { color: var(--up); font-weight: 700; }
.ins-lr.top .l { color: var(--hi); font-weight: 600; }
.ins-lr.ins-axis { min-height: 22px; font-size: 11px; color: var(--tx2b); }
.ins-lr.ins-axis .l { color: var(--tx2); font-weight: 600; }
.ins-lr .ax { display: flex; justify-content: space-between; }
.ins-div { position: relative; height: 10px; border-radius: 5px; background: var(--bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
.ins-div::before { content: ""; position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: var(--tx3); }
.ins-div i { position: absolute; top: 1px; bottom: 1px; border-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
/* 2.2 Where the space goes: a ranked list */
.ins-sr { display: grid; grid-template-columns: minmax(120px, 240px) minmax(0, 1fr) 80px 46px 96px; gap: 12px; align-items: center;
  min-height: 30px; padding: 2px 8px; border-radius: 7px; font-size: 13px; }
.ins-sr.click { cursor: pointer; } .ins-sr.click:hover { background: rgba(255,255,255,.04); }
.ins-sr .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-sr .l small { color: var(--tx2); }
.ins-sr .v { text-align: right; color: var(--hi); font-variant-numeric: tabular-nums; }
.ins-sr .p, .ins-sr .n { text-align: right; color: var(--tx2); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 2.2 Actions */
.ins-data { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 14px; }
.ins-data svg { width: 14px; height: 14px; flex: none; }
.ins-opts { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin: 4px 0 12px; font-size: 12px; color: var(--tx1b); }
.ins-seg { display: inline-flex; gap: 3px; padding: 3px; border-radius: 9px; background: var(--bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2);
  box-shadow: inset 0 2px 4px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-seg button { background: none; border: 0; color: var(--tx1b); padding: 4px 11px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.ins-seg button.on { color: var(--hi); background: color-mix(in srgb, var(--bl) 26%, var(--ui2)); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,calc(.4*var(--sx-k))); }
.ins-tog { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; color: var(--tx1b); cursor: pointer; font-size: 12px; padding: 0; text-align: left; }
/* the suite's switch (Movies, Scenes Toolkit, Tags Toolkit): 26x15, an 11px knob */
.ins-tog i { position: relative; width: 26px; height: 15px; border-radius: 8px; background: var(--ui3); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); flex: none; transition: background .12s; }
.ins-tog i::after { content: ""; position: absolute; left: 2px; top: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--tx1b); transition: left .12s; }
.ins-tog.on i { background: var(--gr); } .ins-tog.on i::after { left: 13px; background: var(--hi); }
.ins-tog:disabled, .ins-seg button:disabled { opacity: .5; cursor: default; }
.ins-sum { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; margin-bottom: 10px; font-size: 12px; }
.ins-sum em { font-style: normal; color: var(--tx2b); letter-spacing: .06em; margin-right: 7px; font-size: 11px; }
.ins-sum b { color: var(--hi); font-weight: 600; }
.ins-dups { max-height: 560px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--ui3) transparent; }
.ins-dg { padding: 6px 0; } .ins-dg + .ins-dg { border-top: 1px solid var(--ins-div1); }
.ins-dg.review { background: color-mix(in srgb, var(--ye) 6%, transparent); border-radius: 8px; padding: 6px 6px; }
.ins-dg .why { color: var(--ye); font-size: 12px; display: flex; align-items: center; gap: 6px; margin: 0 0 4px 30px; }
.ins-cp { display: grid; grid-template-columns: 20px 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 34px; font-size: 12.5px; }
.ins-cp .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-cp .m { color: var(--tx2); }
.ins-cp .v { text-align: right; color: var(--tx2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ins-k { display: inline-block; min-width: 54px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: .05em; padding: 1px 6px; border-radius: 6px; margin-right: 8px; }
.ins-k.keep { background: var(--ins-up-bg); color: var(--up); } .ins-k.del { background: var(--ins-down-bg); color: var(--down); } .ins-k.look { background: var(--ins-warn-bg); color: var(--ye); }
.ins-bx { width: 16px; height: 16px; border-radius: 5px; border: 1px solid var(--tx3); background: var(--bg2); cursor: pointer; padding: 0; position: relative;
  box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
.ins-bx.on { background: var(--re); border-color: var(--sx-re-d); }
.ins-bx.on::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid var(--sx-bg); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.ins-bx:disabled { cursor: default; opacity: .6; }
.ins-btns { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; align-items: center; margin-top: 12px; }
.ins-btn.danger { background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d)); color: var(--sx-on); font-weight: 600; border-top-color: var(--sx-re-tx); }
.ins-btn.danger:hover { color: var(--sx-on); filter: brightness(1.08); }
.ins-btn.danger.armed { background: linear-gradient(180deg, var(--sx-re-tx), var(--sx-re)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--re) 35%, transparent), 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-btn:disabled { opacity: .45; cursor: default; filter: none; }
.ins-run { display: flex; align-items: center; gap: 12px; margin-top: 12px; font-size: 12px; color: var(--tx1b); }
.ins-run .bar { flex: 0 0 220px; height: 8px; border-radius: 4px; background: var(--bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); overflow: hidden; }
.ins-run .bar i { display: block; height: 100%; background: var(--re); border-radius: 4px; transition: width .2s; }
/* 2.5 Movies: posters are portrait, so their rows are narrower on the left */
.ins-li.mv { grid-template-columns: 30px minmax(0, 1fr) auto; }
.ins-poster { width: 30px; height: 44px; border-radius: 6px; object-fit: cover; background: var(--ui2); display: flex; align-items: center;
  justify-content: center; color: var(--tx3); box-shadow: 0 1px 3px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-mvh { display: flex; align-items: center; gap: 8px; margin: 12px 0 2px; font-size: 12px; color: var(--tx1b); }
.ins-mvh i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.ins-mvh b { color: var(--hi); font-weight: 600; }
.ins-mvh .ins-go { margin-left: auto; }
.ins-miss { color: var(--ye); }
@media (max-width: 900px) { .ins-ww { grid-template-columns: minmax(0, 1fr); } .ins-side { position: static; flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .ins-side .h { width: 100%; } .ins-lr { grid-template-columns: 22px minmax(90px, 140px) minmax(80px, 1fr) 48px; } .ins-lr .nums { display: none; }
  .ins-sr { grid-template-columns: minmax(90px, 150px) minmax(0, 1fr) 70px; } .ins-sr .p, .ins-sr .n { display: none; } }
.ins-foot { color: var(--tx3); font-size: 11px; text-align: center; padding: 4px 0 8px; }
#ins-tip { position: fixed; z-index: 2000; pointer-events: none; background: var(--sx-bg2); border: 1px solid var(--sx-ui3); color: var(--sx-hi);
  border-radius: 8px; padding: 7px 10px; font-size: 12px; line-height: 1.5; max-width: 320px; box-shadow: 0 10px 28px rgba(0,0,0,calc(.6*var(--sx-k)));
  display: none; white-space: pre-line; }
@media (max-width: 700px) { .ins-hero { grid-template-columns: minmax(0, 1fr); } .ins-hero .big { font-size: 32px; }
  .ins-grid, .ins-grid3 { grid-template-columns: minmax(0, 1fr); } .ins-sub, .ins-stats { margin-left: 0; } }
/* phones (THEME): the slab without an outer margin and 12px inside; the
   tabs a grid that never leaves one alone on a line: two to a row, the
   first three three to a row when there are seven */
@media (max-width: 576px) { #insights { margin: 8px 0 24px; padding: 12px 12px 8px; }
  .ins-meta { width: 100%; } .ins-meta .ins-upd { flex: 1; min-width: 0; }
  .ins-tabs { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); width: 100%; margin-left: 0; }
  .ins-tab { grid-column: span 3; justify-content: center; padding: 6px 8px; min-width: 0; white-space: nowrap; }
  .ins-tabs:has(> .ins-tab:nth-child(7)) > .ins-tab:nth-child(-n+3) { grid-column: span 2; } }
/* 2.8: Library to-do, the toolkits' hub at the top of Actions */
.ins-pri { background: linear-gradient(180deg, var(--sx-gr), var(--sx-gr-d)); color: var(--sx-on); font-weight: 600; border-top-color: var(--sx-gr-tx); }
.ins-pri:hover { color: var(--sx-on); filter: brightness(1.08); }
.ins-hub { margin-bottom: 14px; }
.ins-hub0 { margin: -4px 0 12px; } .ins-hub0 .ins-note { margin-top: 0; }
.ins-hubtop { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 8px 0 12px; }
.ins-hubt { font-size: 17px; color: var(--tx1b); flex: 1 1 260px; }
.ins-hubt b { font-size: 26px; color: var(--hi); font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.ins-hubt b.one { color: var(--up); }
.ins-hubt0 { color: var(--tx2); font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
.ins-hubs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ins-hubqueue { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; background: var(--bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2);
  box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ins-hqh { color: var(--hi); font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.ins-hqr { display: grid; grid-template-columns: 150px minmax(0, 1fr) 160px; gap: 10px; align-items: center; font-size: 12px; color: var(--tx2); padding: 3px 0; }
.ins-hqr b { color: var(--tx); font-weight: 500; }
.ins-hqr.running span:first-of-type { color: var(--cy); } .ins-hqr.done span { color: var(--up); } .ins-hqr.error span, .ins-hqr.lost span { color: var(--down); }
.ins-hubgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.ins-hk { padding: 10px 12px 8px; display: flex; flex-direction: column; min-width: 0; }
.ins-hk.loading { opacity: .75; }
.ins-hkh { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.ins-hkh b { color: var(--hi); font-size: 14px; font-weight: 600; }
.ins-hkw { color: var(--tx2); font-size: 12px; flex: 1; min-width: 0; } .ins-hkw.busy { color: var(--cy); }
.ins-hkbar { display: block; height: 6px; border-radius: 3px; background: var(--ui); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); overflow: hidden; margin: 0 0 8px; }
.ins-hqr .ins-hkbar { margin: 0; }
.ins-hkbar i { display: block; height: 100%; background: var(--cy); border-radius: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); transition: width .3s; }
.ins-hki { display: grid; grid-template-columns: 76px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; }
.ins-hki + .ins-hki, .ins-hkc + .ins-hki { border-top: 1px solid var(--ins-div1); }
.ins-hkn { font-size: 18px; font-weight: 700; color: var(--c); display: flex; align-items: center; justify-content: flex-end; font-variant-numeric: tabular-nums; }
.ins-hki.info .ins-hkn { color: var(--tx1b); }
.ins-hkn i { width: 7px; height: 7px; border-radius: 2px; background: var(--c); margin-right: auto; flex: none; opacity: .9; }
.ins-hki.info .ins-hkn i { background: var(--tx3); }
.ins-hubk { color: var(--tx2); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; margin: -4px 0 12px; }
.ins-hubk span { display: inline-flex; align-items: center; gap: 6px; } .ins-hubk i { width: 7px; height: 7px; border-radius: 2px; background: var(--c); }
.ins-hkl { color: var(--tx); min-width: 0; }
.ins-hka { display: flex; justify-content: flex-end; }
.ins-hkrun { white-space: nowrap; }
.ins-hkc { margin: 2px 0 8px 86px; padding: 10px 12px; border-radius: 8px; background: var(--ui); border: 1px solid var(--sx-line); border-top-color: var(--ui3);
  color: var(--tx); font-size: 13px; line-height: 1.5; }
.ins-hkc .ins-btns { margin-top: 8px; }
.ins-hkmsg { color: var(--tx2); font-size: 12px; padding: 6px 0 2px; display: flex; align-items: center; gap: 6px; line-height: 1.45; }
.ins-hkmsg.ok { color: var(--up); } .ins-hkmsg.err { color: var(--down); }
.ins-hubq { margin-top: 12px; }
/* 2.8.1: each toolkit's own icon and colour; the Scan all chips */
.ins-hbadge svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.ins-hbadge.sm { width: 20px; height: 20px; border-radius: 6px; vertical-align: middle; } .ins-hbadge.sm svg { width: 13px; height: 13px; }
.ins-hkh { align-items: center; } .ins-hkh .ins-hbadge { margin-right: -2px; }
.ins-hqr b { display: inline-flex; align-items: center; gap: 7px; }
.ins-hmiss { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.ins-hubpick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 4px; }
.ins-hchip { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 4px 10px 4px 5px; border-radius: 8px; cursor: pointer; font-size: 13px;
  background: var(--bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--ui2); color: var(--tx2); box-shadow: inset 0 2px 4px rgba(0,0,0,calc(.4*var(--sx-k))); transition: background .12s, color .12s; }
.ins-hchip .ins-hbadge { opacity: .5; filter: grayscale(.6); }
.ins-hchip:hover:not(:disabled) { color: var(--tx); }
.ins-hchip.on { color: var(--hi); background: var(--ui2); background: color-mix(in srgb, var(--c) 22%, var(--ui2));
  border-color: color-mix(in srgb, var(--c) 50%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.ins-hchip.on .ins-hbadge { opacity: 1; filter: none; }
.ins-hchip:focus-visible, .ins-hlink:focus-visible { outline: 2px solid var(--c, var(--bl)); outline-offset: 2px; }
.ins-hchk { display: inline-flex; font-style: normal; } .ins-hchk .ins-ic { width: 13px; height: 13px; }
.ins-hchip.on .ins-hchk { color: var(--c); }
.ins-hchip.busy { cursor: default; border-style: dashed; border-color: var(--ui3); }
.ins-hchip em { font-style: normal; font-size: 11px; color: var(--cy); }
.ins-hchip:disabled:not(.busy) { opacity: .6; cursor: default; }
.ins-hpq { display: inline-flex; gap: 4px; margin-left: 4px; }
.ins-hlink { background: none; border: 0; color: var(--bl); font-size: 12px; padding: 8px 6px; cursor: pointer; border-radius: 6px; }
.ins-hlink:hover:not(:disabled) { color: var(--sx-bl-tx); } .ins-hlink:disabled { opacity: .5; cursor: default; }
.ins-hpn { margin: 2px 0 12px; }
@media (max-width: 576px) {
  .ins-hubgrid { grid-template-columns: minmax(0, 1fr); }
  .ins-hubs { width: 100%; } .ins-hubs .ins-btn { flex: 1; justify-content: center; }
  .ins-hki { grid-template-columns: 58px minmax(0, 1fr) auto; gap: 8px; } .ins-hki.run .ins-hka { grid-column: 2 / -1; justify-content: flex-start; }
  .ins-hkn { font-size: 16px; } .ins-hkh { flex-wrap: wrap; row-gap: 0; }
  .ins-hkh .ins-go { margin-left: auto; } .ins-hkw { order: 3; flex: 1 1 100%; padding-left: 36px; margin-top: -4px; }
  .ins-hkc { margin-left: 0; }
  .ins-hqr { grid-template-columns: minmax(0, 1fr) auto; } .ins-hqr .ins-hkbar { grid-column: 1 / -1; } }
`;
    document.head.appendChild(s);
  }

  // One tooltip for everything: any element with data-tip.
  function wireTips(root) {
    let tip = document.getElementById("ins-tip");
    if (!tip) { tip = document.createElement("div"); tip.id = "ins-tip"; document.body.appendChild(tip); }
    const place = (ev) => {
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = ev.clientX + 14, y = ev.clientY + 14;
      if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
      if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    root.addEventListener("mouseover", (ev) => {
      const el = ev.target.closest && ev.target.closest("[data-tip]");
      if (!el || !root.contains(el)) { tip.style.display = "none"; return; }
      tip.textContent = el.dataset.tip;
      tip.style.display = "block";
      place(ev);
    });
    root.addEventListener("mousemove", (ev) => { if (tip.style.display === "block") place(ev); });
    root.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    // The tip lives on <body>: a click that opens a list in Stash takes the
    // dashboard away before any mouseleave, and the tip stayed on every page
    // after (user report, 2.3.2). A click hides it; so does leaving /stats.
    root.addEventListener("pointerdown", () => { tip.style.display = "none"; }, true);
  }
  function hideTip() {
    const tip = document.getElementById("ins-tip");
    if (tip && tip.style.display !== "none") tip.style.display = "none";
  }

  const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || "").toUpperCase()).join("");
  // Stash serves a placeholder for performers without an image, marked default=true.
  const hasImage = (p) => p && p.image && !/default=true/.test(p.image);
  const avatar = (p, cls = "") => (hasImage(p) ? `<img class="ins-av ${cls}" src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="ins-av ${cls}">${esc(initials(p && p.name))}</span>`);
  const thumb = (s) => (s && s.shot ? `<img class="ins-th" src="${esc(s.shot)}" alt="" loading="lazy">` : `<span class="ins-th"></span>`);
  const fmtDate = (ms, o = { month: "short", day: "numeric", year: "numeric" }) => new Date(ms).toLocaleDateString(undefined, o);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const fmtN = (n) => (n ?? 0).toLocaleString();
  const fmtMbps = (bps) => (bps ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)}` : "–");
  // Chinese unit for each English noun plural() is called with (by singular
  // or by plural form). The numbers keep their grouping.
  const UNIT_ZH = {
    scene: "个场景", day: "天", hour: "小时", month: "个月", year: "年", run: "次", play: "次播放",
    picture: "张图片", file: "个文件", group: "组", network: "个网络", performer: "位演员", tag: "个标签",
    site: "个站点", copy: "份副本", copies: "份副本", "small group": "个小分组", "quick win": "项快速修复",
    kind: "类问题", "independent studio": "个独立工作室", country: "个国家", countries: "个国家",
    thing: "处", movie: "部影片", appearance: "次出镜", "more studio": "个工作室", lockdown: "次对局",
  };
  const plural = (n, w, ws = `${w}s`) => (isZh()
    ? `${fmtN(n)} ${UNIT_ZH[w] || UNIT_ZH[ws] || w}`
    : `${fmtN(n)} ${n === 1 ? w : ws}`);

  function regionName(code) {
    try { return /^[A-Z]{2}$/.test(code) ? new Intl.DisplayNames(undefined, { type: "region" }).of(code) || code : code; }
    catch (_) { return code; }
  }
  // Stash ships the flag-icons stylesheet (it shows flags on performer
  // cards), so a real flag is one class away; Windows has no flag emoji.
  // If a Stash without it turns up, a code badge stands in.
  let flagOk = null;
  function flagsAvailable() {
    if (flagOk !== null) return flagOk;
    try {
      const t = document.createElement("span");
      t.className = "fi fi-us";
      t.style.cssText = "position:absolute;visibility:hidden";
      document.body.appendChild(t);
      flagOk = /url\(/.test(getComputedStyle(t).backgroundImage || "");
      t.remove();
    } catch (_) { flagOk = false; }
    return flagOk;
  }
  const flag = (code) => (/^[A-Z]{2}$/.test(code || "") && flagsAvailable()
    ? `<span class="fi fi-${code.toLowerCase()} ins-flag" title="${esc(code)}"></span>`
    : `<span class="ins-cc">${esc(code || "?")}</span>`);

  // A card: icon badge in the card's colour, title, controls on the right.
  function card(o, body) {
    return `<section class="ins-card ${o.cls || ""}" ${o.id ? `id="${o.id}"` : ""} style="--c:var(--${o.c || "acc"})">
      <div class="ins-ch"><span class="ins-badge">${ic(o.icon || "list")}</span><b>${o.title}</b>${o.right ? `<span class="r">${o.right}</span>` : ""}</div>
      ${o.sub ? `<div class="ins-sub">${o.sub}</div>` : ""}${body}</section>`;
  }
  // `more`: further attributes, already escaped (the Movies tab's data-mvtab).
  function tile(icon, c, label, value, sub, go, tip, more = "") {
    return `<div class="ins-card ins-tile${go ? " click" : ""}" style="--c:var(--${c})" ${go ? `data-go="${esc(go)}"` : ""} ${tip ? `data-tip="${esc(tip)}"` : ""} ${more}>
      <div class="l">${ic(icon)}${esc(label)}</div><div class="v">${value}</div><div class="s">${sub || ""}</div></div>`;
  }

  // Vertical bars, each with its value above and its label below. Past 16
  // bars both turn sideways so every one still fits and can be read.
  const CLICKS = [];
  function barChart(bars, o = {}) {
    const fmt = o.fmt || fmtN, h = o.height || 130;
    const max = Math.max(1, ...bars.map((b) => b.value));
    // Day numbers fit side by side even in a month; years, dates and
    // durations need turning once there are more than 16.
    const longest = Math.max(0, ...bars.map((b) => Math.max(String(b.label).length, String(fmt(b.value)).length)));
    const dense = (bars.length > 16 && longest > 2) || bars.length > 48;
    const cols = bars.map((b) => {
      const px = b.value ? Math.max(3, Math.round((b.value / max) * h)) : 2;
      const id = b.click ? CLICKS.push(b.click) - 1 : -1;
      return `<div class="ins-bar${b.value ? "" : " zero"}${b.hi ? " hi" : ""}${b.click && !b.future ? " click" : ""}${b.future ? " future" : ""}" ${id >= 0 && !b.future ? `data-bar="${id}"` : ""}
        data-tip="${esc(b.tip || `${b.label}: ${fmt(b.value)}`)}"><em>${b.value || o.zeros ? esc(fmt(b.value)) : ""}</em><i style="height:${px}px${b.color ? `;background:${b.color}` : ""}"></i></div>`;
    }).join("");
    const labels = bars.map((b) => `<span${b.future ? ' style="opacity:.4"' : ""}>${esc(b.label)}</span>`).join("");
    return `<div class="ins-well ins-chart${dense ? " dense" : ""}" ${o.c ? `style="--c:var(--${o.c})"` : ""}><div class="ins-bars" style="height:${h + (dense ? 34 : 18)}px">${cols}</div><div class="ins-xl">${labels}</div></div>`;
  }

  // Horizontal rows: [icon] label | bar | value. rows: {label or
  // labelHtml, value, text, icon, color, go (a link) or set (a control), tip}.
  function rows(list, o = {}) {
    const max = o.max || Math.max(1, ...list.map((r) => r.value));
    const anyIc = list.some((r) => r.icon);
    const style = `${o.lw ? `--lw:${o.lw};` : ""}${o.vw ? `--vw:${o.vw};` : ""}`;
    return list.map((r) => `<div class="ins-row${anyIc ? " has-ic" : ""}${r.go || r.set ? " click" : ""}" style="${style}${r.color ? `--c:${r.color}` : ""}"
      ${r.go ? `data-go="${esc(r.go)}"` : ""} ${r.set ? `data-set="${esc(r.set)}"` : ""} ${r.tip ? `data-tip="${esc(r.tip)}"` : ""}>${anyIc ? `<span>${r.icon || ""}</span>` : ""}
      <span class="l">${r.labelHtml || `<span>${esc(r.label)}</span>`}</span>
      <div class="ins-trk"><i style="width:${r.value ? Math.max(1.5, (r.value / max) * 100).toFixed(1) : 0}%"></i></div>
      <span class="v">${r.text !== undefined ? r.text : fmtN(r.value)}</span></div>`).join("");
  }

  // A ring of segments [{f (0..1), color}] around a centre value.
  function ring(segs, big, small, size = 140) {
    const r = size / 2 - 12, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = segs.filter((sg) => sg.f > 0).map((sg) => {
      const len = sg.f * c, gap = segs.length > 1 ? Math.min(3, len / 3) : 0;
      const a = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${sg.color}" stroke-width="13"
        stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      off += len;
      return a;
    }).join("");
    return `<div class="ins-ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--sx-ui)" stroke-width="13"/>${arcs}</svg>
      <div class="mid"><b>${big}</b><span>${small}</span></div></div>`;
  }

  // ═══ App ═══════════════════════════════════════════════════════════════════

  const PREF_KEY = "insightsI18nPrefs";
  const prefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (_) { return {}; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {} };

  const TABS = [["you", "You", "user", "ma", "你"], ["actions", "Actions", "check", "re", "操作"], ["library", "Library", "film", "or", "库"], ["files", "Files and quality", "chip", "cy", "文件与画质"],
                ["health", "Metadata health", "pulse", "ye", "元数据健康"], ["collection", "Collection", "layers", "gr", "收藏"], ["movies", "Movies", "movie", "pu", "影片"]];
  const tabLabel = (t) => (isZh() && t[4]) || t[1];
  // A remembered Movies tab is kept even while Movies Toolkit is not known to
  // be there yet; `shownTab` draws You meanwhile.
  const firstTab = TABS.some((t) => t[0] === prefs().tab) ? prefs().tab : "you";
  const tabsShown = () => TABS.filter(([id]) => id !== "movies" || moviesShown(app.set));
  const shownTab = () => (tabsShown().some((t) => t[0] === app.tab) ? app.tab : "you");

  // The plugin settings as last read, kept in localStorage so they are right
  // from the first paint: Stash waits for plugin scripts before it draws a
  // page, but reading the config takes a round trip. Display only; nothing
  // here matters if it is lost. Since 2.5 it also remembers whether Movies
  // Toolkit was there (`moviesToolkit`), so the Movies tab does not pop in
  // a moment after the rest.
  const SET_KEY = "insightsI18nSettings";
  function cachedSettings() {
    let j = {};
    try { j = JSON.parse(localStorage.getItem(SET_KEY) || "{}") || {}; } catch (_) {}
    return { ...parseSettings(j), ...parseMovieSetting(j), movies: isOn(j.moviesToolkit), moviesName: isOn(j.moviesName),
             slideshow: isOn(j.slideshow) };
  }

  const app = {
    set: cachedSettings(),
    root: null, data: null, model: null, watch: {}, config: {}, loading: false, error: "", progress: "",
    syncing: "", syncNote: "", lockdown: null, slideshow: null, ostats: null, tab: firstTab,
    // the Movies tab: its last read (cached like the library), and choices
    mv: { data: null, busy: false, err: "", sig: "", rank: prefs().mrank || "plays", more: false, gapsAll: false },
    you: { metric: "o", kind: "month", offset: 0, day: null, top: "byO", mode: "byO", dim: prefs().dim || "country",
           wmetric: "o", sort: "auto", small: !!prefs().small, wgender: prefs().wgender || "ALL", pmore: false },
    lib: { timeline: "released", year: null },
    files: { space: "studio", spaceAll: false },
    acts: freshActs(),
    // Library to-do (2.8): the toolkits' cards, by id, and a running "Scan all"
    hub: { at: 0, loading: false, cards: new Map(), present: null, queue: null, armed: "" },
    col: { tag: null, gender: prefs().gender || "FEMALE", studios: "networks" },
  };

  // Actions state: the last duplicate scan and what the user ticked. A
  // refresh starts it over (the scan would describe the old library).
  function freshActs() {
    return { dups: null, state: "idle", err: "", mode: "hevc", merge: true, sharp: true, ticks: new Map(), armed: false,
             run: null, showAll: false, scanned: 0, msg: "", tagMsg: "", phashMsg: "" };
  }

  // `set.hideO`: the You tab's activity (`act`) is plays instead of O's,
  // and the Lockdown layer is left out (its runs are built around O's).
  function buildModel(data, watch, lockdown, set = {}) {
    const now = Date.now();
    const scenes = data.scenes;
    const perfById = new Map(data.performers.map((p) => [p.id, p]));
    const { events, undated } = collectOs(scenes);
    const byDay = countByDay(events);
    const st = streaks(byDay, now), record = recordDay(byDay);
    const tagIds = new Map(), ptagIds = new Map();
    for (const s of scenes) for (const [id, name] of s.tags) tagIds.set(name, id);
    for (const p of data.performers) for (const [id, name] of p.tags) ptagIds.set(name, id);
    const memo = new Map();
    return {
      now, scenes, perfById, performers: data.performers, studios: data.studios || [], stats: data.stats || {},
      counts: { ...(data.counts || {}), "t.once": tagCounts(scenes).filter((t) => t.n === 1).length },
      events, undated, byDay, tagIds, ptagIds, st, record, noO: !!set.hideO,
      act: set.hideO ? activity(collectPlays(scenes), now)
        : { events, undated, byDay, st, record, cal: calendar(byDay, now), wh: weekdayHour(events) },
      people: performerTable(scenes, perfById, now), top: topScenes(scenes, now), lib: library(scenes),
      ratings: ratingBands(scenes), backlog: backlog(scenes, now, set.hideO), traits: new Map(),
      watchByDay: new Map(Object.entries(watch || {})), watch: watch || {}, lockdown: set.hideO ? null : lockdownModel(lockdown, now),
      // The rest is worked out the first time a tab needs it.
      get: (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); },
    };
  }

  const ALL_DIMS = PERFORMER_TRAITS.concat(SCENE_TRAITS);
  function traits(dimId) {
    const m = app.model, g = worksGender(m);
    const key = `${dimId}|${g === null ? "*" : g}`;
    if (!m.traits.has(key)) m.traits.set(key, traitRows(m.scenes, m.perfById, ALL_DIMS.find((d) => d.id === dimId), { gender: g }));
    return m.traits.get(key);
  }
  // The genders in the library, most performers first, for the chips; the
  // chosen one, or null for everyone (a remembered gender that is no longer
  // in the library falls back to everyone).
  function libGenders(m) {
    return m.get("genders", () => {
      const n = new Map();
      for (const p of m.perfById.values()) { const k = p.gender || ""; n.set(k, (n.get(k) || 0) + 1); }
      return GENDERS.filter(([k]) => n.get(k)).map(([k, label, c]) => ({ k, label, c, n: n.get(k) }));
    });
  }
  function worksGender(m) {
    const g = app.you.wgender;
    return g === "ALL" || g === undefined || g === null || !libGenders(m).some((x) => x.k === g) ? null : g;
  }

  const S = (criteria, sort = "date", dir = "desc") => listUrl("/scenes", criteria, sort, dir);
  const P = (criteria, sort = "scenes_count") => listUrl("/performers", criteria, sort);
  const items = (id, label) => ({ items: [{ id, label }], excluded: [], depth: 0 });

  // Where a trait row leads: a filtered performer or scene list, or nowhere.
  function traitLink(dimId, value) {
    const m = app.model;
    const range = (txt) => (String(txt).match(/\d+/g) || []).map(Number);
    switch (dimId) {
      case "country": return P([{ type: "country", modifier: "EQUALS", value }]);
      case "ethnicity": return P([{ type: "ethnicity", modifier: "EQUALS", value }]);
      case "hair": return P([{ type: "hair_color", modifier: "EQUALS", value }]);
      case "eyes": return P([{ type: "eye_color", modifier: "EQUALS", value }]);
      case "tattoos": return P([{ type: "tattoos", modifier: value === "tattoos" ? "NOT_NULL" : "IS_NULL" }]);
      case "piercings": return P([{ type: "piercings", modifier: value === "piercings" ? "NOT_NULL" : "IS_NULL" }]);
      case "favourite": return P([{ type: "filter_favorites", value: value === "favourites" ? "true" : "false" }]);
      case "height": { const n = range(value); return P([n.length === 2 ? { type: "height_cm", modifier: "BETWEEN", value: { value: n[0], value2: n[1] } }
                                                      : /under/.test(value) ? { type: "height_cm", modifier: "LESS_THAN", value: { value: n[0] } }
                                                      : { type: "height_cm", modifier: "GREATER_THAN", value: { value: n[0] - 1 } }]); }
      case "ptags": { const id = m.ptagIds.get(value); return id ? P([{ type: "tags", modifier: "INCLUDES", value: items(id, value) }]) : null; }
      case "age": { const n = range(value); return S([n.length === 2 ? { type: "performer_age", modifier: "BETWEEN", value: { value: n[0], value2: n[1] } }
                                                   : { type: "performer_age", modifier: "GREATER_THAN", value: { value: n[0] - 1 } }], topSort()); }
      case "tags": { const id = m.tagIds.get(value); return id ? S([{ type: "tags", modifier: "INCLUDES", value: items(id, value) }], topSort()) : null; }
      case "studio": { const st = m.scenes.find((s) => s.studio && s.studio.name === value); return st ? S([{ type: "studios", modifier: "INCLUDES", value: items(st.studio.id, value) }], topSort()) : null; }
      case "cast": return S([value === "solo" ? { type: "performer_count", modifier: "EQUALS", value: { value: 1 } }
                          : value === "two performers" ? { type: "performer_count", modifier: "EQUALS", value: { value: 2 } }
                          : { type: "performer_count", modifier: "GREATER_THAN", value: { value: 2 } }], topSort());
      case "era": { const n = range(value); return S([n.length === 2 ? { type: "date", modifier: "BETWEEN", value: { value: `${n[0]}-01-01`, value2: `${n[1]}-12-31` } }
                                                   : { type: "date", modifier: "LESS_THAN", value: { value: "2005-01-01" } }], topSort()); }
      case "interactive": return S([{ type: "interactive", value: value === "interactive" ? "true" : "false" }], topSort());
      default: return null;
    }
  }
  // Display-only Chinese for the built-in group values. The values themselves
  // stay English: they are what the Stash filters and ORDER are matched on.
  const TRAIT_VALUE_ZH = {
    height: { "under 155 cm": "155 cm 以下", "175 cm and up": "175 cm 及以上" },
    weight: { "under 50 kg": "50 kg 以下", "70 kg and up": "70 kg 及以上" },
    age: { "51 and up": "51 岁及以上" },
    career: { "first 2 years": "前 2 年", "years 3–5": "第 3–5 年", "years 6–10": "第 6–10 年", "over 10 years in": "入行超过 10 年" },
    length: { "under 10 min": "10 分钟以下", "10–30 min": "10–30 分钟", "30–60 min": "30–60 分钟", "over an hour": "超过 1 小时" },
    resolution: { "4K and up": "4K 及以上" },
    cast: { solo: "单人", "two performers": "两人", "three or more": "三人及以上" },
    era: { "before 2005": "2005 年以前" },
    natural: { natural: "天然", enhanced: "隆胸" },
    tattoos: { tattoos: "有纹身", "no tattoos": "无纹身" },
    piercings: { piercings: "有穿孔", "no piercings": "无穿孔" },
    favourite: { favourites: "最爱", "not favourites": "非最爱" },
    interactive: { interactive: "可交互", "not interactive": "不可交互" },
  };
  const traitLabel = (dimId, value) => (dimId === "country" ? regionName(value)
    : (isZh() && TRAIT_VALUE_ZH[dimId] && TRAIT_VALUE_ZH[dimId][value]) || value);
  // A trait dimension's own name, for the sidebar and the axis.
  const dimLabel = (d) => (isZh() && d.labelZh) || d.label;
  const traitIcon = (dimId, value) => (dimId === "country" ? flag(value) : "");

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const root = app.root;
    if (!root) return;
    CLICKS.length = 0;
    const tab = shownTab();
    root.dataset.tab = tab;
    root.innerHTML = `
      <div class="ins-head"><span class="ins-title">${ic("spark")}Insights</span>
        <div class="ins-meta"><span class="ins-upd${app.syncing ? " busy" : ""}">${esc(metaText())}</span>
          ${dataButton()}<button class="ins-btn" data-act="refresh" data-tip="${tc("重新读取媒体库", "Read the library again")}">${ic("refresh")} ${tc("刷新", "Refresh")}</button></div>
        <div class="ins-tabs">${tabsShown().map((t) => `<button class="ins-tab${tab === t[0] ? " on" : ""}" style="--tc:var(--${t[3]})" data-tab="${t[0]}">${ic(t[2])}${tabLabel(t)}</button>`).join("")}</div></div>
      <div class="ins-body"></div>
      <div class="ins-foot">${tc("每根条形、每一行和每个磁贴都会在 Stash 中打开对应的列表。全部在你的浏览器中算出来；数据不会外传。", "Every bar, row and tile opens the matching list in Stash. Worked out in your browser; nothing leaves it.")}</div>`;
    const body = root.querySelector(".ins-body");
    if (app.error) { body.innerHTML = `<div class="ins-error">${tc(`Insights 无法载入你的媒体库：${esc(app.error)}。`, `Insights could not load your library: ${esc(app.error)}.`)} <button class="ins-btn" data-act="refresh">${tc("重试", "Try again")}</button></div>`; return; }
    if (!app.model) { body.innerHTML = `<div class="ins-progress">${esc(app.progress || tc("正在准备…", "Getting ready…"))}<div class="bar"><i></i></div></div>`; return; }
    ({ you: renderYou, actions: renderActions, library: renderLibrary, files: renderFiles, health: renderHealth, collection: renderCollection,
       movies: renderMovies }[tab] || renderYou)(body);
  }

  function metaText() {
    if (!app.data) return "";
    const min = Math.max(0, Math.round((Date.now() - app.data.at) / 60000));
    const when = min < 1 ? tc("刚刚更新", "updated just now") : min < 60 ? tc(`${min} 分钟前更新`, `updated ${min} min ago`)
      : min < 2880 ? tc(`${Math.round(min / 60)} 小时前更新`, `updated ${Math.round(min / 60)} h ago`)
      : tc(`${Math.round(min / 1440)} 天前更新`, `updated ${Math.round(min / 1440)} days ago`);
    return when + (app.syncing ? ` · ${app.syncing}` : app.syncNote ? ` · ${app.syncNote}` : "");
  }
  // Only the line in the header, so a check never redraws what is being read.
  function renderMeta() {
    const el = app.root && app.root.querySelector(".ins-upd");
    if (!el) return;
    el.textContent = metaText();
    el.classList.toggle("busy", !!app.syncing);
  }

  const chipFor = (grp, key, v, label, c) => `<button class="ins-chip${app[grp][key] === v ? " on" : ""}" ${c ? `style="--c:var(--${c})"` : ""} data-set="${grp}.${key}=${v}">${label}</button>`;
  const go = (url, label = "Open") => `<span class="ins-go" data-go="${esc(url)}">${esc(label)}${ic("arrow")}</span>`;

  function importBanner() {
    if (!app.ostats || app.config.ostatsImported === "true") return "";
    return `<div class="ins-card ins-banner"><span class="ins-badge">${ic("clock")}</span><span>${tc(`发现来自 O Stats 插件的 <b>${app.ostats.days}</b> 天观看时长。导进来，你的观看历史就能接着算。`, `Found <b>${app.ostats.days}</b> days of watch time from the O Stats plugin.
      Bring them in so your watch history starts where it left off.`)}</span><button class="ins-btn" data-act="import">${tc("导入", "Import")}</button></div>`;
  }

  // ── You ───────────────────────────────────────────────────────────────────

  // O's in Flexoki blue like everywhere in the suite (magenta up to 2.5).
  // Plays share the ramp; the calendar shows one or the other, never both.
  // The steps are theme tokens (--ins-<ramp><n>, worked out in THEME's
  // extra): Flexoki's own steps with Flexoki on, the theme's surface into
  // the hue without it.
  const RAMP_STEPS = { o: ["#133051", "#1A4F8C", "#205EA6", "#4385BE", "#92BFDB"],
                       watch: ["#14302D", "#1C5A54", "#24837B", "#3AA99F", "#87D3C3"],
                       hour: ["#2A2640", "#3F3765", "#5E409D", "#8B7EC8", "#C4B9F0"] };
  const RAMP_HUE = { o: "bl", watch: "cy", hour: "pu" };
  const rampOf = (k) => ["var(--sx-ui)"].concat([1, 2, 3, 4, 5].map((n) => `var(--ins-${k}${n})`));
  const RAMP = { o: rampOf("o"), watch: rampOf("watch"), hour: rampOf("hour"), play: rampOf("o") };
  function heat(v, max, ramp) {
    if (v <= 0) return ramp[0];
    const r = v / max;
    return ramp[r < 0.2 ? 1 : r < 0.4 ? 2 : r < 0.6 ? 3 : r < 0.85 ? 4 : 5];
  }
  const os = (n) => tc(`${fmtN(n)} 次 O`, `${fmtN(n)} O${n === 1 ? "" : "'s"}`);
  // What the You tab counts (`m.act`): O's, or with "Hide O's" (2.4) plays,
  // for a library of home videos where an O counter means nothing. The same
  // cards and sentences, worded for each.
  const WORDS = {
    o: { n: os, word: "O", one: "an O", many: "O's", Many: "O's", unit: "O's", icon: "drop", c: "o", ramp: "o" },
    plays: { n: (n) => plural(n, "play"), word: "play", one: "a play", many: "plays", Many: "Plays", unit: "plays", icon: "play", c: "bl", ramp: "play" },
  };
  const WORDS_ZH = {
    o: { n: os, word: "O", one: "一次 O", many: "O", Many: "O", unit: " 次 O", icon: "drop", c: "o", ramp: "o" },
    plays: { n: (n) => plural(n, "play"), word: "播放", one: "一次播放", many: "播放", Many: "播放", unit: " 次播放", icon: "play", c: "bl", ramp: "play" },
  };
  const wordsOf = (m) => (isZh() ? WORDS_ZH : WORDS)[m.noO ? "plays" : "o"];
  // Scene lists opened from a ranking: most O's first, or most played.
  const topSort = () => (app.set.hideO ? "play_count" : "o_counter");

  function weekSum(m, off) {
    let v = 0;
    const ws = addDays(weekStart(m.now), off * 7);
    for (let i = 0; i < 7; i++) v += m.act.byDay.get(dayKey(addDays(ws, i))) || 0;
    return v;
  }
  function monthSum(m, off) {
    const d = new Date(m.now), from = new Date(d.getFullYear(), d.getMonth() + off, 1).getTime(), to = new Date(d.getFullYear(), d.getMonth() + off + 1, 1).getTime();
    let v = 0;
    for (let x = from; x < to; x = addDays(x, 1)) v += m.act.byDay.get(dayKey(x)) || 0;
    return v;
  }

  function weekMini(m) {
    const ws = weekStart(m.now), today = dayKey(m.now), W = wordsOf(m);
    const vals = Array.from({ length: 7 }, (_, i) => { const d = addDays(ws, i); return { d, k: dayKey(d), v: m.act.byDay.get(dayKey(d)) || 0 }; });
    const max = Math.max(1, ...vals.map((x) => x.v));
    return `<div class="ins-week">${vals.map((x) => `<div class="${x.k === today ? "today" : ""}" data-day="${x.k}" style="cursor:pointer"
      data-tip="${esc(tc(`${fmtDate(x.d, { weekday: "long", month: "short", day: "numeric" })}：${W.n(x.v)}`, `${fmtDate(x.d, { weekday: "long", month: "short", day: "numeric" })}: ${W.n(x.v)}`))}"><b>${x.d > m.now ? "" : x.v}</b>
      <i class="${x.v ? "" : "z"}" style="height:${x.v ? Math.max(8, Math.round((x.v / max) * 74)) : 4}px"></i>${esc(new Date(x.d).toLocaleDateString(undefined, { weekday: "narrow" }))}</div>`).join("")}</div>`;
  }

  function calendarHtml(m) {
    const cal = m.act.cal, today = dayKey(m.now), W = wordsOf(m);
    const weeks = cal.cells.length / 7;
    // month labels with that month's total, over the column its first week starts in
    const monthTotals = new Map();
    for (const c of cal.cells) if (!c.future) { const k = c.key.slice(0, 7); monthTotals.set(k, (monthTotals.get(k) || 0) + c.value); }
    let months = "";
    for (let w = 0; w < weeks; w++) {
      const d = new Date(cal.cells[w * 7].from);
      const first = w === 0 ? d.getDate() <= 7 : new Date(cal.cells[(w - 1) * 7].from).getMonth() !== d.getMonth();
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      months += `<span>${first ? `${esc(d.toLocaleDateString(undefined, { month: "short" }))}<b>${monthTotals.get(k) || 0}</b>` : ""}</span>`;
    }
    const cells = cal.cells.map((c) => c.future ? `<i class="f"></i>`
      : `<i class="${c.key === today ? "today" : ""}" style="background:${heat(c.value, cal.max, RAMP[W.ramp])}" data-day="${c.key}" data-tip="${esc(fmtDate(c.from, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}: ${W.n(c.value)}"></i>`).join("");
    const total = cal.cells.reduce((a, c) => a + c.value, 0);
    const legend = RAMP[W.ramp].map((col) => `<i style="background:${col}"></i>`).join("");
    return `<div class="ins-calm" style="grid-template-columns:repeat(${weeks},1fr)">${months}</div>
      <div class="ins-cal" style="grid-template-columns:repeat(${weeks},1fr)">${cells}</div>
      <div class="ins-legend" style="margin-top:10px"><span style="margin-right:auto">${tc(`${W.n(total)}，最近 12 个月${m.act.undated ? ` · 另有 ${fmtN(m.act.undated)} 次没有日期` : ""}`, `${W.n(total)} in the last 12 months${m.act.undated ? ` · ${fmtN(m.act.undated)} more without a date` : ""}`)}</span>
        ${tc(`少 ${legend} 多`, `less ${legend} more`)}</div>`;
  }

  function heatmapHtml(m) {
    const wh = m.act.wh, W = wordsOf(m);
    const max = Math.max(1, ...wh.flat());
    const days = isZh() ? ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const hl = (i) => (i === 0 ? "12a" : i < 12 ? `${i}a` : i === 12 ? "12p" : `${i - 12}p`);
    let h = `<span></span>${Array.from({ length: 24 }, (_, i) => `<span class="c">${i % 3 === 0 ? hl(i) : ""}</span>`).join("")}<span class="t">${tc("合计", "all")}</span>`;
    wh.forEach((row, d) => {
      h += `<span>${days[d]}</span>` + row.map((v, hr) => `<i style="background:${heat(v, max, RAMP.hour)}" data-tip="${tc(`${days[d]} ${hl(hr)} 至 ${hl((hr + 1) % 24)}：${W.n(v)}`, `${days[d]} ${hl(hr)} to ${hl((hr + 1) % 24)}: ${W.n(v)}`)}"></i>`).join("") +
        `<span class="t">${row.reduce((a, b) => a + b, 0)}</span>`;
    });
    const cols = Array.from({ length: 24 }, (_, hr) => wh.reduce((a, row) => a + row[hr], 0));
    h += `<span>${tc("合计", "all")}</span>${cols.map((v, hr) => `<span class="c" data-tip="${tc(`${hl(hr)} 至 ${hl((hr + 1) % 24)}，任意一天：${W.n(v)}`, `${hl(hr)} to ${hl((hr + 1) % 24)}, any day: ${W.n(v)}`)}">${v || ""}</span>`).join("")}<span class="t">${cols.reduce((a, b) => a + b, 0)}</span>`;
    return `<div class="ins-hm">${h}</div>`;
  }

  function statRow(icon, c, label, value, sub) {
    return `<div class="ins-chk"><span class="ins-sq" style="--c:var(--${c})">${ic(icon)}</span>
      <div><div class="n">${esc(label)}</div><div class="sub">${esc(sub || "")}</div></div><div class="v">${esc(value)}</div></div>`;
  }

  function perfRow(r, value, text, sub, max) {
    const p = r.p || { name: tc(`演员 ${r.id}`, `Performer ${r.id}`) };
    const counts = app.set.hideO ? plural(r.scenes, "scene") : tc(`${os(r.o)}，共 ${plural(r.scenes, "scene")}`, `${os(r.o)} in ${plural(r.scenes, "scene")}`);
    return `<div class="ins-li av click" data-go="/performers/${esc(r.id)}" data-tip="${esc(tc(`${p.name}\n${counts}\n播放 ${r.plays}× · 观看 ${fmtDur(r.watch)}`, `${p.name}\n${counts}\nplayed ${r.plays}× · watched ${fmtDur(r.watch)}`))}">
      ${avatar(p)}<div style="min-width:0"><div class="n">${esc(p.name)}</div><div class="sub">${sub}</div>
      <div class="ins-trk" style="height:5px;margin-top:4px"><i style="width:${Math.max(2, Math.round((value / Math.max(max, 1e-9)) * 100))}%"></i></div></div>
      <div class="v" style="color:var(--hi);font-weight:700">${text}</div></div>`;
  }

  // Ranked by the O lift, or with "Hide O's" the play lift.
  function strongestPulls(metric) {
    const lift = (r) => (metric === "plays" ? r.playLift : r.lift);
    const out = [];
    for (const d of PERFORMER_TRAITS.concat(SCENE_TRAITS.filter((x) => x.id === "tags" || x.id === "studio"))) {
      for (const r of traits(d.id).rows) {
        if (r.small || lift(r) < 1.25 || r.scenes < 8) continue;
        out.push({ d, r, lift: lift(r), share: metric === "plays" ? r.playShare : r.oShare, score: (lift(r) - 1) * Math.sqrt(r.scenes) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 6);
  }

  function renderYou(el) {
    const m = app.model, y = app.you, A = m.act, W = wordsOf(m), st = A.st, noO = m.noO;
    // a remembered choice that is about O's is not drawn while they are hidden
    const metric = choice("metric", y.metric, noO), ptop = choice("top", y.top, noO);
    const today = A.byDay.get(dayKey(m.now)) || 0;
    const wk = weekSum(m, 0), lastWk = weekSum(m, -1);
    const wpo = noO ? null : watchPerO(m.watch, m.byDay, m.now);
    let watchWk = 0;
    for (let i = 0; i < 7; i++) watchWk += m.watch[dayKey(addDays(weekStart(m.now), i))] || 0;
    const lastToday = A.events.filter((e) => dayKey(e.t) === dayKey(m.now)).pop();
    const mo = monthSum(m, 0), lastMo = monthSum(m, -1);
    const L = m.lockdown;

    // over time
    const source = metric === "watch" ? m.watchByDay : A.byDay;
    const per = periodBars(source, y.kind, y.offset, m.now);
    const fmtV = metric === "watch" ? (v) => (v ? fmtDur(v) : "0") : fmtN;
    const pBars = per.bars.map((b) => ({ ...b, label: y.kind === "month" ? b.label : b.label,
      tip: `${y.kind === "year" ? fmtDate(b.from, { month: "long", year: "numeric" }) : fmtDate(b.from, { weekday: "short", month: "short", day: "numeric" })}: ${metric === "watch" ? fmtDur(b.value) : W.n(b.value)}`,
      hi: y.kind !== "year" && b.key === dayKey(m.now), future: b.from > m.now,
      click: y.kind === "year" ? () => { y.kind = "month"; y.offset = (new Date(b.from).getFullYear() - new Date(m.now).getFullYear()) * 12 + new Date(b.from).getMonth() - new Date(m.now).getMonth(); render(); }
                               : () => { y.day = b.key; render(); document.getElementById("ins-otd")?.scrollIntoView({ behavior: "smooth", block: "center" }); } }));
    const pTotal = per.bars.reduce((a, b) => a + b.value, 0);

    // a day
    const day = y.day || dayKey(m.now);
    const ev = dayEvents(m.scenes, day, noO);
    const dayN = noO ? ev.length : ev.filter((e) => e.o).length, dayScenes = new Set(ev.map((e) => e.scene.id)).size;
    const isToday = day === dayKey(m.now);

    // Lockdown: performers by time watched in their runs (from Lockdown 2.1), then time locked
    const ldPeople = L ? [...L.perf.entries()].map(([id, x]) => ({ ...(m.people.byId.get(id) || { id, o: 0, scenes: 0, plays: 0, watch: 0 }),
      p: m.perfById.get(id) || null, ld: x })).sort((a, b) => b.ld.watched - a.ld.watched || b.ld.ms - a.ld.ms) : [];
    const pmode = choice("mode", y.mode === "lockdown" && !ldPeople.length ? "byO" : y.mode, noO);
    const pall = pmode === "lockdown" ? ldPeople : { byO: m.people.byO, byRate: m.people.byRate, byPlays: m.people.byPlays, byWatch: m.people.byWatch, neglected: m.people.neglected }[pmode];
    const plist = pall.slice(0, y.pmore ? 50 : 10);
    const pmax = plist.length ? (pmode === "byRate" ? plist[0].perScene : pmode === "byWatch" ? plist[0].watch : pmode === "byPlays" ? plist[0].plays
      : pmode === "lockdown" ? Math.max(...plist.map((r) => r.ld.watched)) || Math.max(...plist.map((r) => r.ld.ms)) : Math.max(1, ...plist.map((r) => r.o))) : 1;
    const ldMark = (r) => { const x = L && L.perf.get(r.id); return x ? ` · <span style="color:var(--re)">${ic("lock")}</span> ${plural(x.runs, "run")}` : ""; };
    const ldDay = (L && L.byDay.get(day)) || [];
    const tops = { byO: m.top.byO, byPlays: m.top.byPlays, unvisited: m.top.unvisited }[ptop] || [];
    const bl = m.backlog, blMax = Math.max(1, ...bl.map((b) => b.n)), blHalf = Math.ceil(bl.length / 2);
    const blIcon = { "eye-off": "eyeoff", star: "star", "player-pause": "pause", "drop-off": "dropoff", heart: "heart", folder: "folder" };
    const blColor = { unwatched: "bl", unrated: "ye", started: "cy", teasers: "or", loved: "ma", unorganized: "tx2" };
    // only the choices that can be in effect; Lockdown only with its runs
    const chips = (key, c) => choices(key, noO).filter(([v]) => v !== "lockdown" || ldPeople.length)
      .map(([v, label]) => `<button class="ins-chip${(key === "mode" ? pmode : key === "top" ? ptop : metric) === v ? " on" : ""}" style="--c:var(--${v === "watch" && key === "metric" ? "cy" : c})" data-set="you.${key}=${v}">${label}</button>`).join("");
    const perfSub = (r) => (noO ? plural(r.scenes, "scene") : `${os(r.o)} · ${plural(r.scenes, "scene")}`);

    el.innerHTML = importBanner() + `
      <section class="ins-card ins-hero" style="--c:var(--${W.c})">
        <div><div class="k">${ic(W.icon)}${tc("本周", "THIS WEEK")}</div><div class="big">${W.n(wk)}</div>
          <div class="s">${st.current ? tc(`连续 <b>${st.current} 天</b>${st.atRisk ? `，今天再来一次就能续上` : ""}。 `, `A <b>${st.current}-day streak</b>${st.atRisk ? `, and ${W.one} today keeps it going` : ""}. `) : st.daysSinceLast !== null ? tc(`距上次 ${W.word} 已经 ${plural(st.daysSinceLast, "day")}。 `, `${plural(st.daysSinceLast, "day")} since the last ${W.word}. `) : ""}
            ${st.best.len ? tc(`你的最好成绩是 <b>${plural(st.best.len, "day")}</b>。 `, `Your best is <b>${plural(st.best.len, "day")}</b>. `) : ""}${lastWk || wk ? tc(`上周：${W.n(lastWk)}。 `, `Last week: ${W.n(lastWk)}. `) : ""}
            ${watchWk ? tc(`这周你看了 <b>${fmtDur(watchWk)}</b>${wpo ? `，按最近 30 天算每次 O 约 ${fmtDur(wpo)}` : ""}。`, `You watched <b>${fmtDur(watchWk)}</b> this week${wpo ? `, about ${fmtDur(wpo)} per O over the last 30 days` : ""}.`) : wpo ? tc(`最近 30 天每次 O 大约看 <b>${fmtDur(wpo)}</b>。`, `About <b>${fmtDur(wpo)}</b> of watching per O over the last 30 days.`) : ""}
            ${L && L.week.runs ? tc(` 本周 <b>${plural(L.week.runs, "lockdown")}</b>${L.week.done ? `，${fmtN(L.week.done)} 次脱出` : ""}。`, ` <b>${plural(L.week.runs, "lockdown")}</b> this week${L.week.done ? `, ${fmtN(L.week.done)} got out` : ""}.`) : ""}</div></div>
        ${weekMini(m)}
      </section>
      <div class="ins-tiles">
        ${tile(W.icon, W.c, tc("今天", "Today"), today, lastToday ? tc(`最后一次 ${fmtTime(lastToday.t)}`, `last at ${fmtTime(lastToday.t)}`) : tc("今天还没有", "none yet today"))}
        ${tile("calendar", "or", tc("本月", "This month"), mo, tc(`上月 ${W.n(lastMo)}`, `${W.n(lastMo)} last month`))}
        ${tile("flame", "ye", tc("最长连续", "Best streak"), st.best.len ? plural(st.best.len, "day") : "–", st.best.len ? tc(`${fmtDate(st.best.from, { month: "short", day: "numeric" })} 至 ${fmtDate(st.best.to)}`, `${fmtDate(st.best.from, { month: "short", day: "numeric" })} to ${fmtDate(st.best.to)}`) : tc(`还没有带日期的 ${W.many}`, `no dated ${W.many} yet`))}
        ${tile("trophy", "cy", tc("记录日", "Record day"), A.record ? W.n(A.record.n) : "–", A.record ? fmtDate(parseDay(A.record.day), { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "")}
      </div>
      ${card({ title: tc(`一年的 ${W.many}`, `A year of ${W.many}`), icon: "calendar", c: W.c, right: tc("点击某天可打开它", "click a day to open it") }, calendarHtml(m))}
      <div class="ins-grid">
        ${card({ title: metric === "watch" ? tc("观看时长", "Watch time") : tc(`${W.Many} 随时间变化`, `${W.Many} over time`), icon: "trend", c: metric === "watch" ? "cy" : W.c,
          right: `${chips("metric", W.c)}
            ${chipFor("you", "kind", "week", tc("周", "Week"))}${chipFor("you", "kind", "month", tc("月", "Month"))}${chipFor("you", "kind", "year", tc("年", "Year"))}`,
          sub: `<button class="ins-nav" data-nav="-1" aria-label="${tc("更早", "Earlier")}">‹</button> <b style="color:var(--hi);margin:0 8px">${esc(per.title)}</b>
            <button class="ins-nav" data-nav="1" aria-label="${tc("更晚", "Later")}" ${y.offset >= 0 ? "disabled" : ""}>›</button>
            <span style="margin-left:10px">${tc(`${metric === "watch" ? `看了 ${fmtDur(pTotal)}` : W.n(pTotal)} · ${y.kind === "year" ? "点击某个月可打开它" : "点击某天查看"}`, `${metric === "watch" ? `${fmtDur(pTotal)} watched` : W.n(pTotal)} · ${y.kind === "year" ? "click a month to open it" : "click a day to see it"}`)}</span>` },
          barChart(pBars, { fmt: fmtV, c: metric === "watch" ? "cy" : W.c }) +
          (metric === "watch" && !Object.keys(m.watch).length ? `<div class="ins-note">${tc("观看时长在场景播放器播放时累计；目前还没有记录。", "Watch time counts while a scene's player plays; nothing is counted yet.")}</div>` : ""))}
        ${card({ title: tc("时间分布", "When"), icon: "clock", c: "pu", sub: tc(`按星期与小时的 ${W.Many}，并给出各项合计`, `${W.Many} by weekday and hour, with totals for each`) }, heatmapHtml(m))}
      </div>
      <div class="ins-grid">
        ${card({ title: isToday ? tc("今天", "Today") : esc(fmtDate(parseDay(day), { weekday: "long", month: "long", day: "numeric", year: "numeric" })), icon: "calendar", c: "cy", id: "ins-otd",
          right: `<button class="ins-nav" data-daynav="-1" aria-label="${tc("前一天", "Day before")}">‹</button><button class="ins-nav" data-daynav="1" aria-label="${tc("后一天", "Day after")}" ${isToday ? "disabled" : ""}>›</button>` },
          `<div class="ins-stats"><span><b style="color:var(--${W.c})">${dayN}</b>${W.unit}</span><span><b style="color:var(--cy)">${fmtDur(m.watch[day] || 0)}</b>${tc("观看", "watched")}</span><span><b>${dayScenes}</b>${tc(" 个场景", "scenes")}</span></div>
          <div class="ins-day"><div class="axis"></div>${ev.map((e) => {
            const d = new Date(e.t), x = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
            return `<span class="dot ${e.o ? "o" : "p"}" style="left:${x.toFixed(2)}%" data-go="/scenes/${esc(e.scene.id)}" data-tip="${esc(fmtTime(e.t))} · ${esc(e.scene.title)}${e.o ? " · O" : tc(" · 已播放", " · played")}"></span>`; }).join("")}</div>
          <div class="ins-hours"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
          ${ldDay.map((e) => `<div class="ins-li click" data-go="/lockdown"><span class="ins-sq" style="--c:var(--re);width:28px;height:28px">${ic("lock")}</span>
            <div style="min-width:0"><div class="n">Lockdown · ${esc(e.name || "?")}</div><div class="sub">${tc(`${esc(fmtTime(e.at))} 至 ${esc(fmtTime(e.at + (e.ms || 0)))} · ${e.result === "done" ? "成功脱出" : "放弃"}${typeof e.heat === "number" ? ` · 热度 ${Math.round(e.heat * 10) / 10}` : ""}${ldHasWatch(e) && e.watchedMs ? ` · 观看 ${fmtDur(e.watchedMs / 1000)}` : ""}`, `${esc(fmtTime(e.at))} to ${esc(fmtTime(e.at + (e.ms || 0)))} · ${e.result === "done" ? "got out" : "gave up"}${typeof e.heat === "number" ? ` · heat ${Math.round(e.heat * 10) / 10}` : ""}${ldHasWatch(e) && e.watchedMs ? ` · watched ${fmtDur(e.watchedMs / 1000)}` : ""}`)}</div></div></div>`).join("")}
          <div style="margin-top:8px">${ev.length ? ev.slice(0, 10).map((e) => `<div class="ins-li click" data-go="/scenes/${esc(e.scene.id)}">${thumb(e.scene)}
            <div style="min-width:0"><div class="n">${esc(e.scene.title)}</div><div class="sub">${esc(fmtTime(e.t))}${e.o ? "" : tc(" · 已播放", " · played")}</div></div>
            <div class="v">${e.o ? `<span style="color:var(--otx)">${ic("drop")}</span>` : `<span style="color:var(--cy)">${ic("play")}</span>`}</div></div>`).join("") : `<div class="ins-empty">${tc("这一天没有任何记录。", "Nothing recorded on this day.")}</div>`}</div>`)}
        ${card({ title: tc("节奏", "Rhythm"), icon: "flame", c: "ye" },
          statRow("flame", "or", tc("当前连续", "Current streak"), plural(st.current, "day"), st.atRisk ? `${tc(`今天再来${W.one}就能续上`, `${W.one} today keeps it going`)}` : st.current ? tc("仍在继续", "still going") : st.daysSinceLast !== null ? tc(`距上次 ${W.word} 已经 ${plural(st.daysSinceLast, "day")}`, `${plural(st.daysSinceLast, "day")} since the last ${W.word}`) : "") +
          statRow("trophy", "ye", tc("最长连续", "Best streak"), plural(st.best.len, "day"), st.best.len ? tc(`${fmtDate(st.best.from)} 至 ${fmtDate(st.best.to)}`, `${fmtDate(st.best.from)} to ${fmtDate(st.best.to)}`) : "") +
          statRow("calendar", "bl", tc("最长间隔", "Longest break"), plural(st.longestBreak, "day"), tc(`两次有 ${W.word} 的日子之间`, `between two days with ${W.one}`)) +
          statRow("clock", "cy", tc("通常间隔", "Usually"), st.avgGapDays ? `every ${st.avgGapDays.toFixed(1)} days` : "–", tc(`平均来看，从一个有 ${W.word} 的日子到下一个`, `on average, from one ${W.word} day to the next`)) +
          statRow(W.icon, W.c, tc("记录日", "Record day"), A.record ? W.n(A.record.n) : "–", A.record ? fmtDate(parseDay(A.record.day)) : "") +
          statRow(W.icon, "pu", tc("累计", "All time"), W.n(A.events.length + A.undated), tc(`${fmtN(noO ? m.lib.totals.played : m.lib.totals.withO)} 个场景有`, `${fmtN(noO ? m.lib.totals.played : m.lib.totals.withO)} scenes have one`)))}
      </div>
      ${lockdownCard(m)}
      ${picturesCard(m)}
      ${worksCard(m, y)}
      <div class="ins-grid">
        ${card({ title: tc("你的演员", "Your performers"), icon: "users", c: "ma", right: chips("mode", "ma"),
          sub: pmode === "lockdown" ? tc("每个演员在 Lockdown 对局中被观看的时长（Lockdown 2.1 起），再按锁定时间排。", "Time watched during Lockdown runs on each performer (from Lockdown 2.1), then time locked.") : pmode === "byWatch" ? tc("在 Stash 中的播放时长，全部场景。", "Time played in Stash, all scenes.") : pmode === "byPlays" ? tc("在 Stash 中的播放次数，全部场景。", "Plays in Stash, all scenes.") : "" },
          (plist.length ? plist.map((r) => pmode === "byRate" ? perfRow(r, r.perScene, r.perScene.toFixed(2), tc(`${os(r.o)}，共 ${plural(r.scenes, "scene")}${ldMark(r)}`, `${os(r.o)} in ${plural(r.scenes, "scene")}${ldMark(r)}`), pmax)
            : pmode === "byWatch" ? perfRow(r, r.watch, fmtDur(r.watch), `${perfSub(r)}${ldMark(r)}`, pmax)
            : pmode === "byPlays" ? perfRow(r, r.plays, `${fmtN(r.plays)}×`, tc(`${perfSub(r)} · 观看 ${fmtDur(r.watch)}${ldMark(r)}`, `${perfSub(r)} · watched ${fmtDur(r.watch)}${ldMark(r)}`), pmax)
            : pmode === "lockdown" ? perfRow(r, r.ld.watched || r.ld.ms, r.ld.watched ? fmtDur(r.ld.watched / 1000) : "–",
                tc(`${plural(r.ld.runs, "run")} · 锁定 ${fmtDur(r.ld.ms / 1000)}`, `${plural(r.ld.runs, "run")} · locked ${fmtDur(r.ld.ms / 1000)}`), pmax)
            : pmode === "neglected" ? perfRow(r, r.o, r.o, r.lastO ? tc(`最爱 · 最后一次 O ${fmtDate(r.lastO)}`, `favourite · last O ${fmtDate(r.lastO)}`) : tc("最爱 · 还没有 O", "favourite · no O yet"), pmax)
            : perfRow(r, r.o, r.o, tc(`${plural(r.scenes, "scene")} · 播放 ${r.plays}×${ldMark(r)}`, `${plural(r.scenes, "scene")} · played ${r.plays}×${ldMark(r)}`), pmax)).join("")
            : `<div class="ins-empty">${pmode === "neglected" ? tc("每个最爱最近半年都有过 O。", "Every favourite has had an O in the last six months.") : tc("这里还没有内容。", "Nothing here yet.")}</div>`) +
          (pall.length > 10 ? `<div class="ins-note"><button class="ins-chip" data-set="you.pmore=${y.pmore ? "false" : "true"}">${y.pmore ? tc("少显示一些", "show fewer") : tc(`再显示 ${fmtN(Math.min(50, pall.length) - 10)} 条`, `show ${fmtN(Math.min(50, pall.length) - 10)} more`)}</button></div>` : ""))}
        ${card({ title: noO ? tc("播放最多的场景", "Your most played scenes") : tc("你的场景", "Your scenes"), icon: "play", c: "or", right: choices("top", noO).length > 1 ? chips("top", "or") : "" },
          tops.length ? tops.map((s) => `<div class="ins-li click" data-go="/scenes/${esc(s.id)}">${thumb(s)}
            <div style="min-width:0"><div class="n">${esc(s.title)}</div><div class="sub">${noO ? tc(`播放 ${s.plays}×${s.playDur ? ` · ${fmtDur(s.playDur)}` : ""}`, `played ${s.plays}×${s.playDur ? ` · ${fmtDur(s.playDur)}` : ""}`) : tc(`${os(s.o)} · 播放 ${s.plays}×${s.lastO ? ` · 最后一次 O ${fmtDate(s.lastO)}` : ""}`, `${os(s.o)} · played ${s.plays}×${s.lastO ? ` · last O ${fmtDate(s.lastO)}` : ""}`)}</div></div>
            <div class="v" style="color:var(--hi);font-weight:700">${ptop === "byPlays" ? `${s.plays}×` : s.o}</div></div>`).join("")
            : `<div class="ins-empty">${ptop === "unvisited" ? tc("没有哪个有两次以上 O 的场景已经三个月没再有过 O。", "No scene with two or more O's has gone three months without another.") : tc("这里还没有内容。", "Nothing here yet.")}</div>`)}
      </div>
      ${card({ title: tc("你的队列", "Your queue"), icon: "list", c: "bl", sub: tc("每一项都会在 Stash 中打开恰好那些场景", "Each opens exactly those scenes in Stash") },
        `<div class="ins-grid" style="margin:0;gap:4px 28px">${[bl.slice(0, blHalf), bl.slice(blHalf)].map((half) => `<div>${rows(half.map((b) => ({
          label: b.label, value: b.n, icon: `<span class="ins-sq" style="--c:var(--${blColor[b.id]});width:26px;height:26px">${ic(blIcon[b.icon] || "folder")}</span>`,
          color: `var(--${blColor[b.id]})`, go: listUrl("/scenes", b.criteria, b.sort),
          tip: tc(`${b.label}：${plural(b.n, "scene")}${b.oldestDays !== null && b.n ? `\n最早添加于 ${b.oldestDays > 365 ? `${(b.oldestDays / 365).toFixed(1)} 年前` : `${b.oldestDays} 天前`}` : ""}`, `${b.label}: ${plural(b.n, "scene")}${b.oldestDays !== null && b.n ? `\noldest added ${b.oldestDays > 365 ? `${(b.oldestDays / 365).toFixed(1)} years` : `${b.oldestDays} days`} ago` : ""}`) })),
          { max: blMax, lw: "minmax(140px,200px)", vw: "64px" })}</div>`).join("")}</div>`)}`;
  }

  // Lockdown's runs (2.3), only when that plugin has any. Watched time comes
  // from Lockdown 2.1 on (2.0 Edge runs too), so its share is of the time
  // locked in those runs only.
  function lockdownCard(m) {
    const L = m.lockdown;
    if (!L) return "";
    const ws = weekStart(m.now);
    const bars = Array.from({ length: 12 }, (_, i) => {
      const from = addDays(ws, (i - 11) * 7), b = L.weeks.get(dayKey(from)) || { done: 0, gaveUp: 0 };
      return { label: fmtDate(from, { month: "short", day: "numeric" }), value: b.done + b.gaveUp, hi: i === 11,
               tip: tc(`${fmtDate(from, { month: "short", day: "numeric" })} 那一周：${fmtN(b.done)} 次脱出，${fmtN(b.gaveUp)} 次放弃`, `Week of ${fmtDate(from, { month: "short", day: "numeric" })}: ${fmtN(b.done)} got out, ${fmtN(b.gaveUp)} gave up`) };
    });
    const where = (t) => (t.id ? `/${t.kind === "studio" ? "studios" : t.kind === "tag" ? "tags" : "performers"}/${t.id}` : null);
    const way = (e) => ({ finish: tc("完成", "Finish"), timer: tc("计时", "Timer"), edge: tc("边缘", "Edge") }[e.goal && e.goal.type] || tc("对局", "Run"));
    const b = L.best;
    return card({ title: "Lockdown", icon: "lock", c: "re", right: go("/lockdown", tc("打开 Lockdown", "Open Lockdown")),
        sub: tc("你在 Lockdown 插件里的对局。观看时长从 Lockdown 2.1 起开始统计。", "Your runs in the Lockdown plugin. Time watched is counted from Lockdown 2.1 on.") },
      `<div class="ins-tiles" style="margin:0 0 12px">
        ${tile("lock", "re", tc("对局", "Runs"), fmtN(L.runs), tc(`${fmtN(L.done)} 次脱出 · ${fmtN(L.gaveUp)} 次放弃`, `${fmtN(L.done)} got out · ${fmtN(L.gaveUp)} gave up`))}
        ${tile("play", "bl", tc("对局中观看", "Watched in runs"), L.watchedMs ? fmtDur(L.watchedMs / 1000) : "–",
               L.watchedMs ? tc(`${pct(L.watchedMs / Math.max(1, L.watchLockedMs))} 占锁定的 ${fmtDur(L.watchLockedMs / 1000)}`, `${pct(L.watchedMs / Math.max(1, L.watchLockedMs))} of ${fmtDur(L.watchLockedMs / 1000)} locked`) : tc("从 Lockdown 2.1 起统计", "counted from Lockdown 2.1 on"))}
        ${tile("flame", "or", tc("最高热度", "Highest heat"), L.bestHeat ? String(Math.round(L.bestHeat * 10) / 10) : "–", tc("脱出时", "got out of"))}
        ${tile("trophy", "ye", tc("最高分", "Best score"), b ? fmtN(b.score) : "–", b ? `${way(b)} · ${fmtDate(b.at)}` : tc("从 2.1 的对局中脱出", "get out of a 2.1 run"))}
      </div>
      <div class="ins-grid" style="margin:0">
        <div><div class="ins-sub" style="margin:0 0 6px">${tc("最常锁定", "Locked to most")}</div>${rows(L.targets.slice(0, 6).map((t) => ({
          label: t.name, value: t.runs, text: plural(t.runs, "run"), go: where(t),
          tip: tc(`${t.name}：${plural(t.runs, "run")}，${fmtN(t.done)} 次脱出\n锁定 ${fmtDur(t.ms / 1000)}${t.watched ? `，观看 ${fmtDur(t.watched / 1000)}` : ""}`, `${t.name}: ${plural(t.runs, "run")}, ${fmtN(t.done)} got out\nlocked ${fmtDur(t.ms / 1000)}${t.watched ? `, watched ${fmtDur(t.watched / 1000)}` : ""}`) })),
          { lw: "minmax(110px,180px)", vw: "64px" })}</div>
        <div><div class="ins-sub" style="margin:0 0 6px">${tc("按周的对局", "Runs by week")}</div>${barChart(bars, { c: "re", height: 70 })}</div>
      </div>`);
  }

  // Pictures (2.7): time with pictures in the Slideshow plugin, only while
  // it is installed. Read only, from Slideshow's own config.
  function picturesCard(m) {
    if (!app.set.slideshow) return "";
    const P = m.get("pictures", () => picturesModel(app.slideshow || parseSlideshow(null), m.now, m.perfById));
    if (!P) return "";
    const head = { title: tc("图片", "Pictures"), icon: "image", c: "cy", sub: tc("在 Slideshow 插件里花在图片上的时间：图片在屏幕上停留 2 秒后算作已看。", "Time with pictures in the Slideshow plugin: a picture counts as seen after 2 seconds on screen.") };
    const bad = P.bad ? `<div class="ins-note">${tc("Slideshow 存储的部分数字读不出来；能读出来的已经显示。", "Some of Slideshow's stored numbers could not be read; what could is shown.")}</div>` : "";
    if (!P.secs && !P.seen) {
      return card(head, `<div class="ins-empty">${tc(`<b style="color:var(--hi)">还没有看过图片</b><br>在演员、工作室、标签或图库页面上，或在图片 / 图库列表里点击「Play pictures」，你花的时间就会显示在这里。`, `<b style="color:var(--hi)">No pictures viewed yet</b><br>Press Play pictures on a performer's, studio's, tag's or gallery's page or in a list of images or galleries, and your time shows here.`)}</div>${bad}`);
    }
    const today = dayKey(m.now);
    const bars = P.bars.map((b) => ({ label: String(new Date(b.from).getDate()), value: b.value, hi: b.key === today,
      tip: tc(`${fmtDate(b.from, { weekday: "short", month: "short", day: "numeric" })}：${b.value ? fmtDur(b.value) : "无"}${b.n ? ` · 已看 ${plural(b.n, "picture")}` : ""}`, `${fmtDate(b.from, { weekday: "short", month: "short", day: "numeric" })}: ${b.value ? fmtDur(b.value) : "nothing"}${b.n ? ` · ${plural(b.n, "picture")} seen` : ""}`) }));
    const list = P.top.slice(0, 8);
    const people = list.map((r) => {
      const p = r.p || { name: tc(`演员 ${r.id}`, `Performer ${r.id}`) };
      // a performer with no images now (moved or untagged since) keeps the count seen
      const n = r.total ? Math.min(r.n, r.total) : r.n;
      const sub = r.total ? tc(`已看 ${fmtN(n)} / ${fmtN(r.total)}`, `${fmtN(n)} of ${fmtN(r.total)} seen`) : tc(`已看 ${plural(n, "picture")}`, `${plural(n, "picture")} seen`);
      const f = r.total ? n / r.total : 0;
      return `<div class="ins-li av click" data-go="/performers/${esc(r.id)}" data-tip="${esc(tc(`${p.name}\n在其图片上花了 ${fmtDur(r.s)}\n${sub}`, `${p.name}\n${fmtDur(r.s)} on their pictures\n${sub}`))}">
        ${avatar(p)}<div style="min-width:0"><div class="n">${esc(p.name)}</div><div class="sub">${sub}</div>
        <div class="ins-trk" style="height:5px;margin-top:4px;--c:var(--cy)"><i style="width:${r.total ? Math.max(2, Math.round(f * 100)) : 0}%"></i></div></div>
        <div class="v" style="color:var(--hi);font-weight:700">${fmtDur(r.s)}</div></div>`;
    }).join("");
    return card(head,
      `<div class="ins-tiles" style="margin:0 0 12px">
        ${tile("clock", "cy", tc("图片时长", "Time with pictures"), fmtDur(P.secs), P.week ? tc(`本周 ${fmtDur(P.week)}`, `${fmtDur(P.week)} this week`) : tc("本周没有", "none this week"))}
        ${tile("image", "bl", tc("已看图片", "Pictures seen"), fmtN(P.seen), P.weekN ? tc(`本周 ${fmtN(P.weekN)}`, `${fmtN(P.weekN)} this week`) : tc("本周没有", "none this week"))}
        ${tile("calendar", "or", tc("今天", "Today"), P.today ? fmtDur(P.today) : "–", tc("停留在屏幕上", "on screen"))}
        ${tile("flame", "ye", tc("天数", "Days"), fmtN(P.daysViewed), tc("最近 120 天里有图片的日子", "with pictures, last 120 days"))}
      </div>
      <div class="ins-grid" style="margin:0">
        <div><div class="ins-sub" style="margin:0 0 6px">${tc("最近 30 天", "The last 30 days")}</div>${barChart(bars, { fmt: (v) => (v ? fmtDur(v) : "0"), c: "cy", height: 90 })}</div>
        <div><div class="ins-sub" style="margin:0 0 6px">${tc("演员在图片上花的时间", "Performers by time on their pictures")}</div>${people || `<div class="ins-empty">${tc("到目前为止看过的图片里没有演员。", "No performers in the pictures seen so far.")}</div>`}</div>
      </div>${bad}`);
  }

  // ── Library ───────────────────────────────────────────────────────────────

  const CYCLE = ["var(--sx-cy)", "var(--sx-or)", "var(--sx-pu)", "var(--sx-bl)", "var(--sx-ye)", "var(--sx-gr)", "var(--sx-ma)", "var(--sx-re)"];
  function ago(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return tc("刚刚", "just now");
    if (min < 60) return tc(`${min} 分钟前`, `${min} min ago`);
    if (min < 48 * 60) return tc(`${plural(Math.round(min / 60), "hour")}前`, plural(Math.round(min / 60), "hour") + " ago");
    if (min < 60 * 24 * 60) return tc(`${plural(Math.round(min / 1440), "day")}前`, plural(Math.round(min / 1440), "day") + " ago");
    return fmtDate(ms);
  }
  const resOf = (s) => resBucket(s.w, s.h) || "?";

  const LENGTHS = [[0, 300, "under 5 min"], [300, 600, "5 to 10 min"], [600, 1200, "10 to 20 min"], [1200, 1800, "20 to 30 min"],
                   [1800, 2700, "30 to 45 min"], [2700, 3600, "45 to 60 min"], [3600, 5400, "1 to 1.5 hours"], [5400, Infinity, "over 1.5 hours"]];
  const LENGTHS_ZH = ["5 分钟以下", "5–10 分钟", "10–20 分钟", "20–30 分钟", "30–45 分钟", "45–60 分钟", "1–1.5 小时", "1.5 小时以上"];

  function renderLibrary(el) {
    const m = app.model, L = m.lib.totals, l = app.lib, st = m.stats, c = m.counts;
    const fs = m.get("files", () => fileStats(m.scenes));
    const nb = m.get("notable", () => notable(m.scenes, m.perfById));
    const net = m.get("networks", () => networks(m.studios, m.scenes));
    const share = (n) => (L.scenes ? n / L.scenes : 0);
    const imgSize = st.images_size || 0, total = L.size + imgSize;

    // where the space goes: by resolution, other copies, images
    const resSegs = RES_ORDER.filter((r) => fs.res.has(r)).map((r) => ({ label: r, size: fs.res.get(r).size, color: RES_COLOR[r] }));
    const firstFiles = resSegs.reduce((a, x) => a + x.size, 0);
    if (L.size - firstFiles > total * 0.002) resSegs.push({ label: isZh() ? "额外副本" : "extra copies", size: L.size - firstFiles, color: "var(--sx-tx2b)" });
    if (imgSize) resSegs.push({ label: isZh() ? "图片" : "images", size: imgSize, color: "var(--sx-gr)" });

    // release or added timeline
    const source = l.timeline === "added" ? m.lib.added : m.lib.released;
    let bars;
    if (l.year === null) {
      // fill the gaps, so a year with nothing is a visible zero, not missing
      const yrs = source.map((y) => y.year), byYear = new Map(source.map((y) => [y.year, y.n]));
      const from = yrs.length ? Math.max(Math.min(...yrs), Math.max(...yrs) - 59) : 0;
      bars = [];
      for (let yr = from; yrs.length && yr <= Math.max(...yrs); yr++) {
        const n = byYear.get(yr) || 0;
        bars.push({ value: n, label: String(yr), tip: tc(`${yr}：${plural(n, "scene")}${l.timeline === "added" ? "已添加" : "已发行"}`, `${yr}: ${plural(n, "scene")} ${l.timeline === "added" ? "added" : "released"}`), click: n ? () => { l.year = yr; render(); } : null });
      }
    } else {
      const counts = new Array(12).fill(0);
      for (const s of m.scenes) {
        const when = l.timeline === "added" ? (s.created ? new Date(s.created) : null) : (parseDay(s.date) !== null ? new Date(parseDay(s.date)) : null);
        if (when && when.getFullYear() === l.year) counts[when.getMonth()] += 1;
      }
      bars = counts.map((n, i) => {
        const from = `${l.year}-${pad2(i + 1)}-01`, to = dayKey(new Date(l.year, i + 1, 0).getTime());
        return { value: n, label: new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "short" }), tip: tc(`${new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}：${plural(n, "scene")}`, `${new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}: ${plural(n, "scene")}`),
                 click: n ? () => navigate(S([l.timeline === "added"
                   ? { type: "created_at", modifier: "BETWEEN", value: { value: `${from} 00:00`, value2: `${to} 23:59` } }
                   : { type: "date", modifier: "BETWEEN", value: { value: from, value2: to } }], "date", "asc")) : null };
      });
    }
    const undatedN = l.timeline === "added" ? 0 : m.scenes.filter((s) => parseDay(s.date) === null).length;

    const nbCard = (icon, cc, label, value, sub, url, tip) => value === null ? "" :
      `<div class="ins-card ins-nb${url ? " click" : ""}" style="--c:var(--${cc});${url ? "cursor:pointer" : ""}" ${url ? `data-go="${esc(url)}"` : ""} ${tip ? `data-tip="${esc(tip)}"` : ""}>
        <span class="ins-sq">${ic(icon)}</span><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;
    const sc = (s) => `/scenes/${s.id}`;
    const lens = LENGTHS.map(([a, b, label], i) => ({ label: isZh() ? LENGTHS_ZH[i] : label, value: m.scenes.filter((s) => s.dur >= a && s.dur < b && s.dur > 0).length,
      go: S([b === Infinity ? { type: "duration", modifier: "GREATER_THAN", value: { value: a } } : { type: "duration", modifier: "BETWEEN", value: { value: a, value2: b - 1 } }], "duration") }));
    const lenMax = Math.max(1, ...lens.map((x) => x.value));
    const withMarkers = c["s.markers"], inGroup = c["s.group"] === null || c["s.group"] === undefined ? null : L.scenes - c["s.group"];
    const stateRows = [
      { label: tc("已播放", "Played"), value: L.played, go: S([{ type: "play_count", modifier: "GREATER_THAN", value: { value: 0 } }], "last_played_at"), color: "var(--cy)", icon: ic("play") },
      { label: tc("已整理", "Organized"), value: L.organized, go: S([{ type: "organized", value: "true" }]), color: "var(--gr)", icon: ic("check") },
      { label: tc("已评分", "Rated"), value: L.rated, go: S([{ type: "rating100", modifier: "NOT_NULL", value: { value: 0 } }], "rating"), color: "var(--ye)", icon: ic("star") },
      m.noO ? null : { label: tc("有 O", "With an O"), value: L.withO, go: S([{ type: "o_counter", modifier: "GREATER_THAN", value: { value: 0 } }], "o_counter"), color: "var(--o)", icon: ic("drop") },
      withMarkers === null || withMarkers === undefined ? null : { label: tc("有标记", "With markers"), value: withMarkers, go: S([{ type: "has_markers", value: "true" }]), color: "var(--pu)", icon: ic("tag") },
      inGroup === null ? null : { label: app.set.moviesName ? tc("在影片中", "In a group") : tc("在合集中", "In a group"), value: inGroup, color: "var(--bl)", icon: ic("film") },
      { label: tc("可交互", "Interactive"), value: m.scenes.filter((s) => s.interactive).length, go: S([{ type: "interactive", value: "true" }]), color: "var(--or)", icon: ic("pulse") },
    ].filter(Boolean).map((r) => ({ ...r, text: `${pct(share(r.value))} <small>${fmtN(r.value)}</small>`, icon: `<span style="color:${r.color}">${r.icon}</span>` }));
    const rbands = [[90, 101, tc("5 星", "5 stars")], [70, 90, tc("4 星", "4 stars")], [50, 70, tc("3 星", "3 stars")], [30, 50, tc("2 星", "2 stars")], [0, 30, tc("1 星", "1 star")]].map(([a, b, label]) => {
      const ss = m.scenes.filter((s) => s.rating !== null && s.rating !== undefined && s.rating >= a && s.rating < b);
      const o = ss.reduce((x, s) => x + (s.o || 0), 0);
      return { label, value: ss.length, text: m.noO ? fmtN(ss.length) : `${fmtN(ss.length)} <small>${ss.length ? (o / ss.length).toFixed(2) : "0"}${tc(" 每次 O 的场景数", " O/scene")}</small>`,
               go: S([{ type: "rating100", modifier: "BETWEEN", value: { value: a, value2: Math.min(100, b - 1) } }], "rating"), color: "var(--ye)" };
    });
    const unrated = m.scenes.filter((s) => s.rating === null || s.rating === undefined).length;
    rbands.push({ label: tc("未评分", "not rated"), value: unrated, text: `${fmtN(unrated)}`, go: S([{ type: "rating100", modifier: "IS_NULL", value: { value: 0 } }]), color: "var(--tx3)" });
    const castRows = [[1, 1, tc("单人", "solo")], [2, 2, tc("两人", "two")], [3, 3, tc("三人", "three")], [4, 5, tc("四到五人", "four or five")], [6, 999, tc("六人及以上", "six or more")]].map(([a, b, label]) => {
      const n = m.scenes.filter((s) => s.perf.length >= a && s.perf.length <= b).length;
      return { label, value: n, go: S([a === b ? { type: "performer_count", modifier: "EQUALS", value: { value: a } }
                                          : b === 999 ? { type: "performer_count", modifier: "GREATER_THAN", value: { value: a - 1 } }
                                          : { type: "performer_count", modifier: "BETWEEN", value: { value: a, value2: b } }]), color: "var(--ma)" };
    });
    const noCast = m.scenes.filter((s) => !s.perf.length).length;
    castRows.push({ label: tc("还没有人", "nobody yet"), value: noCast, go: S([{ type: "performer_count", modifier: "EQUALS", value: { value: 0 } }]), color: "var(--tx3)" });
    const perf2 = m.performers.filter((p) => p.sceneCount >= 2).length;
    const imageOnly = app.set.imagePerformers ? m.get("reach:true", () => performerReach(m.scenes, m.performers, true)).imageOnly : null;
    const tagN = st.tag_count ?? new Set(m.scenes.flatMap((s) => s.tags.map((t) => t[0]))).size;
    const tagPer = L.scenes ? m.scenes.reduce((a, s) => a + s.tags.length, 0) / L.scenes : 0;
    const groups = st.group_count ?? st.movie_count;

    el.innerHTML = `
      <section class="ins-card ins-hero" style="--c:var(--or)">
        <div><div class="k">${ic("film")}${tc("你的媒体库", "YOUR LIBRARY")}</div><div class="big">${plural(L.scenes, "scene")}</div>
          <div class="s">${tc(`<b>${fmtDur(L.secs)}</b> 的视频：连续不停播放的话是 <b>${nonstop(L.secs)}</b>。<b>${fmtBytes(L.size)}</b> 在磁盘上${imgSize ? `，另有 ${fmtBytes(imgSize)} 的图片` : ""}：够装满 <b>${(total / 4e12).toFixed(1)}</b> 块四 TB 硬盘。${L.scenes ? `平均每个场景时长 ${fmtDur(L.secs / L.scenes)}，占用 ${fmtBytes(L.size / L.scenes)}。` : ""}`, `<b>${fmtDur(L.secs)}</b> of video: <b>${nonstop(L.secs)}</b> if you watched it nonstop. <b>${fmtBytes(L.size)}</b> on disk${imgSize ? `, plus ${fmtBytes(imgSize)} of images` : ""}: enough to fill <b>${(total / 4e12).toFixed(1)}</b> four-terabyte drives. ${L.scenes ? `The average scene runs ${fmtDur(L.secs / L.scenes)} and takes ${fmtBytes(L.size / L.scenes)}.` : ""}`)}</div>
          <div class="ins-legend2">${resSegs.map((x) => `<span data-tip="${esc(x.label)}: ${fmtBytes(x.size)} (${pct(x.size / Math.max(1, total))})"><i style="background:${x.color}"></i>${esc(x.label)} <b style="color:var(--hi);font-weight:600">${fmtBytes(x.size)}</b></span>`).join("")}</div></div>
        ${ring(resSegs.map((x) => ({ f: x.size / Math.max(1, total), color: x.color })), fmtBytes(total).split(" ")[0], tc(`${fmtBytes(total).split(" ")[1]} 合计`, `${fmtBytes(total).split(" ")[1]} in all`), 150)}
      </section>
      <div class="ins-tiles">
        ${tile("users", "ma", tc("演员", "Performers"), fmtN(m.performers.length), tc(`${fmtN(perf2)} 参演两个及以上场景${imageOnly ? ` · ${fmtN(imageOnly)} 仅出现在图片中` : ""}`, `${fmtN(perf2)} in two or more scenes${imageOnly ? ` · ${fmtN(imageOnly)} only in images` : ""}`), "/performers")}
        ${tile("studio", "or", tc("工作室", "Studios"), fmtN(m.studios.length || net.studios.length), `${plural(net.networks.length, "network")}`, "/studios")}
        ${tile("tag", "gr", tc("标签", "Tags"), fmtN(tagN), tc(`${tagPer.toFixed(1)} 每个场景`, `${tagPer.toFixed(1)} per scene`), "/tags")}
        ${st.gallery_count !== undefined ? tile("image", "bl", tc("图库", "Galleries"), fmtN(st.gallery_count), tc(`${fmtN(st.image_count || 0)} 张图片`, `${fmtN(st.image_count || 0)} images`), "/galleries") : ""}
        ${groups !== undefined ? tile("film", "pu", app.set.moviesName ? tc("影片", "Movies") : tc("合集", "Groups"), fmtN(groups), inGroup !== null ? (app.set.moviesName ? tc(`${fmtN(inGroup)} 个场景在同一影片中`, `${fmtN(inGroup)} scenes in one`) : tc(`${fmtN(inGroup)} 个场景在同一合集中`, `${fmtN(inGroup)} scenes in one`)) : "", "/groups") : ""}
      </div>
      <div class="ins-notable">
        ${nb.longest ? nbCard("ruler", "pu", tc("最长", "Longest"), fmtDur(nb.longest.dur), nb.longest.title, sc(nb.longest)) : ""}
        ${nb.shortest ? nbCard("ruler", "bl", tc("最短", "Shortest"), fmtDur(nb.shortest.dur), nb.shortest.title, sc(nb.shortest)) : ""}
        ${nb.biggest ? nbCard("disk", "or", tc("最大文件", "Biggest file"), fmtBytes(nb.biggest.fsize), `${nb.biggest.title} · ${resOf(nb.biggest)} ${codecName(nb.biggest.vc)}`, sc(nb.biggest)) : ""}
        ${nb.oldest ? nbCard("calendar", "ye", tc("最早发行", "Oldest release"), fmtDate(parseDay(nb.oldest.date)), nb.oldest.title, sc(nb.oldest)) : ""}
        ${nb.newest ? nbCard("spark", "gr", tc("最新添加", "Newest addition"), ago(nb.newest.created), nb.newest.title, sc(nb.newest)) : ""}
        ${nb.cast ? nbCard("users", "ma", tc("参演最多", "Biggest cast"), plural(nb.cast.perf.length, "performer"), nb.cast.title, sc(nb.cast)) : ""}
        ${nb.played ? nbCard("play", "cy", tc("播放最多", "Most played"), plural(nb.played.plays, "play"), nb.played.title, sc(nb.played)) : ""}
        ${nb.tagged ? nbCard("tag", "gr", tc("标签最多", "Most tagged"), plural(nb.tagged.tags.length, "tag"), nb.tagged.title, sc(nb.tagged)) : ""}
        ${nb.performer ? nbCard("user", "ma", tc("场景最多", "Most scenes"), plural(nb.performer.n, "scene"), nb.performer.p.name, `/performers/${nb.performer.p.id}`) : ""}
        ${nb.studio ? nbCard("studio", "or", tc("最忙的工作室", "Busiest studio"), plural(nb.studio.n, "scene"), nb.studio.name, `/studios/${nb.studio.id}`) : ""}
      </div>
      ${card({ title: l.year === null ? (l.timeline === "added" ? tc("按年份看加入 Stash", "Added to Stash, by year") : tc("按年份看发行", "Released, by year")) : tc(`${l.year} 年，按月`, `${l.year}, by month`), icon: "calendar", c: "or",
        right: `${chipFor("lib", "timeline", "released", tc("发行", "Released"), "or")}${chipFor("lib", "timeline", "added", tc("加入 Stash", "Added to Stash"), "or")}${l.year !== null ? ` <button class="ins-chip" data-set="lib.year=null">${tc("← 全部年份", "← all years")}</button>` : ""}`,
        sub: tc(`${l.year === null ? "点击某年查看它的各月。" : "点击某月列出那些场景。"}${undatedN ? ` ${plural(undatedN, "scene")}因为没有发行日期而没有显示。` : ""}`, `${l.year === null ? "Click a year to see its months." : "Click a month to list those scenes."}${undatedN ? ` ${plural(undatedN, "scene")} without a release date are not shown.` : ""}`) },
        bars.length ? barChart(bars, { c: l.timeline === "added" ? "cy" : "or" }) : `<div class="ins-empty">${tc("还没有日期。", "No dates yet.")}</div>`)}
      <div class="ins-grid">
        ${card({ title: tc("时长", "Lengths"), icon: "clock", c: "pu", sub: tc(`中位数 ${fmtDur(percentile(m.scenes.map((s) => s.dur).filter(Boolean).sort((a, b) => a - b), 0.5))} · 点击可列出`, `Median ${fmtDur(percentile(m.scenes.map((s) => s.dur).filter(Boolean).sort((a, b) => a - b), 0.5))} · click to list`) },
          rows(lens.map((x) => ({ ...x, text: `${fmtN(x.value)} <small>${pct(share(x.value))}</small>`, color: "var(--pu)" })), { max: lenMax, lw: "minmax(110px,130px)", vw: "96px" }))}
        ${card({ title: tc("状态", "State"), icon: "check", c: "gr", sub: tc("占场景的比例 · 点击可列出", "Share of scenes · click to list") }, rows(stateRows, { max: L.scenes, lw: "minmax(110px,130px)", vw: "110px" }))}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("评分", "Ratings"), icon: "star", c: "ye", sub: m.noO ? tc("每个评分档的场景数", "Scenes per rating") : tc("每个评分档的场景数，以及每档每次 O 的场景数", "Scenes per rating, and O's per scene at each") }, rows(rbands, { lw: "minmax(80px,100px)", vw: "140px" }))}
        ${card({ title: tc("参演人数", "Cast size"), icon: "users", c: "ma", sub: tc("每个场景的演员数", "Performers per scene") }, rows(castRows.map((r) => ({ ...r, text: `${fmtN(r.value)} <small>${pct(share(r.value))}</small>` })), { lw: "minmax(90px,110px)", vw: "96px" }))}
      </div>`;
  }

  // ── Files and quality ─────────────────────────────────────────────────────

  const VC_MATCH = { H264: "h264", HEVC: "hevc", AV1: "av1", VP9: "vp9", VP8: "vp8", "MPEG-4": "mpeg4", WMV: "wmv", "VC-1": "vc1", "MPEG-2": "mpeg2", "MPEG-1": "mpeg1" };
  const RES_LINK = { "8K": ["EQUALS", "8k"], "5K+": ["GREATER_THAN", "4k"], "4K": ["EQUALS", "4k"], "1440p": ["EQUALS", "1440p"], "1080p": ["EQUALS", "1080p"],
                     "720p": ["EQUALS", "720p"], "480p": ["EQUALS", "480p"], "below 480p": ["LESS_THAN", "480p"] };
  const FPS_LINK = { "24/25": [0, 26], "30": [27, 39], "50": [40, 54], "60": [55, 64], "over 60": [65, null] };

  // Display-only Chinese for the logical keys above. The keys themselves stay
  // English: RES_LINK / FPS_LINK and the `order` arrays match on them, and the
  // Chinese is picked at render time (these tables must not freeze at load).
  const RES_LABEL_ZH = { "below 480p": "480p 以下" };
  const FPS_LABEL_ZH = { "over 60": "60 以上" };
  const SHAPE_LABEL_ZH = { landscape: "横屏", portrait: "竖屏", square: "方形" };
  const CODEC_LABEL_ZH = { unknown: "未知", none: "无" };
  const CONTAINER_LABEL_ZH = { unknown: "未知" };
  const valZh = (t, k) => (isZh() && t[k]) || k;

  // One distribution as console rows: count, share, and a link where Stash
  // has a filter for it.
  function dist(map, order, o = {}) {
    let list = [...map.values()];
    if (order) list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)); else list.sort((a, b) => b.n - a.n);
    const tot = list.reduce((a, r) => a + r.n, 0);
    const max = Math.max(1, ...list.map((r) => r.n));
    return `<div class="hd"><span>${o.head}</span><span>${tc(`共 ${fmtN(tot)} 个文件`, `${fmtN(tot)} FILES`)}</span></div>` + rows(list.slice(0, o.limit || 9).map((r, i) => {
      const key = o.disp ? o.disp(r.key) : r.key;
      const tm = o.tipMore ? o.tipMore(r) : "";
      return { label: key, value: r.n, text: `${fmtN(r.n)} <small>${pct(r.n / Math.max(1, tot))}</small>`,
        color: o.color ? o.color(r, i) : CYCLE[i % CYCLE.length], go: o.link ? o.link(r) : null,
        tip: tc(`${key}：${plural(r.n, "file")}，${fmtBytes(r.size)}，${fmtDur(r.secs)}${r.secs ? `\n每小时 ${fmtBytes((r.size / r.secs) * 3600)}` : ""}${tm}`,
               `${r.key}: ${plural(r.n, "file")}, ${fmtBytes(r.size)}, ${fmtDur(r.secs)}${r.secs ? `\n${fmtBytes((r.size / r.secs) * 3600)} per hour` : ""}${tm}`) };
    }), { max, lw: "minmax(64px,92px)", vw: "88px" });
  }

  function renderFiles(el) {
    const m = app.model;
    const fs = m.get("files", () => fileStats(m.scenes));
    const net = m.get("networks", () => networks(m.studios, m.scenes));
    const first = [...fs.vcodec.values()].reduce((a, r) => a + r.size, 0);
    const avgBr = fs.brN ? fs.brSum / fs.brN : 0;
    const con = (html) => `<div class="ins-well ins-con">${html}</div>`;

    const brRows = RES_ORDER.filter((r) => fs.bitrate[r]).map((r) => {
      const b = fs.bitrate[r];
      return `<tr><td style="color:${RES_COLOR[r]}">${esc(valZh(RES_LABEL_ZH, r))}</td><td>${fmtN(b.n)}</td><td>${fmtMbps(b.p10)}</td><td style="color:var(--hi)">${fmtMbps(b.p50)}</td><td>${fmtMbps(b.p90)}</td><td style="color:var(--ye)">${b.n >= 10 ? fmtMbps(b.p50 * 2.5) : "–"}</td></tr>`;
    }).join("");
    const costRows = [...fs.vcodec.values()].filter((r) => r.secs > 0).sort((a, b) => b.size - a.size).map((r, i) => {
      const avgShort = r.n ? r.short / r.n : 0;
      return `<tr class="click" data-go="${esc(S([{ type: "video_codec", modifier: "INCLUDES", value: VC_MATCH[r.key] || r.raw }], "filesize"))}">
        <td style="color:${tierColor(r.key)}">${esc(r.key)}</td><td>${fmtN(r.n)}</td>
        <td style="color:var(--hi)">${fmtBytes((r.size / r.secs) * 3600)}</td><td>${avgShort ? `${Math.round(avgShort)}p` : "–"}</td><td>${pct(r.size / Math.max(1, first))}</td></tr>`;
    }).join("");

    el.innerHTML = `
      <div class="ins-card ins-well ins-con ins-strip" style="--c:var(--cy)">
        <div><span>${tc("文件", "FILES")}</span><b>${fmtN(fs.files)}</b></div><div><span>${tc("大小", "SIZE")}</span><b>${fmtBytes(fs.size)}</b></div>
        <div><span>${tc("总时长", "RUNTIME")}</span><b>${fmtDur(fs.secs)}</b></div><div><span>${tc("平均码率", "AVG BITRATE")}</span><b>${fmtMbps(avgBr)} Mbps</b></div>
        <div><span>${tc("每小时", "PER HOUR")}</span><b>${fs.secs ? fmtBytes((first / fs.secs) * 3600) : "–"}</b></div>
        <div class="click" data-go="${esc(S([{ type: "file_count", modifier: "GREATER_THAN", value: { value: 1 } }]))}" style="cursor:pointer" data-tip="${tc("文件数超过一个的场景：打开它们", "Scenes with more than one file: open them")}"><span>${tc("多文件", "MULTI-FILE")}</span><b>${fmtN(fs.multi)}</b></div>
        ${fs.noFile ? `<div class="warn" data-go="${esc(S([{ type: "file_count", modifier: "EQUALS", value: { value: 0 } }]))}" style="cursor:pointer" data-tip="${tc("文件已不在的场景：打开它们", "Scenes whose file is gone: open them")}"><span>${tc("无文件", "NO FILE")}</span><b>${fmtN(fs.noFile)}</b></div>` : ""}
        ${fs.noPhash ? `<div class="warn" data-tab="actions" style="cursor:pointer" data-tip="${tc("没有 phash 的文件无法作为重复项匹配。请到「操作」标签页生成。", "Files without a phash cannot be matched as duplicates. Generate them on the Actions tab.")}"><span>${tc("无 PHASH", "NO PHASH")}</span><b>${fmtN(fs.noPhash)}</b></div>` : ""}
      </div>
      <div class="ins-grid3">
        ${card({ title: tc("视频编码", "Video codec"), icon: "film", c: "cy" }, con(dist(fs.vcodec, null, { head: tc("编码", "CODEC"), disp: (k) => valZh(CODEC_LABEL_ZH, k), color: (r) => tierColor(r.key),
          link: (r) => S([{ type: "video_codec", modifier: "INCLUDES", value: VC_MATCH[r.key] || r.raw }], "filesize") })))}
        ${card({ title: tc("音频编码", "Audio codec"), icon: "audio", c: "cy" }, con(dist(fs.acodec, null, { head: tc("编码", "CODEC"), disp: (k) => valZh(CODEC_LABEL_ZH, k), color: (r) => audioColor(r.key),
          link: (r) => (r.raw ? S([{ type: "audio_codec", modifier: "EQUALS", value: r.raw }]) : null) })))}
        ${card({ title: tc("容器", "Container"), icon: "box", c: "cy" }, con(dist(fs.container, null, { head: tc("格式", "FORMAT"), disp: (k) => valZh(CONTAINER_LABEL_ZH, k) })))}
        ${card({ title: tc("分辨率", "Resolution"), icon: "expand", c: "cy" }, con(dist(fs.res, RES_ORDER, { head: tc("分辨率", "RESOLUTION"), disp: (k) => valZh(RES_LABEL_ZH, k), color: (r) => RES_COLOR[r.key],
          link: (r) => S([{ type: "resolution", modifier: RES_LINK[r.key][0], value: RES_LINK[r.key][1] }], "filesize"),
          tipMore: () => tc("\n会打开 Stash 的分辨率筛选；它的档位略有不同", "\nOpens Stash's resolution filter; its steps differ a little") })))}
        ${card({ title: tc("帧率", "Frame rate"), icon: "frame", c: "cy" }, con(dist(fs.fps, FPS_ORDER, { head: tc("帧率", "FPS"), disp: (k) => valZh(FPS_LABEL_ZH, k),
          link: (r) => { const x = FPS_LINK[r.key]; return x ? S([x[1] === null ? { type: "framerate", modifier: "GREATER_THAN", value: { value: x[0] - 1 } } : { type: "framerate", modifier: "BETWEEN", value: { value: x[0], value2: x[1] } }]) : null; } })))}
        ${card({ title: tc("画面比例", "Shape"), icon: "frame", c: "cy" }, con(dist(fs.shape, ["landscape", "portrait", "square", "VR"], { head: tc("画面比例", "SHAPE"), disp: (k) => valZh(SHAPE_LABEL_ZH, k),
          tipMore: (r) => (r.key === "VR" ? tc("\n按比例与尺寸判定：宽 4K 以上的 2:1，或 2.8K 以上的 1:1", "\nTold by shape: 2:1 at 4K wide or more, or 1:1 at 2.8K or more") : "") })))}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("各分辨率的码率", "Bitrate by resolution"), icon: "gauge", c: "cy", sub: tc("Mbps。一半的文件落在低与高之间；超过中位数 2.5 倍的算作空间大户。", "Mbps. Half the files sit between low and high; over 2.5× the median counts as a space hog.") },
          con(`<table><tr><th>${tc("分辨率", "RES")}</th><th>${tc("文件", "FILES")}</th><th>${tc("低 10%", "LOW 10%")}</th><th>${tc("中位数", "MEDIAN")}</th><th>${tc("高 10%", "HIGH 10%")}</th><th>${tc("大户阈值", "HOG ABOVE")}</th></tr>${brRows}</table>`))}
        ${card({ title: tc("每小时占用", "Cost per hour"), icon: "disk", c: "cy", sub: tc("视频每小时占用的存储，按编码分类。点一个编码可按文件大小从大到小列出它的文件。", "Storage an hour of video takes, by codec. Click a codec to list its files, largest first.") },
          con(`<table><tr><th>${tc("编码", "CODEC")}</th><th>${tc("文件", "FILES")}</th><th>${tc("每小时", "PER HOUR")}</th><th>${tc("平均分辨率", "AVG RES")}</th><th>${tc("占空间", "OF SPACE")}</th></tr>${costRows}</table>`))}
      </div>
      ${spaceCard(m, fs, net)}
      <div class="ins-note" style="text-align:center">${tc(`重复项、需要重编码或升级的文件、空间大户都在 ${go("#", "操作")} 标签页。`, `Duplicates, files to re-encode or upgrade, and space hogs are on the ${go("#", "Actions")} tab.`)}</div>`;
    const lnk = el.querySelector('.ins-note .ins-go[data-go="#"]');
    if (lnk) { lnk.removeAttribute("data-go"); lnk.dataset.tab = "actions"; }
  }



  // ── What works for you (2.2) ──────────────────────────────────────────────
  // A sidebar of dimensions, and for the chosen one a row per value: rank,
  // name, a bar centred on 1x (right and green: more than its share, left
  // and coral: less), the two shares, the lift. Strongest first, except
  // dimensions with a natural order (height, age, length...), which keep it;
  // either way the three strongest are highlighted.

  // Everyone, then each gender the library has (2.11). For What works for
  // you and the Collection tab; null or "ALL" is everyone.
  function genderChips(m, grp, key, cur, c, lead) {
    const gs = libGenders(m);
    if (gs.length < 2) return "";
    const on = cur === null || cur === undefined ? "ALL" : cur;
    const chip = (v, label, tip) => `<button class="ins-chip${on === v ? " on" : ""}" style="--c:var(--${c})" data-set="${grp}.${key}=${esc(v)}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${esc(label)}</button>`;
    return `<div class="ins-dims ins-gchips">${lead ? `<span class="g">${esc(lead)}</span>` : ""}${chip("ALL", tc("全部", "Everyone"))}${gs.map((x) => chip(x.k, isZh() ? GENDERS_ZH[x.k] : x.label, plural(x.n, "performer"))).join("")}</div>`;
  }
  function worksCard(m, y) {
    const noO = m.noO, wm = choice("wmetric", y.wmetric, noO);
    const pulls = strongestPulls(noO ? "plays" : "o");
    const dim = ALL_DIMS.find((d) => d.id === y.dim) || ALL_DIMS[0];
    const ordinal = isOrdinal(dim.id);
    // "auto" is the dimension's natural reading: in order where it has one,
    // strongest first where it does not
    const sort = y.sort === "size" ? "size" : ordinal && y.sort !== "pull" ? "order" : "pull";
    const R = rankTraits(traits(dim.id), dim.id, wm, { small: y.small, sort: sort === "order" ? undefined : sort });
    const color = wm === "watch" ? "cy" : wm === "plays" ? "bl" : "o";
    const side = (title, list) => `<div class="h">${title}</div>` + list.map((d) =>
      `<button class="ins-side-b${y.dim === d.id ? " on" : ""}" data-set="you.dim=${d.id}">${esc(dimLabel(d))}</button>`).join("");
    const what = wm === "watch" ? tc("观看", "watching") : wm === "plays" ? tc("播放", "plays") : tc("O", "O's");
    const rowsHtml = R.rows.slice(0, 60).map((r) => {
      const x = liftPos(r.mLift), w = Math.abs(x) * 50, tone = liftTone(r.mLift), link = traitLink(dim.id, r.value);
      return `<div class="ins-lr${r.top ? " top" : ""}${link ? " click" : ""}" ${link ? `data-go="${esc(link)}"` : ""}
        data-tip="${esc(tc(`${traitLabel(dim.id, r.value)}\n${fmtN(r.scenes)} 个场景 · 占库中 ${pct(r.libShare)}\n${noO ? `播放 ${r.plays}× · 占你的 ${pct(r.playShare)}` : `${os(r.o)} · 占你的 ${pct(r.oShare)}\n播放 ${r.plays}×`} · 观看 ${fmtDur(r.watch)}（${pct(r.watchShare)}）\n强度排名第 ${r.rank}`, `${traitLabel(dim.id, r.value)}\n${fmtN(r.scenes)} scenes · ${pct(r.libShare)} of the library\n${noO ? `played ${r.plays}× · ${pct(r.playShare)} of yours` : `${os(r.o)} · ${pct(r.oShare)} of yours\nplayed ${r.plays}×`} · watched ${fmtDur(r.watch)} (${pct(r.watchShare)})\nrank ${r.rank} by strength`))}">
        <span class="rk">${r.rank}</span>
        <span class="l">${traitIcon(dim.id, r.value)}<span>${esc(traitLabel(dim.id, r.value))}</span></span>
        <div class="ins-div"><i style="left:${x >= 0 ? 50 : 50 - w}%;width:${Math.max(0.8, w).toFixed(1)}%;background:var(--${tone === "up" ? "gr" : tone === "down" ? "re" : "tx3"})"></i></div>
        <span class="nums">${tc(`${pct(r.mShare)} 的 ${what} · 占场景 ${pct(r.libShare)}`, `${pct(r.mShare)} of ${what} · ${pct(r.libShare)} of scenes`)}</span>
        <span class="ins-lift ${tone}">${r.mLift.toFixed(1)}×</span></div>`;
    }).join("");
    return card({ title: tc("什么对你有效", "What works for you"), icon: "spark", c: "gr", id: "ins-works",
      right: `${choices("wmetric", noO).map(([v, label]) => `<button class="ins-chip${wm === v ? " on" : ""}" style="--c:var(--gr)" data-set="you.wmetric=${v}">${label}</button>`).join("")} &nbsp;
        ${ordinal ? `${chipFor("you", "sort", "auto", tc("按顺序", "In order"), "gr")}${chipFor("you", "sort", "pull", tc("最强", "Strongest"), "gr")}` : chipFor("you", "sort", "auto", tc("最强", "Strongest"), "gr")}${chipFor("you", "sort", "size", tc("最大", "Biggest"), "gr")}`,
      sub: tc(`每个分组相对它在库中所占份额对你的表现。线右侧表示${noO ? "你播放得比它的份额更多" : "更容易让你达到高潮"}。最强的三个会高亮。`, `How each group does for you against its share of the library. Right of the line ${noO ? "you play more than its share" : "gets you there more often"}. The three strongest are highlighted.`) },
      `${genderChips(m, "you", "wgender", worksGender(m), "gr", tc("演员性别", "Scenes with"))}` +
      `${pulls.length ? `<div class="ins-pulls">${pulls.map(({ d, r, lift, share }) => `<div class="ins-well ins-pull" data-set="you.dim=${d.id}"
        data-tip="${esc(tc(`${r.scenes} 个场景（占库中 ${pct(r.libShare)}）\n${noO ? plural(r.plays, "play") : os(r.o)}（占你的 ${pct(share)}）`, `${r.scenes} scenes (${pct(r.libShare)} of the library)\n${noO ? plural(r.plays, "play") : os(r.o)} (${pct(share)} of yours)`))}">
        <div class="k">${esc(dimLabel(d))}</div><div class="n">${traitIcon(d.id, r.value)}<span>${esc(traitLabel(d.id, r.value))}</span></div><span class="ins-lift up">${lift.toFixed(1)}×</span>
        <div class="d">${tc(`${pct(share)} 的${noO ? "播放" : " O"}来自 ${pct(r.libShare)} 的场景`, `${pct(share)} of ${noO ? "plays" : "O's"} from ${pct(r.libShare)} of scenes`)}</div></div>`).join("")}</div>` : ""}
      <div class="ins-ww">
        <nav class="ins-side">${side(tc("演员", "PERFORMER"), PERFORMER_TRAITS)}${side(tc("场景", "SCENE"), SCENE_TRAITS)}</nav>
        <div class="ins-wbody">
          <div class="ins-lr ins-axis"><span></span><span class="l">${esc(dimLabel(dim))}${sort === "order" ? tc(" · 按顺序", " · in order") : sort === "size" ? tc(" · 最大在前", " · biggest first") : tc(" · 最强在前", " · strongest first")}</span>
            <div class="ax"><span>¼×</span><span>1×</span><span>4×</span></div><span class="nums">${tc(`你的 ${what} · 库`, `your ${what} · library`)}</span><span>lift</span></div>
          <div class="ins-well" style="--c:var(--${color})">${rowsHtml || `<div class="ins-empty">${tc(`暂时没有可供对比的${esc(dimLabel(dim))}${R.hidden ? "；所有分组都太小" : ""}。`, `Nothing to compare yet for ${esc(dim.label.toLowerCase())}${R.hidden ? "; the groups are all small" : ""}.`)}</div>`}</div>
          <div class="ins-note">${R.hidden ? tc(`已隐藏 ${plural(R.hidden, "small group")}（少于 ${fmtN(R.minScenes)} 个场景，或播放太少不足以判断）。<button class="ins-chip" data-set="you.small=${y.small ? "false" : "true"}">${y.small ? "隐藏" : "显示"}</button>`, `${plural(R.hidden, "small group")} hidden (under ${fmtN(R.minScenes)} scenes, or too little played to say). <button class="ins-chip" data-set="you.small=${y.small ? "false" : "true"}">${y.small ? "hide" : "show"} them</button>`) : ""}</div>
        </div>
      </div>`);
  }

  // ── Where the space goes (2.2): a ranked list, by studio, network, codec
  // or resolution ─────────────────────────────────────────────────────────

  function spaceCard(m, fs, net) {
    const f = app.files, mode = f.space;
    let list;
    if (mode === "codec") list = [...fs.vcodec.values()].map((r) => ({ name: r.key, size: r.size, n: r.n, color: tierColor(r.key),
                                go: S([{ type: "video_codec", modifier: "INCLUDES", value: VC_MATCH[r.key] || r.raw }], "filesize") }));
    else if (mode === "resolution") list = [...fs.res.values()].map((r) => ({ name: r.key, size: r.size, n: r.n, color: RES_COLOR[r.key],
                                go: S([{ type: "resolution", modifier: RES_LINK[r.key][0], value: RES_LINK[r.key][1] }], "filesize") }));
    else if (mode === "network") list = net.networks.map((x) => ({ name: `${x.name}`, sub: `${plural(x.sites, "site")}`, size: x.size, n: x.scenes, go: `/studios/${x.id}` }))
      .concat(net.independent.list.map((x) => ({ name: x.name, size: x.size, n: x.scenes, go: `/studios/${x.id}` })));
    else list = net.studios.map((x) => ({ name: x.name, size: x.size, n: x.scenes, go: S([{ type: "studios", modifier: "INCLUDES", value: items(x.id, x.name) }], "filesize") }));
    const noStudio = mode === "studio" || mode === "network" ? m.scenes.filter((s) => !s.studio) : [];
    if (noStudio.length) list.push({ name: tc("无工作室", "no studio"), size: noStudio.reduce((a, s) => a + (s.size || 0), 0), n: noStudio.length, color: "var(--tx3)",
                                     go: S([{ type: "studios", modifier: "IS_NULL", value: { items: [], excluded: [], depth: 0 } }], "filesize") });
    list.sort((a, b) => b.size - a.size);
    const total = Math.max(1, list.reduce((a, x) => a + x.size, 0));
    const shown = list.slice(0, f.spaceAll ? 40 : 15), rest = list.slice(shown.length);
    const max = Math.max(1, ...shown.map((x) => x.size));
    const rowsHtml = shown.map((x) => `<div class="ins-sr${x.go ? " click" : ""}" ${x.go ? `data-go="${esc(x.go)}"` : ""}
      data-tip="${esc(tc(`${x.name}${x.sub ? ` (${x.sub})` : ""}\n${fmtBytes(x.size)} · ${pct(x.size / total)}\n${plural(x.n, "scene")} · 平均每个 ${fmtBytes(x.size / Math.max(1, x.n))}`,
                          `${x.name}${x.sub ? ` (${x.sub})` : ""}\n${fmtBytes(x.size)} · ${pct(x.size / total)}\n${plural(x.n, "scene")} · ${fmtBytes(x.size / Math.max(1, x.n))} each on average`))}">
      <span class="l">${esc(x.name)}${x.sub ? ` <small>${esc(x.sub)}</small>` : ""}</span>
      <div class="ins-trk"><i style="width:${Math.max(0.8, (x.size / max) * 100).toFixed(1)}%;${x.color ? `background:${x.color}` : ""}"></i></div>
      <span class="v">${fmtBytes(x.size)}</span><span class="p">${pct(x.size / total)}</span><span class="n">${plural(x.n, "scene")}</span></div>`).join("");
    const restSize = rest.reduce((a, x) => a + x.size, 0);
    const spaceLabels = { studio: tc("工作室", "Studio"), network: tc("网络", "Network"), codec: tc("编码", "Codec"), resolution: tc("分辨率", "Resolution") };
    return card({ title: tc("空间的去向", "Where the space goes"), icon: "disk", c: "cy",
      right: ["studio", "network", "codec", "resolution"].map((k) => chipFor("files", "space", k, spaceLabels[k], "cy")).join(""),
      sub: tc(`${fmtBytes(total)} 合计，从大到小。点一个可按文件大小列出它的场景。`, `${fmtBytes(total)} in all, largest first. Click one to list its scenes by file size.`) },
      `<div class="ins-well" style="--c:var(--cy)">${rowsHtml}</div>` +
      (rest.length ? `<div class="ins-note">${tc(`另有 ${fmtN(rest.length)} 个 · ${fmtBytes(restSize)}（${pct(restSize / total)}）`, `+ ${fmtN(rest.length)} more · ${fmtBytes(restSize)} (${pct(restSize / total)})`)} ${f.spaceAll || list.length <= 15 ? "" : `<button class="ins-chip" data-set="files.spaceAll=true">${tc("再显示 25 个", "show 25 more")}</button>`}</div>`
        : f.spaceAll && list.length > 15 ? `<div class="ins-note"><button class="ins-chip" data-set="files.spaceAll=false">${tc("收起", "show fewer")}</button></div>` : ""));
  }

  // ── Probably wrong (shared by Actions and the Health hero) ───────────────

  function problemChecks(m) {
    const fs = m.get("files", () => fileStats(m.scenes));
    const conflicts = m.get("conflicts", () => dateConflicts(m.scenes, m.perfById));
    const twins = m.get("twins", () => sameNames(m.performers));
    const future = m.get("future", () => futureDates(m.scenes, m.now));
    const c = m.counts, today = dayKey(m.now);
    // with images counted, a performer only in images is not an orphan; the
    // count comes from the cached performers (Stash's own is scenes only)
    const idle = app.set.imagePerformers ? m.get("reach:true", () => performerReach(m.scenes, m.performers, true)).idle : null;
    const checks = [
      { n: fs.noFile, icon: "alert", c: "re", title: tc("没有文件的场景", "Scenes with no file"), sub: tc("文件在 Stash 之外被移动或删除了；扫一次或清理一下就能解决。", "The file was moved or deleted outside Stash; a scan or clean sorts it out"),
        go: S([{ type: "file_count", modifier: "EQUALS", value: { value: 0 } }]) },
      { n: new Set(conflicts.map((x) => x.s.id)).size, icon: "alert", c: "re", title: tc("日期早于演员年满 18 岁的场景", "Scenes dated before a performer turned 18"), sub: tc("几乎总是生日或场景日期填错了（重发版、笔误）。", "Nearly always a wrong birthdate or a wrong scene date (a re-release, a typo)"),
        more: conflicts.length, pills: conflicts.slice(0, 10).map((x) => ({ label: `${x.s.title} · ${x.p.name}, ${x.age}`, go: `/scenes/${x.s.id}` })) },
      { n: twins.length, icon: "users", c: "re", title: tc("同名的演员", "Performers with the same name"), sub: tc("多半是同一个人被添加了两次；Stash 可以合并。", "Probably one person added twice; Stash can merge them"),
        pills: twins.slice(0, 12).map((g) => ({ label: `${g[0].name} ×${g.length}`, go: `/performers?q=${encodeURIComponent(g[0].name)}` })) },
      { n: future.length, icon: "calendar", c: "ye", title: tc("发行日期在未来", "Release date in the future"), sub: tc("预热发行日期没问题；笔误不是。", "Pre-release dates are fine; typos are not"),
        go: S([{ type: "date", modifier: "GREATER_THAN", value: { value: today } }], "date", "asc") },
      { n: c["t.once"], icon: "tag", c: "or", title: tc("只在一个场景用到的标签", "Tags used on one scene"), sub: tc("往往是笔误，或是另一个标签的近似重复。", "Often a typo or a near-twin of another tag"),
        go: listUrl("/tags", [{ type: "scene_count", modifier: "EQUALS", value: { value: 1 } }], "name", "asc") },
      idle !== null
        ? { n: idle, icon: "user", c: "tx2", title: tc("没有场景、图片或图库的演员", "Performers with no scenes, images or galleries"), sub: tc("若是特意保留，就没问题。", "Fine if you keep them on purpose"),
            go: P(["scene_count", "image_count", "gallery_count"].map((type) => ({ type, modifier: "EQUALS", value: { value: 0 } })), "name") }
        : { n: c["p.noscenes"], icon: "user", c: "tx2", title: tc("没有场景的演员", "Performers with no scenes"), sub: tc("若是特意保留，就没问题。", "Fine if you keep them on purpose"),
            go: P([{ type: "scene_count", modifier: "EQUALS", value: { value: 0 } }], "name") },
      { n: c["st.noscenes"], icon: "studio", c: "tx2", title: tc("没有场景的工作室", "Studios with no scenes"), sub: tc("往往是母网络，这没问题。", "Often a parent network, which is fine"),
        go: listUrl("/studios", [{ type: "scene_count", modifier: "EQUALS", value: { value: 0 } }], "name", "asc") },
    ].filter((x) => x.n !== null && x.n !== undefined);
    const open = checks.filter((x) => x.n > 0);
    return { open, clear: checks.filter((x) => !x.n), serious: open.filter((x) => x.c === "re" || x.c === "ye").reduce((a, x) => a + x.n, 0) };
  }
  const checkRow = (x) => `<div class="ins-chk${x.go ? " click" : ""}" ${x.go ? `data-go="${esc(x.go)}"` : ""}>
    <span class="ins-sq" style="--c:var(--${x.c})">${ic(x.icon)}</span>
    <div><div class="n">${esc(x.title)}</div><div class="sub">${esc(x.sub)}</div></div>
    <div class="v">${fmtN(x.n)}${x.go ? `<span class="ins-go">${ic("arrow")}</span>` : ""}</div>
    ${x.pills && x.pills.length ? `<div class="more">${x.pills.map((p) => `<span class="ins-pill" data-go="${esc(p.go)}">${esc(p.label)}</span>`).join("")}${(x.more ?? x.n) > x.pills.length ? `<span class="ins-pill" style="cursor:default">${tc(`另有 ${fmtN((x.more ?? x.n) - x.pills.length)} 个`, `+${fmtN((x.more ?? x.n) - x.pills.length)} more`)}</span>` : ""}</div>` : ""}
  </div>`;

  // ── Actions (2.2) ─────────────────────────────────────────────────────────
  // Everything that asks for something to be done, in one place. Writes only
  // ever happen on a button press; the destructive one asks twice.

  function dupState() {
    const a = app.acts;
    if (!a.dups) return null;
    const plans = a.dups.map((g) => dupChoose(g, a.mode, { sharp: a.sharp }));
    let files = 0, bytes = 0, ready = 0, review = 0;
    for (const p of plans) {
      let any = false;
      for (const it of p.items) {
        const on = a.ticks.has(it.s.id) ? a.ticks.get(it.s.id) : it.remove;
        it.on = on;
        if (on) { files += 1; bytes += it.s.fsize || 0; any = true; }
      }
      if (p.review) review += 1; else if (any) ready += 1;
    }
    plans.sort((x, y) => (x.review ? 1 : 0) - (y.review ? 1 : 0) || y.items.reduce((n, i) => n + (i.on ? i.s.fsize : 0), 0) - x.items.reduce((n, i) => n + (i.on ? i.s.fsize : 0), 0));
    return { plans, files, bytes, ready, review };
  }

  function renderActions(el) {
    const m = app.model, a = app.acts;
    const fs = m.get("files", () => fileStats(m.scenes));
    const up = m.get("upgrades", () => upgrades(m.scenes, m.noO));
    const hog = m.get("hogs", () => spaceHogs(m.scenes, fs));
    const ne = m.get("noteff", () => notEfficient(m.scenes, fs));
    const H = m.get("health", () => healthModel(m));
    const P2 = problemChecks(m);
    const D = dupState();
    const noPhashIds = m.scenes.filter((s) => s.phash === false).map((s) => s.id);
    const con = (html) => `<div class="ins-well ins-con">${html}</div>`;
    const sceneLine = (s, right, color, extra) => `<div class="ins-li click" data-go="/scenes/${esc(s.id)}">${thumb(s)}
      <div style="min-width:0"><div class="n">${esc(s.title)}</div><div class="sub">${esc(resOf(s))} · ${esc(codecName(s.vc))} · ${fmtBytes(s.fsize)}${extra || ""}</div></div>
      <div class="v" style="color:${color}">${right}</div></div>`;
    const tileA = (icon, c, label, value, sub, target) => `<div class="ins-card ins-tile click" style="--c:var(--${c})" data-jump="${target}">
      <div class="l">${ic(icon)}${esc(label)}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

    // the duplicate cleaner
    let dupBody;
    if (a.state === "scanning") dupBody = `<div class="ins-progress" style="padding:24px 0">${tc("正在向 Stash 请求精确匹配…", "Asking Stash for exact matches…")}<div class="bar"><i></i></div></div>`;
    else if (a.state === "error" && !a.dups) dupBody = `<div class="ins-error">${tc(`Stash 无法执行匹配：${esc(a.err)}`, `Stash could not run the match: ${esc(a.err)}`)}</div>`;
    else if (!a.dups) dupBody = `<div style="text-align:center;padding:16px 0 8px"><div style="color:var(--tx2);margin-bottom:12px">${tc("用 Stash 的 phash 匹配找出完全相同的副本，再为每一组挑出要保留的那份。", "Finds exact copies with Stash's phash match, then picks the copy to keep in each group.")}</div>
      <button class="ins-btn big" data-act="dups">${ic("search")} ${tc("查找重复项", "Find duplicates")}</button>
      ${fs.noPhash ? `<div class="ins-note">${tc(`有 ${plural(fs.noPhash, "file")} 还没有 phash，无法匹配；请先在下面生成。`, `${plural(fs.noPhash, "file")} have no phash yet and cannot be matched; generate them below first.`)}</div>` : ""}</div>`;
    else {
      const run = a.run;
      // only a cleanup in progress locks the controls; a finished one does not
      const busy = !!(run && !run.finished);
      const seg = (k, l) => `<button class="${a.mode === k ? "on" : ""}" data-set="acts.mode=${k}" ${busy ? "disabled" : ""}>${l}</button>`;
      const tog = (k, l) => `<button class="ins-tog${a[k] ? " on" : ""}" data-set="acts.${k}=${a[k] ? "false" : "true"}" ${busy ? "disabled" : ""}><i></i>${l}</button>`;
      const item = (it, keep) => `<div class="ins-cp">${keep ? "<span></span>" : `<button class="ins-bx${it.on ? " on" : ""}" data-act="dtick" data-id="${esc(it.s.id)}" ${busy ? "disabled" : ""} aria-label="${tc("移除这份副本", "Remove this copy")}"></button>`}
        ${thumb(it.s)}<span class="t"><span class="ins-k ${keep ? "keep" : it.on ? "del" : "look"}">${keep ? tc("保留", "KEEP") : it.on ? tc("删除", "REMOVE") : tc("查看", "LOOK")}</span>
        <span class="ins-go" data-go="/scenes/${esc(it.s.id)}" style="color:var(--tx)">${esc(it.s.title)}</span>
        <span class="m"> · ${esc(codecName(it.s.vc))} ${esc(resOf(it.s))} · ${fmtBytes(it.s.fsize)}${it.s.o && !m.noO ? ` · ${os(it.s.o)}` : ""}${!keep && it.why ? ` · ${esc(it.why)}` : ""}${!keep && it.on && a.merge && (it.s.o || it.s.plays) ? tc(" · 历史会移过来", " · history moves over") : ""}</span></span>
        <span class="v">${keep ? tc(`场景 ${esc(it.s.id)}`, `scene ${esc(it.s.id)}`) : it.on ? `<b style="color:var(--down)">${fmtBytes(it.s.fsize)}</b>` : tc("保留", "kept")}</span></div>`;
      const shown = D.plans.slice(0, a.showAll ? 400 : 25);
      dupBody = `<div class="ins-opts"><span>${tc("保留", "Keep")}</span><span class="ins-seg">${seg("hevc", tc("HEVC 或 AV1", "HEVC or AV1"))}${seg("best", tc("画质最佳", "Best quality"))}${seg("smallest", tc("最小", "Smallest"))}</span>
          ${tog("merge", m.noO ? tc("先把播放、标签和演员移到保留的场景", "Move plays, tags and performers to the kept scene first") : tc("先把 O、播放、标签和演员移到保留的场景", "Move O's, plays, tags and performers to the kept scene first"))}
          ${a.mode === "hevc" ? tog("sharp", tc("仅当 HEVC/AV1 副本至少一样清晰", "Only if the HEVC/AV1 copy is at least as sharp")) : ""}</div>
        <div class="ins-con ins-sum"><span><em>${tc("分组", "GROUPS")}</em><b>${fmtN(D.plans.length)}</b></span><span><em>${tc("可清理", "READY")}</em><b style="color:var(--up)">${fmtN(D.ready)}</b></span>
          <span><em>${tc("待移除", "TO REMOVE")}</em><b style="color:var(--down)">${plural(D.files, "file")} · ${fmtBytes(D.bytes)}</b></span><span><em>${tc("需查看", "NEEDS A LOOK")}</em><b style="color:var(--ye)">${fmtN(D.review)}</b></span>
          <span style="margin-left:auto"><button class="ins-chip" data-act="dups" ${busy ? "disabled" : ""}>${tc("重新扫描", "scan again")}</button></span></div>
        ${D.plans.length ? `<div class="ins-well ins-dups">${shown.map((p) => `<div class="ins-dg${p.review ? " review" : ""}">${p.review ? `<div class="why">${ic("alert")} ${esc(p.reason)}</div>` : ""}
          ${item({ s: p.keep }, true)}${p.items.map((it) => item(it, false)).join("")}</div>`).join("")}</div>
          ${D.plans.length > shown.length ? `<div class="ins-note"><button class="ins-chip" data-set="acts.showAll=true">${tc(`显示全部 ${plural(D.plans.length, "group")}`, `show all ${fmtN(D.plans.length)} groups`)}</button></div>` : ""}`
          : `<div class="ins-empty">${ic("check")} ${tc("有 phash 的文件里没有完全重复的。", "No exact duplicates among files that have a phash.")}</div>`}
        ${run ? `<div class="ins-run"><div class="bar"><i style="width:${(run.done / Math.max(1, run.total) * 100).toFixed(1)}%"></i></div>
            <span>${run.finished ? tc(`完成：清理 ${plural(run.ok, "group")}，移除 ${plural(run.files, "file")}，释放 ${fmtBytes(run.bytes)}${run.errors.length ? `，跳过 ${plural(run.errors.length, "group")}` : ""}。`, `Done: ${plural(run.ok, "group")} cleaned, ${plural(run.files, "file")} removed, ${fmtBytes(run.bytes)} freed${run.errors.length ? `, ${plural(run.errors.length, "group")} skipped` : ""}.`) : tc(`第 ${run.done + 1} / ${run.total} 组…`, `Group ${run.done + 1} of ${run.total}…`)}</span></div>
            ${run.errors.length ? `<div class="ins-note" style="color:var(--down)">${run.errors.slice(0, 6).map((e) => esc(e)).join("<br>")}</div>` : ""}` : ""}
        ${a.msg ? `<div class="ins-note" style="color:var(--up)">${esc(a.msg)}</div>` : ""}
        <div class="ins-btns">
          <button class="ins-btn" data-act="dtag" ${!D.files || busy ? "disabled" : ""}>${ic("tag")} ${tc(`把 ${plural(D.files, "copy", "copies")} 标记为删除`, `Tag ${plural(D.files, "copy", "copies")} for delete`)}</button>
          <button class="ins-btn danger${a.armed ? " armed" : ""}" data-act="dremove" ${!D.files || busy ? "disabled" : ""}>${ic("alert")}
            ${a.armed ? tc(`真的要从磁盘移除 ${plural(D.files, "file")}（${fmtBytes(D.bytes)}）吗？再点一次`, `Really remove ${plural(D.files, "file")} (${fmtBytes(D.bytes)}) from disk? Click again`) : tc(`移除 ${plural(D.files, "file")} · ${fmtBytes(D.bytes)}…`, `Remove ${plural(D.files, "file")} · ${fmtBytes(D.bytes)}…`)}</button></div>
        <div class="ins-note" style="text-align:right">${tc(`打标签是安全的，用的是 Quick Tools 的删除标签。移除会把副本文件从磁盘删除${a.merge ? `；它们的 ${m.noO ? "" : "O、"}播放、标记、标签和演员会先移到保留的场景上` : ""}。自扫描后发生过改动的组不会被处理。`, `Tagging is safe and uses Quick Tools' delete tag. Removing deletes the copies' files from disk${a.merge ? `; their ${m.noO ? "" : "O's, "}plays, markers, tags and performers move to the kept scene first` : ""}. Nothing happens to a group that changed since the scan.`)}</div>`;
    }

    const wins = H.wins.slice(0, 3);
    el.innerHTML = `
      ${hubHtml()}
      <div class="ins-tiles">
        ${tileA("copy", "bl", tc("重复文件", "Duplicates"), a.dups ? plural(a.dups.length, "group") : tc("扫描", "scan"), a.dups && D ? tc(`可释放 ${fmtBytes(D.bytes)}`, `${fmtBytes(D.bytes)} to free`) : tc("phash 完全匹配", "exact phash matches"), "ins-a-dups")}
        ${tileA("disk", "cy", tc("非 HEVC 或 AV1", "Not HEVC or AV1"), fmtN(ne.n), tc(`可省约 ${fmtBytes(ne.gain)}`, `~${fmtBytes(ne.gain)} to gain`), "ins-a-hevc")}
        ${tileA("up", "re", tc("值得升级", "Worth upgrading"), fmtN(up.n), tc("低于 720p 或编码较差", "below 720p or a poor codec"), "ins-a-up")}
        ${tileA("pulse", "ye", tc("元数据", "Metadata"), esc(H.grade), wins.length ? `${plural(wins.length, "quick win")}` : tc("无快速修复", "nothing quick"), "ins-a-fix")}
        ${tileA("alert", "or", tc("可能是错的", "Probably wrong"), fmtN(P2.serious), `${plural(P2.open.length, "kind")}`, "ins-a-fix")}
        ${tileA("search", "pu", tc("无 phash", "No phash"), fmtN(fs.noPhash), tc("暂时无法匹配", "cannot be matched yet"), "ins-a-fix")}
      </div>
      ${card({ title: tc("重复文件清理", "Duplicate cleaner"), icon: "copy", c: "bl", id: "ins-a-dups", right: a.scanned ? tc(`上次扫描 ${ago(a.scanned)}`, `scanned ${ago(a.scanned)}`) : "",
        sub: tc("每组保留一份副本，其余移除。在你按下底部的按钮之前，什么都不会改动。", "Keeps one copy per group and removes the rest. Nothing is changed until you press a button at the bottom.") }, dupBody)}
      <div class="ins-grid">
        ${card({ title: tc("还不是 HEVC 或 AV1", "Not HEVC or AV1 yet"), icon: "disk", c: "cy", id: "ins-a-hevc", right: `<b style="color:var(--hi)">${fmtN(ne.n)}</b>`,
          sub: tc(`${fmtBytes(ne.size)} 的文件；按这个媒体库常见的 HEVC/AV1 码率，它们大约只需 ${fmtBytes(ne.size - ne.gain)}。从收益最大的开始。给它们打标签，好让重编码工具（Tdarr、Unmanic）接手。`, `${fmtBytes(ne.size)} of files; at this library's usual HEVC/AV1 rates they would take about ${fmtBytes(ne.size - ne.gain)}. Biggest gain first. Tag them so a re-encoder (Tdarr, Unmanic) can pick them up.`) },
          con(ne.list.length ? ne.list.slice(0, 8).map((x) => sceneLine(x.s, `−${fmtBytes(x.gain)}`, "var(--cy)", ` · ${fmtMbps(bitrateOf(x.s))} Mbps`)).join("") : `<div class="ins-empty">${ic("check")} ${tc("每个文件都是 HEVC 或 AV1。", "Every file is HEVC or AV1.")}</div>`) +
          (ne.n ? `<div class="ins-btns"><button class="ins-btn" data-act="reencode" data-n="100">${ic("tag")} ${tc(`给前 ${fmtN(Math.min(100, ne.n))} 个打「Re-encode」标签`, `Tag the top ${fmtN(Math.min(100, ne.n))} "Re-encode"`)}</button>
            ${ne.n > 100 ? `<button class="ins-btn" data-act="reencode" data-n="all">${tc(`全部 ${fmtN(ne.n)} 个都打标签`, `Tag all ${fmtN(ne.n)}`)}</button>` : ""}
            <span class="ins-go" data-go="${esc(S([{ type: "video_codec", modifier: "NOT_MATCHES_REGEX", value: "hevc|av1" }], "filesize"))}">${tc("在 Stash 中打开全部", "Open all in Stash")}${ic("arrow")}</span></div>` : "") +
          (a.tagMsg ? `<div class="ins-note" style="color:var(--up)">${esc(a.tagMsg)}</div>` : ""))}
        ${card({ title: tc("值得升级", "Worth upgrading"), icon: "up", c: "re", id: "ins-a-up", right: `<b style="color:var(--hi)">${fmtN(up.n)}</b>`,
          sub: tc(`低于 720p，或编码不是 HEVC、AV1、H264（${fmtBytes(up.size)}）。你观看最多的排在最前：这些换个好点的副本最值。`, `Below 720p, or in a codec other than HEVC, AV1 or H264 (${fmtBytes(up.size)}). The ones you watch most come first: a better copy of those is worth the most.`) },
          con(up.list.length ? up.list.slice(0, 8).map((s) => (m.noO ? sceneLine(s, s.plays ? `${s.plays}×` : "", "var(--cy)", "") : sceneLine(s, s.o ? `${s.o}${ic("drop")}` : "", "var(--otx)", s.o || s.plays ? ` · played ${s.plays}×` : ""))).join("") : `<div class="ins-empty">${ic("check")} ${tc("没有低于 720p 或编码较差的文件。", "Nothing below 720p or in a poor codec.")}</div>`) +
          (up.n ? `<div class="ins-btns"><span class="ins-go" data-go="${esc(S([{ type: "resolution", modifier: "LESS_THAN", value: "720p" }], topSort()))}">${tc("全部低于 720p", "All below 720p")}${ic("arrow")}</span></div>` : ""))}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("占空间的大户", "Space hogs"), icon: "box", c: "ye", right: `<b style="color:var(--hi)">${fmtN(hog.n)}</b>`,
          sub: tc(`超过其分辨率常见码率的 2.5 倍，任何编码。重编码后大约能释放 ${fmtBytes(hog.saving)}。`, `Over 2.5× the usual bitrate for their resolution, any codec. Re-encoded they would free about ${fmtBytes(hog.saving)}.`) },
          con(hog.list.length ? hog.list.slice(0, 8).map((x) => sceneLine(x.s, `−${fmtBytes(x.saving)}`, "var(--ye)", ` · ${fmtMbps(bitrateOf(x.s))} Mbps, ${x.ratio.toFixed(1)}× usual`)).join("") : `<div class="ins-empty">${ic("check")} ${tc("没有文件因体积而突出。", "No file stands out for its size.")}</div>`))}
        ${card({ title: tc("接下来修", "Fix next"), icon: "pulse", c: "ye", id: "ins-a-fix", sub: tc("最能提升你评分的元数据缺口，以及看起来不对的地方。", "The metadata gaps that would lift your grade most, and things that look wrong.") },
          (wins.length ? wins.map((w) => `<div class="ins-chk click" data-go="${esc(missingLink(w.p.g, w.p.key))}"><span class="ins-sq" style="--c:var(--ye)">${ic("pulse")}</span>
            <div><div class="n">${esc(winText(w.p).replace(/^./, (c) => c.toUpperCase()))}</div><div class="sub">${w.grade !== H.grade ? tc(`升至 ${esc(w.grade)}`, `to ${esc(w.grade)}`) : tc(`+${(w.gain * 100).toFixed(1)} 分`, `+${(w.gain * 100).toFixed(1)} points`)}</div></div>
            <div class="v"><span class="ins-go">${ic("arrow")}</span></div></div>`).join("") : "") +
          (fs.noPhash ? `<div class="ins-chk"><span class="ins-sq" style="--c:var(--pu)">${ic("search")}</span>
            <div><div class="n">${tc(`${plural(fs.noPhash, "file")}没有 phash`, `${plural(fs.noPhash, "file")} without a phash`)}</div><div class="sub">${tc("它们无法作为重复项匹配。生成会只为这些场景跑一个 Stash 任务。", "They cannot be matched as duplicates. Generating runs a Stash task for just these scenes.")}</div></div>
            <div class="v">${a.phashMsg ? `<span style="color:var(--up);font-weight:400;font-size:12px">${esc(a.phashMsg)}</span>` : `<button class="ins-btn" data-act="phash">${tc("生成", "Generate")}</button>`}</div></div>` : "") +
          P2.open.map(checkRow).join("") +
          (!wins.length && !P2.open.length && !fs.noPhash ? `<div class="ins-empty">${ic("check")} ${tc("没有要修的。", "Nothing to fix.")}</div>` : "") +
          (P2.clear.length ? `<div class="ins-note" style="color:var(--gr)">${tc(`全部正常：${P2.clear.map((x) => esc(x.title.toLowerCase())).join("、")}。`, `All clear: ${P2.clear.map((x) => esc(x.title.toLowerCase())).join(", ")}.`)}</div>` : ""))}
      </div>
      ${dataLine()}`;
    a._noPhashIds = noPhashIds;
    a._noteff = ne;
    hubEnsure();
  }

  // 2.9.0: where the suite's data lives, one small line at the foot of
  // Actions (MAINTENANCE §4.24): with Suite Data a link to its Your data
  // page; its notice when it is off or not answering; else what it is for.
  // 2.10.0 (user: plugin data was "very discrete way down the actions tab"):
  // a Your data button in the header, on every tab, whenever Suite Data is
  // installed; yellow, with its notice as the tip, when it is not answering.
  function dataButton() {
    const mode = SD.mode();
    if (mode === "config") return "";
    const warn = mode === "mirror";
    const tip = warn ? (sdNote || tc("Suite Data 没有响应；这期间各插件把数据放在自己的设置里。", "Suite Data is not answering; plugins keep their data in their settings meanwhile."))
      : tc("各插件的数据由 Suite Data 保管：备份、导出、导入", "Your plugins' data, kept by Suite Data: backups, export, import");
    return `<button class="ins-btn ins-databtn${warn ? " warn" : ""}" data-go="/suitedata" data-tip="${esc(tip)}">${ic(warn ? "alert" : "box")} ${tc("你的数据", "Your data")}</button>`;
  }
  function dataLine() {
    const mode = SD.mode();
    if (mode === "store") return `<div class="ins-note ins-data">${ic("box")} ${tc(`插件数据由 Suite Data 保管，Stash 的设置页碰不到。<span class="ins-go" data-go="/suitedata">你的数据：备份、导出、导入${ic("arrow")}</span>`, `Plugin data is kept by Suite Data, out of reach of Stash's Settings page. <span class="ins-go" data-go="/suitedata">Your data: backups, export, import${ic("arrow")}</span>`)}</div>`;
    if (mode === "mirror" && sdNote) return `<div class="ins-note ins-data" style="color:var(--ye)">${ic("alert")} ${esc(sdNote)}</div>`;
    return `<div class="ins-note ins-data">${ic("box")} ${tc("插件数据（待办、历史、观看时长）存放在各插件的设置里，Stash 设置页上的改动可能会把它回滚。Suite Data 插件把它保管好并做好备份。", "Plugin data (to-dos, history, watch time) is kept in each plugin's settings, where a change on Stash's Settings page can roll it back. The Suite Data plugin keeps it safe and backs it up.")}</div>`;
  }

  // ── 2.8: Library to-do ────────────────────────────────────────────────────
  // One card per toolkit with what its last scan found, a quick action
  // where the toolkit has one (its own background job, after a confirm),
  // and "Scan all". Insights only calls the toolkits' connectors: the
  // reading, the rules and the writing are theirs. Updates redraw this
  // section alone (`drawHub`), never the whole tab.
  const hubConns = () => (window.StashSuite && window.StashSuite.toolkits) || {};
  const hubConn = (id) => hubConns()[id] || null;
  const hubSkip = () => (Array.isArray(prefs().hubSkip) ? prefs().hubSkip.map(String) : []);
  const hubLive = (c) => !!(c && c.job && !c.job.finished);
  function hubEnsure() {
    const H = app.hub;
    if (!H.loading && (!H.at || Date.now() - H.at > 5 * 60000)) { const force = !!H.force; H.force = false; hubLoad(force); }
    else if ([...H.cards.values()].some(hubLive) || (H.queue && hubQueueView(H.queue).active)) hubWatch();
  }
  function drawHub() {
    const el = app.root && app.root.querySelector("#ins-hub");
    if (el) el.outerHTML = hubHtml();
  }
  // `force`: the toolkits read again too (the Refresh chip); otherwise each
  // answers from what it already has.
  async function hubLoad(force) {
    const H = app.hub;
    if (H.loading) return;
    H.loading = true; drawHub();
    const installed = await readInstalled();
    H.present = hubPresent(installed, hubConns());
    for (const id of [...H.cards.keys()]) if (!H.present.ids.includes(id)) H.cards.delete(id);
    for (const id of H.present.ids) {
      const conn = hubConn(id);
      const c = H.cards.get(id) || { id, msg: "", err: false, busy: "" };
      H.cards.set(id, { ...c, name: String(conn.name || id), page: String(conn.page || ""), loading: true });
    }
    drawHub();
    await Promise.all(H.present.ids.map((id) => hubRead(id, force)));
    H.loading = false; H.at = Date.now();
    drawHub();
    hubWatch();
  }
  async function hubRead(id, refresh) {
    const c = app.hub.cards.get(id), conn = hubConn(id);
    if (!c || !conn) return;
    c.loading = true; drawHub();
    try {
      const was = c.job;
      c.sum = hubNorm(await conn.summary({ refresh: !!refresh }));
      // A job the toolkit found gone (Stash restarted, or it was stopped in
      // Stash's task list) stays in its config unfinished, so a fresh read
      // shows it running again until the toolkit has polled it three times.
      // Kept as stopped here, or the hub would read it again and again.
      c.job = hubKeepLost(was, c.sum.job);
      c.readErr = "";
    } catch (e) { c.readErr = (e && e.message) || tc("读不出来", "could not read"); }
    c.loading = false;
    drawHub();
  }
  // While a job of a toolkit runs (a quick action, a scan), its status is
  // asked every 3 s; when it finishes, the toolkit's summary is read again.
  // Paused off the Stats page; picked up when the tab draws again.
  let hubTimer = 0;
  function hubWatch() {
    clearTimeout(hubTimer);
    const H = app.hub;
    if ([...H.cards.values()].some(hubLive) || (H.queue && hubQueueView(H.queue).active)) hubTimer = setTimeout(hubTick, 3000);
  }
  async function hubTick() {
    if (!onStats() || app.tab !== "actions") return;
    const H = app.hub;
    for (const c of [...H.cards.values()].filter(hubLive)) {
      const conn = hubConn(c.id);
      try {
        const j = conn && typeof conn.status === "function" ? await conn.status() : null;
        if (j) c.job = j;
        if (!j || j.finished) { c.job = j; hubRead(c.id, true); }
      } catch (_) {}
    }
    if (H.queue) for (const e of H.queue) if (e.state === "started") e.job = (H.cards.get(e.id) || {}).job || e.job;
    if (H.queue && !hubQueueView(H.queue).active && !H.queue.over) { H.queue.over = Date.now(); }
    drawHub();
    hubWatch();
  }
  // "Scan all": each picked toolkit's scan() one after another. Each starts
  // a Stash task and Stash runs them in turn, so the browser can be closed
  // once they are all asked; a toolkit refuses while a job of its own runs.
  async function hubScanAll() {
    const H = app.hub;
    if (H.queue && hubQueueView(H.queue).active) return;
    const cards = hubOrder([...H.cards.values()]);
    const ids = hubQueue(cards.map((c) => c.id), hubSkip(), cards.filter(hubLive).map((c) => c.id));
    if (!ids.length) return;
    H.queue = ids.map((id) => ({ id, state: "waiting", msg: "", job: null }));
    drawHub();
    for (const e of H.queue) {
      const conn = hubConn(e.id), c = H.cards.get(e.id);
      e.state = "starting"; drawHub();
      try {
        e.msg = String((await conn.scan()) || "");
        const j = typeof conn.status === "function" ? await conn.status() : null;
        if (j && !j.finished) { e.state = "started"; e.job = j; if (c) c.job = j; }
        else { e.state = "nothing"; if (c) hubRead(e.id, true); }
      } catch (err) { e.state = "error"; e.msg = (err && err.message) || tc("它没有启动", "it did not start"); }
      drawHub();
    }
    hubWatch();
  }
  async function hubRun(id, key) {
    const c = app.hub.cards.get(id), conn = hubConn(id);
    if (!c || !conn || c.busy) return;
    c.busy = key; c.msg = ""; c.err = false; drawHub();
    try {
      c.msg = String((await conn.run(key)) || tc("已启动。", "Started."));
      const j = typeof conn.status === "function" ? await conn.status() : null;
      if (j) c.job = j;
      if (!j || j.finished) hubRead(id, true);
    } catch (e) { c.msg = (e && e.message) || tc("它没有启动。", "It did not start."); c.err = true; }
    c.busy = "";
    drawHub();
    hubWatch();
  }
  const HUB_TONE = { ready: ["gr", "Ready: can be done now"], look: ["ye", "Needs you: a look or a choice"], info: ["tx2", "Worth knowing"] };
  const HUB_TONE_ZH = { ready: "可做：现在就能处理", look: "需要你：看一眼或做个选择", info: "值得知道" };
  function hubJobText(j) {
    if (!j) return "";
    const what = j.kind === "save" ? tc("保存中", "Saving") : j.kind === "scan" ? tc("扫描中", "Scanning") : tc("处理中", "Working");
    if (!j.finished) return j.total ? tc(`${what}：${fmtN(j.done)} / ${fmtN(j.total)}`, `${what}: ${fmtN(j.done)} of ${fmtN(j.total)}`) : `${what}…`;
    return "";
  }
  // The toolkit's own icon in the suite's icon badge, tinted with its colour.
  function hubBadge(id, small) {
    const L = hubLook(id, hubConn(id));
    const svg = /^\s*<svg/i.test(L.svg) ? L.svg : `<svg class="ins-ic" viewBox="0 0 16 16" aria-hidden="true">${L.svg}</svg>`;
    return `<span class="ins-badge ins-hbadge${small ? " sm" : ""}" style="--c:${L.color}">${svg}</span>`;
  }
  function hubCardHtml(c) {
    const s = c.sum, live = hubLive(c);
    const when = live ? hubJobText(c.job) : c.loading ? tc("读取中…", "reading…") : s && s.scannedAt ? tc(`上次扫描 ${ago(s.scannedAt)}`, `scanned ${ago(s.scannedAt)}`) : s ? tc("尚未扫描", "not scanned yet") : "";
    const head = `<div class="ins-hkh">${hubBadge(c.id)}<b>${esc(c.name)}</b><span class="ins-hkw${live ? " busy" : ""}">${esc(when)}</span>
      ${c.page ? `<span class="ins-go" data-go="${esc(c.page)}">${tc("打开", "Open")}${ic("arrow")}</span>` : ""}</div>`;
    const bar = live && c.job.total ? `<div class="ins-hkbar"><i style="width:${Math.min(100, (c.job.done / Math.max(1, c.job.total)) * 100).toFixed(1)}%"></i></div>` : "";
    let body;
    if (!s && c.readErr) body = `<div class="ins-hkmsg err">${tc(`读不出来：${esc(c.readErr)}`, `Could not read it: ${esc(c.readErr)}`)}</div>`;
    else if (!s) body = `<div class="ins-hkmsg">${tc("正在读取它找到的内容…", "Reading what it found…")}</div>`;
    else if (!s.items.length) body = `<div class="ins-hkmsg ok">${ic("check")} ${s.scannedAt ? tc("没什么要做。", "Nothing to do.") : tc("还没有找到内容。扫描一下，看看能做什么。", "Nothing found yet. Scan it to see what can be done.")}</div>`;
    else body = s.items.map((x) => {
      const [col] = HUB_TONE[x.tone];
      const word = isZh() ? HUB_TONE_ZH[x.tone] : HUB_TONE[x.tone][1];
      const armed = app.hub.armed === `${c.id}|${x.key}`;
      const go = x.action && x.action.kind === "run"
        ? `<button class="ins-btn ins-hkrun" data-hub="arm" data-id="${esc(c.id)}" data-key="${esc(x.key)}" ${live || c.busy ? "disabled" : ""}
            ${live ? `data-tip="${esc(tc(`${c.name} 正忙于一个任务；这个会等到它完成`, `${c.name} is busy with a job; this waits until it is done`))}"` : ""}>${c.busy === x.key ? tc("启动中…", "Starting…") : esc(x.action.label)}</button>`
        : x.url ? `<span class="ins-go" data-go="${esc(x.url)}">${x.tone === "info" ? tc("查看", "See") : tc("打开", "Open")}${ic("arrow")}</span>` : "";
      return `<div class="ins-hki ${x.tone}${x.action && x.action.kind === "run" ? " run" : ""}" style="--c:var(--${col})"><span class="ins-hkn" data-tip="${esc(word)}"><i></i>${fmtN(x.count)}</span>
          <span class="ins-hkl">${esc(x.label)}</span><span class="ins-hka">${go}</span></div>
        ${armed ? `<div class="ins-hkc"><div>${esc(x.action.confirm || `${x.action.label}?`)}</div>
          <div class="ins-btns"><button class="ins-btn" data-hub="disarm">${tc("取消", "Cancel")}</button>
            <button class="ins-btn ins-pri" data-hub="go" data-id="${esc(c.id)}" data-key="${esc(x.key)}">${ic("check")} ${esc(x.action.label)}</button></div></div>` : ""}`;
    }).join("");
    const msg = c.msg ? `<div class="ins-hkmsg ${c.err ? "err" : "ok"}">${esc(c.msg)}</div>` : s && c.readErr ? `<div class="ins-hkmsg err">${tc(`还是读不出来：${esc(c.readErr)}`, `Could not read it again: ${esc(c.readErr)}`)}</div>` : "";
    return `<div class="ins-well ins-hk${c.loading ? " loading" : ""}">${head}${bar}${body}${msg}</div>`;
  }
  function hubHtml() {
    const H = app.hub, cards = hubOrder([...H.cards.values()]);
    const P = H.present;
    const T = hubTotals(cards);
    const Q = H.queue ? hubQueueView(H.queue) : null;
    const quiet = P && P.missing.length ? `<div class="ins-note ins-hubq">${tc(`未安装：`, `Not installed: `)}${P.missing.map((m) => `<span class="ins-hmiss">${hubBadge(m.id, true)}${esc(m.name)} (${esc(isZh() ? HUB_KNOWN_DOES_ZH[m.id] || m.does : m.does)})</span>`).join(", ")}${tc("。", ".")}</div>` : "";
    const stale = P && P.stale.length ? `<div class="ins-note ins-hubq">${tc(`${P.stale.map((m) => esc(m.name)).join("、")} 比这份列表旧：在 Settings > Plugins 里更新${P.stale.length === 1 ? "它" : "它们"}，才能在这里看到${P.stale.length === 1 ? "它的" : "它们的"}待办。`, `${P.stale.map((m) => esc(m.name)).join(", ")} ${P.stale.length === 1 ? "is" : "are"} older than this list: update ${P.stale.length === 1 ? "it" : "them"} in Settings > Plugins to see ${P.stale.length === 1 ? "its" : "their"} to-dos here.`)}</div>` : "";
    if (P && !cards.length) return `<section id="ins-hub" class="ins-hub0">${stale}${quiet}</section>`;
    if (!P) return `<section id="ins-hub" class="ins-card ins-hub" style="--c:var(--gr)"><div class="ins-ch"><span class="ins-badge">${ic("list")}</span><b>${tc("媒体库待办", "Library to-do")}</b></div>
      <div class="ins-progress" style="padding:14px 0 6px">${tc("正在询问各工具箱找到了什么…", "Asking your toolkits what they found…")}<div class="bar"><i></i></div></div></section>`;
    const skip = hubSkip();
    const pick = hubPick(cards.map((c) => c.id), skip, cards.filter(hubLive).map((c) => c.id));
    const qbusy = !!(Q && Q.active);
    const reading = cards.some((c) => c.loading && !c.sum);
    const total = reading && !T.fix ? `<span class="ins-hubt0">${tc("正在读取各工具箱找到的内容…", "Reading what your toolkits found…")}</span>`
      : T.fix ? tc(`<b>${fmtN(T.fix)}</b> 处可修复${T.oneClick ? `，其中 <b class="one">${fmtN(T.oneClick)}</b> 处一键完成` : ""}`, `<b>${fmtN(T.fix)}</b> ${T.fix === 1 ? "thing" : "things"} you can fix${T.oneClick ? `, <b class="one">${fmtN(T.oneClick)}</b> in one click` : ""}`)
      : `<span class="ins-hubt0">${ic("check")} ${tc("你的工具箱没发现有需要修复的。", "Nothing to fix that your toolkits know of.")}</span>`;
    const qrow = (r) => {
      const c = H.cards.get(r.id) || { name: r.id };
      const txt = { waiting: tc("等待中", "waiting"), starting: tc("启动中…", "starting…"), running: r.job && r.job.total ? tc(`${fmtN(r.job.done)} / ${fmtN(r.job.total)}`, `${fmtN(r.job.done)} of ${fmtN(r.job.total)}`) : tc("进行中", "running"),
        queued: tc("在 Stash 队列中等待", "waiting in Stash's queue"), done: tc("完成", "done"), lost: tc("中途停止", "stopped before the end"), nothing: r.msg || tc("没有可扫描的", "nothing to scan"), error: r.msg || tc("没有启动", "did not start") }[r.state] || r.state;
      return `<div class="ins-hqr ${r.state}"><b>${hubBadge(r.id, true)}${esc(c.name)}</b><span>${esc(txt)}</span>${r.state === "running" && r.job && r.job.total
        ? `<span class="ins-hkbar"><i style="width:${Math.min(100, (r.job.done / Math.max(1, r.job.total)) * 100).toFixed(1)}%"></i></span>` : ""}</div>`;
    };
    return `<section id="ins-hub" class="ins-card ins-hub" style="--c:var(--gr)">
      <div class="ins-ch"><span class="ins-badge">${ic("list")}</span><b>${tc("媒体库待办", "Library to-do")}</b>
        <span class="r">${H.loading ? tc("读取中…", "reading…") : H.at ? tc(`读取于 ${ago(H.at)}`, `read ${ago(H.at)}`) : ""}<button class="ins-chip" data-hub="reload" ${H.loading ? "disabled" : ""}>${ic("refresh")} ${tc("再读一次", "Read again")}</button></span></div>
      <div class="ins-hubtop"><div class="ins-hubt">${total}</div>
        <div class="ins-hubs"><button class="ins-btn big ins-pri" data-hub="scanall" ${qbusy || !pick.scan.length ? "disabled" : ""}>${ic("search")} ${qbusy ? tc("扫描中…", "Scanning…") : esc(pick.label)}</button></div></div>
      <div class="ins-hubpick" role="group" aria-label="${tc("「全部扫描」会扫描的工具箱", "Toolkits that Scan all scans")}">
        ${pick.rows.map((r) => { const c = H.cards.get(r.id); return `<button class="ins-hchip${r.on && !r.busy ? " on" : ""}${r.busy ? " busy" : ""}" style="--c:${hubLook(r.id, hubConn(r.id)).color}"
          data-hub="skip" data-id="${esc(r.id)}" aria-pressed="${r.on && !r.busy}" ${qbusy || r.busy ? "disabled" : ""}
          data-tip="${esc(r.busy ? tc(`${c.name} 正忙于一个任务；「全部扫描」会跳过它`, `${c.name} is busy with a job; Scan all leaves it out`) : r.on ? tc(`「全部扫描」会扫描 ${c.name}。点击可跳过。`, `Scan all scans ${c.name}. Click to leave it out.`) : tc(`已跳过。点击可把 ${c.name} 也纳入扫描。`, `Left out. Click to scan ${c.name} too.`))}">
          ${hubBadge(r.id, true)}<span>${esc(c.name)}</span>${r.busy ? `<em>${tc("进行中", "running")}</em>` : `<i class="ins-hchk">${ic(r.on ? "check" : "plus")}</i>`}</button>`; }).join("")}
        <span class="ins-hpq"><button class="ins-hlink" data-hub="all" ${qbusy ? "disabled" : ""}>${tc("全选", "All")}</button><button class="ins-hlink" data-hub="none" ${qbusy ? "disabled" : ""}>${tc("全不选", "None")}</button></span></div>
      <div class="ins-note ins-hpn">${tc("每次扫描都是一个 Stash 任务；Stash 会依次运行，所以你可以关掉浏览器。", "Each scan is a Stash task; Stash runs them one after another, so you can close the browser.")}</div>
      ${Q ? `<div class="ins-hubqueue">${Q.active ? tc(`<div class="ins-hqh">正在扫描第 ${fmtN(Math.min(Q.done + 1, Q.total))} / ${fmtN(Q.total)} 个</div>`, `<div class="ins-hqh">Scanning ${fmtN(Math.min(Q.done + 1, Q.total))} of ${fmtN(Q.total)}</div>`) : `<div class="ins-hqh">${tc("全部扫描已完成。", "Scan all is done.")} <button class="ins-chip" data-hub="qclose">${tc("好", "OK")}</button></div>`}${Q.rows.map(qrow).join("")}</div>` : ""}
      <div class="ins-hubk"><span style="--c:var(--gr)"><i></i>${tc("可做，现在就能处理", "ready, can be done now")}</span><span style="--c:var(--ye)"><i></i>${tc("需要你", "needs you")}</span><span style="--c:var(--tx3)"><i></i>${tc("值得知道", "worth knowing")}</span></div>
      <div class="ins-hubgrid">${cards.map(hubCardHtml).join("")}</div>
      ${stale}${quiet}</section>`;
  }

  async function scanDuplicates() {
    const a = app.acts;
    a.state = "scanning"; a.err = ""; a.msg = ""; a.run = null; a.armed = false;
    render();
    try { a.dups = await loadDuplicates(); a.ticks = new Map(); a.state = "done"; a.scanned = Date.now(); }
    catch (e) { a.err = e.message; a.state = "error"; }
    if (app.tab === "actions") render();
  }

  // Group by group, one at a time, so a failure stops at that group and the
  // rest still get done; each re-reads its scenes before touching them.
  async function removeTicked() {
    const a = app.acts, D = dupState();
    const work = D.plans.map((p) => ({ keep: p.keep, drops: p.items.filter((i) => i.on).map((i) => i.s) })).filter((w) => w.drops.length);
    a.armed = false;
    a.run = { total: work.length, done: 0, ok: 0, files: 0, bytes: 0, errors: [], finished: false };
    render();
    const doneIds = new Set();
    for (const w of work) {
      try {
        a.run.files += await removeCopies(w.keep, w.drops, a.merge);
        a.run.bytes += w.drops.reduce((n, s) => n + (s.fsize || 0), 0);
        a.run.ok += 1;
        w.drops.forEach((s) => doneIds.add(s.id));
      } catch (e) {
        a.run.errors.push(`${w.keep.title}: ${e.message}`);
      }
      a.run.done += 1;
      if (app.tab === "actions") render();
    }
    a.run.finished = true;
    if (a.run.ok) refreshStash([...doneIds]);
    // the cleaned groups leave the list; the library cache is stale now
    a.dups = a.dups.map((g) => g.filter((s) => !doneIds.has(s.id))).filter((g) => g.length > 1);
    a.msg = tc("Insights 的其余部分会在后台跟上这些改动。", "The rest of Insights catches up with these changes in the background.");
    render();
    refresh(false);
  }

  async function tagTicked(btn) {
    const a = app.acts, D = dupState();
    const ids = D.plans.flatMap((p) => p.items.filter((i) => i.on).map((i) => i.s.id));
    btn.disabled = true;
    try {
      const name = await deleteTagName();
      await tagScenes(ids, name);
      a.msg = tc(`已为 ${plural(ids.length, "copy", "copies")}打上「${name}」标签。用该标签筛选场景列表来复核并删除。`, `Tagged ${plural(ids.length, "copy", "copies")} "${name}". Filter the scene list by that tag to review and delete them.`);
    } catch (e) { a.msg = ""; a.err = e.message; a.msg = tc(`打标签失败：${e.message}`, `Tagging failed: ${e.message}`); }
    render();
  }

  async function tagReencode(btn) {
    const a = app.acts, ne = a._noteff;
    const list = btn.dataset.n === "all" ? ne.list : ne.list.slice(0, 100);
    btn.disabled = true;
    try { await tagScenes(list.map((x) => x.s.id), "Re-encode"); a.tagMsg = tc(`已为 ${plural(list.length, "scene")}打上「Re-encode」标签。`, `Tagged ${plural(list.length, "scene")} "Re-encode".`); }
    catch (e) { a.tagMsg = tc(`打标签失败：${e.message}`, `Tagging failed: ${e.message}`); }
    render();
  }

  async function runPhash(btn) {
    const a = app.acts;
    btn.disabled = true;
    try { await generatePhashes(a._noPhashIds || []); a.phashMsg = tc("已在 Stash 的任务队列中启动。完成后刷新。", "Started in Stash's task queue. Refresh when it is done."); }
    catch (e) { a.phashMsg = tc(`无法启动：${e.message}`, `Could not start: ${e.message}`); }
    render();
  }

  // ── Metadata health ───────────────────────────────────────────────────────

  // [is_missing value, label, count key, weight]. Weights are how much a
  // gap hurts finding and filtering things: a scene without a studio or
  // performers is lost to most filters, one without details is not.
  const HEALTH = {
    scenes: [["title", "Title", "s.title", 1], ["date", "Date", "s.date", 1], ["studio", "Studio", "s.studio", 2],
             ["performers", "Performers", "s.performers", 2], ["tags", "Tags", "s.tags", 2], ["cover", "Cover", "s.cover", 0.5],
             ["details", "Details", "s.details", 0.5], ["url", "URL", "s.url", 0.5], ["stash_id", "StashDB link", "s.stash_id", 1.5],
             ["organized", "Organized", "s.organized", 1]],
    performers: [["image", "Image", "p.image", 1], ["gender", "Gender", "p.gender", 0.5], ["birthdate", "Birthdate", "p.birthdate", 0.75],
                 ["country", "Country", "p.country", 0.5], ["height", "Height", "p.height", 0.25], ["measurements", "Measurements", "p.measurements", 0.25],
                 ["stash_id", "StashDB link", "p.stash_id", 1], ["url", "URL", "p.url", 0.25]],
    studios: [["image", "Image", "st.image", 1], ["stash_id", "StashDB link", "st.stash_id", 1], ["url", "URL", "st.url", 0.5]],
  };
  const GROUP_WEIGHT = { scenes: 0.7, performers: 0.22, studios: 0.08 };
  const NOUN = { scenes: ["scene", "scenes"], performers: ["performer", "performers"], studios: ["studio", "studios"] };
  // Display-only Chinese for the HEALTH labels above, keyed by the missing key
  // (the labels themselves stay English: they are read at load time).
  const HEALTH_ZH = { title: "标题", date: "日期", studio: "工作室", performers: "演员", tags: "标签", cover: "封面",
    details: "详情", url: "URL", stash_id: "StashDB 链接", organized: "已整理", image: "图片", gender: "性别",
    birthdate: "生日", country: "国家", height: "身高", measurements: "三围" };
  const NOUN_ZH = { scenes: "个场景", performers: "位演员", studios: "个工作室" };
  const COUNT_ZH = { scenes: "个", performers: "位", studios: "个" };
  const healthLabel = (p) => (isZh() && HEALTH_ZH[p.key]) || p.label;

  function healthModel(m) {
    const totals = { scenes: m.scenes.length, performers: m.performers.length, studios: m.studios.length };
    const parts = {};
    for (const g of Object.keys(HEALTH)) {
      parts[g] = HEALTH[g].map(([key, label, ck, weight]) => {
        const missing = m.counts[ck];
        return { g, key, label, weight, missing: missing ?? null, total: totals[g] };
      }).filter((p) => p.missing !== null && p.total);
    }
    const scoreOf = (pp) => {
      let w = 0, have = 0;
      for (const g of Object.keys(pp)) { const s = healthScore(pp[g]); if (s !== null) { w += GROUP_WEIGHT[g]; have += GROUP_WEIGHT[g] * s; } }
      return w ? have / w : null;
    };
    const score = scoreOf(parts);
    // the gaps that would lift the score most if filled
    const wins = [];
    for (const g of Object.keys(parts)) for (const p of parts[g]) {
      if (!p.missing) continue;
      const fixed = { ...parts, [g]: parts[g].map((x) => (x === p ? { ...x, missing: 0 } : x)) };
      wins.push({ p, gain: scoreOf(fixed) - score, grade: gradeOf(Math.floor(scoreOf(fixed) * 100) / 100) });
    }
    wins.sort((a, b) => b.gain - a.gain);
    return { parts, score, grade: gradeOf(score === null ? null : Math.floor(score * 100) / 100), wins: wins.slice(0, 3) };
  }

  function missingLink(g, key) {
    if (g === "scenes") return key === "organized" ? S([{ type: "organized", value: "false" }]) : S([{ type: "is_missing", modifier: "EQUALS", value: key }]);
    return listUrl(`/${g}`, [{ type: "is_missing", modifier: "EQUALS", value: key }], g === "performers" ? "scenes_count" : "scenes_count");
  }
  // Rounded down, so 99.8% filled never reads as complete and the shown
  // percentage agrees with the grade.
  const pctDown = (f) => `${Math.floor((f || 0) * 100)}%`;
  const toneOf = (f) => (f >= 0.85 ? "var(--gr)" : f >= 0.65 ? "var(--ye)" : f >= 0.45 ? "var(--or)" : "var(--re)");
  const winText = (p) => (p.key === "organized" ? tc(`把 ${fmtN(p.missing)} 个场景标记为已整理`, `mark ${fmtN(p.missing)} scenes organized`)
    : tc(`为 ${plural(p.missing, NOUN[p.g][0])} 补上${healthLabel(p)}`, `add ${p.label === "StashDB link" ? "StashDB links" : p.label.toLowerCase()} to ${plural(p.missing, NOUN[p.g][0], NOUN[p.g][1])}`));

  function renderHealth(el) {
    const m = app.model;
    const H = m.get("health", () => healthModel(m));
    const block = (g) => {
      const list = H.parts[g];
      if (!list.length) return `<div class="ins-empty">${tc("Stash 没有报告这些计数。", "Stash did not report these counts.")}</div>`;
      return list.map((p) => {
        const f = 1 - p.missing / p.total;
        const label = healthLabel(p);
        return `<div class="ins-row${p.missing ? " click" : ""}" style="--lw:minmax(100px,120px);--vw:150px;--c:${toneOf(f)}" ${p.missing ? `data-go="${esc(missingLink(g, p.key))}"` : ""}
          data-tip="${esc(tc(`${label}：${fmtN(p.total)} ${NOUN_ZH[g]}中已填 ${fmtN(p.total - p.missing)} ${COUNT_ZH[g]}${p.missing ? `\n点击列出未填的 ${fmtN(p.missing)} ${COUNT_ZH[g]}` : ""}`,
                              `${p.label}: ${fmtN(p.total - p.missing)} of ${fmtN(p.total)} ${NOUN[g][1]} have it${p.missing ? `\nclick to list the ${fmtN(p.missing)} without` : ""}`))}">
          <span class="l"><span>${esc(label)}</span></span><div class="ins-trk"><i style="width:${(f * 100).toFixed(1)}%"></i></div>
          <span class="v">${pctDown(f)} ${p.missing ? `<small style="color:var(--bl)">${tc(`${fmtN(p.missing)} 项缺失`, `${fmtN(p.missing)} missing`)}</small>` : `<small style="color:var(--gr)">${tc("完整", "complete")}</small>`}</span></div>`;
      }).join("");
    };

    const P2 = problemChecks(m);
    const ringColor = H.score === null ? "var(--sx-tx3)" : H.score >= 0.8 ? "var(--sx-gr)" : H.score >= 0.66 ? "var(--sx-ye)" : H.score >= 0.5 ? "var(--sx-or)" : "var(--sx-re)";

    el.innerHTML = `
      <section class="ins-card ins-hero" style="--c:var(--ye)">
        <div><div class="k">${ic("pulse")}${tc("元数据健康", "METADATA HEALTH")}</div><div class="big">${esc(H.grade)}</div>
          <div class="s">${H.score === null ? tc("Stash 没有报告哪些字段已填。", "Stash did not report what is filled in.") : tc(`在 Stash 能知道的字段中，已填 <b>${pctDown(H.score)}</b>，按每处缺失对查找的影响程度加权。`, `<b>${pctDown(H.score)}</b> of what Stash can know is filled in, weighted by how much each gap gets in the way of finding things.`)}
            ${H.wins.length ? `<br>${tc("最快见效：", "Quickest wins: ")}${H.wins.map((w, i) => `<span class="ins-go" data-go="${esc(missingLink(w.p.g, w.p.key))}">${esc(winText(w.p))}</span>${i === 0 && w.grade !== H.grade ? tc(`（升到 ${esc(w.grade)}）`, ` (to ${esc(w.grade)})`) : ""}`).join(tc("，", ", "))}${tc("。", ".")}` : ""}</div></div>
        ${ring([{ f: H.score || 0, color: ringColor }], pctDown(H.score), tc("已填", "filled in"), 150)}
      </section>
      <div class="ins-grid">
        ${card({ title: tc("场景", "Scenes"), icon: "film", c: "or", right: fmtN(m.scenes.length), sub: tc("点一行可列出缺少该项的场景", "Click a row to list the scenes missing it") }, block("scenes"))}
        <div>
          ${card({ title: tc("演员", "Performers"), icon: "users", c: "ma", right: fmtN(m.performers.length) }, block("performers"))}
          ${card({ title: tc("工作室", "Studios"), icon: "studio", c: "cy", right: fmtN(m.studios.length) }, block("studios"))}
        </div>
      </div>
      <div class="ins-note" style="text-align:center">${P2.serious ? tc(`${plural(P2.serious, "thing")}像是错的，而不是缺失；`, `${plural(P2.serious, "thing")} look wrong rather than missing; `) : ""}${tc(`修复与检查在 <span class="ins-go" data-tab="actions">操作${ic("arrow")}</span> 标签页。`, `fixes and checks are on the <span class="ins-go" data-tab="actions">Actions${ic("arrow")}</span> tab.`)}</div>`;
  }

  // ── Collection ────────────────────────────────────────────────────────────

  const GENDERS = [["FEMALE", "Women", "ma"], ["MALE", "Men", "bl"], ["TRANSGENDER_FEMALE", "Trans women", "pu"], ["TRANSGENDER_MALE", "Trans men", "cy"],
                   ["NON_BINARY", "Non-binary", "ye"], ["INTERSEX", "Intersex", "gr"], ["", "Not set", "tx3"]];
  // Display-only Chinese for the gender labels above (the table itself is read
  // at load time and its keys are Stash's gender values).
  const GENDERS_ZH = { FEMALE: "女性", MALE: "男性", TRANSGENDER_FEMALE: "跨性别女性", TRANSGENDER_MALE: "跨性别男性",
                       NON_BINARY: "非二元", INTERSEX: "间性", "": "未设置" };

  function growthChart(g) {
    const W = 1000, H = 170, padL = 46, padB = 22, padT = 10;
    const max = Math.max(1, ...g.map((x) => x.total));
    const step = (W - padL) / Math.max(1, g.length - 1);
    const X = (i) => padL + i * step, Y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const line = g.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(x.total).toFixed(1)}`).join(" ");
    const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))); return Math.ceil(v / p) * p; };
    const top = nice(max);
    const ticks = [0, top / 2, top].filter((v) => v <= max * 1.001 || v === 0);
    const years = g.map((x, i) => ({ i, d: new Date(x.from) })).filter((x) => x.d.getMonth() === 0 || x.i === 0);
    const hit = g.map((x, i) => `<rect x="${(X(i) - step / 2).toFixed(1)}" y="0" width="${Math.max(2, step).toFixed(1)}" height="${H - padB}" fill="transparent"
      data-tip="${esc(tc(`${fmtDate(x.from, { month: "long", year: "numeric" })}\n新增 ${fmtN(x.added)} · 共 ${fmtN(x.total)}\n当时占磁盘 ${fmtBytes(x.size)}`,
                          `${fmtDate(x.from, { month: "long", year: "numeric" })}\n+${fmtN(x.added)} added · ${fmtN(x.total)} in all\n${fmtBytes(x.size)} on disk then`))}"/>`).join("");
    return `<div class="ins-well" style="padding:8px 10px 4px"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
      <defs><linearGradient id="ins-gg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--sx-gr)" stop-opacity=".45"/><stop offset="1" stop-color="var(--sx-gr)" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => `<line x1="${padL}" x2="${W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--sx-ui)" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <text x="${padL - 6}" y="${(Y(v) + 4).toFixed(1)}" fill="var(--sx-tx2)" font-size="11" text-anchor="end">${fmtN(v)}</text>`).join("")}
      ${years.map((x) => `<text x="${X(x.i).toFixed(1)}" y="${H - 5}" fill="var(--sx-tx2)" font-size="11" text-anchor="${x.i === 0 ? "start" : "middle"}">${x.d.getFullYear()}</text>
        <line x1="${X(x.i).toFixed(1)}" x2="${X(x.i).toFixed(1)}" y1="${H - padB}" y2="${H - padB + 4}" stroke="var(--sx-tx3)" vector-effect="non-scaling-stroke"/>`).join("")}
      <path d="${line} L${X(g.length - 1).toFixed(1)} ${H - padB} L${padL} ${H - padB} Z" fill="url(#ins-gg)"/>
      <path d="${line}" fill="none" stroke="var(--sx-gr-tx)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${hit}</svg></div>`;
  }

  function renderCollection(el) {
    const m = app.model, cs = app.col;
    const g = m.get("growth", () => growth(m.scenes, m.now));
    const tags = m.get("tags", () => tagCounts(m.scenes));
    const net = m.get("networks", () => networks(m.studios, m.scenes));
    const pr = m.get("pairs", () => pairs(m.scenes).slice(0, 12));
    const faces = m.get("faces", () => newFaces(m.scenes));
    const ages = m.get("ages", () => ageCounts(m.scenes, m.perfById));
    const N = m.scenes.length;

    const last12 = g.slice(-12), avg12 = last12.length ? last12.reduce((a, x) => a + x.added, 0) / last12.length : 0;
    const busiest = g.reduce((b, x) => (!b || x.added > b.added ? x : b), null);
    let doubled = null;
    if (g.length) { const now = g[g.length - 1].total; for (let i = g.length - 1; i >= 0; i--) if (g[i].total <= now / 2) { doubled = g.length - 1 - i; break; } }
    const recent = g.slice(-24).map((x) => ({ value: x.added, label: new Date(x.from).toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
      tip: tc(`${fmtDate(x.from, { month: "long", year: "numeric" })}：新增 ${fmtN(x.added)}`, `${fmtDate(x.from, { month: "long", year: "numeric" })}: +${fmtN(x.added)}`), hi: busiest && x.key === busiest.key,
      click: x.added ? () => { const d = new Date(x.from), to = dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime());
        navigate(S([{ type: "created_at", modifier: "BETWEEN", value: { value: `${dayKey(x.from)} 00:00`, value2: `${to} 23:59` } }], "created_at")); } : null }));

    const tagSel = tags.find((t) => t.id === cs.tag) || tags[0];
    const co = tagSel ? m.get(`co:${tagSel.id}`, () => coTags(m.scenes, tagSel.id)) : { n: 0, rows: [] };

    // who is in it: performers with a scene here, or with "Count performers
    // with images only" also those only in images or galleries
    const withImages = app.set.imagePerformers;
    const inLib = m.get(`reach:${withImages}`, () => performerReach(m.scenes, m.performers, withImages)).ids;
    const genderN = new Map();
    for (const id of inLib) { const p = m.perfById.get(id); const k = p && p.gender ? p.gender : ""; genderN.set(k, (genderN.get(k) || 0) + 1); }
    const gTotal = Math.max(1, inLib.size);
    const allow = cs.gender === "ALL" ? null : cs.gender;
    const countries = new Map();
    let noCountry = 0;
    for (const id of inLib) {
      const p = m.perfById.get(id);
      if (!p || (allow !== null && (p.gender || "") !== allow)) continue;  // "" is Not set (2.11)
      const code = countryCode(p.country);
      if (!code) { noCountry += 1; continue; }
      countries.set(code, (countries.get(code) || 0) + 1);
    }
    const cRows = [...countries.entries()].sort((a, b) => b[1] - a[1]);
    const ageBars = [];
    for (let a = 18; a <= 50; a++) {
      const r = ages.get(a) || { n: 0, o: 0 };
      ageBars.push({ value: r.n, label: String(a), tip: tc(`年龄 ${a}：${plural(r.n, "appearance")}${m.noO ? "" : `，${os(r.o)}${r.n ? `（每场 ${(r.o / r.n).toFixed(2)}）` : ""}`}`,
                                                          `Age ${a}: ${plural(r.n, "appearance")}${m.noO ? "" : `, ${os(r.o)}${r.n ? ` (${(r.o / r.n).toFixed(2)} per scene)` : ""}`}`),
                     click: r.n ? () => navigate(S([{ type: "performer_age", modifier: "EQUALS", value: { value: a } }], "date")) : null });
    }
    const faceBars = faces.slice(-30).map((x) => ({ value: x.n, label: String(x.year), tip: tc(`${x.year} 年：${plural(x.n, "performer")}在这里首次出镜`, `${x.year}: ${plural(x.n, "performer")} in their first scene here`) }));
    const sMode = cs.studios;

    el.innerHTML = `
      ${card({ title: tc("增长", "Growth"), icon: "trend", c: "gr",
        sub: g.length ? tc(`${fmtN(N)} 个场景，自 ${fmtDate(g[0].from, { month: "long", year: "numeric" })} 起加入 · 过去一年平均每月 <b style="color:var(--hi)">${Math.round(avg12)}</b> 个${busiest ? ` · 最忙的月份是 ${fmtDate(busiest.from, { month: "short", year: "numeric" })}（+${fmtN(busiest.added)}）` : ""}${doubled !== null && doubled > 0 ? ` · 最近 ${plural(doubled, "month")}翻了一倍` : ""}`, `${fmtN(N)} scenes added since ${fmtDate(g[0].from, { month: "long", year: "numeric" })} · <b style="color:var(--hi)">${Math.round(avg12)}</b> a month over the last year${busiest ? ` · busiest month ${fmtDate(busiest.from, { month: "short", year: "numeric" })} (+${fmtN(busiest.added)})` : ""}${doubled !== null && doubled > 0 ? ` · doubled in the last ${plural(doubled, "month")}` : ""}`) : "" },
        g.length ? growthChart(g) + `<div style="margin-top:12px">${barChart(recent, { c: "gr", height: 90 })}</div><div class="ins-note">${tc("按月新增，最近 24 个月。点一个月可列出当时加入的内容。", "Added per month, last 24. Click a month to list what came in.")}</div>` : `<div class="ins-empty">${tc("没有加入日期。", "No added dates.")}</div>`)}
      <div class="ins-grid">
        ${card({ title: tc("热门标签", "Top tags"), icon: "tag", c: "gr", sub: tc("每个标签对应的场景数。点一个看看它常和什么一起出现。", "Scenes with each tag. Click one to see what goes with it.") },
          `<div class="ins-scroll" style="max-height:470px">${rows(tags.slice(0, 40).map((t) => ({ labelHtml: `<span style="${tagSel && t.id === tagSel.id ? "color:var(--hi);font-weight:600" : ""}">${esc(t.name)}</span>`,
            value: t.n, text: `${fmtN(t.n)} <small>${pct(t.n / Math.max(1, N))}</small>`, color: tagSel && t.id === tagSel.id ? "var(--sx-gr-tx)" : "var(--gr)",
            set: `col.tag=${t.id}`, tip: tc(`${t.name}：${plural(t.n, "scene")}`, `${t.name}: ${plural(t.n, "scene")}`) })), { lw: "minmax(110px,170px)", vw: "100px" })}</div>`)}
        ${card({ title: tagSel ? tc(`常与 ${esc(tagSel.name)} 一同出现`, `Goes with ${esc(tagSel.name)}`) : tc("常与…一同出现", "Goes with"), icon: "link", c: "gr",
          right: tagSel ? go(S([{ type: "tags", modifier: "INCLUDES", value: items(tagSel.id, tagSel.name) }]), tc(`${fmtN(tagSel.n)} 个场景`, `${fmtN(tagSel.n)} scenes`)) : "",
          sub: tc("它的场景中同时带有该标签的比例；lift 是相对整个媒体库高出多少倍。", "Share of its scenes that also have each tag; the lift is how much more often than across the library.") },
          co.rows.length ? rows(co.rows.slice(0, 14).map((r) => ({ label: r.name, value: r.share, text: `${pct(r.share)} <span class="ins-lift ${liftTone(r.lift)}">${r.lift.toFixed(1)}×</span>`,
            color: r.lift >= 1.25 ? "var(--gr)" : r.lift <= 0.8 ? "var(--re)" : "var(--tx2)",
            tip: tc(`${r.name}：${fmtN(co.n)} 个「${tagSel.name}」场景中有 ${fmtN(r.together)} 个`, `${r.name}: on ${fmtN(r.together)} of ${fmtN(co.n)} ${tagSel.name} scenes`),
            go: S([{ type: "tags", modifier: "INCLUDES_ALL", value: { items: [{ id: tagSel.id, label: tagSel.name }, { id: r.id, label: r.name }], excluded: [], depth: 0 } }]) })),
            { max: 1, lw: "minmax(110px,170px)", vw: "120px" }) : `<div class="ins-empty">${tc("与它共现的标签场景还不够多。", "Not enough scenes share a tag with it yet.")}</div>`)}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("工作室", "Studios"), icon: "studio", c: "or", right: `${chipFor("col", "studios", "networks", tc("网络", "Networks"), "or")}${chipFor("col", "studios", "studios", tc("工作室", "Studios"), "or")}`,
          sub: sMode === "networks" ? tc(`母工作室与其下属站点合并计数。${plural(net.independent.studios, "independent studio")}持有 ${plural(net.independent.scenes, "scene")}。`, `A parent studio and its sites together. ${plural(net.independent.studios, "independent studio")} hold ${plural(net.independent.scenes, "scene")}.`) : tc("每个工作室的场景数", "Scenes per studio") },
          sMode === "networks"
            ? (net.networks.length ? rows(net.networks.slice(0, 14).map((x, i) => ({ label: x.name, value: x.scenes, text: `${fmtN(x.scenes)} <small>${plural(x.sites, "site")}</small>`,
                color: CYCLE[i % CYCLE.length], go: `/studios/${x.id}`, tip: tc(`${x.name}\n${plural(x.sites, "site")}在这里有场景\n${plural(x.scenes, "scene")} · ${fmtBytes(x.size)}`, `${x.name}\n${plural(x.sites, "site")} with scenes here\n${plural(x.scenes, "scene")} · ${fmtBytes(x.size)}`) })), { lw: "minmax(110px,170px)", vw: "120px" })
              : `<div class="ins-empty">${tc("这里没有设置了母工作室的工作室。", "No studio here has a parent set.")}</div>`) +
              (net.independent.list.length ? `<div class="ins-sub" style="margin:14px 0 6px">${tc("最大的独立工作室", "Largest independents")}</div>` +
                rows(net.independent.list.slice(0, 8).map((x) => ({ label: x.name, value: x.scenes, text: `${fmtN(x.scenes)} <small>${pct(x.scenes / Math.max(1, N))}</small>`,
                  color: "var(--tx2)", go: `/studios/${x.id}`, tip: tc(`${x.name}：${plural(x.scenes, "scene")}，${fmtBytes(x.size)}`, `${x.name}: ${plural(x.scenes, "scene")}, ${fmtBytes(x.size)}`) })),
                  { lw: "minmax(110px,170px)", vw: "120px", max: Math.max(1, ...net.networks.map((x) => x.scenes), net.independent.list[0].scenes) }) : "")
            : rows(net.studios.slice(0, 15).map((x, i) => ({ label: x.name, value: x.scenes, text: `${fmtN(x.scenes)} <small>${pct(x.scenes / Math.max(1, N))}</small>`,
                color: CYCLE[i % CYCLE.length], go: `/studios/${x.id}`, tip: tc(`${x.name}：${plural(x.scenes, "scene")}，${fmtBytes(x.size)}`, `${x.name}: ${plural(x.scenes, "scene")}, ${fmtBytes(x.size)}`) })), { lw: "minmax(110px,170px)", vw: "100px" }))}
        ${card({ title: tc("都有谁", "Who is in it"), icon: "globe", c: "ma", sub: tc(`${plural(inLib.size, "performer")}在这里有场景${withImages ? "、图片或图库" : ""}`, `${plural(inLib.size, "performer")} with a scene${withImages ? ", image or gallery" : ""} here`) },
          `<div class="ins-split">${GENDERS.filter(([k]) => genderN.get(k)).map(([k, label, c]) => `<i style="flex:${genderN.get(k)};background:var(--${c})" data-tip="${esc(isZh() ? GENDERS_ZH[k] : label)}: ${fmtN(genderN.get(k))} (${pct(genderN.get(k) / gTotal)})"></i>`).join("")}</div>
          <div class="ins-legend2" style="margin:0 0 12px">${GENDERS.filter(([k]) => genderN.get(k)).map(([k, label, c]) => `<span><i style="background:var(--${c})"></i>${esc(isZh() ? GENDERS_ZH[k] : label)} <b style="color:var(--hi);font-weight:600">${fmtN(genderN.get(k))}</b> ${pct(genderN.get(k) / gTotal)}</span>`).join("")}</div>
          ${genderChips(m, "col", "gender", cs.gender, "ma") || `<div class="ins-dims">${[["FEMALE", tc("女性", "Women")], ["MALE", tc("男性", "Men")], ["ALL", tc("全部", "Everyone")]].map(([k, l]) => chipFor("col", "gender", k, l, "ma")).join("")}</div>`}
          <div class="ins-scroll" style="max-height:330px">${cRows.length ? rows(cRows.map(([code, n]) => ({ labelHtml: `${flag(code)}<span>${esc(regionName(code))}</span>`, value: n,
            text: `${fmtN(n)}`, color: "var(--ma)", go: P([{ type: "country", modifier: "EQUALS", value: code }]) })), { lw: "minmax(130px,200px)", vw: "60px" }) : `<div class="ins-empty">${tc("没有设置国家。", "No countries set.")}</div>`}</div>
          <div class="ins-note">${tc(`${plural(cRows.length, "country", "countries")} · ${plural(noCountry, "performer")}没有填写`, `${plural(cRows.length, "country", "countries")} · ${plural(noCountry, "performer")} without one`)}</div>`)}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("搭档", "Pairs"), icon: "link", c: "ma", sub: tc("同场次数最多的演员。点一下可列出他们。", "Performers who share the most scenes. Click to list them.") },
          pr.length ? pr.map((x) => { const a = m.perfById.get(x.a) || { id: x.a, name: tc(`演员 ${x.a}`, `Performer ${x.a}`) }, b = m.perfById.get(x.b) || { id: x.b, name: tc(`演员 ${x.b}`, `Performer ${x.b}`) };
            return `<div class="ins-li click" style="grid-template-columns:54px minmax(0,1fr) auto" data-go="${esc(S([{ type: "performers", modifier: "INCLUDES_ALL", value: { items: [{ id: a.id, label: a.name }, { id: b.id, label: b.name }], excluded: [], depth: 0 } }]))}">
              <span style="display:flex">${avatar(a, "sm")}<span style="margin-left:-6px">${avatar(b, "sm")}</span></span>
              <div class="n">${esc(a.name)} <span style="color:var(--tx2)">${tc("和", "and")}</span> ${esc(b.name)}</div><div class="v" style="color:var(--hi);font-weight:700">${plural(x.n, "scene")}</div></div>`; }).join("")
            : `<div class="ins-empty">${tc("还没有两位演员同场过。", "No two performers share a scene yet.")}</div>`)}
        ${card({ title: tc("年龄与新面孔", "Ages and new faces"), icon: "user", c: "pu", sub: tc("每位演员在场景拍摄当天的年龄。点一个年龄可列出那些场景。", "Age of each performer on the scene's date. Click an age to list those scenes.") },
          barChart(ageBars, { c: "pu", height: 90 }) +
          `<div class="ins-sub" style="margin:14px 0 8px">${tc("每位演员在这里首次出镜的年份", "The year each performer's first scene here came out")}</div>` +
          (faceBars.length ? barChart(faceBars, { c: "ma", height: 70 }) : `<div class="ins-empty">${tc("没有发行日期。", "No release dates.")}</div>`))}
      </div>`;
  }

  // ── Movies (2.5, with Movies Toolkit) ─────────────────────────────────────

  // Links into a Movies Toolkit tab. Up to 2.5 Insights wrote the tab into
  // Movies Toolkit's own localStorage prefs ("moviesPrefs"); a plugin never
  // writes another plugin's keys (THEME "Saving", audit C8), so now:
  // - the link carries the tab, /movies?tab=chapters, for a new browser tab
  //   or a reload; Movies Toolkit has to read that parameter for it to work
  //   there (until it does, it opens on its last tab);
  // - within this page, once its page is drawn, its own tab button is
  //   pressed, its public behaviour (it saves its own pref itself).
  function mvUrl(tab) { return tab ? `/movies?tab=${encodeURIComponent(tab)}` : "/movies"; }
  function toolkitTab(tab, here) {
    if (!here) return;
    let n = 0;
    const timer = setInterval(() => {
      const b = document.querySelector(`.mv-page .mv-tab[data-tab="${tab}"]`);
      if (b || ++n > 40 || location.pathname !== "/movies") {
        clearInterval(timer);
        if (b && !b.classList.contains("on")) b.click();
      }
    }, 150);
  }
  const tk = (tab) => `data-go="${esc(mvUrl(tab))}" data-mvtab="${esc(tab)}"`;
  const tkGo = (tab, label) => `<span class="ins-go" ${tk(tab)}>${esc(label)}${ic("arrow")}</span>`;
  const G = (criteria, sort = "name", dir = "asc") => listUrl("/groups", criteria, sort, dir);
  // Stash's own group filters for each gap; their counts were checked to
  // match these on the user's Stash (is_missing has no "synopsis" for groups).
  const MOVIE_META_LINK = {
    cover: { type: "is_missing", modifier: "EQUALS", value: "front_image" }, date: { type: "is_missing", modifier: "EQUALS", value: "date" },
    studio: { type: "is_missing", modifier: "EQUALS", value: "studio" }, director: { type: "is_missing", modifier: "EQUALS", value: "director" },
    synopsis: { type: "synopsis", modifier: "IS_NULL", value: "" },
  };

  // Worked out again only when the movies or the scenes change.
  let mvMemo = { data: null, model: null, out: null };
  function moviesModel() {
    const d = app.mv.data, m = app.model;
    if (mvMemo.data !== d || mvMemo.model !== m) {
      mvMemo = { data: d, model: m, out: movieModel(d.groups, m.scenes, { legacy: new Map(Object.entries(d.legacy || {})) }) };
    }
    return mvMemo.out;
  }

  const poster = (x) => (x.poster ? `<img class="ins-poster" src="${esc(x.poster)}" alt="" loading="lazy">` : `<span class="ins-poster">${ic("movie")}</span>`);
  // A movie in a list: poster, name, a line under it, a value on the right.
  // Opens the movie in Stash, or with `go` somewhere else.
  function movieRow(x, o = {}) {
    const noO = app.model.noO;
    const tip = o.tip || `${x.name}\n${plural(x.owned, "scene")} · played ${fmtN(x.plays)}× · watched ${fmtDur(x.watch)}${noO ? "" : ` · ${os(x.o)}`}`;
    return `<div class="ins-li mv click" data-go="${esc(o.go || `/groups/${x.id}`)}" data-tip="${esc(tip)}">${poster(x)}
      <div style="min-width:0"><div class="n">${esc(x.name)}</div><div class="sub">${o.sub || ""}</div>
      ${o.max ? `<div class="ins-trk" style="height:5px;margin-top:4px"><i style="width:${Math.max(2, Math.round((o.value / o.max) * 100))}%"></i></div>` : ""}</div>
      <div class="v" style="${o.vstyle || "color:var(--hi);font-weight:700"}">${o.text ?? ""}</div></div>`;
  }

  // Reads the movies again in the background (each check, and on first
  // showing the tab); a read that finds the same movies does not redraw.
  // The first time, the kept copy is shown while it reads.
  async function syncMovies(force) {
    const mv = app.mv;
    if (!moviesShown(app.set) || mv.busy) return;
    if (!force && mv.data && Date.now() - (mv.data.at || 0) < 20000) return;
    mv.busy = true;
    let changed = false;
    try {
      if (!mv.data) {
        const c = await cacheGet(MOVIES_KEY);
        if (c && Array.isArray(c.groups)) { mv.data = c; mv.sig = JSON.stringify([c.groups, c.legacy]); if (app.root && shownTab() === "movies") render(); }
      }
      const d = (await readMovies()) || { at: Date.now(), groups: [], legacy: {} };
      const sig = JSON.stringify([d.groups, d.legacy]);
      cachePut(d, MOVIES_KEY);
      if (sig !== mv.sig || !mv.data) { mv.data = d; mv.sig = sig; changed = true; }
      else mv.data.at = d.at;
      if (mv.err) { mv.err = ""; changed = true; }
    } catch (e) {
      log(`Movies read failed: ${e.message}`, "error");
      if (!mv.data) { mv.err = e.message; changed = true; }
    } finally {
      mv.busy = false;
      if (changed && app.root && shownTab() === "movies") render();
    }
  }

  function renderMovies(el) {
    const mv = app.mv, m = app.model, noO = m.noO;
    if (!mv.data) {
      el.innerHTML = mv.err ? `<div class="ins-error">${tc(`Insights 读不了你的影片：${esc(mv.err)}。`, `Insights could not read your movies: ${esc(mv.err)}.`)} <button class="ins-btn" data-act="movies">${tc("重试", "Try again")}</button></div>`
        : `<div class="ins-progress">${tc("正在读取你的影片…", "Reading your movies…")}<div class="bar"><i></i></div></div>`;
      if (!mv.busy && !mv.err) syncMovies();
      return;
    }
    const M = moviesModel(), T = M.totals, n = T.movies;
    if (!n) {
      el.innerHTML = card({ title: tc("还没有影片", "No movies yet"), icon: "movie", c: "pu",
        sub: tc("Movies Toolkit 的「查找」标签页会翻遍你的场景，按链接和文件名找出它们所属的影片并生成影片，连同封面和详情。之后你的影片就会出现在这里。", "Movies Toolkit's Find tab looks through your scenes for the movies they belong to (by their links and file names) and makes them, with covers and details. Your movies show up here after that.") },
        `<div class="ins-btns" style="justify-content:flex-start;margin:0 0 4px 38px"><button class="ins-btn big" ${tk("find")}>${ic("search")} ${tc("打开 Movies Toolkit 的「查找」标签页", "Open Movies Toolkit's Find tab")}</button></div>`);
      return;
    }
    const libN = m.scenes.length, slots = M.movies.reduce((a, x) => a + x.owned, 0);
    const sceneById = m.get("sceneById", () => new Map(m.scenes.map((s) => [s.id, s])));

    // 2: your movies, ranked
    const rank = choice("mrank", mv.rank, noO, MOVIE_CHOICES);
    const ranked = rankMovies(M.movies, rank), list = ranked.slice(0, mv.more ? 50 : 10);
    const rmax = list.length ? movieValue(list[0], rank) : 1;
    const rtext = (x) => (rank === "watch" ? fmtDur(x.watch) : rank === "o" ? fmtN(x.o) : `${fmtN(x.plays)}×`);
    const rchips = choices("mrank", noO, MOVIE_CHOICES).map(([v, label]) =>
      `<button class="ins-chip${rank === v ? " on" : ""}" style="--c:var(--pu)" data-set="mv.rank=${v}">${label}</button>`).join("");
    const lastLine = (x) => (x.last ? tc(`上次观看 ${ago(x.last)}`, `last watched ${ago(x.last)}`) : tc("还没看过", "not watched yet"));

    // 4: how far each is watched
    const Wt = M.watching, wN = Wt.finished.length + Wt.part.length + Wt.never.length;
    const wSegs = [["finished", tc("已看完", "Finished"), "gr"], ["part", tc("看了一部分", "Part watched"), "ye"], ["never", tc("还没开始", "Never started"), "tx3"]];
    const wList = (key) => {
      const all = Wt[key], shown = all.slice(0, 3);
      return shown.map((x) => movieRow(x, { text: "", sub: key === "part" ? tc(`${fmtN(x.played)} / ${plural(x.owned, "scene")} 已播放`, `${fmtN(x.played)} of ${plural(x.owned, "scene")} played`)
        : key === "finished" ? `${plural(x.owned, "scene")} · ${lastLine(x)}` : `${plural(x.owned, "scene")}${x.created ? tc(` · 加入于 ${ago(x.created)}`, ` · added ${ago(x.created)}`) : ""}` })).join("") +
        (all.length > shown.length ? `<div class="ins-note" style="margin:2px 0 0 40px">${tc(`另有 ${plural(all.length - shown.length, "movie")}`, `+ ${fmtN(all.length - shown.length)} more`)}</div>` : "");
    };

    // 3: numbering
    const inc = M.incomplete, incShown = mv.gapsAll ? inc : inc.slice(0, 6);
    // "missing 2 of 1–3" read as two missing; the numbers and the range apart
    const missText = (g) => tc(`缺第 ${g.missing.join("、")} 号${g.n > g.missing.length ? `，另有 ${fmtN(g.n - g.missing.length)} 个` : ""} · 编号到 ${fmtN(g.max)}`, `missing no. ${g.missing.join(", ")}${g.n > g.missing.length ? ` and ${fmtN(g.n - g.missing.length)} more` : ""} · numbered up to ${fmtN(g.max)}`);

    // 6: years and studios
    const Y = movieYears(M.movies);
    const yBars = Y.bars.map((b) => ({ label: b.label, value: b.n, tip: tc(`${Y.unit === "decade" ? `${b.label} 年代` : b.label}：${plural(b.n, "movie")}`, `${Y.unit === "decade" ? `The ${b.label}` : b.label}: ${plural(b.n, "movie")}`),
      click: b.n ? () => navigate(G([{ type: "date", modifier: "BETWEEN", value: { value: `${b.from}-01-01`, value2: `${b.to}-12-31` } }], "date")) : null }));
    const topStudios = M.studios.slice(0, 12);

    // 7: chapters
    const C = M.chapters, cN = C.files.length;

    el.innerHTML = `
      <div class="ins-tiles">
        ${tile("movie", "pu", tc("影片", "Movies"), fmtN(n), Wt.empty.length ? tc(`${plural(Wt.empty.length, "movie")}还没有场景`, `${plural(Wt.empty.length, "movie")} with no scenes yet`) : tc(`平均每部 ${(slots / n).toFixed(1)} 个场景`, `${(slots / n).toFixed(1)} scenes each on average`), "/groups")}
        ${tile("film", "or", tc("属于影片的场景", "Scenes in a movie"), fmtN(T.inMovie), tc(`占媒体库的 ${pct(libN ? T.inMovie / libN : 0)}`, `${pct(libN ? T.inMovie / libN : 0)} of the library`),
          S([{ type: "groups", modifier: "NOT_NULL", value: { items: [], excluded: [], depth: 0 } }], "date"))}
        ${tile("clock", "cy", tc("影片总时长", "Movie runtime"), fmtDur(T.runtime), T.runtime ? tc(`连续观看 ${nonstop(T.runtime)}`, `${nonstop(T.runtime)} nonstop`) : tc("还没有时长", "no lengths yet"))}
        ${tile("disk", "bl", tc("整部影片的文件", "Full-movie files"), fmtN(T.fullFiles), tc("时长一小时以上，属于某部影片", "an hour or more, in a movie"), mvUrl("chapters"), tc("本身就是整部影片的文件：时长一小时以上，属于某部影片。打开 Movies Toolkit 的「章节」标签页。", "Files that are a whole movie: an hour or more, in a movie. Opens Movies Toolkit's Chapters tab."), `data-mvtab="chapters"`)}
        ${tile("flag", "gr", tc("已设章节", "With chapters"), fmtN(T.withChapters), T.fullFiles ? tc(`占整部影片文件的 ${pct(T.withChapters / T.fullFiles)}`, `${pct(T.withChapters / T.fullFiles)} of full-movie files`) : tc("没有整部影片的文件", "no full-movie files"), mvUrl("chapters"),
          tc("打开 Movies Toolkit 的「章节」标签页", "Opens Movies Toolkit's Chapters tab"), `data-mvtab="chapters"`)}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("你的影片", "Your movies"), icon: "trophy", c: "pu", right: rchips,
          sub: rank === "watch" ? tc("在 Stash 里的播放时长，按一部影片的所有场景累加。", "Time played in Stash, over all of a movie's scenes.") : rank === "o" ? tc("一部影片所有场景的 O 数累加。", "O's on a movie's scenes, added up.") : tc("一部影片所有场景的播放次数累加。", "Plays of a movie's scenes, added up.") },
          (list.length ? list.map((x) => movieRow(x, { value: movieValue(x, rank), max: rmax, text: rtext(x),
            sub: tc(`${plural(x.owned, "scene")} · ${lastLine(x)}`, `${plural(x.owned, "scene")} owned · ${lastLine(x)}`) })).join("")
            : `<div class="ins-empty">${rank === "o" ? tc("你的影片还没有一次 O。", "None of your movies has an O yet.") : tc("你的影片还没有播放过。", "None of your movies has been played yet.")}</div>`) +
          (ranked.length > 10 ? `<div class="ins-note"><button class="ins-chip" data-set="mv.more=${mv.more ? "false" : "true"}">${mv.more ? tc("少显示一些", "show fewer") : tc(`再显示 ${plural(Math.min(50, ranked.length) - 10, "movie")}`, `show ${fmtN(Math.min(50, ranked.length) - 10)} more`)}</button></div>` : ""))}
        ${card({ title: tc("观看进度", "Watching"), icon: "play", c: "cy", sub: tc("已看完：你手上的场景全都播放过。看了一部分：有些播放过。", "Finished: every scene of it you have is played. Part watched: some are.") },
          (wN ? `<div class="ins-split">${wSegs.map(([k, , c]) => Wt[k].length ? `<i style="width:${((Wt[k].length / wN) * 100).toFixed(2)}%;background:var(--${c})" data-tip="${esc(`${plural(Wt[k].length, "movie")}`)}"></i>` : "").join("")}</div>` : "") +
          wSegs.map(([k, label, c]) => `<div class="ins-mvh"><i style="background:var(--${c})"></i>${label} <b>${fmtN(Wt[k].length)}</b><span style="color:var(--tx2)">${pct(wN ? Wt[k].length / wN : 0)}</span></div>` +
            (Wt[k].length ? wList(k) : `<div class="ins-empty" style="padding:4px 0 0 18px">${tc("没有。", "None.")}</div>`)).join(""))}
      </div>
      <div class="ins-grid">
        ${card({ title: tc("完整度", "Completeness"), icon: "gap", c: "ye", sub: tc("影片编号最高值之下缺失的场景号。每项都会在 Movies Toolkit 里打开该影片。", "Scene numbers missing below a movie's highest. Each opens the movie in Movies Toolkit.") },
          `<div class="ins-stats" style="margin:0 0 10px"><span><b style="color:var(--gr)">${fmtN(M.complete)}</b>${tc("完整", "complete")}</span><span><b style="color:var(--ye)">${fmtN(inc.length)}</b>${tc("有缺口", "with gaps")}</span>
            <span><b style="color:var(--tx1b)">${fmtN(M.unnumbered)}</b>${tc("未编号", "not numbered")}</span></div>` +
          (inc.length ? `<div class="${mv.gapsAll && inc.length > 8 ? "ins-scroll" : ""}">${incShown.map((x) => movieRow(x, { go: `/movies?g=${x.id}`, sub: `<span class="ins-miss">${esc(missText(x.gaps))}</span>`,
              text: tc(`缺 ${fmtN(x.gaps.n)} 个`, `${fmtN(x.gaps.n)} missing`), vstyle: "color:var(--ye);font-weight:600;font-size:12px", tip: tc(`${x.name}\n${missText(x.gaps)}\n会在 Movies Toolkit 里打开它`, `${x.name}\n${missText(x.gaps)}\nOpens it in Movies Toolkit`) })).join("")}</div>` +
              (inc.length > 6 ? `<div class="ins-note"><button class="ins-chip" data-set="mv.gapsAll=${mv.gapsAll ? "false" : "true"}">${mv.gapsAll ? tc("少显示一些", "show fewer") : tc(`显示全部 ${plural(inc.length, "movie")}`, `show all ${fmtN(inc.length)}`)}</button></div>` : "")
            : `<div class="ins-empty">${tc("没有已编号的影片存在缺口。", "No numbered movie has a gap.")}</div>`))}
        ${card({ title: tc("元数据缺口", "Metadata gaps"), icon: "pulse", c: "or", right: tkGo("movies", tc("用 Movies Toolkit 补全", "Fill in with Movies Toolkit")), sub: tc("缺少各项的影片数。点一项可在 Stash 中列出它们。", "Movies missing each. Click one to list them in Stash.") },
          rows(M.meta.map((r) => ({ label: isZh() ? MOVIE_META_ZH[r.key] : r.label, value: r.n, text: `${fmtN(r.n)} <small>${pct(r.n / n)}</small>`, color: r.n ? "var(--or)" : "var(--gr)",
            go: MOVIE_META_LINK[r.key] ? G([MOVIE_META_LINK[r.key]]) : null, tip: tc(`${plural(r.n, "movie")}缺少${MOVIE_META_ZH[r.key]}`, `${plural(r.n, "movie")} without ${r.label === "Cover" ? "a cover" : r.label === "Release date" ? "a release date" : `a ${r.label.toLowerCase()}`}`) })),
            { max: n, lw: "minmax(100px,130px)", vw: "96px" }) +
          `<div class="ins-btns" style="justify-content:flex-start"><button class="ins-btn" ${tk("movies")}>${ic("movie")} ${tc("用 Movies Toolkit 补全", "Fill in with Movies Toolkit")}</button>
            <span class="ins-note" style="margin:0">${tc("它的「你的影片」标签页会去查这些影片，只补空着的字段。", "Its Your movies tab looks them up and fills in only what is empty.")}</span></div>`)}
      </div>
      ${card({ title: Y.unit === "decade" ? tc("按年代发行", "Released, by decade") : tc("按年份发行", "Released, by year"), icon: "calendar", c: "ye",
        sub: tc(`点一根柱子可列出那些影片。${Y.undated ? `另有 ${plural(Y.undated, "movie")}没有发行日期，未显示。` : ""}`, `Click a bar to list those movies.${Y.undated ? ` ${plural(Y.undated, "movie")} without a release date ${Y.undated === 1 ? "is" : "are"} not shown.` : ""}`) },
        yBars.length ? barChart(yBars, { c: "ye" }) : `<div class="ins-empty">${tc("还没有发行日期。", "No release dates yet.")}</div>`)}
      <div class="ins-grid">
        ${card({ title: tc("工作室排行", "Top studios"), icon: "studio", c: "gr", sub: tc("按影片数量 · 点击可列出", "By number of movies · click to list them") },
          (topStudios.length ? rows(topStudios.map((s) => ({ label: s.name, value: s.n, text: fmtN(s.n), color: "var(--gr)",
            go: G([{ type: "studios", modifier: "INCLUDES", value: items(s.id, s.name) }], "date", "desc"), tip: tc(`${s.name}：${plural(s.n, "movie")}`, `${s.name}: ${plural(s.n, "movie")}`) })), { lw: "minmax(120px,220px)", vw: "48px" })
            : `<div class="ins-empty">${tc("还没有影片有工作室。", "No movie has a studio yet.")}</div>`) +
          `<div class="ins-note">${M.studios.length > topStudios.length ? tc(`另有 ${plural(M.studios.length - topStudios.length, "more studio")}。`, `+ ${plural(M.studios.length - topStudios.length, "more studio")}. `) : ""}${M.noStudio ? tc(`${plural(M.noStudio, "movie")}没有工作室。`, `${plural(M.noStudio, "movie")} without a studio.`) : ""}</div>`)}
        ${card({ title: tc("章节", "Chapters"), icon: "flag", c: "gr", right: tkGo("chapters", tc("打开「章节」标签页", "Open the Chapters tab")),
          sub: tc("整部影片的文件（时长一小时以上，属于某部影片）以及 Movies Toolkit 是否已为它们设好章节。", "Full-movie files (an hour or more, in a movie) and whether Movies Toolkit has set their chapters.") },
          (cN ? `<div class="ins-stats" style="margin:0 0 6px"><span><b>${fmtN(cN)}</b>${tc("整部影片的文件", "full-movie files")}</span><span><b style="color:var(--gr)">${fmtN(C.with.length)}</b>${tc("已设章节", "with chapters")}</span>
              <span><b style="color:var(--tx1b)">${fmtN(C.without.length)}</b>${tc("未设", "without")}</span></div>
            <div class="ins-split"><i style="width:${((C.with.length / cN) * 100).toFixed(2)}%;background:var(--gr)"></i><i style="width:${((C.without.length / cN) * 100).toFixed(2)}%;background:var(--ui3)"></i></div>` +
            (C.old ? `<div class="ins-note" style="margin:0 0 6px">${tc(`还有 ${plural(C.old, "file")}的章节仍是 Movies Toolkit 1.0 的标记；它的「章节」标签页会把它们迁移过来。`, `${plural(C.old, "file")} still ${C.old === 1 ? "has" : "have"} chapters as markers from Movies Toolkit 1.0; its Chapters tab moves them.`)}</div>` : "") +
            (C.without.length ? `<div class="ins-sub" style="margin:8px 0 2px">${tc("最长的未设章节文件", "Longest without chapters")}</div>` + C.without.slice(0, 5).map((f) => {
              const s = sceneById.get(f.id) || { id: f.id, title: tc(`场景 ${f.id}`, `Scene ${f.id}`) };
              return `<div class="ins-li click" data-go="/scenes/${esc(f.id)}">${thumb(s)}<div style="min-width:0"><div class="n">${esc(s.title)}</div>
                <div class="sub">${esc((M.movies.find((x) => x.id === f.movie) || {}).name || "")}</div></div><div class="v" style="color:var(--tx1b)">${fmtDur(f.dur)}</div></div>`;
            }).join("") : `<div class="ins-empty">${tc("每个整部影片的文件都设了章节。", "Every full-movie file has chapters.")}</div>`)
            : `<div class="ins-empty">${tc("影片里没有时长一小时以上的文件。", "No file in a movie runs an hour or more.")}</div>`) +
          `<div class="ins-btns" style="justify-content:flex-start"><button class="ins-btn" ${tk("chapters")}>${ic("flag")} ${tc("打开 Movies Toolkit 的「章节」标签页", "Open Movies Toolkit's Chapters tab")}</button></div>`)}
      </div>`;
  }

  // ── Controls (one delegated click handler on the root) ────────────────────

  function onClick(ev) {
    const t = ev.target.closest && ev.target.closest("[data-tab],[data-set],[data-nav],[data-daynav],[data-day],[data-bar],[data-go],[data-act],[data-jump],[data-hub]");
    // the panel carries data-tab itself (for its colour): a click on blank
    // space would find it and act as a tab click (user report: blank areas
    // jumped the page to the top)
    if (!t || t === app.root || !app.root.contains(t)) return;
    // a tab only swaps the content; the page stays where it is
    if (t.dataset.tab) { app.tab = t.dataset.tab; setPref("tab", app.tab); render(); return; }
    if (t.dataset.hub) { onHub(t); return; }
    if (t.dataset.jump) { document.getElementById(t.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (t.dataset.set) {
      const i = t.dataset.set.indexOf("=");
      const path = t.dataset.set.slice(0, i), raw = t.dataset.set.slice(i + 1);
      const [grp, key] = path.split(".");
      const val = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
      app[grp][key] = val;
      if (grp === "you" && key === "kind") app.you.offset = 0;
      if (grp === "you" && key === "dim") { setPref("dim", val); app.you.sort = "auto"; }
      // 2.11: kept between visits (forum: "can we perm enable this?")
      if (grp === "you" && key === "small") setPref("small", val);
      if (grp === "you" && key === "wgender") setPref("wgender", val);
      // a different rule makes a different selection: hand ticks start over
      if (grp === "acts" && (key === "mode" || key === "sharp")) { app.acts.ticks = new Map(); app.acts.armed = false; }
      if (grp === "col" && key === "gender") setPref("gender", val);
      if (grp === "lib" && key === "timeline") app.lib.year = null;
      if (grp === "mv" && key === "rank") { setPref("mrank", val); app.mv.more = false; }
      render();
      if (grp === "you" && key === "dim") document.getElementById("ins-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (t.dataset.nav) { app.you.offset = Math.min(0, app.you.offset + Number(t.dataset.nav)); render(); return; }
    if (t.dataset.daynav) {
      const d = parseDay(app.you.day || dayKey(Date.now()));
      const next = addDays(d, Number(t.dataset.daynav));
      if (next <= dayStart(Date.now())) app.you.day = dayKey(next);
      render(); document.getElementById("ins-otd")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (t.dataset.day) {
      app.tab = "you"; app.you.day = t.dataset.day; render();
      document.getElementById("ins-otd")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (t.dataset.bar) { const f = CLICKS[+t.dataset.bar]; if (f) f(); return; }
    if (t.dataset.go) {
      const newTab = t.dataset.go !== "#" && (ev.ctrlKey || ev.metaKey || ev.shiftKey);
      if (t.dataset.mvtab) toolkitTab(t.dataset.mvtab, !newTab);
      if (newTab) window.open(t.dataset.go, "_blank", "noopener"); else navigate(t.dataset.go);
      return;
    }
    if (t.dataset.act === "refresh") {
      if (!app.acts.run || app.acts.run.finished) { app.acts = freshActs(); if (app.hub.at) { app.hub.at = 0; app.hub.force = true; } if (app.data) refresh(true); else load(); }
      return;
    }
    if (t.dataset.act === "import") { importOStats(t); return; }
    if (t.dataset.act === "movies") { app.mv.err = ""; render(); syncMovies(true); return; }
    if (t.dataset.act === "dups") { scanDuplicates(); return; }
    if (t.dataset.act === "dtick") {
      const a = app.acts, id = t.dataset.id;
      const it = dupState().plans.flatMap((p) => p.items).find((i) => i.s.id === id);
      if (it) a.ticks.set(id, !it.on);
      a.armed = false; render(); return;
    }
    if (t.dataset.act === "dtag") { tagTicked(t); return; }
    if (t.dataset.act === "dremove") {
      const a = app.acts;
      if (!a.armed) {
        a.armed = true; render();
        clearTimeout(a.armTimer);
        a.armTimer = setTimeout(() => { if (a.armed) { a.armed = false; if (app.tab === "actions") render(); } }, 6000);
        return;
      }
      removeTicked(); return;
    }
    if (t.dataset.act === "reencode") { tagReencode(t); return; }
    if (t.dataset.act === "phash") { runPhash(t); return; }
  }

  // Library to-do's buttons (2.8)
  function onHub(t) {
    const H = app.hub, a = t.dataset.hub, id = t.dataset.id || "", key = t.dataset.key || "";
    if (a === "reload") { hubLoad(true); return; }
    if (a === "scanall") { hubScanAll(); return; }
    if (a === "all") { setPref("hubSkip", []); drawHub(); return; }
    if (a === "none") { setPref("hubSkip", [...H.cards.keys()]); drawHub(); return; }
    if (a === "skip") {
      const skip = hubSkip();
      setPref("hubSkip", skip.includes(id) ? skip.filter((x) => x !== id) : [...skip, id]);
      drawHub(); return;
    }
    if (a === "qclose") { H.queue = null; drawHub(); return; }
    // a quick action shows what it will do first; the second button runs it
    if (a === "arm") { H.armed = `${id}|${key}`; drawHub(); return; }
    if (a === "disarm") { H.armed = ""; drawHub(); return; }
    if (a === "go") { H.armed = ""; hubRun(id, key); }
  }

  async function importOStats(btn) {
    btn.disabled = true; btn.textContent = tc("正在导入…", "Importing…");
    try {
      const saved = await updateConfig((mine) => {
        const stored = parseWatch(mine.watch);
        if (stored === null) throw new Error(tc("已保存的观看时间无法读取", "stored watch time could not be read"));
        return { ...mine, watch: JSON.stringify(mergeOStats(stored, app.ostats.data).merged), ostatsImported: "true" };
      });
      app.config = saved;
      app.watch = parseWatch(saved.watch) || {};
      app.model = buildModel(app.data, app.watch, app.lockdown, app.set);
      render();
    } catch (e) { btn.textContent = tc(`失败：${e.message}`, `Failed: ${e.message}`); }
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  // Opens at once from the last read, however old (user, 2.3: Insights
  // "refreshes every time I open the browser"; the full read is ~50 s on
  // 21,000 scenes), then brings it up to date in the background. Only a
  // browser with no cache at all waits for the full read.
  async function load() {
    if (app.loading) return;
    app.loading = true; app.error = "";
    let fresh = false;
    try {
      const [plugins, installed] = await Promise.all([readPlugins(), readInstalled()]);
      applySettings(plugins ? plugins[PLUGIN_ID] || {} : null, true, installed, plugins);
      app.config = (plugins && plugins[PLUGIN_ID]) || {};
      app.watch = parseWatch(app.config.watch) || {};
      app.lockdown = parseLockdown(plugins && plugins.Lockdown);
      app.slideshow = plugins ? parseSlideshow(plugins[SLIDESHOW_ID]) : app.slideshow;
      let data = app.data || await cacheGet();
      if (!data || !Array.isArray(data.scenes)) {
        app.model = null;
        app.progress = tc("正在读取你的媒体库…", "Reading your library…");
        render();
        data = await loadLibrary((t) => { app.progress = t; const p = app.root?.querySelector(".ins-progress"); if (p) p.firstChild.textContent = t; });
        cachePut(data);
        fresh = true;
      }
      setData(data);
      checkOStats();
      syncMovies();
    } catch (e) {
      log(`Load failed: ${e.message}`, "error");
      app.error = e.message;
    } finally {
      app.loading = false;
      render();
    }
    if (app.data && !fresh) refresh(false);
  }
  function setData(data) {
    app.data = data;
    app.model = buildModel(data, app.watch, app.lockdown, app.set);
  }

  // Brings what is shown up to date while it stays on screen: a check and
  // only what changed, or with `full` everything again (Refresh). A check
  // this Stash cannot do (an older one without the filters) reads everything.
  // A failure leaves the shown data as it is.
  async function refresh(full) {
    if (app.syncing || app.loading || !app.data) return;
    const say = (t) => { app.syncing = t; renderMeta(); };
    say(full ? tc("重新读取全部内容…", "reading everything again…") : tc("正在检查改动…", "checking for changes…"));
    // the movies are read alongside (a second or so), not after
    syncMovies(full);
    try {
      let r = null;
      if (!full) {
        try { r = await syncLibrary(app.data, say); }
        catch (e) { log(`Check failed (${e.message}); reading everything`); }
      }
      if (!r) r = { data: await loadLibrary(say), changed: null };
      cachePut(r.data);
      // watch time and Lockdown runs may have moved too
      const [plugins, installed] = await Promise.all([readPlugins(), readInstalled()]);
      applySettings(plugins ? plugins[PLUGIN_ID] || {} : null, true, installed, plugins);
      if (plugins) {
        if (plugins[PLUGIN_ID]) { app.config = plugins[PLUGIN_ID]; app.watch = parseWatch(app.config.watch) || app.watch; }
        app.lockdown = parseLockdown(plugins.Lockdown);
        app.slideshow = parseSlideshow(plugins[SLIDESHOW_ID]);
      }
      app.syncNote = r.changed === null ? "" : r.changed ? tc(`${plural(r.changed, "scene")}有改动`, `${plural(r.changed, "scene")} changed`) : tc("无改动", "no changes");
      setData(r.data);
    } catch (e) {
      log(`Refresh failed: ${e.message}`, "error");
      app.syncNote = tc("无法检查，显示上次读取的结果", "could not check; showing the last read");
    } finally {
      app.syncing = "";
      render();
    }
  }

  async function checkOStats() {
    if (app.ostats || app.config.ostatsImported === "true") return;
    try {
      const r = await fetch(`/plugin/ostats/assets/watch_data.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const { days } = mergeOStats({}, data);
      if (days) { app.ostats = { data, days }; render(); }
    } catch (_) {}
  }

  // ── Mounting on the Stats page ────────────────────────────────────────────
  // Stash draws its numbers as three ".stats" rows; Insights goes after the
  // last one (after the first put it between them). Insights covers every
  // one of those numbers, so by user request Stash's rows are hidden unless
  // the "Show Stash's own numbers" setting is on. Never by removing React's
  // elements (Stats Enhancer hid a tile by position and resized the rest).
  //
  // 2.4: the hiding is Insights.css, which Stash loads with the plugin, so
  // it is there before the Stats page is first drawn. Up to 2.3 a stylesheet
  // was added by the 1 s timer once on /stats, so after a click on Stats the
  // rows showed for up to a second whatever the setting (forum: "a slight
  // delay where the normal stash stats show"), and the setting was read once
  // per page load, so changing it did nothing until a reload. Now the
  // setting is an attribute on <html> that Insights.css reads, set at once
  // from the last value seen and checked again every time Stats opens.

  const onStats = () => /^\/stats\/?$/.test(location.pathname);
  const showNativeRows = (on) => document.documentElement.toggleAttribute("data-ins-native", !!on);
  showNativeRows(app.set.showNative);

  // Applies the settings from Insights' config (`quiet`: the caller builds
  // the model itself). A changed "Hide O's" or "Count performers with images
  // only" rebuilds what is shown from the data already read.
  //
  // 2.5: `cfg` null (the config read failed) keeps the settings as they
  // are; `installed` (Stash's plugin list, or null when that read failed)
  // says whether Movies Toolkit is there. The Movies tab follows both, and
  // its movies are read the moment it first shows.
  // `all` (2.6): every plugin's config, for Movies Toolkit's rename; null
  // or a failed plugin list keeps the last answer.
  function applySettings(cfg, quiet, installed, all) {
    const prev = app.set;
    const next = { ...(cfg === null ? prev : { ...parseSettings(cfg), ...parseMovieSetting(cfg) }),
                   movies: installed ? moviesInstalled(installed) : !!prev.movies,
                   slideshow: installed ? slideshowInstalled(installed) : !!prev.slideshow,
                   moviesName: installed && all ? moviesRenamed(installed, all) : !!prev.moviesName };
    app.set = next;
    try {
      localStorage.setItem(SET_KEY, JSON.stringify({ showStashNumbers: next.showNative, hideO: next.hideO, imagePerformers: next.imagePerformers,
                                                     hideMovies: next.hideMovies, moviesToolkit: next.movies, moviesName: next.moviesName,
                                                     slideshow: next.slideshow }));
    } catch (_) {}
    showNativeRows(next.showNative);
    const mvChanged = moviesShown(prev) !== moviesShown(next);
    if (mvChanged && moviesShown(next)) syncMovies();
    if (!quiet && app.data && (prev.hideO !== next.hideO || prev.imagePerformers !== next.imagePerformers)) { setData(app.data); render(); }
    else if (!quiet && (mvChanged || prev.moviesName !== next.moviesName) && app.model) render();
  }
  async function checkSettings() {
    const [plugins, installed] = await Promise.all([readPlugins(), readInstalled()]);
    applySettings(plugins ? plugins[PLUGIN_ID] || {} : null, false, installed, plugins);
  }
  // Read when Stats opens: by load() the first time, by mount() after that.

  function mount() {
    if (!onStats()) return;
    if (app.root && app.root.isConnected) return;
    const rows = document.querySelectorAll(".stats");
    const native = rows[rows.length - 1];
    if (!native) return;
    injectStyles();
    if (!app.root) {
      app.root = document.createElement("div");
      app.root.id = "insights";
      app.root.addEventListener("click", onClick);
    // Middle-click (or Ctrl/Cmd/Shift-click) on anything that goes to a page
    // opens it in a new tab, as a link would; most of these are buttons and
    // rows, not <a href> (user report: middle-click did nothing). The
    // mousedown stops Chrome's autoscroll from starting first. A real link
    // is left to the browser.
    const goEl = (ev) => { const g = ev.target.closest && ev.target.closest("[data-go]"); return g && app.root.contains(g) && g.dataset.go && g.dataset.go !== "#" && !g.matches("a[href]") ? g : null; };
    app.root.addEventListener("mousedown", (ev) => { if (ev.button === 1 && goEl(ev)) ev.preventDefault(); });
    app.root.addEventListener("auxclick", (ev) => {
      const g = ev.button === 1 && goEl(ev);
      if (g) { ev.preventDefault(); if (g.dataset.mvtab) toolkitTab(g.dataset.mvtab, false); window.open(g.dataset.go, "_blank", "noopener"); }
    });
      wireTips(app.root);
    }
    native.insertAdjacentElement("afterend", app.root);
    // back on the page after a while: check again, still showing what is
    // there; a refresh reads the settings too, otherwise they are read alone
    if (app.model || app.loading) {
      render();
      if (app.data && Date.now() - app.data.at > 2 * 60000) refresh(false); else checkSettings();
    }
    else load();
  }

  // ═══ Start ═════════════════════════════════════════════════════════════════
  // One 1 s timer does everything that runs off the Stats page: the
  // watch-time tick (a cheap check of one element on scene pages, nothing
  // elsewhere), a once-a-minute flush, and noticing the Stats page. O Stats
  // ran two page-wide observers and two intervals on every page.

  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    trackTick();
    if (ticks % 30 === 0) { try { localStorage.setItem(ALIVE, String(Date.now())); } catch (_) {} }
    if (ticks % 60 === 0) flushWatch();
    if (onStats()) mount(); else hideTip();
  }, 1000);

  // React redraws the Stats page after data loads; put the dashboard back
  // at once rather than up to a second later. Only observes on that page,
  // and mounts as soon as it notices the page, not on the next 1 s tick.
  let obs = null;
  setInterval(() => {
    if (onStats() && !obs) {
      obs = new MutationObserver(() => { if (!app.root || !app.root.isConnected) mount(); });
      obs.observe(document.body, { childList: true, subtree: true });
      mount();
    } else if (!onStats() && obs) { obs.disconnect(); obs = null; }
  }, 500);

  try { localStorage.setItem(ALIVE, String(Date.now())); } catch (_) {}
  setTimeout(flushWatch, 5000);      // anything a closed tab left behind
  window.addEventListener("pagehide", () => { try { localStorage.setItem(ALIVE, "0"); } catch (_) {} });
  mount();
})();
