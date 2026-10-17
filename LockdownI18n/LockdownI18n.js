/**
 * Lockdown - Stash UI plugin
 *
 * Locks Stash to one performer, studio or tag until you get out: by an O
 * (Finish), when a timer runs out (Timer), or by watching for a while
 * without finishing (Edge). Conditions stacked on top (a skip budget, no
 * fast-forward, random scenes and more) add heat, and heat raises the score
 * on the leaderboard (2.1). Only the target's pages and the scenes, images and
 * galleries that belong to it open; anything else bounces back. Holding
 * "Give up" for five seconds ends it early, as a forfeit.
 *
 * Since 2.0 the active lock lives in Stash's plugin config, so it holds on
 * every device and browser that opens this Stash; localStorage keeps a copy
 * so a page load enforces at once. A plugin cannot truly lock anything; this
 * is a commitment game, and giving up is meant to be possible but visible.
 */
(function () {
  "use strict";
  if (window.__LockdownI18nLoaded) return;
  window.__LockdownI18nLoaded = true;

  // ==================== i18n ====================
  var PLUGIN_VERSION = '2.7.0';
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
      console.warn('[LockdownI18n] i18n bridge failed:', e);
    }
  })();
  console.log('[LockdownI18n] Lockdown I18n v' + PLUGIN_VERSION + ' loaded');

  const PLUGIN_ID = "LockdownI18n";
  const DATA_KEYS = ["history", "stats", "active", "presets"];   // in Suite Data's store when it is installed
  const STATE_KEY = "lockdownI18nState";   // this browser's copy of the active lock
  const PREF_KEY  = "lockdownI18nPrefs";   // { setup, last, guideSeen, barTipSeen }
  const HOLD_MS   = 5000;              // how long Give up must be held
  const ARM_MS    = 6000;              // "Click again to ..." stays armed this long (suite standard)
  const HISTORY_MAX = 200;
  const SYNC_LOCKED_MS = 5000;         // how often a locked page re-reads the lock
  const SYNC_IDLE_MS = 20000;          // how often an unlocked page looks for one
  const SAVE_MS = 15000;               // progress (watch time, playhead) is written at most this often
  const SEEK_SLACK = 2;                // seconds forward that are not a skip
  const INPUT_MS = 1000;               // a seek this soon after a click, key or wheel is the user's
  // Not under /plugin/: Stash's server owns that prefix (plugin files) and
  // answers 404, so a reload or a bookmark of the page broke. Unknown paths
  // get the app, and the plugin route draws it.
  const PAGE_PATH = "/lockdown-i18n";
  const TOP_MAX = 20;                  // runs kept for the leaderboard
  const DEBUG = (() => { try { return localStorage.getItem("lockdownI18nDebug") === "1"; } catch (_) { return false; } })();
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  // ═══ Pure helpers (tested) ═════════════════════════════════════════════════

  // What each kind of target is in Stash: its pages, which of their tabs a
  // lock allows, and the URL filter type that would widen its own lists.
  const KINDS = {
    performer: { path: "performers", label: "performer", plural: "performers", rule: "performers",
                 tabs: ["", "scenes", "galleries", "images"] },
    studio:    { path: "studios", label: "studio", plural: "studios", rule: "studios",
                 tabs: ["", "scenes", "galleries", "images"] },
    tag:       { path: "tags", label: "tag", plural: "tags", rule: "tags",
                 tabs: ["", "scenes", "galleries", "images"] },
  };
  const KIND_ZH = { performer: { label: "演员", plural: "演员" }, studio: { label: "工作室", plural: "工作室" }, tag: { label: "标签", plural: "标签" } };
  const kl = (k) => tc((KIND_ZH[k] || {}).label || k, (KINDS[k] || {}).label || k);
  const kp = (k, n) => tc(`${n} 个${(KIND_ZH[k] || {}).plural || k}`, plural(n, KINDS[k].label, KINDS[k].plural));

  // What the lock says about a path:
  //   { ok: true }                      allowed as it is
  //   { check: "scene"|"image"|"gallery", id }   allowed if it belongs to the target
  //   { bounce: true }                  not allowed, send them back
  // `target` is { kind, ids } (ids: the target and, for a studio or tag, the
  // ones under it), or a bare performer id. With random scenes on, the
  // target's scene list is off limits, so the Scenes tab bounces too.
  function routeCheck(pathname, target, roulette) {
    const t = target && typeof target === "object" ? target : { kind: "performer", ids: [String(target)] };
    const K = KINDS[t.kind] || KINDS.performer;
    const ids = t.groups ? [...new Set(t.groups.flat().map(String))] : (t.ids || []).map(String);
    const p = (pathname || "").replace(/\/+$/, "");
    if (p === PAGE_PATH) return { ok: true };     // the run, the leaderboard, the history: no content
    let m = new RegExp(`^/${K.path}/(\\d+)(?:/([a-z]+))?$`).exec(p);
    if (m) {
      if (!ids.includes(m[1])) return { bounce: true };
      const tab = m[2] || "";
      if (!K.tabs.includes(tab)) return { bounce: true };
      if (roulette && (tab === "" || tab === "scenes")) return { bounce: true };
      return { ok: true };
    }
    // several tags: their scenes are listed on Stash's Scenes page (each card
    // is still checked); with random scenes that list is off limits too
    if (p === "/scenes" && t.groups && t.groups.length > 1) return roulette ? { bounce: true } : { ok: true };
    if ((p === "/images" || p === "/galleries") && t.groups && t.groups.length > 1) return { ok: true };
    if ((m = /^\/scenes\/(\d+)$/.exec(p)))            return { check: "scene", id: m[1] };
    if ((m = /^\/images\/(\d+)$/.exec(p)))            return { check: "image", id: m[1] };
    if ((m = /^\/galleries\/(\d+)(?:\/.*)?$/.exec(p))) return { check: "gallery", id: m[1] };
    return { bounce: true };
  }

  // A card or list row on any page, as the item it shows: {kind, id} or
  // null. Scene, image and gallery cards are told apart by class, because a
  // scene card also links its galleries; a wall item or a queue row takes the
  // first item link it has.
  function cardItem(className, hrefs) {
    const cls = " " + (className || "") + " ";
    const order = cls.includes(" scene-card ") ? ["scenes"]
      : cls.includes(" image-card ") ? ["images"]
      : cls.includes(" gallery-card ") ? ["galleries"]
      : ["scenes", "images", "galleries"];
    const kinds = { scenes: "scene", images: "image", galleries: "gallery" };
    for (const want of order) {
      const re = new RegExp(`^(?:https?://[^/]+)?/${want}/(\\d+)(?:[/?#]|$)`);
      for (const h of hrefs || []) {
        const m = re.exec(h || "");
        if (m) return { kind: kinds[want], id: m[1] };
      }
    }
    return null;
  }

  // On the target's own tabs, Stash merges a URL rule of the target's type
  // ("performers" on a performer page, "studios" on a studio page, ...) with
  // the page's own; an "any of" rule then lists other people's scenes too.
  // Those rules come out of the URL. Returns the cleaned query string, or
  // null when there was nothing to remove.
  function stripRules(search, type) {
    let params;
    try { params = new URLSearchParams(search || ""); } catch { return null; }
    const cs = params.getAll("c");
    const keep = cs.filter((raw) => {
      let inString = false, escaped = false, json = "";
      for (const ch of raw) {
        if (escaped) { escaped = false; json += ch; continue; }
        if (ch === "\\" && inString) { escaped = true; json += ch; continue; }
        if (ch === '"') inString = !inString;
        json += (!inString && ch === "(") ? "{" : (!inString && ch === ")") ? "}" : ch;
      }
      try { return JSON.parse(json).type !== type; } catch { return true; }
    });
    if (keep.length === cs.length) return null;
    // Rebuild by hand from the raw parts: URLSearchParams would re-encode the
    // criteria differently from how Stash writes them.
    const parts = (search || "").replace(/^\?/, "").split("&").filter((part) => {
      if (!part.startsWith("c=")) return true;
      let raw;
      try { raw = decodeURIComponent(part.slice(2).replace(/\+/g, " ")); } catch { return true; }
      return keep.includes(raw);
    });
    return parts.length ? "?" + parts.join("&") : "";
  }
  const stripPerformerRules = (search) => stripRules(search, "performers");

  // Gender and circumcision are saved as display labels ("Transgender
  // Female", "Uncut"); GraphQL wants the enum. Stash maps label to enum and
  // falls back to a case-insensitive match; the enums are the labels in upper
  // snake case, so that is the rule.
  function enumOf(label) {
    return String(label || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  }

  const ids = (list) => (list || []).map((x) => (x && typeof x === "object" ? String(x.id) : String(x)));

  // A saved filter's object_filter (performers, studios or tags), as the
  // GraphQL filter input, the way Stash's criteria do it (toCriterionInput).
  // `fieldTypes` maps each filter field to its input type name, read from the
  // schema, so the shape follows the Stash version rather than a list in this
  // file. Throws on a field it cannot translate: a spin that silently dropped
  // part of a filter would pick from the wrong ones.
  function toGraphQLFilter(objectFilter, fieldTypes) {
    const out = {};
    for (const [field, saved] of Object.entries(objectFilter || {})) {
      const type = fieldTypes[field];
      if (!type) throw new Error(`unknown filter field "${field}"`);
      const s = saved && typeof saved === "object" ? saved : { value: saved };
      const mod = s.modifier;
      const v = s.value;
      const num = (x) => (x && typeof x === "object" ? x : { value: x, value2: s.value2 });
      switch (type) {
        case "IntCriterionInput":
        case "FloatCriterionInput": {
          const n = num(v);
          out[field] = { modifier: mod, value: n.value ?? 0, value2: n.value2 };
          break;
        }
        case "DateCriterionInput":
        case "TimestampCriterionInput": {
          const n = num(v);
          out[field] = { modifier: mod, value: n.value ?? "", value2: n.value2 };
          break;
        }
        case "StringCriterionInput":
          out[field] = { modifier: mod, value: v ?? "" };
          break;
        case "MultiCriterionInput":
        case "HierarchicalMultiCriterionInput": {
          const items = Array.isArray(v) ? v : (v && v.items) || [];
          const o = { modifier: mod, value: ids(items), excludes: ids(v && v.excluded) };
          if (type === "HierarchicalMultiCriterionInput") o.depth = mod === "EQUALS" ? 0 : ((v && v.depth) || 0);
          out[field] = o;
          break;
        }
        case "GenderCriterionInput":
          out[field] = { modifier: mod, value_list: (Array.isArray(v) ? v : v ? [v] : []).map(enumOf) };
          break;
        case "CircumcisionCriterionInput":
          out[field] = { modifier: mod, value: (Array.isArray(v) ? v : v ? [v] : []).map(enumOf) };
          break;
        case "StashIDCriterionInput":
          out[field] = { modifier: mod, endpoint: v && v.endpoint, stash_id: v && (v.stashID ?? v.stash_id) };
          break;
        case "Boolean":
          out[field] = v === true || v === "true";
          break;
        case "String":
          out[field] = v ?? "";
          break;
        case "CustomFieldCriterionInput":     // saved as the list itself
          out[field] = Array.isArray(saved) ? saved : v;
          break;
        default:
          throw new Error(`filter field "${field}" (${type}) is not supported`);
      }
    }
    return out;
  }

  // Delays for a spin of `steps` names: fast, then slowing into the pick.
  function spinSchedule(steps) {
    const out = [];
    for (let i = 0; i < steps; i++) {
      const t = i / Math.max(1, steps - 1);
      out.push(Math.round(55 + 420 * t * t * t));
    }
    return out;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h) return tc(`${h}时 ${m}分`, `${h}h ${m}m`);
    if (m) return tc(`${m}分 ${String(r).padStart(2, "0")}秒`, `${m}m ${String(r).padStart(2, "0")}s`);
    return tc(`${r}秒`, `${r}s`);
  }

  // A countdown or a watch clock: "4:05", "48:12", "1:02:03".
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  }

  // A length the setup is counted in: "45 min", "1 h", "1 h 30 min", "1 day".
  function fmtMinutes(min) {
    const n = Math.max(0, Math.round(min));
    if (n && n % 1440 === 0) return n === 1440 ? tc("1 天", "1 day") : tc(`${n / 1440} 天`, `${n / 1440} days`);
    const h = Math.floor(n / 60), m = n % 60;
    if (!h) return tc(`${m} 分`, `${m} min`);
    return m ? tc(`${h} 时 ${m} 分`, `${h} h ${m} min`) : tc(`${h} 时`, `${h} h`);
  }

  // ── Setup: how a lockdown is played ──────────────────────────────────────
  // 2.1, the user on difficulty presets plus fine-tune plus modifiers: three
  // layers for one idea. Now a roguelike's "heat" (Hades' Pact of
  // Punishment): no difficulty levels, every rule is a condition you opt
  // into, some with ranks, each rank adds heat, and heat scales the score.
  // A run with no conditions is heat 0. Conditions tied to a way out (Slow
  // burn: Finish, Harsh slips: Edge) count only for it.
  // `text` is what the rule does, shown under its name; `ranks` what each
  // rank sets it to.
  const conditions = () => ([
    { k: "skip", name: tc("跳过配额", "Skip budget"), heat: [1, 2, 4], ranks: [tc("每场景可跳过 3 次", "3 skips per scene"), tc("每场景可跳过 1 次", "1 skip per scene"), tc("不能跳过", "No skips")],
      text: tc("跳到一个你没看过的片段会用掉一次跳过；回到已看过的地方则始终免费。", "Jumping to a part of a scene you haven't watched uses a skip. Going back to what you've watched is always free.") },
    // 2.5.1 (user): heat 1, and Next scene allowed; with a Skip budget it
    // costs a skip, so the budget below it decides how free that is
    { k: "roulette", name: tc("轮盘", "Roulette"), heat: [1], ranks: [tc("随机场景", "Random scenes")],
      text: tc("场景不由你选：每个都是随机挑的，放完后下一个也一样。点「下一个场景」会再随机挑一个；有跳过配额时会用掉一次跳过。", "You don't choose scenes: each one is picked at random, and so is the next when it ends. Next scene picks another one; with a Skip budget it uses a skip.") },
    { k: "stay", name: tc("坚持到底", "Stay to the end"), heat: [2], ranks: [tc("每个场景都看完", "Finish every scene")],
      text: tc("一旦某个场景开始播放，在它放完之前不会打开别的场景。", "Once a scene plays, no other scene opens until it has played to the end.") },
    { k: "speed", name: tc("禁止快进", "No fast-forward"), heat: [0.5], ranks: [tc("1 倍速", "1x speed")],
      text: tc("播放速度固定在 1 倍速。", "Playback speed is held at 1x.") },
    { k: "blind", name: tc("盲拖进度条", "Blind seeking"), heat: [1], ranks: [tc("无预览", "No previews")],
      text: tc("时间轴、进度条和场景卡片上都不显示缩略图：你看不到跳转会落在哪里。", "No thumbnails on the timeline, the scrubber or scene cards: you don't see where a jump lands.") },
    // 2.2 (user feedback): no heat; fresh scenes are, if anything, easier
    { k: "fresh", name: tc("仅未看过", "Unwatched only"), heat: [0], noHeat: true, ranks: [tc("从未播放过的场景", "Never-played scenes")],
      text: tc("只打开你从未播放过的场景。", "Only scenes you've never played open.") },
    // 2.3 (forum): watched time, not time locked (a break ran it down), and
    // an O before it starts the wait over (that part was not done yet)
    { k: "slow", name: tc("慢热", "Slow burn"), goal: "finish", heat: [1, 2, 3], ranks: [tc("看满 10 分钟后 O 才计数", "O's count after 10 min watched"), tc("看满 20 分钟后", "after 20 min watched"), tc("看满 30 分钟后", "after 30 min watched")],
      text: tc("只有看满这么长时间后 O 才开始计数。在那之前的 O 不算数，并把等待重新计时。", "O's only count once you've watched this long. An O before that doesn't count and starts the wait over.") },
    // 2.2: a share of the target instead of fixed minutes (user feedback: "at
    // least reset the goal to the original time if I came")
    { k: "harsh", name: tc("严苛失误", "Harsh slips"), goal: "edge", heat: [1, 2], ranks: [tc("每次 O 加一半", "Each O adds half"), tc("一次 O 就重新计时", "An O starts it over")],
      text: tc("一次 O 的代价高于通常的三分之一：要么一半，要么整段目标重新来过。", "An O costs more than the usual third of the target: half of it, or the whole target again.") },
    // 2.2 (user feedback): Timer had no condition of its own, so its runs
    // could not reach the heat of Finish and Edge.
    { k: "one", name: tc("单一场景", "One scene"), goal: "timer", heat: [2], ranks: [tc("循环重播", "On repeat")],
      text: tc("整盘只有一个场景，每次放完都从头再来。你第一个播放的场景就是它（配合轮盘时则是随机一个）。", "The whole run is one scene, played again from the start each time it ends. The first scene you play is the one (with Roulette, a random one).") },
  ]);
  const HEAT_STEP = 0.2;               // each point of heat: +20% score
  const SLOW_MIN = [0, 10, 20, 30];
  const HARSH_MIN = [10, 20, 30];      // 2.1's minutes, for its runs
  // What an O costs in Edge (2.2): a share of the target, or starting over.
  const SLIP = ["third", "half", "reset"];
  const SKIPS_AT = [null, 3, 1, 0];
  // 2.0's difficulty names, for its runs in the history.
  const DIFF_LABEL = { easy: "Easy", normal: "Normal", hard: "Hard", hardcore: "Hardcore", custom: "Custom", classic: "Classic" };
  const DIFF_LABEL_ZH = { easy: "简单", normal: "普通", hard: "困难", hardcore: "硬核", custom: "自定义", classic: "经典" };
  // Times: any whole minute typed in, 1 min to a day; the buttons step by 15
  // (user, 2.2: "keep the - / + to 15 minutes steps and the typed any custom
  // amount").
  const MIN_MIN = 1, MAX_MIN = 1440, STEP_MIN = 15;
  function stepMinutes(v, d) {
    const n = d > 0 ? Math.floor(v / STEP_MIN) * STEP_MIN + STEP_MIN : Math.ceil(v / STEP_MIN) * STEP_MIN - STEP_MIN;
    return Math.min(MAX_MIN, Math.max(STEP_MIN, n));
  }
  // "90", "90m", "90 min", "1h30", "1 h 30 min", "1:30", "1.5h" -> minutes, or
  // null for anything else.
  function parseMinutes(text) {
    const t = String(text || "").trim().toLowerCase().replace(/\s+/g, "").replace(/,/g, ".");
    let m, v = null;
    if ((m = /^(\d+(?:\.\d+)?)$/.exec(t))) v = Number(m[1]);
    else if ((m = /^(\d+):(\d{1,2})$/.exec(t))) v = Number(m[1]) * 60 + Number(m[2]);
    else if ((m = /^(\d+(?:\.\d+)?)(?:h|hr|hrs|hour|hours)(?:(\d+(?:\.\d+)?)(?:m|min|mins|minute|minutes)?)?$/.exec(t))) v = Number(m[1]) * 60 + Number(m[2] || 0);
    else if ((m = /^(\d+(?:\.\d+)?)(?:m|min|mins|minute|minutes)$/.exec(t))) v = Number(m[1]);
    return v !== null && isFinite(v) && v > 0 ? Math.round(v) : null;
  }
  // 2.3 (forum): targets with images and no scenes can be locked to, for the
  // ways out that need no watching: Finish (an O on their images) and Timer
  // by locked time. Edge and Timer by watched time need scenes.
  const imagesOk = (setup) => !!setup && (setup.goal === "finish" || (setup.goal === "timer" && setup.timerBy === "locked"));
  const playable = (list) => (list || []).filter((x) => x && (x.scene_count > 0 || x.image_count > 0));
  const imageOnly = (x) => !!x && !(x.scene_count > 0) && x.image_count > 0;
  // Timer counts watched time by default (the user, 2.1).
  const DEFAULT_SETUP = { kind: "performer", pick: "choose", goal: "finish", os: 1, timerMin: 60, timerBy: "watched",
                          edgeMin: 30, conds: {} };

  const clamp = (v, lo, hi, dflt) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
  const condApplies = (c, goal) => !c.goal || c.goal === goal;

  // 2.0's rules (a saved setup or a history entry) as conditions.
  function condsFromRules(r, goal) {
    const x = r || {};
    const k = x.skips;
    const min = (x.minMs || 0) / 60000, add = goal && goal.addMs ? goal.addMs / 60000 : 10;
    return {
      skip: k === null || k === undefined ? 0 : k <= 0 ? 3 : k <= 1 ? 2 : 1,
      roulette: x.random ? 1 : 0, stay: x.stay ? 1 : 0, speed: x.speed ? 1 : 0, blind: x.blind ? 1 : 0, fresh: x.fresh ? 1 : 0,
      slow: min >= 30 ? 3 : min >= 20 ? 2 : min >= 10 ? 1 : 0,
      harsh: add >= 30 ? 2 : add >= 20 ? 1 : 0,
    };
  }

  // A stored or edited setup, made whole and kept in range. A 2.0 setup
  // (skips, speed, random... instead of conditions) is converted.
  function normaliseSetup(s) {
    const x = { ...DEFAULT_SETUP, ...(s && typeof s === "object" ? s : {}) };
    const d = DEFAULT_SETUP;
    const legacy = s && typeof s === "object" && !s.conds && ("skips" in s || "speed" in s || "random" in s);
    const raw = legacy ? condsFromRules({ skips: s.skips, speed: s.speed, random: s.random, fresh: s.fresh, stay: s.stay,
                                          blind: s.blind, minMs: (s.minMin || 0) * 60000 },
                                        { addMs: (s.edgeAddMin || 10) * 60000 })
                       : (x.conds && typeof x.conds === "object" ? x.conds : {});
    const conds = {};
    for (const c of conditions()) {
      const v = clamp(raw[c.k], 0, c.ranks.length, 0);
      if (v) conds[c.k] = v;
    }
    return {
      kind: KINDS[x.kind] ? x.kind : d.kind,
      pick: x.pick === "random" ? "random" : "choose",
      goal: ["finish", "timer", "edge"].includes(x.goal) ? x.goal : d.goal,
      os: clamp(x.os, 1, 5, d.os),
      timerMin: clamp(x.timerMin, MIN_MIN, MAX_MIN, d.timerMin),
      timerBy: x.timerBy === "locked" ? "locked" : "watched",
      edgeMin: clamp(x.edgeMin, MIN_MIN, MAX_MIN, d.edgeMin),
      tagMode: x.tagMode === "or" ? "or" : "and",
      conds,
    };
  }

  function heatOf(conds, goal) {
    const g = goal && goal.type ? goal.type : goal;
    const one = !!(conds && conds.one) && g === "timer";
    return conditions().reduce((h, c) => (condApplies(c, g) && conds && conds[c.k] && !(one && c.k === "stay")
      ? h + c.heat[conds[c.k] - 1] : h), 0);
  }
  const heatMult = (heat) => Math.round((1 + (heat || 0) * HEAT_STEP) * 100) / 100;

  function goalOf(setup) {
    // A Timer counts watched time (the default) or locked time.
    if (setup.goal === "timer") return setup.timerBy === "locked"
      ? { type: "timer", ms: setup.timerMin * 60000 } : { type: "timer", ms: setup.timerMin * 60000, by: "watched" };
    if (setup.goal === "edge") return { type: "edge", watchMs: setup.edgeMin * 60000, slip: SLIP[(setup.conds && setup.conds.harsh) || 0] };
    return { type: "finish", os: setup.os };
  }

  // What the enforcement reads; the minimum time only means something when
  // an O is the way out.
  function rulesOf(setup) {
    const c = setup.conds || {};
    return { skips: SKIPS_AT[c.skip || 0], speed: !!c.speed, random: !!c.roulette, fresh: !!c.fresh,
             minMs: setup.goal === "finish" ? SLOW_MIN[c.slow || 0] * 60000 : 0,
             stay: !!c.stay, blind: !!c.blind, one: setup.goal === "timer" && !!c.one };
  }

  // A history entry's setup, to play it again. Entries from 2.0 have rules
  // instead of conditions; from before 2.0 none: one O, maybe roulette.
  function setupFromEntry(e) {
    const g = (e && e.goal) || { type: "finish", os: 1 };
    const r = (e && e.rules) || { skips: null, speed: false, random: !!(e && e.roulette), fresh: false, minMs: 0 };
    return normaliseSetup({
      kind: (e && e.kind) || "performer", pick: "choose",
      goal: g.type, os: g.os, timerMin: g.ms ? Math.round(g.ms / 60000) : undefined,
      timerBy: g.type === "timer" ? (g.by === "watched" ? "watched" : "locked") : undefined,
      edgeMin: g.watchMs ? Math.round(g.watchMs / 60000) : undefined,
      conds: (e && e.conds) || condsFromRules(r, g),
    });
  }

  const UNIT_ZH = { "O": "次O", "O's": "次O", skip: "次跳过", skips: "次跳过", scene: "个场景", scenes: "个场景", image: "张图片", images: "张图片", moment: "个瞬间", moments: "个瞬间", play: "次播放", plays: "次播放" };
  const plural = (n, one, many) => tc(`${n} ${UNIT_ZH[one] || one}`, `${n} ${n === 1 ? one : many}`);

  // "Finish · 2 O's", "Timer · 1 h watched", "Edge · 30 min".
  function goalLabel(g) {
    if (!g || g.type === "finish") return tc(`完成 · ${plural((g && g.os) || 1, "O", "O's")}`, `Finish · ${plural((g && g.os) || 1, "O", "O's")}`);
    if (g.type === "timer") return tc(`计时 · ${fmtMinutes(g.ms / 60000)}${g.by === "watched" ? "（观看）" : ""}`, `Timer · ${fmtMinutes(g.ms / 60000)}${g.by === "watched" ? " watched" : ""}`);
    return tc(`边缘 · ${fmtMinutes(g.watchMs / 60000)}`, `Edge · ${fmtMinutes(g.watchMs / 60000)}`);
  }

  // The rules in force, as short labels (run card, live run, briefing).
  function rulesLabels(rules, goal) {
    const r = rules || {};
    const out = [];
    if (r.skips !== null && r.skips !== undefined) out.push(tc(r.skips === 0 ? "不能跳过" : `每场景 ${plural(r.skips, "skip", "skips")}`, r.skips === 0 ? "no skips" : `${plural(r.skips, "skip", "skips")} per scene`));
    if (r.random) out.push(tc("随机场景", "random scenes"));
    if (r.stay) out.push(tc("坚持到底", "stay to the end"));
    if (r.speed) out.push(tc("1 倍速", "1x speed"));
    if (r.blind) out.push(tc("盲拖进度条", "blind seeking"));
    if (r.fresh) out.push(tc("仅未看过", "unwatched only"));
    if ((goal || {}).type === "finish" && r.minMs) out.push(tc(`看满 ${fmtMinutes(r.minMs / 60000)} 后 O 才计数`, `O's count after ${fmtMinutes(r.minMs / 60000)} watched`));
    if (r.one) out.push(tc("单一场景循环", "one scene on repeat"));
    if ((goal || {}).type === "edge" && goal.slip && goal.slip !== "third") out.push(tc(goal.slip === "reset" ? "一次 O 就重新计时" : "每次 O 加一半", goal.slip === "reset" ? "an O starts it over" : "each O adds half"));
    if ((goal || {}).type === "edge" && !goal.slip && goal.addMs && goal.addMs !== 600000) out.push(tc(`每次 O 加 ${fmtMinutes(goal.addMs / 60000)}`, `each O adds ${fmtMinutes(goal.addMs / 60000)}`));
    return out;
  }

  // What an O costs in Edge, in words. 2.1 runs carry fixed minutes (addMs).
  function slipText(g) {
    if (!g || !g.slip) return tc(`每次 O 加 ${fmtMinutes(((g && g.addMs) || 600000) / 60000)}`, `each O adds ${fmtMinutes(((g && g.addMs) || 600000) / 60000)}`);
    if (g.slip === "reset") return tc("一次 O 就重新计时", "an O starts it over");
    const add = g.slip === "half" ? g.watchMs / 2 : g.watchMs / 3;
    return tc(`每次 O 加${g.slip === "half" ? "一半" : "三分之一"}（${fmtMinutes(Math.round(add / 60000))}）`, `each O adds ${g.slip === "half" ? "half" : "a third"} (${fmtMinutes(Math.round(add / 60000))})`);
  }

  // The one-sentence deal before Start. `who` is the target's name, or a
  // "random ..." description.
  function briefing(setup, who) {
    const goal = goalOf(setup);
    const g = setup.goal === "finish" ? tc(`直到你射 ${setup.os === 1 ? "一次" : `${setup.os} 次`}`, `until you finish ${setup.os === 1 ? "once" : `${setup.os} times`}`)
      : setup.goal === "timer" ? (setup.timerBy === "locked" ? tc(`持续 ${fmtMinutes(setup.timerMin)}`, `for ${fmtMinutes(setup.timerMin)}`) : tc(`直到你看满 ${fmtMinutes(setup.timerMin)}`, `until you've watched ${fmtMinutes(setup.timerMin)}`))
      : tc(`直到你看满 ${fmtMinutes(setup.edgeMin)} 而不射，${slipText(goal)}`, `until you've watched ${fmtMinutes(setup.edgeMin)} without finishing, ${slipText(goal)}`);
    const rules = rulesLabels(rulesOf(setup), goal);
    return { deal: tc(`只限 ${who}，${g}。`, `Only ${who}, ${g}.`), rules: rules.length ? rules.join(" · ") : tc("无附加条件", "no conditions") };
  }

  // ── Score ────────────────────────────────────────────────────────────────
  // Watch time carries a run (the user: "a higher priority for scoring");
  // skips cost, getting out pays, heat multiplies. Edge counts watch time
  // only up to its target and each O there costs 100: otherwise slipping,
  // which adds watch time, would raise the score in the one mode where it
  // is the failure. Only runs got out of score, and only from 2.1 on (v 3).
  // 2.5.1 (user: a finished Finish run with 82 skips scored 0): a skip
  // costs 5, not 15, and skips take away at most half of what watching
  // earned, so skimming scores less but a run got out of never scores 0.
  // 2.6: Edge overtime (`overtimeMs`, watched after Keep going) earns the
  // same 10 a minute, up to the target's length again; the target part and
  // the skip cap are as before, so a run without it scores as it did.
  const SKIP_COST = 5;
  function scoreOf(e) {
    if (!e || e.result !== "done" || !(e.v >= 3)) return null;
    const g = e.goal || {};
    const wMs = g.type === "edge" && g.watchMs ? Math.min(e.watchedMs || 0, g.watchMs) : (e.watchedMs || 0);
    const watched = Math.round((wMs / 60000) * 10);
    const skips = -Math.min(SKIP_COST * (e.skipsUsed || 0), Math.floor(watched / 2));
    const slips = g.type === "edge" ? -100 * (e.slips || 0) : 0;
    const overtime = g.type === "edge" && e.overtimeMs > 0 ? Math.round((Math.min(e.overtimeMs, g.watchMs || 0) / 60000) * 10) : 0;
    const out = 100;
    const heat = typeof e.heat === "number" ? e.heat : heatOf(e.conds || condsFromRules(e.rules, g), g);
    const mult = heatMult(heat);
    return { watched, skips, slips, overtime, out, heat, mult, total: Math.max(0, Math.round((watched + skips + slips + overtime + out) * mult)) };
  }

  // ── The active lock ───────────────────────────────────────────────────────

  // `target`: { kind, id, name, image_path }; `idsUnder`: the target and,
  // for a studio or tag, everything under it.
  // Several tags (2.2): `target.tags` [{id, name}], `groups` each tag with
  // what is under it, `target.mode` "and" | "or". `ids` stays what a 2.1
  // device understands: with AND only the first tag's (stricter than
  // nothing), with OR all of them.
  function newLock(target, idsUnder, setup, how, baseO, now, id, groups) {
    const rules = rulesOf(setup);
    const L = {
      v: 2, id: id || now.toString(36) + Math.random().toString(36).slice(2, 7),
      kind: target.kind, tid: String(target.id), ids: (idsUnder && idsUnder.length ? idsUnder : [target.id]).map(String),
      name: target.name || "?", image: target.image_path || "", how, startedAt: now,
      goal: goalOf(setup), rules, conds: { ...setup.conds }, heat: heatOf(setup.conds, setup.goal), roulette: rules.random,
      baseO: 0, os: 0, early: 0, slips: 0, slipMs: 0, watchedMs: 0, scenes: {},
      // 2.3: Slow burn counts watched time from `slowFrom` (moved on by an
      // early O); a lock without `slowBy` (2.2) keeps counting time locked
      slowBy: "watched", slowFrom: 0,
    };
    // 2.3: a target with images and no scenes is an image run: O's on its
    // images count, there is nothing to watch, and no conditions apply
    if (target.media === "images") L.media = "images";
    // baseO: the O rows at the start (2.2), or a plain sum
    if (Array.isArray(baseO)) {
      L.oBase = {};
      for (const r of baseO) { L.oBase[String(r.id)] = r.o || 0; L.baseO += r.o || 0; }
    } else L.baseO = baseO || 0;
    if (rules.one) L.one = { id: null, loops: 0 };
    if (target.kind === "tag" && target.tags && target.tags.length > 1 && groups && groups.length === target.tags.length) {
      L.tags = target.tags.map((t) => ({ id: String(t.id), name: t.name }));
      L.mode = target.mode === "or" ? "or" : "and";
      L.groups = groups.map((g) => g.map(String));
      L.ids = L.mode === "or" ? [...new Set(L.groups.flat())] : L.groups[0];
      L.name = tagsName(L.tags, L.mode);
    }
    return L;
  }
  const tagsName = (tags, mode) => tags.map((t) => t.name).join(mode === "or" ? tc(" 或 ", " or ") : " + ");
  // The ids a route may open: every chosen tag's page.
  const routeIds = (L) => (L.groups ? [...new Set(L.groups.flat())] : (L.ids || []).map(String));

  // A stored lock, brought up to date. A 1.x lock (this browser only, one
  // performer, one O) keeps going as a 2.0 lock with the old rules.
  function migrateLock(s) {
    if (!s || typeof s !== "object") return null;
    if (s.v >= 2 && s.tid && s.kind) return { scenes: {}, os: 0, early: 0, slips: 0, watchedMs: 0, ...s };
    if (!s.pid) return null;
    return {
      v: 2, id: `v1-${s.startedAt || 0}`, kind: "performer", tid: String(s.pid), ids: [String(s.pid)],
      name: s.name || "?", image: s.image || "", how: s.how || "chosen", startedAt: s.startedAt || Date.now(),
      goal: { type: "finish", os: 1 },
      rules: { skips: null, speed: false, random: !!s.roulette, fresh: false, minMs: 0 },
      difficulty: "classic", roulette: !!s.roulette,
      baseO: s.baseO || 0, os: 0, early: 0, slips: 0, watchedMs: 0, scenes: {},
    };
  }

  // A new O sum for the target's scenes. In Finish an O counts toward the
  // way out, unless it came before the minimum time ("early"); in Edge it is
  // a slip that adds watch time; in Timer it is only remembered. A sum that
  // falls (an O taken back) lowers the baseline and nothing else.
  // Returns { lock, end } with end "done" when the last O needed came in.
  //
  // 2.2 (review): `x` is the target's scenes with an O, [{id, o}], against
  // `oBase` ({id: o} at the last look). A scene new to that list counts only
  // if it was opened in this run; one that joined the target mid-run (a tag
  // or performer added, Identify, a merge) starts at its count instead of
  // ending a Finish at once. A plain sum is a lock from before 2.2.
  function applyO(lock, x, now) {
    const L = { ...lock };
    let d;
    if (Array.isArray(x) && L.oBase) {
      const nb = {};
      let sum = 0;
      d = 0;
      for (const r of x) {
        const id = String(r.id), c = r.o || 0, b = L.oBase[id];
        if (b !== undefined) { if (c > b) d += c - b; }
        // an image run has no record of what was opened: an image with its
        // first O counts (an image tagged in mid-run with O's on it would too)
        else if ((L.scenes && L.scenes[id]) || L.media === "images") d += c;
        nb[id] = c;
        sum += c;
      }
      L.oBase = nb;
      L.baseO = sum;
    } else {
      const sum = Array.isArray(x) ? x.reduce((a, r) => a + (r.o || 0), 0) : x;
      if (typeof sum !== "number" || !isFinite(sum)) return { lock: L, end: null };
      d = sum - (L.baseO || 0);
      L.baseO = sum;
    }
    if (d <= 0) return { lock: L, end: null };
    const g = L.goal || { type: "finish", os: 1 };
    // 2.6: past the target (waiting, or in overtime) an O is the natural
    // finish: the run ends got out, nothing banked is lost, no slip
    if (g.type === "edge" && L.over) return { lock: L, end: "done" };
    if (g.type === "edge") {
      L.slips = (L.slips || 0) + d;
      // 2.2: each slip adds a share of the target, or sets what is left back
      // to all of it (two at once: the second finds it already full)
      if (g.slip) {
        for (let i = 0; i < d; i++) {
          const progress = Math.max(0, (L.watchedMs || 0) - (L.slipMs || 0));
          L.slipMs = (L.slipMs || 0) + (g.slip === "reset" ? progress : g.slip === "half" ? g.watchMs / 2 : g.watchMs / 3);
        }
      }
      return { lock: L, end: null };
    }
    if (g.type === "timer") { L.os = (L.os || 0) + d; return { lock: L, end: null }; }
    const minMs = (L.rules && L.rules.minMs) || 0;
    if (L.slowBy === "watched") {
      if (minMs && (L.watchedMs || 0) - (L.slowFrom || 0) < minMs) {
        L.early = (L.early || 0) + d;
        L.slowFrom = L.watchedMs || 0;
        return { lock: L, end: null };
      }
    } else if (now - L.startedAt < minMs) { L.early = (L.early || 0) + d; return { lock: L, end: null }; }
    L.os = (L.os || 0) + d;
    return { lock: L, end: L.os >= (g.os || 1) ? "done" : null };
  }

  // Edge: the watch time still owed grows by the penalty with every slip.
  function edgeNeedMs(lock) {
    const g = lock.goal || {};
    if (g.slip) return (g.watchMs || 0) + (lock.slipMs || 0);
    return (g.watchMs || 0) + (lock.slips || 0) * (g.addMs || 0);
  }

  // Timer and Edge end on time; Finish only on an O (applyO).
  function goalReached(lock, now) {
    const g = lock && lock.goal;
    if (!g) return false;
    if (g.type === "timer") return g.by === "watched" ? (lock.watchedMs || 0) >= g.ms : now >= lock.startedAt + g.ms;
    if (g.type === "edge") return (lock.watchedMs || 0) >= edgeNeedMs(lock);
    return false;
  }

  // ── Watched parts of a scene ──────────────────────────────────────────────
  // A scene's record is { ranges, skips }: the stretches actually played,
  // as [start, end] seconds, merged, and the skips used. (Builds before the
  // timeline kept only `far`, the furthest point; that reads as [0, far].)

  const roundT = (t) => Math.round(t * 10) / 10;

  // The ranges with [s, e] added, merged where they touch or nearly do.
  function addRange(ranges, s, e) {
    if (!(e > s)) return (ranges || []).slice();
    const all = (ranges || []).concat([[roundT(s), roundT(e)]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [a, b] of all) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  function rangesOf(rec) {
    if (rec && Array.isArray(rec.ranges)) return rec.ranges;
    return rec && rec.far > 0 ? [[0, rec.far]] : [];
  }

  // Whether `t` is in a watched part (a little past its end too: the player
  // reports the position a beat behind), or at the very start: starting a
  // scene over is never a skip.
  function watchedAt(ranges, t) {
    if (t <= SEEK_SLACK) return true;
    return (ranges || []).some(([s, e]) => t >= s - 1 && t <= e + SEEK_SLACK);
  }

  // Where a seek that just misses a watched part lands instead: the nearest
  // edge of a part within `tol` seconds (the caller makes that a few pixels
  // of the timeline), or null. Small parts are hard to hit with a mouse;
  // landing next to one should not cost a skip.
  function snapTarget(ranges, to, tol) {
    if (watchedAt(ranges, to)) return null;
    let best = null, gap = Infinity;
    for (const [s, e] of [[0, 0]].concat(ranges || [])) {
      const d = to < s ? s - to : to - e;
      if (d >= 0 && d <= tol && d < gap) { gap = d; best = to < s ? s : e; }
    }
    return best;
  }

  // What a seek to `to` (seconds) does under a skip budget (null: any).
  // Into a watched part (or the start): free. Anywhere else, ahead or in a
  // stretch jumped over earlier: a skip. Out of skips: refused, and the
  // player stays where it was. A drag along the timeline is judged once, at
  // its end (the caller), so passing over unwatched parts on the way costs
  // nothing. Returns { allow, skip, rec, left }.
  // 2.6: a moment found on the scene (a marker, see addMoment) adds one to
  // its budget (`bonus`), "No skips" included.
  function seekDecision(rec, to, budget) {
    const r = { skips: 0, ...(rec || {}), ranges: rangesOf(rec) };
    delete r.far;
    delete r.lastSkipAt;
    if (budget === null || budget === undefined) return { allow: true, skip: false, rec: r };
    const b = budget + (r.bonus || 0);
    if (watchedAt(r.ranges, to)) return { allow: true, skip: false, rec: r, left: b - r.skips };
    if (r.skips < b) return { allow: true, skip: true, rec: { ...r, skips: r.skips + 1 }, left: b - r.skips - 1 };
    return { allow: false, skip: false, rec: r, left: 0 };
  }

  // Roulette's Next scene (2.5.1) under a skip budget (null: any): free
  // without one, one skip of the current scene's budget with one, refused
  // when that scene has none left. Returns { allow, skip, rec, left }.
  function nextSceneDecision(rec, budget) {
    const r = { skips: 0, ...(rec || {}) };
    if (budget === null || budget === undefined) return { allow: true, skip: false, rec: r };
    const b = budget + (r.bonus || 0);
    if (r.skips < b) return { allow: true, skip: true, rec: { ...r, skips: r.skips + 1 }, left: b - r.skips - 1 };
    return { allow: false, skip: false, rec: r, left: 0 };
  }
  // Skips left on a scene under a budget (null: no budget), its moment's
  // extra skip counted (2.6).
  const skipsLeft = (rec, budget) => (budget === null || budget === undefined ? null
    : Math.max(0, budget + ((rec && rec.bonus) || 0) - ((rec && rec.skips) || 0)));

  const skipsUsed = (lock) => Object.values((lock && lock.scenes) || {}).reduce((a, s) => a + ((s && s.skips) || 0), 0);

  // ── 2.6: moments ─────────────────────────────────────────────────────────
  // A marker added to a scene of the run means the player found a moment
  // worth keeping (the user's game design). It is a reward, so it is hard to
  // farm: only a marker made during the run (one the scene did not have when
  // the run first looked at it), on a scene with 2 minutes of it watched in
  // this run (its watched parts), one per scene, five per run. It gives that
  // scene one more skip (`bonus`; under Roulette also one more Next scene).
  // Whatever made the marker counts (QuickTools' M, Stash's own editor):
  // the page polls the open scene's markers (no key listeners of its own).
  // `marks` in a scene's record are the marker ids already seen there; the
  // first look takes them all as known. Each marker is judged once.
  const MOMENT_WATCH_S = 120;
  const MOMENTS_MAX = 5;
  // A marker stamped (server clock) clearly before the start never counts;
  // a minute of slack for a client clock ahead of the server's. The known
  // ids are the real guard, this only backs them up.
  const MARK_SKEW_MS = 60000;
  const watchedSec = (ranges) => (ranges || []).reduce((a, r) => a + Math.max(0, (r[1] || 0) - (r[0] || 0)), 0);
  const markTitle = (m) => String((m && (m.title || (m.primary_tag && m.primary_tag.name))) || "").trim();

  // One marker newly seen on scene `sid`: { lock, result }, result
  //   "counted"  a moment: listed, and the scene's budget +1
  //   "early"    under 2 minutes of the scene watched in this run
  //   "one"      the scene already has its moment
  //   "cap"      the run has its five
  //   "before"   made before the run started
  //   "known"    seen before (nothing changes)
  //   "scene"    not a scene of this run (nothing changes)
  // Every marker judged is remembered in `marks`, so it is never judged again.
  function addMoment(lock, sid, m, now) {
    const id = String(sid), mid = String(m && m.id);
    const rec = lock && lock.scenes && lock.scenes[id];
    if (!rec) return { lock, result: "scene" };
    const list = Array.isArray(lock.moments) ? lock.moments : [];
    const known = Array.isArray(rec.marks) ? rec.marks : [];
    if (known.includes(mid) || list.some((x) => x.marker === mid)) return { lock, result: "known" };
    const L = { ...lock, scenes: { ...lock.scenes, [id]: { ...rec, marks: known.concat(mid) } } };
    const made = Date.parse((m && m.created_at) || "");
    let result = "counted";
    if (isFinite(made) && made < (lock.startedAt || 0) - MARK_SKEW_MS) result = "before";
    else if (watchedSec(rangesOf(rec)) < MOMENT_WATCH_S) result = "early";
    else if (list.some((x) => x.scene === id)) result = "one";
    else if (list.length >= MOMENTS_MAX) result = "cap";
    if (result === "counted") {
      L.moments = list.concat({ scene: id, marker: mid, title: markTitle(m), seconds: roundT(Number(m.seconds) || 0), at: now });
      L.scenes[id] = { ...L.scenes[id], bonus: 1 };
    }
    return { lock: L, result };
  }

  // The open scene's markers, as just read: the first look takes them all
  // as known; after that each new one is judged. { lock, results: [{ marker,
  // result }] }; the same lock object back when nothing changed.
  function markersSeen(lock, sid, markers, now) {
    const id = String(sid);
    const rec = lock && lock.scenes && lock.scenes[id];
    if (!rec) return { lock, results: [] };
    const all = (markers || []).filter((m) => m && m.id !== undefined && m.id !== null);
    if (!Array.isArray(rec.marks)) {
      return { lock: { ...lock, scenes: { ...lock.scenes, [id]: { ...rec, marks: all.map((m) => String(m.id)) } } }, results: [] };
    }
    let L = lock;
    const results = [];
    for (const m of all) {
      const r = addMoment(L, id, m, now);
      if (r.result === "known") continue;
      L = r.lock;
      results.push({ marker: String(m.id), result: r.result });
    }
    return { lock: L, results };
  }

  // Two lists of moments as one (devices, mergeLock): by marker id, the
  // earliest first, one per scene, five in all.
  function mergeMoments(a, b) {
    const seen = new Set(), scenes = new Set(), out = [];
    for (const x of (a || []).concat(b || []).filter(Boolean).sort((p, q) => (p.at || 0) - (q.at || 0))) {
      const k = String(x.marker);
      if (seen.has(k) || scenes.has(String(x.scene)) || out.length >= MOMENTS_MAX) continue;
      seen.add(k); scenes.add(String(x.scene)); out.push(x);
    }
    return out;
  }

  // At the end, the moments whose markers still exist. `found`: Map scene id
  // -> its markers as read now (an empty list for a scene that is gone); a
  // scene not in it (not read) keeps its moments. A marker renamed or moved
  // keeps its new title and time. The extra skip it gave stays given.
  function keepMoments(moments, found) {
    return (moments || []).flatMap((x) => {
      if (!found || !found.has(String(x.scene))) return [x];
      const m = (found.get(String(x.scene)) || []).find((y) => String(y.id) === String(x.marker));
      return m ? [{ ...x, title: markTitle(m) || x.title, seconds: roundT(Number(m.seconds) || 0) }] : [];
    });
  }

  // A run's moments as links: the scene at the marker's time.
  function momentLinks(e) {
    return ((e && e.moments) || []).map((m) => ({
      href: `/scenes/${encodeURIComponent(m.scene)}?t=${Math.max(0, Math.floor(Number(m.seconds) || 0))}`,
      label: `${m.title || "Marker"} ${fmtClock((Number(m.seconds) || 0) * 1000)}`,
    }));
  }

  // ── 2.6: Edge overtime ───────────────────────────────────────────────────
  // Reaching an Edge target gets the player out with the score banked; the
  // run then waits ("reached") for Keep going or Finish, and never ends on
  // its own there. Keep going is overtime ("over"): watching earns 10 a
  // minute again, times heat, up to the target's length once more; an O ends
  // it (the natural finish, not a slip), and so do Stop, Give up and a full
  // overtime, always as got out. `lock.over` = { at: reached, on: Keep going
  // pressed (0 until then), w0: the watch time then }.
  const edgeState = (L) => (L && L.over && L.goal && L.goal.type === "edge" ? (L.over.on ? "over" : "reached") : null);
  const overtimeCap = (L) => ((L && L.goal && L.goal.watchMs) || 0);
  function overtimeMs(L) {
    if (edgeState(L) !== "over") return 0;
    return Math.min(overtimeCap(L), Math.max(0, (L.watchedMs || 0) - (L.over.w0 || 0)));
  }
  const overtimeFull = (L) => edgeState(L) === "over" && overtimeMs(L) >= overtimeCap(L);
  const overtimePts = (ms) => Math.round(((ms || 0) / 60000) * 10);
  const reachEdge = (L, now) => (L.over ? L : { ...L, over: { at: now, on: 0, w0: 0 } });
  const startOvertime = (L, now) => (edgeState(L) === "reached" ? { ...L, over: { ...L.over, on: now, w0: L.watchedMs || 0 } } : L);
  // How a run that is out ends: never given up (Give up there, or on a
  // device that had not seen the target reached yet, banks the score).
  const endResult = (L, result) => (result === "gaveup" && L && L.over ? "done" : result);

  // The same lock as two devices saw it: whatever only grows takes the
  // larger, per scene too (watched parts are joined). The writer's baseline
  // wins (it just read the sum).
  function mergeLock(remote, local) {
    if (!remote || !local || remote.id !== local.id) return local || remote || null;
    const out = { ...remote, ...local };
    // the O baseline goes with the counts it produced: the copy that counted
    // more O's has seen them (review, 2.2: a stale local baseline next to the
    // other device's count made one O count twice)
    const seen = (x) => (x.os || 0) + (x.early || 0) + (x.slips || 0);
    if (seen(remote) > seen(local)) { out.baseO = remote.baseO; if (remote.oBase) out.oBase = remote.oBase; }
    for (const k of ["os", "early", "slips", "slipMs", "watchedMs", "slowFrom"]) out[k] = Math.max(remote[k] || 0, local[k] || 0);
    // One scene: the copy that knows which scene it is, and the most loops
    if (remote.one || local.one) {
      const a = remote.one || {}, b = local.one || {};
      out.one = { id: b.id || a.id || null, loops: Math.max(a.loops || 0, b.loops || 0) };
    }
    const scenes = { ...(remote.scenes || {}) };
    for (const [id, r] of Object.entries(local.scenes || {})) {
      const o = scenes[id] || {};
      // One scene: each loop starts its timeline over; the later loop's copy
      // wins whole, or the ranges of the last loop would come back
      if ((r.loop || 0) !== (o.loop || 0)) { scenes[id] = (r.loop || 0) > (o.loop || 0) ? r : o; continue; }
      let ranges = rangesOf(o);
      for (const [s, e] of rangesOf(r)) ranges = addRange(ranges, s, e);
      const m = { ...o, ...r, ranges, skips: Math.max(o.skips || 0, r.skips || 0) };
      delete m.far;
      // 2.6: the markers either copy has seen, and a moment's extra skip
      if (Array.isArray(o.marks) || Array.isArray(r.marks)) m.marks = [...new Set([...(o.marks || []), ...(r.marks || [])].map(String))];
      if (o.bonus || r.bonus) m.bonus = Math.max(o.bonus || 0, r.bonus || 0);
      scenes[id] = m;
    }
    out.scenes = scenes;
    if (remote.current && local.current && remote.current.id === local.current.id) {
      out.current = { ...local.current, done: !!(remote.current.done || local.current.done) };
    }
    // 2.6: moments grow like the rest (by marker id); a target reached on
    // either device is reached, at the earlier time, and overtime started on
    // either is on, from the earlier start
    if ((remote.moments && remote.moments.length) || (local.moments && local.moments.length)) out.moments = mergeMoments(remote.moments, local.moments);
    if (remote.over || local.over) {
      const a = remote.over || {}, b = local.over || {};
      const ats = [a.at, b.at].filter((x) => x > 0);
      const first = a.on && b.on ? (a.on <= b.on ? a : b) : a.on ? a : b.on ? b : null;
      out.over = { at: ats.length ? Math.min(...ats) : 0, on: first ? first.on : 0, w0: first ? first.w0 || 0 : 0 };
    }
    return out;
  }

  // Whether an item belongs to the lock: `data` is the scene, image or
  // gallery's { id, performers, studio, tags, play_count }. With "unwatched
  // only", a scene played before the lock does not; one first opened during
  // it does (Stash counts the play while it runs), which `scenes` remembers.
  function itemMatches(kind, data, lock) {
    if (!data || !lock) return false;
    const want = (lock.ids && lock.ids.length ? lock.ids : [lock.tid]).map(String);
    // several tags: one of each (AND), or one of any (OR), sub-tags counting
    const groupsOk = (tags) => {
      const has = (g) => tags.some((t) => g.includes(String(t.id)));
      return lock.mode === "or" ? lock.groups.some(has) : lock.groups.every(has);
    };
    const own = (d) => (lock.kind === "studio" ? !!(d && d.studio) && want.includes(String(d.studio.id))
      : lock.kind === "tag" ? (lock.groups && lock.groups.length > 1 ? groupsOk((d && d.tags) || [])
                                                                     : ((d && d.tags) || []).some((t) => want.includes(String(t.id))))
      : ((d && d.performers) || []).some((p) => want.includes(String(p.id))));
    // An image counts through its gallery too: a studio's gallery often has
    // the studio on the gallery only, not on each image (user report).
    let ok = own(data) || (kind === "image" && (data.galleries || []).some(own));
    if (ok && kind === "scene" && lock.rules && lock.rules.fresh && (data.play_count || 0) > 0 &&
        !(lock.scenes || {})[String(data.id)]) ok = false;
    return ok;
  }

  // Everything under a studio: `pairs` is every studio as [id, parentId].
  function descendantsOf(rootId, pairs) {
    const kids = new Map();
    for (const [id, parent] of pairs || []) {
      if (parent === null || parent === undefined) continue;
      const k = String(parent);
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(String(id));
    }
    const out = [String(rootId)], seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const c of kids.get(out[i]) || []) if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  }

  // ── History ──────────────────────────────────────────────────────────────

  // Lifetime totals, kept apart from the history list and updated with each
  // lockdown. The list is capped (HISTORY_MAX) to keep the config small;
  // totals counted from it would quietly shrink once it filled (1.0 did
  // that). `perf` counts lockdowns per target for "most locked"; `wins`
  // counts the ones got out of, per difficulty; `longestEdgeMs` is the
  // longest Edge got through. Keys this version does not know ride through.
  const EMPTY_STATS = { v: 3, done: 0, gaveUp: 0, totalMs: 0, streak: 0, bestStreak: 0, perf: {}, wins: {}, longestEdgeMs: 0, top: [], bestHeat: 0 };

  // The leaderboard: the best scored runs, kept with the totals (the history
  // list is capped at HISTORY_MAX; a best run must outlive that).
  const slimRun = (e) => ({ id: e.id, name: e.name, image: e.image || "", kind: e.kind, goal: e.goal, rules: e.rules,
                             difficulty: e.difficulty, heat: e.heat, conds: e.conds, watchedMs: e.watchedMs || 0, skipsUsed: e.skipsUsed || 0,
                             slips: e.slips || 0, ms: e.ms, at: e.at, score: e.score,
                             // 2.6: kept, or rescoring a board-only run would drop its overtime
                             ...(e.overtimeMs > 0 ? { overtimeMs: e.overtimeMs } : {}) });
  function addTop(top, e) {
    if (!e || e.result !== "done" || !(e.score > 0)) return (top || []).slice();
    // 20 of each way out: Finish runs filling the list emptied the Edge and
    // Timer filters (review, 2.2)
    const per = {};
    return (top || []).filter((x) => x.id !== e.id).concat(slimRun(e))
      .sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0))
      .filter((x) => { const g = goalType(x); per[g] = (per[g] || 0) + 1; return per[g] <= TOP_MAX; });
  }
  const topFrom = (list) => (list || []).reduce(addTop, []);
  // Best first, 20 of each way out (addTop's order and limit, for a board
  // whose scores changed).
  function limitTop(top) {
    const per = {};
    return (top || []).slice().sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0))
      .filter((x) => x.score > 0).filter((x) => { const g = goalType(x); per[g] = (per[g] || 0) + 1; return per[g] <= TOP_MAX; });
  }
  // Scores again with the current rule (2.5.1 changed the skip cost): the
  // history's runs, and the board's (a board run no longer in the history is
  // scored from what the board kept; an Edge one from before 2.5.1 has no
  // slips kept and keeps its score). Runs now above 0 join the board.
  // Nothing is written here: the next save stores it (unpack -> packConfig).
  function rescore(list, top) {
    let changed = false;
    const L = (list || []).map((e) => {
      const sc = scoreOf(e);
      if (sc && sc.total !== e.score) { changed = true; return { ...e, score: sc.total }; }
      return e;
    });
    const byId = new Map(L.filter((e) => e && e.id).map((e) => [String(e.id), e]));
    let T = (top || []).map((x) => {
      const e = byId.get(String(x.id));
      const canFromBoard = !e && (goalType(x) !== "edge" || "slips" in x);
      const sc = e ? scoreOf(e) : canFromBoard ? scoreOf({ ...x, result: "done", v: 3 }) : null;
      if (sc && sc.total !== x.score) { changed = true; return { ...x, score: sc.total }; }
      return x;
    });
    for (const e of L) {
      if (e && e.result === "done" && e.score > 0 && !T.some((x) => String(x.id) === String(e.id))) { T = T.concat(slimRun(e)); changed = true; }
    }
    return { list: L, top: changed ? limitTop(T) : T, changed };
  }

  const isEntry = (e) => !!e && (e.result === "done" || e.result === "gaveup") && typeof e.ms === "number";
  // Performers keep the bare id (1.x entries have only that); studios and
  // tags get a prefix, so the same number never mixes two kinds.
  const perfKey = (e) => (e.kind && e.kind !== "performer" ? `${e.kind.charAt(0)}:${e.tags && e.tags.length > 1 ? e.tags.map((t) => t.id).join(e.mode === "or" ? "|" : "+") : e.tid}`
                          : e.pid || e.tid ? String(e.pid || e.tid) : `name:${e.name || "?"}`);
  const goalType = (e) => (e && e.goal && e.goal.type) || "finish";
  const edgeWin = (e) => (e.result === "done" && goalType(e) === "edge" ? e.watchedMs || 0 : 0);

  // Which entry a row is: its id from 1.3 on, a fingerprint before that.
  function entryKey(e) {
    return e && e.id ? String(e.id) : `${e && e.pid}|${e && e.at}|${e && e.ms}|${e && e.result}`;
  }

  function addToStats(stats, e) {
    const st = { ...EMPTY_STATS, ...(stats || {}) };
    st.perf = { ...(st.perf || {}) };
    st.wins = { ...(st.wins || {}) };
    if (!isEntry(e)) return st;
    st.top = addTop(st.top, e);
    st.totalMs += e.ms;
    if (e.result === "done") {
      st.done += 1;
      st.streak += 1;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
      if (e.difficulty && tc(DIFF_LABEL_ZH[e.difficulty], DIFF_LABEL[e.difficulty])) st.wins[e.difficulty] = (st.wins[e.difficulty] || 0) + 1;
      st.longestEdgeMs = Math.max(st.longestEdgeMs || 0, edgeWin(e));
      if (typeof e.heat === "number") st.bestHeat = Math.max(st.bestHeat || 0, e.heat);
    } else {
      st.gaveUp += 1;
      st.streak = 0;
    }
    const k = perfKey(e);
    st.perf[k] = { name: e.name || (st.perf[k] && st.perf[k].name) || "?", n: ((st.perf[k] && st.perf[k].n) || 0) + 1 };
    return st;
  }

  // For a history from before totals (or one of their parts) were kept:
  // count what the list has.
  function statsFromHistory(list) {
    return (list || []).reduce(addToStats, { ...EMPTY_STATS, perf: {}, wins: {} });
  }

  // Stored totals missing a part a later version added get it from the list.
  function completeStats(stats, list) {
    let st = stats;
    if (!st.perf) st = { ...st, perf: statsFromHistory(list).perf };
    if (!st.wins) { const f = statsFromHistory(list); st = { ...st, wins: f.wins, longestEdgeMs: f.longestEdgeMs }; }
    if (!Array.isArray(st.top)) st = { ...st, top: topFrom(list) };
    if (typeof st.bestHeat !== "number") st = { ...st, bestHeat: statsFromHistory(list).bestHeat || 0 };
    return st;
  }

  // Current and best run of completions, from a list in time order.
  function streaksOf(list) {
    let run = 0, best = 0;
    for (const e of list || []) {
      if (!isEntry(e)) continue;
      if (e.result === "done") { run += 1; best = Math.max(best, run); } else run = 0;
    }
    return { streak: run, best };
  }

  // Totals after removing one entry. `rest` is the list without it. When the
  // list still holds every lockdown counted, streaks (and the longest edge)
  // are recounted exactly; past the 200-entry cap the oldest are gone, so
  // those can only be kept or raised, never recounted (documented limit).
  function removeFromStats(stats, e, rest) {
    const st = { ...EMPTY_STATS, ...(stats || {}) };
    st.perf = { ...(st.perf || {}) };
    st.wins = { ...(st.wins || {}) };
    if (!isEntry(e)) return st;
    const complete = st.done + st.gaveUp === (rest || []).filter(isEntry).length + 1;
    st.totalMs = Math.max(0, st.totalMs - e.ms);
    if (e.result === "done") {
      st.done = Math.max(0, st.done - 1);
      if (e.difficulty && st.wins[e.difficulty]) {
        const n = st.wins[e.difficulty] - 1;
        if (n > 0) st.wins[e.difficulty] = n; else delete st.wins[e.difficulty];
      }
    } else st.gaveUp = Math.max(0, st.gaveUp - 1);
    const k = perfKey(e);
    if (st.perf[k]) {
      const n = (st.perf[k].n || 0) - 1;
      if (n > 0) st.perf[k] = { ...st.perf[k], n }; else delete st.perf[k];
    }
    const s = streaksOf(rest);
    st.streak = s.streak;
    st.bestStreak = complete ? s.best : Math.max(s.best, st.bestStreak);
    if (complete) st.longestEdgeMs = (rest || []).filter(isEntry).reduce((a, x) => Math.max(a, edgeWin(x)), 0);
    // past the cap a removed best run cannot be replaced from the list, only dropped
    st.top = complete ? topFrom(rest) : (st.top || []).filter((x) => x.id !== e.id);
    if (complete) st.bestHeat = (rest || []).filter((x) => isEntry(x) && x.result === "done" && typeof x.heat === "number")
      .reduce((a, x) => Math.max(a, x.heat), 0);
    return st;
  }

  // The target locked most often, or null. Ties go to the name first in
  // the alphabet so the tile does not flicker between equals.
  function mostLocked(stats) {
    let best = null;
    for (const v of Object.values((stats && stats.perf) || {})) {
      if (!v || !v.n) continue;
      if (!best || v.n > best.n || (v.n === best.n && String(v.name) < String(best.name))) best = v;
    }
    return best;
  }

  // Newest first, by calendar month: [{ key, label, done, gaveUp, items }].
  function groupByMonth(entries) {
    const groups = [];
    const byKey = new Map();
    const sorted = (entries || []).filter(isEntry).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    for (const e of sorted) {
      const d = new Date(typeof e.at === "number" ? e.at : 0);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), done: 0, gaveUp: 0, items: [] };
        byKey.set(key, g);
        groups.push(g);
      }
      g.items.push(e);
      if (e.result === "done") g.done += 1; else g.gaveUp += 1;
    }
    return groups;
  }

  // The full view's filters: "all", a result ("done" | "gaveup") or a way
  // out ("finish" | "timer" | "edge"), and a name.
  function filterEntries(entries, filter, q) {
    const term = String(q || "").trim().toLowerCase();
    const f = filter || "all";
    return (entries || []).filter((e) => isEntry(e) &&
      (f === "all" || e.result === f || goalType(e) === f) &&
      (!term || String(e.name || "").toLowerCase().includes(term)));
  }

  // The leaderboard's rows: the best runs, by way out ("all" | goal type).
  function boardRows(top, goal) {
    return (top || []).filter((x) => x && x.score > 0 && (!goal || goal === "all" || goalType(x) === goal))
      .sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0));
  }

  // The small print under an entry's name: what happened along the way.
  function entryDetail(e) {
    if (!e || !e.goal) return tc("本次更新之前", "before this update");
    const out = [];
    const g = e.goal.type;
    if (g === "edge" && e.slips) {
      const gl = e.goal, share = gl.slip === "half" ? 1 / 2 : gl.slip === "third" ? 1 / 3 : 0;
      const add = e.slipMs !== undefined ? e.slipMs : gl.slip ? e.slips * share * (gl.watchMs || 0) : e.slips * (gl.addMs || 0);
      out.push(tc(gl.slip === "reset" ? `${plural(e.slips, "slip", "slips")}，重新计时` : `${plural(e.slips, "slip", "slips")}，+${fmtMinutes(Math.round(add / 60000))}`, gl.slip === "reset" ? `${plural(e.slips, "slip", "slips")}, started over` : `${plural(e.slips, "slip", "slips")}, +${fmtMinutes(Math.round(add / 60000))}`));
    }
    if (e.loops) out.push(tc(`${plural(e.loops + 1, "play", "plays")}同一个场景`, `${plural(e.loops + 1, "play", "plays")} of one scene`));
    if (g === "timer" && e.os) out.push(tc(`过程中 ${plural(e.os, "O", "O's")}`, `${plural(e.os, "O", "O's")} along the way`));
    if (g === "edge" && e.overtimeMs > 0) out.push(overtimeText(e));
    if (e.early) out.push(tc(`${plural(e.early, "O", "O's")} 为时过早`, `${plural(e.early, "O", "O's")} too early`));
    if (e.skipsUsed) out.push(tc(`用掉 ${plural(e.skipsUsed, "skip", "skips")}`, `${plural(e.skipsUsed, "skip", "skips")} used`));
    if (e.rules && e.rules.fresh) out.push(tc("仅未看过", "unwatched only"));
    return out.join(" · ");
  }

  // A history entry for a lock that just ended.
  function entryFromLock(L, result, now) {
    const e = { id: L.id, v: 3, kind: L.kind, tid: L.tid, name: L.name, image: L.image || "", how: L.how,
                result, ms: Math.max(0, now - L.startedAt), at: L.startedAt, goal: L.goal, rules: L.rules,
                difficulty: L.difficulty, heat: L.heat, conds: L.conds, os: L.os || 0, early: L.early || 0, slips: L.slips || 0,
                watchedMs: Math.round(L.watchedMs || 0), skipsUsed: skipsUsed(L) };
    if (L.kind === "performer") e.pid = L.tid;
    if (L.tags) { e.tags = L.tags; e.mode = L.mode; }
    if (L.media) e.media = L.media;
    if (L.slipMs) e.slipMs = Math.round(L.slipMs);
    if (L.one && L.one.loops) e.loops = L.one.loops;
    // 2.6: where the target was reached, the overtime watched, the moments
    if (L.over && L.over.at) e.reachedAt = L.over.at;
    if (edgeState(L) === "over") e.overtimeMs = Math.round(overtimeMs(L));
    if (L.moments && L.moments.length) e.moments = L.moments.map((m) => ({ scene: String(m.scene), marker: String(m.marker), title: m.title || "", seconds: m.seconds || 0 }));
    const sc = scoreOf(e);
    if (sc) e.score = sc.total;
    return e;
  }
  // "overtime 12:30 (+125)": the points before heat, as the breakdown shows them.
  const overtimeText = (e) => tc(`加时 ${fmtClock(e.overtimeMs || 0)} (+${overtimePts(Math.min(e.overtimeMs || 0, (e.goal && e.goal.watchMs) || 0))})`, `overtime ${fmtClock(e.overtimeMs || 0)} (+${overtimePts(Math.min(e.overtimeMs || 0, (e.goal && e.goal.watchMs) || 0))})`);

  // undefined: none stored yet (build from history); null: stored but
  // unreadable (leave alone); otherwise the totals.
  function parseStats(raw) {
    if (raw === undefined || raw === null || raw === "") return undefined;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (_) { return null; }
  }

  // When a run started, to the minute (2.3, forum: "start timestamps down
  // to the minute ... to verify your lock with a dom/domme or accountability
  // partner"): "today 21:47", "yesterday 08:05", "Mon 21:47", "12 Oct 21:47",
  // with the year once it is not this year's.
  function fmtWhen(at, now) {
    const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(now) - day(at)) / 86400000);
    const d = new Date(at);
    const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (days <= 0) return tc(`今天 ${hm}`, `today ${hm}`);
    if (days === 1) return tc(`昨天 ${hm}`, `yesterday ${hm}`);
    if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
    const y = d.getFullYear() !== new Date(now).getFullYear();
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}) })} ${hm}`;
  }
  // The full stamp, for the tooltip: date, year, time.
  const fmtStamp = (at) => new Date(at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });

  // Presets (2.3): [{ id, name, at, setup, target, src }], newest first, a
  // name used again replaces the old one. null when the stored list cannot
  // be read (it is then never overwritten, rule 5).
  const PRESETS_MAX = 30;
  function parsePresets(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return null;
      return v.filter((x) => x && typeof x === "object" && typeof x.name === "string" && x.setup && typeof x.setup === "object");
    } catch (_) { return null; }
  }
  function presetOf(name, setup, target, src, now) {
    const t = target ? { kind: target.kind, id: String(target.id), name: target.name, image_path: target.image_path || "",
                         scene_count: target.scene_count, image_count: target.image_count,
                         ...(target.tags ? { tags: target.tags.map((x) => ({ id: String(x.id), name: x.name })), mode: target.mode } : {}) } : null;
    return { id: `p${now.toString(36)}`, name: String(name).trim().slice(0, 40), at: now, setup: normaliseSetup(setup),
             target: t, src: !t && src ? { type: src.type, ...(src.type === "filter" ? { id: String(src.id), name: src.name } : {}) } : null };
  }
  function addPreset(list, x) {
    const k = x.name.toLowerCase();
    return [x].concat((list || []).filter((y) => String(y.name || "").toLowerCase() !== k)).slice(0, PRESETS_MAX);
  }
  // One line about a preset, for its tooltip.
  function presetLine(x) {
    const S = normaliseSetup(x.setup);
    const who = x.target ? x.target.name : x.src ? (x.src.type === "fav" ? tc(`来自收藏的随机${kl(S.kind)}`, `a random favourite ${kl(S.kind)}`) : tc(`从“${x.src.name}”中随机一个${kl(S.kind)}`, `a random ${kl(S.kind)} from “${x.src.name}”`)) : "?";
    const h = heatOf(S.conds, S.goal);
    return `${who} · ${goalLabel(goalOf(S))}${h ? ` · ${tc("热度", "heat")} ${h}` : ""}`;
  }

  // The stored history, or null when it cannot be trusted (never overwrite
  // a list that failed to parse).
  function parseHistory(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch (_) { return null; }
  }

  // The stored active lock, or null for none (or one that cannot be read).
  function parseActive(raw) {
    if (!raw) return null;
    try { return migrateLock(JSON.parse(raw)); } catch (_) { return null; }
  }

  // This plugin's map, read: history, totals, the active lock and presets.
  // `bad` / `presetsBad`: stored values that do not parse (never overwritten).
  function unpack(mine) {
    const raw = parseHistory(mine.history);
    let stats = parseStats(mine.stats);
    const bad = raw === null || stats === null;
    const list = raw || [];
    if (!stats) stats = statsFromHistory(list);
    const pr = parsePresets(mine.presets);
    const full = completeStats(stats, list);
    const r = bad ? { list, top: full.top, changed: false } : rescore(list, full.top);
    return { list: r.list, stats: r.changed ? { ...full, top: r.top } : full, active: parseActive(mine.active), bad, presets: pr || [], presetsBad: pr === null, rescored: r.changed };
  }

  // The whole new map for a change `next` ({ list?, stats?, active?,
  // presets? }; active null clears it), every other key riding through, or
  // null when there is nothing to change. A history, totals or presets that
  // did not parse are never replaced (rule 5): the change throws instead,
  // except one that only clears the active lock, so an unreadable history
  // can never leave every device locked.
  function packConfig(mine, cur, next) {
    if (!next || (!("list" in next) && !("stats" in next) && !("active" in next) && !("presets" in next))) return null;
    if ((next.list || next.stats) && cur.bad) throw new Error(tc("已保存的历史无法读取，保持原样", "saved history could not be read; left as it was"));
    if (next.presets && cur.presetsBad) throw new Error(tc("已保存的预设无法读取，保持原样", "saved presets could not be read; left as they were"));
    const input = { ...mine };
    if (next.list) input.history = JSON.stringify(next.list.slice(-HISTORY_MAX));
    if (next.stats) input.stats = JSON.stringify(next.stats);
    if ("active" in next) input.active = next.active ? JSON.stringify(next.active) : "";
    if (next.presets) input.presets = JSON.stringify(next.presets.slice(0, PRESETS_MAX));
    return input;
  }

  // ── The suite's toast: kinds, how long each stays, where it is mounted ────
  // `kind` true was 2.3's "good" (blue), false or nothing its plain warning.
  const TOAST_MS = { info: 3000, done: 3000, warn: 4000, error: 8000 };
  function toastKind(kind) {
    if (kind === true) return "info";
    return typeof kind === "string" && TOAST_MS[kind] ? kind : "warn";
  }
  // A fixed body child is not painted over a fullscreen element, so floating
  // things go into it; a bare <video> cannot hold children (some browsers'
  // native fullscreen), so that case stays in the body.
  function toastHost(doc) {
    const fs = doc.fullscreenElement;
    return fs && fs.tagName !== "VIDEO" ? fs : doc.body;
  }

  // Keys while a Lockdown dialog is open (suite keyboard rules): the dialog
  // owns the keyboard. Escape closes it (not the spin, which plays out);
  // every other unmodified key stops there, so nothing behind it acts
  // (IntifaceSync's output keys above all), except the keys that work the
  // focused control. Typing in its boxes is left to the boxes.
  // "close" | "keep" (stop it, let the control have it) | "stop" | null.
  const NAV_KEYS = new Set(["Tab", "Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
  function modalKey(ev, typing, sticky) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
    if (ev.key === "Escape") return sticky ? "stop" : "close";
    if (typing) return null;
    return NAV_KEYS.has(ev.key) ? "keep" : "stop";
  }

  if (window.__LOCKDOWN_TEST__) {
    window.__LockdownTest = { suiteData, DATA_KEYS, unpack, packConfig, toastKind, toastHost, modalKey, TOAST_MS, routeCheck, enumOf, toGraphQLFilter, spinSchedule, fmtDuration, fmtClock, fmtMinutes,
                              addToStats, statsFromHistory, completeStats, parseStats, fmtWhen, entryKey,
                              removeFromStats, mostLocked, groupByMonth, filterEntries, streaksOf,
                              parseHistory, parseActive, cardItem, stripRules, stripPerformerRules,
                              normaliseSetup, heatOf, heatMult, condsFromRules, goalOf, rulesOf, setupFromEntry, goalLabel, briefing, rulesLabels,
                              newLock, migrateLock, applyO, edgeNeedMs, goalReached, seekDecision, nextSceneDecision, skipsUsed, addRange, watchedAt, rangesOf, snapTarget,
                              mergeLock, itemMatches, descendantsOf, entryDetail, entryFromLock,
                              picturesFor, imagesOk, playable, imageOnly, parsePresets, presetOf, addPreset, tagsListUrl, keepsListFilter, listUrl,
                              scoreOf, addTop, topFrom, rescore, limitTop, SKIP_COST, boardRows, PAGE_PATH, slimRun,
                              skipsLeft, watchedSec, addMoment, markersSeen, mergeMoments, keepMoments, momentLinks, MOMENTS_MAX, MOMENT_WATCH_S,
                              edgeState, overtimeMs, overtimeCap, overtimeFull, overtimePts, reachEdge, startOvertime, endResult, overtimeText,
                              CONDITIONS: conditions(), DEFAULT_SETUP, parseMinutes, stepMinutes, slipText, sceneFilterFor, listUrl, perfKey, keepsListFilter };
    return;
  }

  // ═══ Stash ═════════════════════════════════════════════════════════════════

  async function gql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`Stash returned ${res.status}${res.status === 401 ? ": logged out?" : ""}`); }
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    return json?.data ?? null;
  }

  // Per kind: the list query, its result key, its filter argument and type,
  // the saved-filter mode, the favourites rule, and the fields to fetch.
  // Studios and tags count their scenes with everything under them
  // (depth -1): a network with no scenes of its own is still worth a lock.
  const Q = {
    performer: { find: "findPerformers", one: "findPerformer", key: "performers", arg: "performer_filter",
                 type: "PerformerFilterType", mode: "PERFORMERS", fav: { filter_favorites: true },
                 fields: "id name image_path scene_count image_count" },
    studio:    { find: "findStudios", one: "findStudio", key: "studios", arg: "studio_filter",
                 type: "StudioFilterType", mode: "STUDIOS", fav: { favorite: true },
                 fields: "id name image_path scene_count(depth: -1) image_count(depth: -1)" },
    tag:       { find: "findTags", one: "findTag", key: "tags", arg: "tag_filter",
                 type: "TagFilterType", mode: "TAGS", fav: { favorite: true },
                 fields: "id name image_path scene_count(depth: -1) image_count(depth: -1)" },
  };
  const withScenes = (list) => (list || []).filter((x) => x && x.scene_count > 0);

  async function listOf(kind, filter, find) {
    const q = Q[kind];
    const d = await gql(`query ($x: ${q.type}, $f: FindFilterType) { r: ${q.find}(${q.arg}: $x, filter: $f) {
                           ${q.key} { ${q.fields} } } }`, { x: filter, f: find });
    return d?.r?.[q.key] ?? [];
  }

  const favouritesOf = (kind, images) => listOf(kind, Q[kind].fav, { per_page: -1 }).then(images ? playable : withScenes);

  // Search box: by name, the ones with scenes or images (2.3; one with
  // images only says so, and works for Finish and Timer by locked time).
  // Filtered after the query, for every kind: studios' and tags' own counts
  // leave out what is under them, and for performers 2.3.0 put
  // `scene_count > 0 OR image_count > 0` in the query, which Stash reads as
  // (name AND scenes) OR images: every performer with images matched, A
  // first, whatever was typed (user report, 2.3.1). Never an OR here.
  async function searchTargets(kind, term) {
    return playable(await listOf(kind, undefined, { q: term, per_page: 24, sort: "name", direction: "ASC" })).slice(0, 8);
  }

  async function savedFiltersOf(kind) {
    const d = await gql(`query ($m: FilterMode!) { findSavedFilters(mode: $m) { id name find_filter { q } object_filter } }`,
                        { m: Q[kind].mode });
    return d?.findSavedFilters ?? [];
  }

  // Each filter field's input type name, read once per kind.
  const fieldTypes = {};
  async function fieldTypesOf(kind) {
    if (fieldTypes[kind]) return fieldTypes[kind];
    const d = await gql(`query ($n: String!) { __type(name: $n) {
                           inputFields { name type { kind name ofType { kind name ofType { name } } } } } }`,
                        { n: Q[kind].type });
    const out = {};
    for (const f of d?.__type?.inputFields ?? []) {
      let t = f.type;
      while (t && !t.name && t.ofType) t = t.ofType;
      out[f.name] = t?.name;
    }
    fieldTypes[kind] = out;
    return out;
  }

  // Everything a saved filter matches, with scenes. Throws when the filter
  // cannot be translated.
  async function targetsFor(kind, saved, images) {
    const filter = toGraphQLFilter(saved.object_filter, await fieldTypesOf(kind));
    const list = await listOf(kind, filter, { per_page: -1, q: saved.find_filter?.q || undefined });
    return images ? playable(list) : withScenes(list);
  }

  async function targetById(kind, id) {
    const q = Q[kind];
    const d = await gql(`query ($id: ID!) { r: ${q.one}(id: $id) { ${q.fields} } }`, { id });
    return d?.r ?? null;
  }

  // The target and everything under it: a studio's sub-studios (worked out
  // from every studio's parent, since the studio filter has no depth), a
  // tag's sub-tags (depth -1 does it).
  // Scenes with all (AND) or any (OR) of these tags, sub-tags counting.
  async function countTagScenes(tags, mode) {
    const d = await gql(`query ($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: 0 }) { count } }`,
                        { x: { tags: { value: tags.map((t) => String(t.id)), modifier: mode === "or" ? "INCLUDES" : "INCLUDES_ALL", depth: -1 } } });
    return d?.findScenes?.count ?? 0;
  }
  // 2.3: and their images, for a combination with images only
  async function countTagImages(tags, mode) {
    const d = await gql(`query ($x: ImageFilterType) { findImages(image_filter: $x, filter: { per_page: 0 }) { count } }`,
                        { x: { tags: { value: tags.map((t) => String(t.id)), modifier: mode === "or" ? "INCLUDES" : "INCLUDES_ALL", depth: -1 } } });
    return d?.findImages?.count ?? 0;
  }

  async function idsUnder(kind, id) {
    if (kind === "studio") {
      const d = await gql(`query { findStudios(filter: { per_page: -1 }) { studios { id parent_studio { id } } } }`);
      return descendantsOf(id, (d?.findStudios?.studios ?? []).map((s) => [s.id, s.parent_studio?.id]));
    }
    if (kind === "tag") {
      const d = await gql(`query ($x: TagFilterType) { findTags(tag_filter: $x, filter: { per_page: -1 }) { tags { id } } }`,
                          { x: { parents: { value: [String(id)], modifier: "INCLUDES", depth: -1 } } });
      return [String(id), ...(d?.findTags?.tags ?? []).map((t) => String(t.id)).filter((x) => x !== String(id))];
    }
    return [String(id)];
  }

  // The scenes that belong to a lock, as a scene filter.
  function sceneFilterFor(L, fresh) {
    const one = [String(L.tid)];
    const f = L.kind === "studio" ? { studios: { value: one, modifier: "INCLUDES", depth: -1 } }
      : L.kind === "tag" && L.tags && L.tags.length > 1
        ? { tags: { value: L.tags.map((t) => String(t.id)), modifier: L.mode === "or" ? "INCLUDES" : "INCLUDES_ALL", depth: -1 } }
      : L.kind === "tag" ? { tags: { value: one, modifier: "INCLUDES", depth: -1 } }
      : { performers: { value: one, modifier: "INCLUDES" } };
    if (fresh) f.play_count = { modifier: "EQUALS", value: 0 };
    return f;
  }

  // The images of an image run (2.3), as an image filter: the same rules.
  const imageFilterFor = (L) => sceneFilterFor(L, false);
  async function imageORows(L) {
    const d = await gql(`query ($x: ImageFilterType) { findImages(image_filter: $x, filter: { per_page: -1 }) {
                           images { id o_counter } } }`,
                        { x: { ...imageFilterFor(L), o_counter: { modifier: "GREATER_THAN", value: 0 } } });
    return (d?.findImages?.images ?? []).map((s) => ({ id: String(s.id), o: s.o_counter || 0 }));
  }
  async function imageCount(L) {
    const d = await gql(`query ($x: ImageFilterType) { findImages(image_filter: $x, filter: { per_page: 0 }) { count } }`,
                        { x: imageFilterFor(L) });
    return d?.findImages?.count ?? 0;
  }
  const oRows = (L) => (L.media === "images" ? imageORows(L) : sceneORows(L));

  // ── 2.5: Play pictures, with the Slideshow plugin ─────────────────────────
  // A run whose target has images gets a "Pictures" button (bar and run
  // page) that plays exactly them in Slideshow: Lockdown's own image filter
  // for the run, so the slideshow, the Images link and an image run agree
  // (several tags with AND / OR included). Without Slideshow nothing
  // changes: the button needs window.Slideshow.open.
  const slideshowApi = () => { const s = window.Slideshow; return s && typeof s.open === "function" ? s : null; };
  function picturesFor(L) {
    // imageFilterFor(L), spelled out: a const, and the test hook returns before it
    const src = { kind: L.kind, id: String(L.tid), name: L.name, filter: sceneFilterFor(L, false) };
    if (L.tags && L.tags.length > 1) { src.tags = L.tags.map((t) => ({ id: String(t.id), name: t.name })); src.mode = L.mode; }
    return src;
  }
  // The target's image count, read once per run: null while reading.
  const picCounts = new Map();
  function picsReady(L) {
    if (!L || !slideshowApi()) return false;
    if (L.media === "images") return true;
    if (!picCounts.has(L.id)) {
      picCounts.set(L.id, null);
      imageCount(L).then((n) => picCounts.set(L.id, n), () => picCounts.set(L.id, 0))
        .then(() => { if (lock && lock.id === L.id) renderBar(); });
    }
    return picCounts.get(L.id) > 0;
  }
  function playPictures() {
    const api = slideshowApi();
    if (!api || !lock) return;
    Promise.resolve(api.open(picturesFor(lock))).catch((e) => ldToast(tc(`无法播放图片：${e.message}`, `Could not play the pictures: ${e.message}`), "error"));
  }

  // Sum of O counts over every scene that belongs to the target. An O
  // anywhere on those scenes, from any page or device, raises it. Only
  // scenes with an O are fetched: a big tag has thousands of scenes.
  async function sceneORows(L) {
    const d = await gql(`query ($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: -1 }) {
                           scenes { id o_counter } } }`,
                        { x: { ...sceneFilterFor(L, false), o_counter: { modifier: "GREATER_THAN", value: 0 } } });
    return (d?.findScenes?.scenes ?? []).map((s) => ({ id: String(s.id), o: s.o_counter || 0 }));
  }
  // How many scenes a run would have to choose from.
  async function sceneCount(L) {
    const d = await gql(`query ($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: 0 }) { count } }`,
                        { x: sceneFilterFor(L, L.rules && L.rules.fresh) });
    return d?.findScenes?.count ?? 0;
  }

  async function randomScene(L, notId) {
    const seed = Math.floor(Math.random() * 1e8);
    const d = await gql(`query ($x: SceneFilterType, $f: FindFilterType) { findScenes(scene_filter: $x, filter: $f) {
                           scenes { id } } }`,
                        { x: sceneFilterFor(L, L.rules && L.rules.fresh), f: { per_page: 2, sort: `random_${seed}` } });
    const list = d?.findScenes?.scenes ?? [];
    const pick = list.find((s) => String(s.id) !== String(notId)) || list[0];
    return pick ? String(pick.id) : null;
  }

  // Which items belong to the lock, in one request: aliases of findScene /
  // findImage / findGallery, which exist under the same names across Stash
  // versions (the by-id arguments of the list queries do not).
  const ITEM_FIELDS = { scene: "id play_count performers { id } studio { id } tags { id }",
                        image: "id performers { id } studio { id } tags { id } galleries { id performers { id } studio { id } tags { id } }",
                        gallery: "id performers { id } studio { id } tags { id }" };
  async function itemsMatch(items, L) {
    const field = { scene: "findScene", image: "findImage", gallery: "findGallery" };
    const ok = items.map((it) => /^\d+$/.test(it.id) && field[it.kind]);
    const parts = items.map((it, i) => ok[i] ? `a${i}: ${field[it.kind]}(id: "${it.id}") { ${ITEM_FIELDS[it.kind]} }` : "")
      .filter(Boolean);
    if (!parts.length) return items.map(() => false);
    const d = await gql(`query { ${parts.join(" ")} }`);
    return items.map((it, i) => ok[i] && itemMatches(it.kind, d?.[`a${i}`], L));
  }

  // ── Plugin config: the history, the totals and the active lock ───────────
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

  // Read-merge-write of this plugin's own config map, one write at a time;
  // every key it does not touch rides through. A history or totals that do
  // not parse are never overwritten (rule 5); a write that does not touch
  // them still goes through. `fn({ list, stats, active })` returns what to
  // change: { list?, stats?, active? } (active null clears it); nothing,
  // and nothing is written.

  const CONFIG_Q = `query ($p: [ID!]) { configuration { plugins(include: $p) } }`;

  async function readMine() {
    const d = await gql(CONFIG_Q, { p: [PLUGIN_ID] });
    const plugins = d?.configuration?.plugins;
    if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
    return plugins[PLUGIN_ID] || {};
  }

  // The one config writer (suite convention): read this plugin's map,
  // `fn(copy)` returns the whole new map (null: nothing to write; throwing
  // stops the write), configurePlugin replaces it whole. One at a time.
  // `quiet`: progress merges every 15 s skip the refetch below, which would
  // otherwise re-render Stash's app under a playing scene that often.
  // 2.7.0: with the Suite Data plugin installed, DATA_KEYS (history, stats,
  // the active lock, presets) live in its store, where Stash's Settings page
  // cannot roll them back (MAINTENANCE §4.24); the client (SD) runs the
  // chain, re-runs fn on a newer copy when another device wrote first (so
  // mergeLock still sees every device's progress) and keeps a copy in the
  // config. Without it, the config exactly as before.
  async function writeOwnConfig(input, opt) {
    await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
              { id: PLUGIN_ID, input });
    // Stash keeps its own copy of the config (its Settings page re-saves
    // from it, the open issue in MAINTENANCE §6); keep that copy current
    if (!(opt && (opt.quiet || opt.copy))) refetch(["Configuration"]);   // not for the throttled copy either
  }
  const SD = suiteData({ id: PLUGIN_ID, keys: DATA_KEYS, gql, label: "Lockdown", readConfig: readMine, writeConfig: writeOwnConfig,
                         notify: (t) => ldToast(t, "warn") });
  function writeMine(fn, quiet, mirror) {
    let seen = null;
    const run = SD.update((mine) => { seen = mine; return fn({ ...mine }) || null; }, { quiet: !!quiet, mirror: !!mirror })
      .then((input) => input || seen);
    run.catch((e) => log(`Config not saved: ${e.message}`, "error"));
    return run;
  }

  // History, totals, the active lock and presets, through writeMine.
  // `fn({ list, stats, active, presets })` returns only what changes; see
  // packConfig for what is refused. Resolves to the unpacked result.
  // `mirror`: a run's end and history edits refresh the config's copy at once.
  function updateConfig(fn, quiet, mirror) {
    return writeMine((mine) => { const cur = unpack(mine); return packConfig(mine, cur, fn(cur) || {}); }, quiet, mirror).then(unpack);
  }

  function apolloClient() {
    try {
      const svc = window.PluginApi?.utils?.StashService;
      if (typeof svc?.getClient === "function") return svc.getClient();
    } catch (_) {}
    return null;
  }
  // QuickTools' refetch: Stash's active queries by name, so its views show
  // what was just written without a reload (MAINTENANCE §3.2).
  function refetch(queries) {
    const c = apolloClient();
    if (!c) return;
    try { c.refetchQueries({ include: queries }); } catch (e) { log(`refetch failed: ${e.message}`); }
  }

  function removeEntry(key) {
    return updateConfig(({ list, stats }) => {
      const i = list.findIndex((e) => isEntry(e) && entryKey(e) === key);
      if (i < 0) return {};
      const rest = list.slice(0, i).concat(list.slice(i + 1));
      return { list: rest, stats: removeFromStats(stats, list[i], rest) };
    }, false, true);
  }

  // A fresh start: the list and the totals. The active lock and other keys
  // are kept.
  function clearHistory() {
    return updateConfig(() => ({ list: [], stats: { ...EMPTY_STATS, perf: {}, wins: {} } }), false, true);
  }

  async function readConfig() {
    try { return unpack(await SD.read()); }
    catch (_) { return { list: [], stats: { ...EMPTY_STATS, perf: {}, wins: {} }, active: undefined, failed: true, presets: [] }; }
  }

  // ═══ State ═════════════════════════════════════════════════════════════════

  function readState() {
    try { return migrateLock(JSON.parse(localStorage.getItem(STATE_KEY) || "null")); }
    catch (_) { return null; }
  }
  // Two tabs of one browser share this copy. A tab that wrote back an older
  // copy of the same lock (a hidden tab saving on its way out) used to hand
  // skips back to the tab in use, so a copy of the same lock is merged in.
  function writeState(s) {
    try {
      if (!s) { localStorage.removeItem(STATE_KEY); return; }
      let out = s;
      const cur = migrateLock(JSON.parse(localStorage.getItem(STATE_KEY) || "null"));
      if (cur && cur.id === s.id) out = mergeLock(cur, s);
      localStorage.setItem(STATE_KEY, JSON.stringify(out));
      if (lock && lock.id === out.id && lock !== out) lock = out;
    } catch (e) { log(`${tc("无法存储锁：", "Could not store the lock:")} ${e.message}`, "error"); }
  }
  function prefs() {
    try { return { ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; }
    catch (_) { return {}; }
  }
  function setPref(k, v) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {}
  }
  // The setup the dialog opens with: the last one used, or 1.x's roulette
  // preference carried into a default setup.
  function savedSetup() {
    const p = prefs();
    if (p.setup) return normaliseSetup(p.setup);
    return normaliseSetup(p.roulette ? { random: true, skips: null, speed: false } : {});
  }

  let lock = readState();
  let confirmedId = null;   // the lock id Stash is known to hold

  // ═══ Styles ════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("lockdown-styles")) return;
    const s = document.createElement("style");
    s.id = "lockdown-styles";
    s.textContent = `
/* Flexoki dark (as Insights). Red #D14D41 is the lock, blue #4385BE an O,
   coral #E8705F a give-up, cyan #3AA99F a timer served. Difficulty runs
   green, yellow, orange, red. Only colours and shadows live here besides
   the enforcement rules, which must not change. */
.ld-nav .ld-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #D14D41;
  margin-left: 5px; vertical-align: middle; box-shadow: 0 0 6px #D14D41; }
/* The nav button stays Stash's own; only the lock picks up the accent. */
.ld-nav a svg { color: #D14D41; width: 1em; height: 1em; }
/* Stash spaces its own Font Awesome nav icons from the label; ours is a plain
   svg, so it needs the gap itself, but only where icon and label share a line */
@media (min-width: 1200px) { .ld-nav .nav-menu-icon { margin-right: .4em; } }
body.ld-on .top-nav { visibility: hidden !important; }
#ld-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 1065; display: flex; align-items: center; gap: 12px;
  padding: 0 14px; background: #282726; background: linear-gradient(90deg, color-mix(in srgb, #D14D41 20%, #1C1B1A), #282726 60%);
  border-bottom: 2px solid #D14D41;
  color: #CECDC3; font-size: 14px; box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 12px 24px -10px rgba(0,0,0,.65); }
#ld-bar img, #ld-bar video { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 2px solid #D14D41; }
#ld-bar .ld-who { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
#ld-bar .ld-who b { font-size: 15px; color: #E6E4D9; }
#ld-bar .ld-who small { color: #878580; font-size: 12px; margin-left: 4px; }
#ld-bar .ld-time { font-variant-numeric: tabular-nums; color: #D0A215; font-weight: 600; min-width: 64px; }
#ld-bar .ld-goal { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; display: inline-flex;
  align-items: center; gap: 8px; }
#ld-bar .ld-goal.finish { color: #4385BE; }
#ld-bar .ld-goal.timer { color: #D0A215; }
#ld-bar .ld-goal.edge { color: #3AA99F; }
#ld-bar .ld-goal small { color: #878580; font-weight: 400; font-size: 12px; }
#ld-bar .ld-meter { width: 90px; height: 5px; border-radius: 3px; background: #403E3C; overflow: hidden; display: inline-block; }
#ld-bar .ld-meter i { display: block; height: 100%; background: #3AA99F; }
#ld-bar .ld-skips { color: #B7B5AC; font-size: 13px; white-space: nowrap; }
#ld-bar .ld-skips.ld-zero { color: #E8705F; }
#ld-bar a, #ld-bar button { background: linear-gradient(180deg, #343331, #282726); border: 1px solid #0b0a0a;
  border-top-color: #403E3C; color: #CECDC3; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.5);
  padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
/* one row, one height: the theme's and Stash's own link and button rules
   made them tall and wrapped "Random scene" (user screenshot, 2.2) */
#ld-bar .ld-links a, #ld-bar .ld-links button, #ld-bar .ld-giveup { display: inline-flex; align-items: center; justify-content: center;
  height: 30px; min-height: 0; margin: 0; padding: 0 12px; line-height: 1; white-space: nowrap; box-sizing: border-box; }
#ld-bar a:hover, #ld-bar button:hover { color: #E6E4D9; border-top-color: #575653; }
#ld-bar .ld-links { display: flex; align-items: center; gap: 6px; flex: none; }
#ld-bar .ld-giveup { margin-left: auto; position: relative; overflow: hidden; border-color: #AF3029; color: #E8705F;
  user-select: none; touch-action: none; flex: none; }
#ld-bar .ld-giveup:hover { border-color: #D14D41; color: #E6E4D9; }
#ld-bar .ld-giveup .ld-fill { position: absolute; inset: 0; width: 0; background: rgba(209,77,65,.55); }
#ld-bar .ld-giveup span { position: relative; }
/* 2.5: Play pictures (Slideshow); cyan is play across the suite */
#ld-bar .ld-pics .ld-ico { width: 14px; height: 14px; color: #3AA99F; margin-right: 6px; flex: none; }
@media (max-width: 760px) {
  #ld-bar { gap: 8px; padding: 0 8px; font-size: 13px; }
  #ld-bar .ld-links .ld-more, #ld-bar .ld-time, #ld-bar .ld-meter { display: none; }
  #ld-bar img, #ld-bar video { width: 28px; height: 28px; }
  #ld-bar .ld-pics { padding: 0 9px; }
  #ld-bar .ld-pics span { display: none; }
  #ld-bar .ld-pics .ld-ico { margin-right: 0; }
}
/* 2.5: a phone (390 px) had Give up pushed past the edge (measured: right
   edge at 439 px with one O to get out and "watched 7:00"), worse with
   Pictures. Under 480 px the watched time (also on the run page) and the
   bar's Pictures (Play pictures is on the run page) go, and the buttons
   are narrower, so Give up stays on screen. */
@media (max-width: 480px) {
  #ld-bar .ld-watch, #ld-bar .ld-links .ld-pics { display: none; }
  #ld-bar .ld-links a, #ld-bar .ld-links button, #ld-bar .ld-giveup { padding: 0 8px; }
}
#ld-veil { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1064; background: #100F0F; display: none; }
/* Every card stays invisible until it is known to belong to the target, so
   a list that somehow widens never shows anything else. */
body.ld-on .scene-card:not(.ld-ok), body.ld-on .image-card:not(.ld-ok),
body.ld-on .gallery-card:not(.ld-ok), body.ld-on .wall-item:not(.ld-ok),
body.ld-on li:has(> .queue-scene-details):not(.ld-ok),
body.ld-on li:has(.queue-scene-details):not(.ld-ok) { visibility: hidden !important; }
body.ld-on .ld-no { display: none !important; }
body.ld-checking #ld-veil { display: block; }
.ld-modal-back { position: fixed; inset: 0; z-index: 1070; background: rgba(0,0,0,.65); display: flex;
  align-items: center; justify-content: center; }
.ld-modal { width: 540px; max-width: calc(100vw - 24px); max-height: calc(100vh - 32px); overflow-y: auto;
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-radius: 12px; color: #CECDC3; padding: 16px 18px;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); scrollbar-color: #403E3C transparent; }
.ld-modal h3 { margin: 0 0 4px; font-size: 19px; color: #E6E4D9; }
.ld-modal .ld-sub { color: #878580; font-size: 13px; margin-bottom: 14px; }
.ld-modal button, .ld-modal select { font: inherit; font-size: 14px; border-radius: 8px; }
.ld-modal .ld-err { color: #D0A215; font-size: 12px; min-height: 1.2em; margin-top: 6px; }
.ld-modal .ld-hist { border-top: 1px solid #403E3C; margin-top: 12px; padding-top: 12px; font-size: 12px; color: #B7B5AC; }
.ld-modal .ld-empty { color: #878580; text-align: center; padding: 6px 0; }
/* the suite's empty state: a raised card, one bold line and one muted line */
.ld-emptycard { margin: 8px 0; padding: 18px 16px; border-radius: 12px; text-align: center; color: #878580; font-size: 13px; line-height: 1.5;
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 12px 24px -10px rgba(0,0,0,.65); }
.ld-emptycard b { display: block; color: #E6E4D9; font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.ld-emptycard span { display: block; }
/* loading: what is read, over Insights' thin sliding bar */
.ld-loading { padding: 40px 0; text-align: center; color: #878580; font-size: 13px; }
.ld-lbar { width: 260px; max-width: 80%; height: 6px; margin: 14px auto 0; background: #1C1B1A; border-radius: 3px; overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,.6); }
.ld-lbar i { display: block; width: 40%; height: 100%; background: #D14D41; border-radius: 3px; animation: ldSlide 1.1s ease-in-out infinite; }
@keyframes ldSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.ld-notice { margin: 8px 0; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; color: #CECDC3;
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-left: 3px solid #D14D41; }
.ld-ico { width: 16px; height: 16px; flex: none; vertical-align: middle; }
.ld-drop path { fill: #4385BE; }
.ld-drop .ld-shine { fill: none; stroke: rgba(255,255,255,.75); stroke-width: 1.1; stroke-linecap: round; }
.ld-x path { fill: none; stroke: #E8705F; stroke-width: 2.4; stroke-linecap: round; }
.ld-clock circle, .ld-clock path { fill: none; stroke: #3AA99F; stroke-width: 1.8; stroke-linecap: round; }
.ld-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.ld-tile { background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331; border-radius: 8px; padding: 8px 6px 7px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.5);
  text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
.ld-tile .ld-ico { width: 18px; height: 18px; margin-bottom: 1px; }
.ld-tile b { font-size: 17px; color: #E6E4D9; font-variant-numeric: tabular-nums; line-height: 1.15; }
.ld-tile span { font-size: 10.5px; color: #878580; line-height: 1.25; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 100%; }
.ld-wins { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 8px; font-size: 11px; color: #878580; }
.ld-wins .ld-long { margin-left: auto; }
.ld-pill { font-size: 11px; padding: 0 7px; border-radius: 6px; border: 1px solid #403E3C; color: #B7B5AC;
  white-space: nowrap; line-height: 17px; }
.ld-d-easy { color: #879A39; border-color: color-mix(in srgb, #879A39 45%, transparent); }
.ld-d-normal { color: #D0A215; border-color: color-mix(in srgb, #D0A215 45%, transparent); }
.ld-d-hard { color: #DA702C; border-color: color-mix(in srgb, #DA702C 45%, transparent); }
.ld-d-hardcore { color: #D14D41; border-color: color-mix(in srgb, #D14D41 45%, transparent); }
.ld-d-custom { color: #8B7EC8; border-color: color-mix(in srgb, #8B7EC8 45%, transparent); }
.ld-strip { display: flex; flex-wrap: wrap; gap: 3px; margin: 10px 0 2px; }
.ld-strip .ld-ico { width: 14px; height: 14px; }
.ld-total { font-size: 11px; color: #878580; margin: 6px 0 4px; }
.ld-rows { display: flex; flex-direction: column; gap: 2px; }
.ld-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; }
.ld-row:hover { background: #343331; }
.ld-row.gaveup .ld-rname { color: #B7B5AC; }
.ld-av { flex: none; }
/* a tag's picture can be a video (Tags Toolkit plays WebM ones): same box */
.ld-av img, .ld-av video, .ld-av i { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; display: block; }
.ld-av i { background: #403E3C; color: #B7B5AC; font-style: normal; font-size: 11px; font-weight: 700;
  text-align: center; line-height: 26px; }
.ld-rmain { flex: 1; min-width: 0; }
.ld-rname { display: block; color: #CECDC3; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-rname small { color: #878580; font-size: 11px; margin-left: 4px; }
.ld-rsub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; margin-top: 2px; }
.ld-rsub em { font-style: normal; color: #878580; font-size: 11px; }
.ld-rend { text-align: right; flex: none; }
.ld-rtime { display: block; font-variant-numeric: tabular-nums; color: #B7B5AC; }
.ld-row.gaveup .ld-rtime { color: #E8705F; }
.ld-rwhen { display: block; color: #878580; font-size: 11px; }
.ld-more { margin-top: 6px; width: 100%; padding: 5px; background: none; border: 1px dashed #403E3C;
  border-radius: 6px; color: #878580; font: inherit; font-size: 12px; cursor: pointer; }
.ld-more:hover { color: #E6E4D9; border-color: #575653; }
.ld-modal .ld-close { margin-top: 12px; width: 100%; padding: 7px; background: linear-gradient(180deg, #343331, #282726);
  color: #878580; border: 1px solid #0b0a0a; border-top-color: #403E3C; box-shadow: 0 1px 2px rgba(0,0,0,.5); cursor: pointer; }
.ld-modal .ld-close:hover { color: #E6E4D9; border-top-color: #575653; }
.ld-spin { text-align: center; padding: 10px 0 4px; }
.ld-spin img, .ld-spin video { width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 3px solid #403E3C;
  background: #1C1B1A; box-shadow: 0 12px 24px -10px rgba(0,0,0,.65); }
.ld-spin .ld-name { font-size: 22px; font-weight: 700; margin-top: 12px; min-height: 1.3em; color: #E6E4D9; }
.ld-spin.ld-landed img, .ld-spin.ld-landed video { border-color: #D14D41; box-shadow: 0 0 24px rgba(209,77,65,.6); }
.ld-spin.ld-won img, .ld-spin.ld-won video { border-color: #4385BE; box-shadow: 0 0 24px rgba(67,133,190,.6); }
.ld-spin .ld-msg { color: #878580; font-size: 13px; margin-top: 6px; min-height: 1.2em; }

.ld-modal.ld-tall { max-height: calc(100vh - 32px); }
.ld-modal .ld-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.ld-modal .ld-head h3 { display: flex; align-items: center; gap: 7px; margin: 0; }
.ld-lock { width: 19px; height: 19px; }
.ld-lock rect { fill: #D14D41; }
.ld-lock path { stroke: #D14D41; stroke-width: 1.6; }
.ld-modal .ld-link { background: none; border: 0; padding: 0; color: #4385BE; font: inherit; font-size: 13px;
  cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.ld-modal .ld-head .ld-link:first-of-type { margin-left: auto; }
.ld-modal .ld-link:hover { text-decoration: underline; color: #66A0C8; }
.ld-modal .ld-danger { color: #E8705F; }
.ld-modal .ld-danger.ld-armed { color: #100F0F; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  border-radius: 6px; padding: 2px 8px; font-weight: 600; text-decoration: none; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-guide { background: #282726; background: color-mix(in srgb, #4385BE 10%, #1C1B1A);
  border: 1px solid color-mix(in srgb, #4385BE 35%, transparent); border-radius: 8px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  padding: 10px 12px; margin-bottom: 12px; font-size: 13px; color: #CECDC3; }
.ld-guide ol { margin: 6px 0 4px; padding-left: 20px; line-height: 1.6; }
.ld-guide .ld-link { display: block; margin-left: auto; }
.ld-card { background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331; border-radius: 10px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.35); padding: 11px 12px; margin-bottom: 8px; }
.ld-step { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #878580; margin-bottom: 8px; }
.ld-step i { width: 19px; height: 19px; border-radius: 50%; background: #343331; color: #CECDC3; font-style: normal;
  font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
.ld-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.ld-choices.ld-four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.ld-choice { text-align: left; padding: 8px 10px; background: linear-gradient(180deg, #343331, #282726); color: #CECDC3;
  border: 1px solid #0b0a0a; border-top-color: #403E3C; box-shadow: 0 1px 2px rgba(0,0,0,.5); cursor: pointer; min-width: 0; }
.ld-choice:hover { color: #E6E4D9; border-top-color: #575653; }
.ld-choice b { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
.ld-choice small { display: block; color: #878580; font-size: 11.5px; margin-top: 1px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.ld-choice .ld-ico { width: 16px; height: 16px; color: #878580; }
.ld-choice.ld-on { border-color: #D14D41; background: #343331; background: color-mix(in srgb, #D14D41 16%, #282726);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
.ld-choice.ld-on .ld-ico { color: #D14D41; }
.ld-seg { display: inline-flex; gap: 2px; padding: 2px; margin-top: 9px; background: #100F0F; border: 1px solid #343331;
  border-radius: 8px; }
.ld-seg button { background: none; border: 0; color: #878580; padding: 4px 12px; font-size: 13px; cursor: pointer; }
.ld-seg button.ld-on { background: #403E3C; color: #E6E4D9; }
.ld-seg.ld-mini { margin-top: 0; }
.ld-seg.ld-mini button { padding: 2px 9px; font-size: 12px; }
.ld-opts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 9px; font-size: 13px; }
.ld-opts small { color: #6F6E69; font-size: 12px; }
.ld-stepper { display: inline-flex; align-items: center; border: 1px solid #403E3C; border-radius: 7px; overflow: hidden; }
.ld-stepper button { background: #282726; border: 0; border-radius: 0; color: #B7B5AC; width: 26px; padding: 2px 0;
  font-size: 15px; cursor: pointer; }
.ld-stepper button:hover { color: #E6E4D9; background: #343331; }
.ld-stepper b { font-weight: 600; font-size: 13px; padding: 2px 10px; min-width: 64px; text-align: center;
  font-variant-numeric: tabular-nums; color: #E6E4D9; }
.ld-fine { margin-top: 8px; }
.ld-fine summary { font-size: 12px; color: #878580; cursor: pointer; }
.ld-fine summary:hover { color: #CECDC3; }
.ld-frow { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px; }
.ld-frow > span { flex: 1; min-width: 0; }
.ld-frow small { color: #6F6E69; font-size: 12px; margin-left: 4px; }
.ld-sw { flex: none; width: 26px; height: 15px; border-radius: 8px; background: #403E3C; position: relative; border: 0;
  cursor: pointer; padding: 0; }
.ld-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%;
  background: #878580; transition: left .15s; }
.ld-sw.ld-on { background: #D14D41; }
.ld-sw.ld-on::after { left: 13px; background: #FFFCF0; }
.ld-search { position: relative; margin-top: 8px; }
.ld-search .ld-ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #878580; }
.ld-search input { width: 100%; box-sizing: border-box; background: #100F0F; color: #CECDC3; border: 1px solid #000;
  border-bottom-color: #343331; box-shadow: inset 0 2px 5px rgba(0,0,0,.5);
  border-radius: 8px; padding: 8px 10px 8px 32px; font: inherit; font-size: 14px; outline: none; }
.ld-search input::placeholder { color: #6F6E69; }
.ld-search input:focus { border-color: #D14D41; }
.ld-search.ld-small { flex: 0 1 150px; margin: 0 0 0 auto; }
.ld-search.ld-small input { padding: 5px 8px 5px 28px; font-size: 12px; }
.ld-results { margin-top: 4px; }
/* a short list, so a search doesn't push the rest of the setup off screen */
.ld-page .ld-results { max-height: 260px; overflow-y: auto; }
.ld-pagehead .ld-headslim { margin: 0 0 0 auto; gap: 14px; }
.ld-pagehead .ld-headslim + .ld-tabs { margin-left: 0; }
@media (max-width: 600px) {
  .ld-choices[data-a="kinds"] .ld-a { display: none; }
  .ld-choices[data-a="kinds"] .ld-choice { padding: 8px 7px; }
  .ld-choices[data-a="kinds"] b { white-space: nowrap; font-size: 13px; gap: 5px; }
  .ld-cond .ld-condtxt em { display: block; margin-left: 0; }
  .ld-pagehead .ld-headslim { order: 3; width: 100%; justify-content: flex-end; margin: 0; }
}
.ld-res { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 14px;
  border: 1px solid transparent; }
.ld-res:hover, .ld-res.ld-hi { background: #282726; }
.ld-res.ld-sel { border-color: #D14D41; background: #282726; background: color-mix(in srgb, #D14D41 12%, #282726); color: #E6E4D9; }
.ld-res .ld-rname { flex: 1; }
.ld-res .ld-rmeta { color: #878580; font-size: 12px; }
.ld-res .ld-tick { color: #D14D41; visibility: hidden; font-weight: 700; }
.ld-res.ld-sel .ld-tick { visibility: visible; }
.ld-hint { color: #878580; font-size: 12px; padding: 6px 2px; }
.ld-srcs { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.ld-srcs .ld-res .ld-ico { color: #878580; }
.ld-srcs .ld-res.ld-cant { opacity: .55; }
.ld-brief { display: flex; align-items: center; gap: 12px; margin-top: 4px; padding: 11px 12px; border-radius: 10px;
  background: #282726; background: color-mix(in srgb, #D14D41 12%, #1C1B1A); border: 1px solid color-mix(in srgb, #D14D41 40%, #000); }
.ld-brief > div { flex: 1; min-width: 0; font-size: 13px; line-height: 1.5; color: #E6E4D9; }
.ld-brief > div small { display: block; color: #B7B5AC; font-size: 12px; }
.ld-modal .ld-start { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; font-size: 15px;
  font-weight: 600; color: #100F0F; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  border: 1px solid #0b0a0a; box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 2px 6px rgba(0,0,0,.5); cursor: pointer; }
.ld-modal .ld-start:hover { filter: brightness(1.08); }
.ld-modal .ld-start .ld-ico rect { fill: #100F0F; }
.ld-modal .ld-start .ld-ico path { stroke: #100F0F; }
.ld-foot { font-size: 11px; color: #6F6E69; text-align: center; margin-top: 8px; }
.ld-modal .ld-foot .ld-soundbtn { font-size: 11px; display: inline; }
.ld-hhead { display: flex; align-items: center; margin-bottom: 8px; }
.ld-hhead b { font-size: 14px; color: #E6E4D9; }
.ld-hhead .ld-link { margin-left: auto; }
.ld-crown path { fill: #D0A215; }
.ld-flame path { fill: #DA702C; }
.ld-tile.ld-tname b { font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-rbtn { background: none; border: 0; color: #878580; cursor: pointer; padding: 0 2px; font: inherit; font-size: 12px;
  visibility: hidden; min-width: 18px; white-space: nowrap; }
.ld-row:hover .ld-rbtn, .ld-row.ld-confirm .ld-del { visibility: visible; }
.ld-again:hover { color: #66A0C8; }
.ld-del:hover { color: #E8705F; }
.ld-row.ld-confirm { background: rgba(209,77,65,.18); }
/* touch screens have no hover: Play again and remove stay visible, or a
   history entry could never be removed on a phone */
@media (hover: none) { .ld-rbtn { visibility: visible; } }
/* phones: the time and the row's buttons go under the name, so the name and
   its pills keep the width (they wrapped a word per line) */
@media (max-width: 575.98px) {
  .ld-row { flex-wrap: wrap; row-gap: 2px; }
  .ld-rmain { flex: 1 1 calc(100% - 80px); }
  .ld-rend { margin-left: auto; }
}
.ld-row.ld-confirm .ld-del { color: #100F0F; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  border-radius: 6px; padding: 2px 8px; font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-all { margin-top: 8px; }
.ld-filters { display: flex; align-items: center; gap: 6px; margin: 10px 0 6px; flex-wrap: wrap; }
.ld-filters .ld-sep { width: 1px; align-self: stretch; background: #403E3C; margin: 2px 2px; }
.ld-chip { display: inline-flex; align-items: center; gap: 4px; background: #1C1B1A; border: 1px solid #000;
  border-bottom-color: #343331; color: #B7B5AC;
  border-radius: 8px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.ld-chip:hover { color: #E6E4D9; }
.ld-chip .ld-ico { width: 12px; height: 12px; }
.ld-chip.ld-on { background: #343331; background: color-mix(in srgb, #D14D41 22%, #343331);
  border-color: color-mix(in srgb, #D14D41 50%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); color: #E6E4D9; }
.ld-month { display: flex; align-items: center; font-size: 11px; color: #878580; padding: 12px 6px 4px;
  border-bottom: 1px solid #403E3C; margin-bottom: 2px; }
.ld-month .ld-mcount { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; }
.ld-month .ld-ico { width: 11px; height: 11px; }
.ld-back { background: none; border: 0; color: #B7B5AC; font: inherit; font-size: 18px; cursor: pointer; padding: 0 4px 0 0; }
.ld-back:hover { color: #E6E4D9; }
#ld-tip { position: fixed; left: 50%; transform: translateX(-50%); z-index: 1066; max-width: min(560px, calc(100vw - 32px));
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px); border: 1px solid #D14D41;
  border-radius: 12px; padding: 9px 12px; color: #CECDC3; font-size: 13px;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); }
#ld-tip button { margin-left: 8px; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  border: 1px solid #0b0a0a; color: #100F0F; border-radius: 8px; padding: 3px 10px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.5);
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
#ld-toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 1080;
  max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 9px 14px; color: #CECDC3; font-size: 13px; line-height: 1.45;
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-left: 3px solid var(--c, #D0A215); border-radius: 12px;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75);
  opacity: 0; pointer-events: none; transition: opacity .2s; }
#ld-toast.ld-show { opacity: 1; }
#ld-toast.ld-t-info { --c: #4385BE; }
#ld-toast.ld-t-done { --c: #879A39; }
#ld-toast.ld-t-warn { --c: #D0A215; }
#ld-toast.ld-t-error { --c: #D14D41; }
/* Blind seeking: no previews of where a seek lands. */
body.ld-blind .vjs-vtt-thumbnail-display, body.ld-blind .scrubber-wrapper,
body.ld-blind .hover-scrubber, body.ld-blind .preview-scrubber { display: none !important; }
/* The Lockdown page reuses the dialog's styles (.ld-modal) without its box. */
.ld-modal.ld-page { width: auto; max-width: 1180px; max-height: none; overflow: visible; margin: 24px auto 48px;
  padding: 18px 18px 28px; background: #100F0F; border: 1px solid #000; border-top-color: #232120; border-radius: 16px;
  box-shadow: 0 20px 50px -20px rgba(0,0,0,.7); box-sizing: border-box; }
.ld-pagehead { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.ld-ptitle { display: flex; align-items: baseline; gap: 4px 12px; flex-wrap: wrap; min-width: 0; }
.ld-psub { color: #878580; font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.ld-pagehead h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 22px; font-weight: 700; color: #E6E4D9; }
.ld-pagehead h2 .ld-lock { width: 22px; height: 22px; }
.ld-tabs { display: flex; gap: 4px; margin-left: auto; padding: 4px; border-radius: 11px;
  background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331; box-shadow: inset 0 2px 4px rgba(0,0,0,.5); }
.ld-modal .ld-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: none;
  border: 1px solid transparent; color: #B7B5AC; padding: 6px 13px; border-radius: 8px; font-size: 14px; cursor: pointer; white-space: nowrap; }
.ld-tabs button .ld-ico { color: var(--tc); opacity: .75; }
.ld-tabs button:hover { color: #E6E4D9; }
.ld-modal .ld-tabs button.ld-on { color: #E6E4D9; background: #343331; background: color-mix(in srgb, var(--tc) 24%, #282726);
  border-color: color-mix(in srgb, var(--tc) 55%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,.4); }
.ld-tabs button.ld-on .ld-ico { opacity: 1; }
/* phones: the slab loses its outer margin and keeps 12px inside; the tabs
   share the width as a grid, so none is left alone on a line */
@media (max-width: 575.98px) {
  .ld-modal.ld-page { margin: 0 0 24px; padding: 12px 12px 24px; }
  .ld-pagehead .ld-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; margin-left: 0; box-sizing: border-box; }
  .ld-modal .ld-tabs button { padding: 6px 4px; gap: 5px; font-size: 13px; min-width: 0; }
  .ld-tabs button span { overflow: hidden; text-overflow: ellipsis; }
}
.ld-setup { display: grid; gap: 10px; }
.ld-page .ld-setup { grid-template-columns: minmax(0, 1.35fr) minmax(280px, 1fr); align-items: start; gap: 14px; }
.ld-page .ld-runcard { position: sticky; top: 70px; }
@media (max-width: 900px) { .ld-page .ld-setup { grid-template-columns: minmax(0, 1fr); } .ld-page .ld-runcard { position: static; } }
.ld-runcard { background: #282726; background: color-mix(in srgb, #D14D41 10%, #1C1B1A); border: 1px solid color-mix(in srgb, #D14D41 40%, #000);
  border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; }
.ld-rcwho { display: flex; align-items: center; gap: 12px; margin: 4px 0 10px; }
.ld-rcwho b { display: block; font-size: 16px; color: #E6E4D9; }
.ld-rcwho small { display: block; color: #B7B5AC; font-size: 12.5px; }
.ld-av.ld-big img, .ld-av.ld-big video, .ld-av.ld-big i { width: 48px; height: 48px; line-height: 48px; font-size: 18px; border: 2px solid #D14D41; }
.ld-rcchips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
.ld-rcchips .ld-pill { font-size: 11.5px; line-height: 20px; display: inline-flex; align-items: center; gap: 4px; }
.ld-rcchips .ld-pill .ld-ico { width: 13px; height: 13px; }
.ld-rcmult { display: flex; align-items: baseline; gap: 8px; padding: 9px 12px; border-radius: 8px; background: #100F0F; }
.ld-rcmult span { flex: 1; color: #878580; }
.ld-rcmult b { font-size: 24px; color: #D0A215; font-variant-numeric: tabular-nums; }
.ld-rcformula { color: #878580; font-size: 12px; line-height: 1.55; margin: 8px 0 10px; }
.ld-rcformula b { color: #CECDC3; font-weight: 600; }
.ld-runcard .ld-start { width: 100%; justify-content: center; }
.ld-blue { color: #4385BE !important; }
.ld-gold { color: #D0A215 !important; }
.ld-coral { color: #E8705F !important; }
.ld-bonus { font-style: normal; color: #D0A215; font-size: 12px; margin-left: auto; padding-right: 6px; }
.ld-frow > span .ld-ico { width: 14px; height: 14px; color: #878580; margin-right: 3px; vertical-align: -2px; }
.ld-scorepill { color: #D0A215; border-color: color-mix(in srgb, #D0A215 45%, transparent); font-variant-numeric: tabular-nums; }
.ld-board .ld-brow { display: grid; grid-template-columns: 30px minmax(0, 1fr) 80px 54px 74px 80px; gap: 10px; align-items: center;
  padding: 8px 6px; border-top: 1px solid #282726; font-size: 13.5px; }
.ld-board .ld-bhead { color: #6F6E69; font-size: 11.5px; border-top: 0; }
.ld-board .ld-brun { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ld-board .ld-brun b { color: #E6E4D9; font-weight: 600; }
.ld-board .ld-brun small { display: block; color: #878580; font-size: 11.5px; margin-top: 2px; }
.ld-board .ld-brun small .ld-ico { width: 12px; height: 12px; }
.ld-board .ld-rank { font-weight: 700; color: #6F6E69; }
.ld-board .ld-rank.r1 { color: #D0A215; } .ld-board .ld-rank.r2 { color: #B7B5AC; } .ld-board .ld-rank.r3 { color: #DA702C; }
.ld-board .ld-bscore { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; color: #E6E4D9; }
.ld-board .ld-brow:nth-child(2) .ld-bscore { color: #D0A215; }
.ld-ruleico .ld-ico { width: 14px; height: 14px; color: #B7B5AC; margin-right: 3px; }
@media (max-width: 640px) { .ld-board .ld-brow { grid-template-columns: 24px minmax(0, 1fr) 64px; }
  .ld-board .ld-brow > span:nth-child(4), .ld-board .ld-brow > span:nth-child(5), .ld-board .ld-brow > span:nth-child(3) { display: none; } }
.ld-live { max-width: 720px; }
.ld-live .ld-tiles { margin: 8px 0 12px; }
.ld-live .ld-lvgo { width: auto; margin: 4px 0 8px; }
.ld-live .ld-lvrow { display: flex; flex-wrap: wrap; gap: 8px; }
.ld-live .ld-lvpics[hidden] { display: none; }
.ld-modal .ld-start.ld-lvpics { color: #CECDC3; background: linear-gradient(180deg, #343331, #282726); border-top-color: #403E3C;
  box-shadow: 0 1px 2px rgba(0,0,0,.5); }
.ld-modal .ld-start.ld-lvpics:hover { color: #E6E4D9; border-top-color: #575653; filter: none; }
.ld-modal .ld-start.ld-lvpics .ld-ico path { stroke: #3AA99F; }
.ld-live .ld-foot { text-align: left; }
.ld-endico .ld-ico { width: 40px; height: 40px; }
.ld-score { background: #1C1B1A; border: 1px solid #343331; border-radius: 10px; padding: 10px 12px; margin-top: 10px; font-size: 13px; }
.ld-score > div { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
.ld-score .ld-mline { border-top: 1px solid #343331; margin-top: 4px; padding-top: 6px; color: #B7B5AC; }
.ld-score .ld-total { font-size: 16px; }
.ld-score .ld-total b { font-size: 18px; }
.ld-score .ld-place { justify-content: center; color: #D0A215; font-size: 12.5px; }
.ld-score .ld-place:empty { display: none; }
.ld-heatsum { margin-left: 6px; color: #DA702C; font-weight: 700; display: inline-flex; align-items: center; gap: 3px; }
.ld-heatsum .ld-ico { width: 13px; height: 13px; }
.ld-clearheat { margin-left: auto; font-size: 12px !important; }
.ld-conds { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
.ld-cond { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto 30px; gap: 10px; align-items: center; padding: 8px 9px;
  border-radius: 8px; border: 1px solid transparent; cursor: pointer; user-select: none; }
.ld-cond:hover { background: #282726; }
.ld-cond.ld-on { background: #282726; background: color-mix(in srgb, #DA702C 10%, #1C1B1A); border-color: color-mix(in srgb, #DA702C 35%, transparent); }
.ld-condico .ld-ico { width: 18px; height: 18px; color: #878580; }
.ld-cond.ld-on .ld-condico .ld-ico { color: #DA702C; }
.ld-condtxt b { font-weight: 600; color: #E6E4D9; font-size: 13.5px; }
.ld-condtxt em { font-style: normal; color: #DA702C; font-size: 12.5px; margin-left: 8px; }
.ld-condtxt small { display: block; color: #878580; font-size: 11.5px; line-height: 1.35; margin-top: 1px; }
.ld-pips { display: inline-flex; gap: 5px; }
.ld-modal .ld-pip { width: 13px; height: 13px; padding: 0; border-radius: 50%; border: 1.5px solid #575653; background: none; cursor: pointer; }
.ld-modal .ld-pip:hover { border-color: #DA702C; }
.ld-modal .ld-pip.ld-on { background: #DA702C; border-color: #DA702C; }
.ld-noheat { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid #343331; }
.ld-noheat > span { color: #878580; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.ld-noheat small { color: #6F6E69; font-size: 11.5px; }
.ld-nhchip { display: inline-flex; align-items: center; gap: 6px; background: #1C1B1A; color: #B7B5AC; border: 1px solid #000; border-bottom-color: #343331;
  border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 13px; }
.ld-nhchip i { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid #575653; flex: none; }
.ld-nhchip.ld-on { color: #E6E4D9; }
.ld-nhchip.ld-on i { background: #D14D41; border-color: #D14D41; }
.ld-nhchip .ld-ico { width: 14px; height: 14px; }
.ld-tagpick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 2px; }
.ld-tagchip { display: inline-flex; align-items: center; gap: 4px; background: #343331; color: #E6E4D9; border-radius: 8px; padding: 3px 4px 3px 10px; font-size: 13.5px; }
.ld-tagchip button { background: none; border: 0; color: #878580; cursor: pointer; font-size: 15px; padding: 0 4px; }
.ld-tagchip button:hover { color: #E8705F; }
.ld-tagjoin { color: #D14D41; font-size: 11px; font-weight: 700; text-transform: uppercase; }
/* 2.3: presets above the setup, saving one under Start */
.ld-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
.ld-presets:empty { display: none; }
.ld-plabel { color: #878580; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-right: 4px; }
.ld-preset { display: inline-flex; align-items: center; background: #282726; border: 1px solid #0d0c0c; border-top-color: #403E3C; border-radius: 8px; overflow: hidden; }
.ld-pplay { background: none; border: 0; color: #E6E4D9; font-size: 13.5px; padding: 4px 6px 4px 12px; cursor: pointer; }
.ld-pplay:hover { color: #FFFCF0; text-decoration: underline; text-underline-offset: 2px; }
.ld-pdel { background: none; border: 0; color: #878580; font-size: 14px; padding: 4px 10px 4px 4px; cursor: pointer; }
.ld-pdel:hover { color: #E8705F; }
.ld-pdel.ld-armed { font-size: 12px; font-weight: 600; color: #100F0F; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  padding: 4px 10px; margin-left: 2px; border-radius: 0; }
.ld-pdel.ld-armed:hover { color: #100F0F; }
.ld-psave { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 8px; }
.ld-pname { flex: 1 1 auto; min-width: 0; background: #100F0F; color: #CECDC3; border: 1px solid #000; border-radius: 8px; padding: 5px 9px; font-size: 13.5px; }
.ld-pname:focus { outline: none; border-color: #D14D41; }
/* 2.3: a target with images only has no conditions */
.ld-condsoff .ld-cond, .ld-condsoff .ld-noheat { opacity: .35; pointer-events: none; }
.ld-ionote { margin: 0 0 8px; }
.ld-rmeta i { color: #878580; font-style: normal; }
.ld-tagmore { color: #6F6E69; font-size: 12px; }
.ld-tagmode { display: flex; align-items: center; gap: 10px; margin: 2px 2px 4px; }
.ld-tagmode .ld-hint { margin: 0; }
.ld-timebox input.ld-time { width: 92px; text-align: center; background: #1C1B1A; color: #E6E4D9; border: 0; font: inherit; font-weight: 600; padding: 4px 6px; outline: none; }
.ld-timebox input.ld-time:focus { box-shadow: inset 0 0 0 1px #D14D41; }
.ld-condheat { text-align: right; color: #6F6E69; font-variant-numeric: tabular-nums; font-weight: 600; }
.ld-cond.ld-on .ld-condheat { color: #DA702C; }
.ld-rcheat { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; background: #100F0F; margin-bottom: 10px; }
.ld-rcheat .ld-bigflame .ld-ico { width: 30px; height: 30px; }
.ld-rcheat b { display: block; font-size: 26px; line-height: 1; color: #DA702C; font-variant-numeric: tabular-nums; }
.ld-rcheat small { color: #878580; font-size: 11.5px; }
.ld-rcheat .ld-grow { flex: 1; }
.ld-rcheat .ld-rcx { text-align: right; }
.ld-rcheat .ld-rcx b { color: #D0A215; font-size: 20px; }
.ld-heatpill { color: #DA702C; border-color: color-mix(in srgb, #DA702C 45%, transparent); display: inline-flex; align-items: center; gap: 3px; }
.ld-heatpill .ld-ico { width: 11px; height: 11px; }
.ld-condpill { color: #E6E4D9; }
.ld-condpill .ld-ico { color: #DA702C; }
.ld-board .ld-bheat { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ld-score .ld-mline .ld-ico { width: 13px; height: 13px; vertical-align: -2px; }
.ld-drop path { fill: #4385BE; }
/* The parts of a scene watched in this lock, on video.js's progress bar. */
.ld-watched { position: absolute; inset: 0; pointer-events: none; }
.ld-watched i { position: absolute; top: 0; bottom: 0; min-width: 3px; background: #4385BE;
  box-shadow: 0 0 4px rgba(67,133,190,.75); }
/* Hovering the timeline: the time tooltip turns blue where a click is free
   (watched, or close enough to snap onto a watched part). */
.video-js .vjs-progress-holder[data-ld-free="1"] .vjs-mouse-display .vjs-time-tooltip,
.video-js .vjs-progress-holder[data-ld-free="1"] .vjs-time-tooltip { background: #4385BE !important; color: #100F0F !important; }
/* While locked the bar reads blue = watched, grey = not, the dot = here: the
   played-so-far fill would cover the watched parts behind the playhead. */
body.ld-on .video-js .vjs-play-progress { background: transparent !important; }
@media (max-width: 560px) {
  .ld-choices.ld-four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ld-choice small { white-space: normal; }
  .ld-brief { flex-direction: column; align-items: stretch; }
}
/* 2.6: Edge overtime. Cyan is Edge's colour (the bar's goal, its meter):
   the card says the target is reached and the score banked, Keep going is
   the cyan primary, Finish / Stop overtime the plain button. The card sits
   under the bar like the first-lock tip (#ld-over), or on the run page. */
.ld-otcard { background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-left: 3px solid #3AA99F; border-radius: 12px;
  padding: 12px 14px; margin: 4px 0 12px; color: #CECDC3; font-size: 13px; line-height: 1.5;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 12px 24px -10px rgba(0,0,0,.65); }
.ld-otcard .ld-othead { display: flex; align-items: center; gap: 8px; }
.ld-otcard .ld-othead b { font-size: 15px; color: #E6E4D9; font-variant-numeric: tabular-nums; }
.ld-otcard .ld-othead .ld-ico { width: 18px; height: 18px; color: #3AA99F; fill: #3AA99F; flex: none; }
.ld-otcard .ld-otbank { margin-top: 4px; color: #B7B5AC; }
.ld-otcard .ld-otbank b { font-size: 18px; margin-left: 6px; font-variant-numeric: tabular-nums; }
.ld-otcard p { margin: 6px 0 10px; color: #878580; font-size: 12.5px; }
.ld-otcard .ld-otbtns { display: flex; flex-wrap: wrap; gap: 8px; }
.ld-otcard .ld-otmeter { height: 6px; border-radius: 6px; margin-top: 8px; overflow: hidden;
  background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331; box-shadow: inset 0 2px 5px rgba(0,0,0,.5); }
.ld-otcard .ld-otmeter i { display: block; height: 100%; width: 0; background: #3AA99F; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-otcard .ld-start { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px; font: inherit; font-size: 14px;
  font-weight: 600; border-radius: 8px; cursor: pointer; border: 1px solid #0b0a0a; }
.ld-otcard .ld-start.ld-otgo, .ld-modal .ld-start.ld-otgo { color: #100F0F; background: #3AA99F; background: linear-gradient(180deg, #3AA99F, #24837B);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 2px 6px rgba(0,0,0,.5); }
.ld-otcard .ld-start.ld-otfin, .ld-modal .ld-start.ld-otfin { color: #CECDC3; background: linear-gradient(180deg, #343331, #282726);
  border-top-color: #403E3C; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
.ld-otcard .ld-start:hover { filter: brightness(1.08); }
#ld-over { position: fixed; right: 14px; z-index: 1066; width: min(400px, calc(100vw - 28px)); }
#ld-over .ld-otcard { margin: 0; box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); }
#ld-bar .ld-otbar { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
#ld-bar .ld-otbar button { display: inline-flex; align-items: center; justify-content: center; height: 30px; min-height: 0; margin: 0;
  padding: 0 12px; line-height: 1; white-space: nowrap; box-sizing: border-box; }
#ld-bar .ld-otbar .ld-otgo { color: #100F0F; font-weight: 600; background: #3AA99F; background: linear-gradient(180deg, #3AA99F, #24837B);
  border-top-color: #5ABDAC; }
#ld-bar .ld-otbar .ld-otgo:hover { color: #100F0F; filter: brightness(1.08); }
#ld-bar .ld-otbar .ld-otshort { display: none; }
#ld-bar .ld-meter.ld-otm { width: 70px; }
@media (max-width: 760px) {
  #ld-bar .ld-otbar .ld-otlong { display: none; }
  #ld-bar .ld-otbar .ld-otshort { display: inline; }
  #ld-over { right: 8px; width: calc(100vw - 16px); }
}
/* a 375 px phone: Finish ran past the edge with "target reached" shown
   (measured, 464 px); the card under the bar says it */
@media (max-width: 480px) {
  #ld-bar .ld-otbar button { padding: 0 8px; }
  #ld-bar .ld-reachedtxt { display: none; }
}
/* 2.6: moments found in a run (markers): magenta, the suite's colour for
   intimate highlights; each links to the scene at the marker. */
.ld-moments { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin-top: 3px; font-size: 12px; color: #B7B5AC; }
.ld-moments .ld-ico { width: 13px; height: 13px; color: #CE5D97; flex: none; }
.ld-moments a.ld-mlink { color: #E6E4D9; text-decoration: none; border-bottom: 1px dotted #878580; }
.ld-moments a.ld-mlink:hover { color: #F4A4C2; border-bottom-color: #CE5D97; }
.ld-moments > i { color: #6F6E69; font-style: normal; }
.ld-resmoments { background: #1C1B1A; border: 1px solid #343331; border-radius: 10px; padding: 8px 12px; margin-top: 10px; }
.ld-resmoments .ld-moments { margin: 0; font-size: 12.5px; }
.ld-live [data-a="lvmoments"] .ld-moments { margin: -4px 0 10px; }
.ld-spin .ld-msg.ld-otline { color: #3AA99F; font-variant-numeric: tabular-nums; }
.ld-spin .ld-msg.ld-note { color: #B7B5AC; }
`;
    document.head.appendChild(s);
  }

  // ═══ Sounds ════════════════════════════════════════════════════════════════
  // Made with Web Audio, no files: a struck bell when a lock starts (here or
  // arriving from another device), a bright rising chime for getting out, a
  // low falling tone for giving up. On by default, per device (pref
  // `sound`). Browsers only let a page make sound after the user has
  // interacted with it, which the Start and Give up presses are; an O seen
  // by polling plays if the page was used before.

  let audio = null;
  function audioCtx() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      return audio;
    } catch (_) { return null; }
  }
  function tone(c, freq, at, dur, gain, type) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(c.destination);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  }
  function sound(kind) {
    if (prefs().sound === false) return;
    const c = audioCtx();
    if (!c) return;
    const t = c.currentTime + 0.03;
    try {
      if (kind === "start") {
        // A bell's partials (hum, prime, tierce, quint, nominal, upper) ring
        // out at different lengths; struck twice.
        for (const at of [t, t + 0.9]) {
          for (const [m, g, d] of [[0.5, 0.10, 3.4], [1, 0.22, 3.0], [1.19, 0.08, 2.2], [1.5, 0.06, 1.8], [2, 0.10, 1.6], [2.74, 0.04, 1.0]]) {
            tone(c, 392 * m, at, d, at === t ? g : g * 0.7);
          }
        }
      } else if (kind === "out") {
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          tone(c, f, t + i * 0.11, 1.3, 0.16);
          tone(c, f * 2, t + i * 0.11, 0.5, 0.04);
        });
      } else if (kind === "giveup") {
        const a = tone(c, 233, t, 1.2, 0.2, "triangle");
        a.frequency.exponentialRampToValueAtTime(117, t + 1.1);
        const b = tone(c, 196, t + 0.18, 1.3, 0.12, "triangle");
        b.frequency.exponentialRampToValueAtTime(98, t + 1.3);
      }
    } catch (e) { log(`Sound failed: ${e.message}`); }
  }

  // ═══ Navigation ════════════════════════════════════════════════════════════

  function navigate(url, replace) {
    // React Router listens for popstate; a full reload would lose the SPA.
    (replace ? history.replaceState : history.pushState).call(history, {}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  // The target's scene list, where a lock starts and a bounce lands. With
  // "unwatched only" it opens filtered to scenes never played (the cards
  // are checked either way; this just keeps the page from looking empty).
  const FRESH_Q = "?c=" + encodeURIComponent('("type":"play_count","modifier":"EQUALS","value":("value":0))');
  function listUrl(L) {
    if (L.tags && L.tags.length > 1) return tagsListUrl(L, L.media === "images" ? "images" : "scenes");
    return `/${KINDS[L.kind].path}/${L.tid}/${L.media === "images" ? "images" : `scenes${L.rules && L.rules.fresh ? FRESH_Q : ""}`}`;
  }
  // Several tags have no page of their own: Stash's Scenes list, filtered to
  // them (and to unplayed scenes with "unwatched only"); 2.3: its Images and
  // Galleries lists the same way (forum: with OR, the other tags' images had
  // no list to be found in, only each tag's own page).
  function tagsListUrl(L, page) {
    const crit = [{ type: "tags", modifier: L.mode === "or" ? "INCLUDES" : "INCLUDES_ALL",
                    value: { items: L.tags.map((t) => ({ id: String(t.id), label: t.name })), excluded: [], depth: -1 } }];
    if (page === "scenes" && L.rules && L.rules.fresh) crit.push({ type: "play_count", modifier: "EQUALS", value: { value: 0 } });
    return `/${page}?${crit.map((c) => `c=${encodeCriterion(c)}`).join("&")}`;
  }
  const scenesListUrl = (L) => tagsListUrl(L, "scenes");
  // Whether a Scenes list URL still has the lock's tags criterion (and the
  // unplayed one with "unwatched only"); other filters may narrow it.
  function keepsListFilter(search, L, page) {
    const cs = new URLSearchParams(search || "").getAll("c").map((c) => c.replace(/\(/g, "{").replace(/\)/g, "}"));
    const mod = L.mode === "or" ? '"INCLUDES"' : '"INCLUDES_ALL"';
    const tags = cs.some((c) => c.includes('"type":"tags"') && c.includes(`"modifier":${mod}`) &&
      (L.tags || []).every((t) => c.includes(`"id":"${t.id}"`)));
    const fresh = (page && page !== "scenes") || !(L.rules && L.rules.fresh) ||
      cs.some((c) => c.includes('"type":"play_count"') && c.includes('"modifier":"EQUALS"'));
    return tags && fresh;
  }
  // Stash's criterion URL form: JSON with { } as ( ) outside strings.
  function encodeCriterion(obj) {
    let inString = false, escaped = false, out = "";
    for (const ch of JSON.stringify(obj)) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === "\\" && inString) { escaped = true; out += ch; continue; }
      if (ch === '"') inString = !inString;
      out += (!inString && ch === "{") ? "(" : (!inString && ch === "}") ? ")" : ch;
    }
    let r = encodeURI(out);
    for (const c of "?#&;=+") r = r.split(c).join(encodeURIComponent(c));
    return r;
  }

  // The performer, studio or tag page Lockdown was opened from, if any.
  function targetOnPage() {
    const m = /^\/(performers|studios|tags)\/(\d+)/.exec(location.pathname);
    if (!m) return null;
    const kind = { performers: "performer", studios: "studio", tags: "tag" }[m[1]];
    return { kind, id: m[2] };
  }

  function closeModal() {
    document.querySelector(".ld-modal-back")?.remove();
  }

  // sticky: no closing by clicking outside (the spin must play out).
  function modal(html, sticky) {
    closeModal();
    injectStyles();
    const back = document.createElement("div");
    back.className = "ld-modal-back";
    if (sticky) back.dataset.sticky = "1";
    back.innerHTML = `<div class="ld-modal">${html}</div>`;
    if (!sticky) back.addEventListener("pointerdown", (ev) => { if (ev.target === back) closeModal(); });
    document.body.appendChild(back);
    return back.querySelector(".ld-modal");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── Shared pieces ─────────────────────────────────────────────────────────

  // A drop for a lockdown got out of with an O, a clock for a timer served,
  // an X for one given up.
  const DROP = `<svg class="ld-ico ld-drop" viewBox="0 0 16 16" aria-label="${tc("已出局", "got out")}"><path d="M8 1.2C8 1.2 3.2 6.6 3.2 10.1a4.8 4.8 0 0 0 9.6 0C12.8 6.6 8 1.2 8 1.2z"/><path class="ld-shine" d="M5.9 10.4a2.2 2.2 0 0 0 1.6 2.1" fill="none"/></svg>`;
  // Stash's own O-counter drops (its SweatDrops icon), so an O looks the same
  // in Lockdown as on the scene page; Edge, held without an O, is one drop.
  const SWEAT_D = "M22.855.758L7.875 7.024l12.537 9.733c2.633 2.224 6.377 2.937 9.77 1.518c4.826-2.018 7.096-7.576 5.072-12.413C33.232 1.024 27.68-1.261 22.855.758zm-9.962 17.924L2.05 10.284L.137 23.529a7.993 7.993 0 0 0 2.958 7.803a8.001 8.001 0 0 0 9.798-12.65zm15.339 7.015l-8.156-4.69l-.033 9.223c-.088 2 .904 3.98 2.75 5.041a5.462 5.462 0 0 0 7.479-2.051c1.499-2.644.589-6.013-2.04-7.523z";
  const DROPS = `<svg class="ld-ico ld-drop" viewBox="0 0 36 36" aria-label="${tc("已出局", "got out")}"><path d="${SWEAT_D}"/></svg>`;
  const CLOCK = `<svg class="ld-ico ld-clock" viewBox="0 0 16 16" aria-label="${tc("服刑时长", "time served")}"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.6"/></svg>`;
  const CROSS = `<svg class="ld-ico ld-x" viewBox="0 0 16 16" aria-label="${tc("已放弃", "given up")}"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>`;
  const CROWN = `<svg class="ld-ico ld-crown" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5l3 3L8 4l2.5 4.5 3-3-1.3 7H3.8z"/></svg>`;
  const FLAME = `<svg class="ld-ico ld-flame" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.5 2.5 3.8 4 3.8 7.6A3.8 3.8 0 0 1 4.2 9.1c0-1.8 1-2.8 1.8-3.6.1 1.3.7 2.1 1.4 2.4C7.2 5.6 7.6 3.5 8 1.5z"/></svg>`;
  const TRASH = `<svg class="ld-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SEARCH = `<svg class="ld-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const LOCK_SVG = `<svg class="ld-ico ld-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none"/></svg>`;
  // Line icons for the setup's choices, in the plugins' hand.
  const line = (d) => `<svg class="ld-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  // 2.5: Play pictures (Slideshow), a play triangle in cyan
  const PICS_ICON = line('<path d="M5 3.3v9.4L12.6 8z"/>');
  const KIND_ICON = {
    performer: line('<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14c.6-3 2.7-4.6 5.2-4.6s4.6 1.6 5.2 4.6"/>'),
    studio: line('<rect x="2.5" y="4.5" width="8" height="8" rx="1.2"/><path d="M10.5 7.2l3-1.8v6.2l-3-1.8"/>'),
    tag: line('<path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z"/><circle cx="5.4" cy="5.4" r="0.9"/>'),
  };
  const goalInfo = () => ({
    finish: [tc("完成", "Finish"), tc("射出来就出局", "finish to get out"), `<svg class="ld-ico" viewBox="0 0 36 36" fill="currentColor" aria-hidden="true"><path d="${SWEAT_D}"/></svg>`],
    timer: [tc("计时", "Timer"), tc("锁定一段设定时间", "locked for a set time"), line('<circle cx="8" cy="8.6" r="5.4"/><path d="M8 5.6v3l2 1.4M6.2 1.8h3.6"/>')],
    edge: [tc("边缘", "Edge"), tc("忍住不射地观看", "watch without finishing"), line('<path d="M8 1.8S3.6 6.8 3.6 10a4.4 4.4 0 0 0 8.8 0C12.4 6.8 8 1.8 8 1.8z"/>')],
  });
  const HEART = line('<path d="M8 13.4S2.2 10 2.2 6.1A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5.8 1.5C13.8 10 8 13.4 8 13.4z"/>');
  const FUNNEL = line('<path d="M2.5 3h11l-4.2 5.2v4.6l-2.6 1.2V8.2z"/>');
  // The page's tab strip icons: 16-grid line icons at stroke 1.6, in the
  // tab's colour (the suite's tab strip).
  const tabIcon = (d) => `<svg class="ld-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const LOCK_LINE = tabIcon('<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>');
  const CROWN_LINE = tabIcon('<path d="M2.5 5.5l3 3L8 4l2.5 4.5 3-3-1.3 7H3.8z"/>');
  const HISTORY_LINE = tabIcon('<path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7"/><path d="M2.5 2.5V5H5M8 5.2V8l2 1.3"/>');

  // How a run ended: two drops for an O (as Stash's O counter), one drop
  // for an edge held, a clock for a timer served, a cross for giving up.
  const icon = (e) => (e.result !== "done" ? CROSS : goalType(e) === "timer" ? CLOCK : goalType(e) === "edge" ? DROP : DROPS);
  // An icon for each heat condition, in the plugins' line style.
  const COND_ICON = {
    skip: line('<path d="M2.5 4l5 4-5 4zM8.5 4l5 4-5 4z"/>'),
    roulette: line('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.6" cy="5.6" r=".6"/><circle cx="10.4" cy="10.4" r=".6"/><circle cx="8" cy="8" r=".6"/>'),
    stay: line('<path d="M3 4l5 4-5 4zM9 4v8M13 3L3 13"/>'),
    speed: line('<path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11l2.6-3.2"/>'),
    blind: line('<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="1.6"/><path d="M2.5 13.5l11-11"/>'),
    fresh: line('<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M11.8 4.2l-1.6 1.6M5.8 10.2l-1.6 1.6"/>'),
    slow: line('<path d="M4 2h8M4 14h8M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6"/>'),
    harsh: line('<path d="M6.5 2.5S3 6.5 3 9.2a3.5 3.5 0 0 0 7 0C10 6.5 6.5 2.5 6.5 2.5z"/><path d="M12.5 4v4M10.5 6h4"/>'),
    one: line('<path d="M13 6.5A5 5 0 0 0 4 4.5L2.5 6M3 9.5a5 5 0 0 0 9 2L13.5 10"/><path d="M2.5 3v3h3M13.5 13v-3h-3"/>'),
  };
  // The conditions a run had on, as icons (leaderboard).
  const condIcons = (conds, goal) => conditions().filter((c) => conds && conds[c.k] && condApplies(c, goal && goal.type))
    .map((c) => `<span class="ld-ruleico" title="${escapeHtml(c.name)}: ${escapeHtml(c.ranks[conds[c.k] - 1])}">${COND_ICON[c.k]}</span>`).join("");
  const heatPill = (h) => `<span class="ld-pill ld-heatpill" title="${tc("热度", "Heat")}">${FLAME} ${h}</span>`;

  // The suite's empty state: a raised card, one bold line, one muted line.
  const emptyHtml = (title, line) => `<div class="ld-emptycard"><b>${escapeHtml(title)}</b>${line ? `<span>${escapeHtml(line)}</span>` : ""}</div>`;
  // Loading: what is being read, over Insights' thin sliding bar.
  const loadingHtml = (text) => `<div class="ld-loading">${escapeHtml(text)}<div class="ld-lbar"><i></i></div></div>`;
  // A saved history or totals that do not parse are left alone (rule 5);
  // 2.2's review found that went unsaid (§6, open issue 6).
  const notReadHtml = (d) => (d && d.bad ? tc(`<div class="ld-notice">你保存的历史无法读取，Lockdown 会保持原样、不往里添加任何内容。
    对局仍会锁定并结束；在历史恢复可读之前，它们不会被记录下来。</div>`, `<div class="ld-notice">Your saved history could not be read, so Lockdown leaves it as it is and adds nothing to it. ` +
    `Runs still lock and end; they are not recorded until the history is readable again.</div>`) : "");

  function avatarHtml(name, image) {
    return image ? `<img src="${escapeHtml(image)}" alt="">`
                 : `<i>${escapeHtml(String(name || "?").trim().charAt(0).toUpperCase())}</i>`;
  }

  function tilesHtml(st) {
    const top = mostLocked(st);
    const tile = (ico, big, label, cls = "") => `<div class="ld-tile ${cls}">${ico}<b>${big}</b><span>${label}</span></div>`;
    return `<div class="ld-tiles">` +
      tile(DROPS, st.done, tc("已出局", "got out")) +
      tile(CROSS, st.gaveUp, tc("已放弃", "gave up")) +
      tile(CROWN, top ? escapeHtml(top.name) : "–", top ? tc(`最常锁定 · ${top.n}×`, `most locked · ${top.n}×`) : tc("最常锁定", "most locked"), "ld-tname") +
      tile(FLAME, st.bestStreak, tc(`最长连胜${st.streak ? ` · 当前 ${st.streak}` : ""}`, `best streak${st.streak ? ` · now ${st.streak}` : ""}`)) +
      `</div>` + winsHtml(st);
  }

  function winsHtml(st) {
    const parts = [];
    if (st.bestHeat) parts.push(tc(`${heatPill(st.bestHeat)} 出局时的最高热度`, `${heatPill(st.bestHeat)} highest heat you got out of`));
    if (st.longestEdgeMs) parts.push(`<span class="ld-long">${tc("最长边缘", "Longest edge")} ${escapeHtml(fmtMinutes(st.longestEdgeMs / 60000))}</span>`);
    return parts.length ? `<div class="ld-wins">${parts.join("")}</div>` : "";
  }

  function rowHtml(e, now) {
    const kind = e.kind && e.kind !== "performer" && KINDS[e.kind] ? kl(e.kind) : "";
    const from = /^(random from |从收藏中随机|从\u201c)/.test(e.how || "") ? e.how : "";
    const note = [kind, from].filter(Boolean).join(" · ");
    const pills = (e.goal ? `<span class="ld-pill">${escapeHtml(goalLabel(e.goal))}</span>` : "") +
      (typeof e.heat === "number" ? heatPill(e.heat)
        : e.difficulty && tc(DIFF_LABEL_ZH[e.difficulty], DIFF_LABEL[e.difficulty]) ? `<span class="ld-pill ld-d-${e.difficulty}">${tc(DIFF_LABEL_ZH[e.difficulty], DIFF_LABEL[e.difficulty])}</span>` : "");
    const detail = entryDetail(e);
    const scorePill = e.score ? `<span class="ld-pill ld-scorepill" title="${tc("分数", "Score")}">${Number(e.score).toLocaleString()}</span>` : "";
    const watched = e.v >= 3 ? tc(` · 观看 ${fmtMinutes((e.watchedMs || 0) / 60000)}`, ` · watched ${fmtMinutes((e.watchedMs || 0) / 60000)}`) : "";
    return `<div class="ld-row ${e.result}" data-key="${escapeHtml(entryKey(e))}">${icon(e)}` +
      `<span class="ld-av">${avatarHtml(e.name, e.image)}</span>` +
      `<span class="ld-rmain"><span class="ld-rname">${escapeHtml(e.name || "?")}${note ? `<small>${escapeHtml(note)}</small>` : ""}</span>` +
        `<span class="ld-rsub">${scorePill}${pills}${detail ? `<em>${escapeHtml(detail)}</em>` : ""}</span>${momentsHtml(e)}</span>` +
      `<span class="ld-rend"><span class="ld-rtime">${e.result === "done" ? "" : tc("放弃 ", "gave up ")}${escapeHtml(fmtDuration(e.ms))}</span>` +
        `<span class="ld-rwhen"${typeof e.at === "number" ? ` title="${tc("开始于 ", "Started ")}${escapeHtml(fmtStamp(e.at))}"` : ""}>${escapeHtml(typeof e.at === "number" ? fmtWhen(e.at, now) : "")}${watched}</span></span>` +
      `<button class="ld-rbtn ld-again" title="${tc("重新设置同样的锁定", "Set up the same lockdown again")}">${tc("再玩一次", "Play again")}</button>` +
      `<button class="ld-rbtn ld-del" title="${tc("从历史中移除", "Remove from history")}" aria-label="${tc("移除", "Remove")}">${TRASH}</button></div>`;
  }

  // 2.6: "Found 2 moments: Title 4:05 · ..." with each linked to the scene
  // at the marker's time (result card, history rows).
  const MOMENT_ICON = line('<path d="M4 2.5h8v11l-4-3-4 3z"/>');
  function momentsHtml(e) {
    const links = momentLinks(e);
    if (!links.length) return "";
    return `<span class="ld-moments">${MOMENT_ICON}<span>${tc(`找到 ${plural(links.length, "moment", "moments")}：`, `Found ${plural(links.length, "moment", "moments")}:`)}</span> ` +
      links.map((l) => `<a class="ld-mlink" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join(`<i>·</i>`) + `</span>`;
  }
  // A plain click on a moment link goes through Stash's router (and the
  // lock's route check, if a run is on); middle and modified clicks are the
  // browser's.
  function momentClick(ev, after) {
    const a = ev.target.closest && ev.target.closest("a.ld-mlink");
    if (!a || ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return false;
    ev.preventDefault();
    if (after) after();
    navigate(a.getAttribute("href"));
    return true;
  }

  // Row buttons: remove (the first click asks, a second within 6 s removes;
  // no dialogs) and play again. `after(data)` re-renders with what Stash
  // now holds; `entries()` is the list the rows came from.
  function wireRows(box, after, entries) {
    box.addEventListener("click", async (ev) => {
      if (momentClick(ev, closeModal)) return;
      const again = ev.target.closest && ev.target.closest(".ld-again");
      if (again) {
        const e = entries().find((x) => entryKey(x) === again.closest(".ld-row").dataset.key);
        if (e) openStart({ setup: setupFromEntry(e),
                           target: { kind: e.kind || "performer", id: String(e.tid || e.pid), name: e.name, image_path: e.image,
                                     ...(e.tags ? { tags: e.tags, mode: e.mode } : {}) } });
        return;
      }
      const btn = ev.target.closest && ev.target.closest(".ld-del");
      if (!btn) return;
      const row = btn.closest(".ld-row");
      if (!row.classList.contains("ld-confirm")) {
        box.querySelectorAll(".ld-row.ld-confirm").forEach((r) => r.classList.remove("ld-confirm"));
        row.classList.add("ld-confirm");
        btn.innerHTML = tc("再点一次移除", "Click again to remove");
        setTimeout(() => { if (row.isConnected && row.classList.contains("ld-confirm")) {
          row.classList.remove("ld-confirm"); btn.innerHTML = TRASH; } }, ARM_MS);
        return;
      }
      btn.innerHTML = "…";
      try { after(await removeEntry(row.dataset.key)); }
      catch (e) { btn.innerHTML = tc("失败", "Failed"); log(`${tc("移除失败：", "Remove failed:")} ${e.message}`, "error"); ldToast(tc(`未能移除：${e.message}`, `Not removed: ${e.message}`), "error"); }
    });
  }

  // Clear everything: the first click names the count, a second clears.
  function wireClear(btn, count, after) {
    let armed = false, t = null;
    btn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        btn.textContent = tc(`再点一次可清空全部 ${typeof count === "function" ? count() : count}`, `Click again to clear all ${typeof count === "function" ? count() : count}`);
        btn.classList.add("ld-armed");
        t = setTimeout(() => { armed = false; btn.innerHTML = `${TRASH} ${tc("清空历史", "Clear history")}`; btn.classList.remove("ld-armed"); }, ARM_MS);
        return;
      }
      clearTimeout(t);
      btn.textContent = tc("清空中…", "Clearing…");
      try { after(await clearHistory()); }
      catch (e) { btn.textContent = tc("失败", "Failed"); log(`Clear failed: ${e.message}`, "error"); ldToast(tc(`未能清空：${e.message}`, `Not cleared: ${e.message}`), "error"); }
    });
  }

  // ── Start dialog: a game setup ────────────────────────────────────────────

  const guideHtml = () => tc(`<div class="ld-guide" data-a="guide">
      <b>一盘是怎么运作的</b>
      <ol>
        <li><b>锁给谁。</b> 一名演员、一个工作室（含其子工作室）或一个标签（含其子标签）。锁定期间，
          Stash 只打开他们的场景、图片和画廊，在你所有设备上都是如此。</li>
        <li><b>怎么出去。</b> <i>完成</i>：射出来就出局。<i>计时</i>：等它走完。<i>边缘</i>：在设定时间内忍住不射；
          每次 O 都算一次失误，会加时间。一旦达标你就出局、分数入账；你可以在那里射出来，也可以进入加时继续：
          每多看一分钟再加 10 分（乘以热度），最多再补一个目标时长，直到一次 O、按停止，或时间走满。</li>
        <li><b>热度。</b> 各种条件让这一盘更难。每一点热度给分数加 20%。没有必选的条件：
          热度 0 就是无负担的一盘。</li>
        <li><b>分数。</b> 观看分钟数 × 10，每次跳过减 5（最多扣掉观看所得的一半），边缘模式每次 O 减 100，边缘加时每分钟加 10，出局再加 100，全部
          再乘以热度加成。只有成功出局的对局才计分。</li>
        <li><b>时间轴。</b> 你看过的部分显示为蓝色。在那里拖动是免费的；其他地方会用掉一次跳过（见
          跳过配额）。</li>
        <li><b>瞬间。</b> 在一盘中给某个场景添加标记，且你已看过它 2 分钟，就算作你找到的一个瞬间：
          每个场景一个，每盘五个。有跳过配额时，它给该场景多一次跳过。这一盘会列出它们，并链接到对应位置。</li>
        <li><b>卡住了？</b> 在顶栏里长按 <i>放弃</i> 5 秒。会记为一次放弃。</li></ol>
      <button class="ld-link" data-a="gotit">知道了</button></div>`, `<div class="ld-guide" data-a="guide">
      <b>How a run works</b>
      <ol>
        <li><b>Who.</b> A performer, a studio (with its sub-studios) or a tag (with its sub-tags). While you're locked,
          Stash only opens their scenes, images and galleries, on every device.</li>
        <li><b>Way out.</b> <i>Finish</i>: finish to get out. <i>Timer</i>: wait it out. <i>Edge</i>: watch for the set time
          without finishing; each O is a slip that adds time. Once you reach it you're out and the score is banked; you can
          finish there or keep going in overtime: each minute watched adds 10 more (times heat), up to the target's length
          again, until an O, Stop, or the time is full.</li>
        <li><b>Heat.</b> Conditions make the run harder. Each point of heat adds 20% to your score. None are required:
          heat 0 is a free run.</li>
        <li><b>Score.</b> Watched minutes × 10, minus 5 per skip (at most half of what watching earned), minus 100 per O in Edge, plus 10 per minute of Edge overtime, plus 100 for getting out, all
          times your heat bonus. Only runs you get out of are scored.</li>
        <li><b>The timeline.</b> What you've watched shows blue. Seeking there is free; anywhere else uses a skip (see
          Skip budget).</li>
        <li><b>Moments.</b> Add a marker to a scene during a run, once you've watched 2 minutes of it, and it counts as a
          moment you found: one per scene, five per run. With a Skip budget it gives that scene one more skip. The run
          lists them, linked to the spot.</li>
        <li><b>Stuck?</b> Hold <i>Give up</i> in the bar for 5 seconds. It counts as a give-up.</li></ol>
      <button class="ld-link" data-a="gotit">Got it</button></div>`);

  // How each number in the setup steps, and how it reads.
  const STEP = {
    os: (v, d) => clamp(v + d, 1, 5, 1),
    timerMin: stepMinutes,
    edgeMin: stepMinutes,
  };
  const SHOW = {
    os: (v) => plural(v, "O", "O's"), timerMin: fmtMinutes, edgeMin: fmtMinutes,
  };
  const stepperHtml = (key) =>
    `<span class="ld-stepper" data-s="${key}"><button data-d="-1" aria-label="${tc("减少", "Less")}">−</button><b></b><button data-d="1" aria-label="${tc("增加", "More")}">+</button></span>`;
  // A time: typed in (any whole minute), or stepped by a quarter hour.
  const timeHtml = (key) =>
    `<span class="ld-stepper ld-timebox" data-s="${key}"><button data-d="-1" aria-label="${tc("减少 15 分钟", "15 minutes less")}">−</button>` +
    `<input class="ld-time" data-time="${key}" autocomplete="off" spellcheck="false" aria-label="${tc("时长，例如 45、1h30 或 1:30", "Time, for example 45, 1h30 or 1:30")}">` +
    `<button data-d="1" aria-label="${tc("增加 15 分钟", "15 minutes more")}">+</button></span>`;

  // prefill: { setup, target, src } (Play again, Play last setup again).
  // prefill: { setup, target, src } (Play again, Play last setup again).
  // `into`: draw into the Lockdown page instead of a dialog. With the page
  // registered, opening the setup goes to the page.
  function openStart(prefill, into) {
    if (!into && hasPage) { pagePrefill = prefill || null; pageTab = "new"; showPage(); return; }
    const pf = prefill || {};
    const S = normaliseSetup(pf.setup || savedSetup());
    let target = pf.target ? { ...pf.target, id: String(pf.target.id) } : null;
    let src = pf.src || null;            // random pick: { type: "fav" } | { type: "filter", id, name }
    if (target) { S.kind = target.kind; S.pick = "choose"; }
    // Tags can be several (2.2, user feedback): `tagList`, joined by AND or OR;
    // `target` is then the combination (see tagTarget).
    let tagList = target && target.kind === "tag"
      ? (target.tags && target.tags.length ? target.tags.map((x) => ({ id: String(x.id), name: x.name })) : [{ ...target }]) : [];
    if (target && target.mode) S.tagMode = target.mode === "or" ? "or" : "and";
    let tagCount = null, countSeq = 0;
    if (src) S.pick = "random";
    const here = !pf.setup && !target ? targetOnPage() : null;
    if (here) S.kind = here.kind;
    const last = prefs().last;

    const html = `
      <div class="ld-head${into ? " ld-headslim" : ""}">${into ? "" : `<h3>${LOCK_SVG} ${tc("新锁局", "New lockdown")}</h3>`}
        ${last && !prefill ? `<button class="ld-link" data-a="again">${tc("再次使用上次设置", "Play last setup again")}</button>` : ""}
        <button class="ld-link" data-a="help">${tc("它是怎么运作的", "How it works")}</button></div>
      <div data-a="guidebox">${prefs().guideSeen ? "" : guideHtml()}</div>
      <div class="ld-presets" data-a="presets"></div>
      <div class="ld-setup"><div class="ld-setupmain">
      <div class="ld-card"><div class="ld-step"><i>1</i>${tc("你要锁给谁？", "Who are you locked to?")}</div>
        <div class="ld-choices" data-a="kinds">${Object.keys(KINDS).map((k) =>
          `<button class="ld-choice" data-k="${k}"><b>${KIND_ICON[k]} <span><span class="ld-a">A </span>${kl(k)}</span></b></button>`).join("")}</div>
        <div class="ld-seg" data-a="pick"><button data-p="choose">${tc("我来挑", "I'll choose")}</button><button data-p="random">${tc("随机抽取", "Random pick")}</button></div>
        <div data-a="choose"><div class="ld-search">${SEARCH}<input data-a="q" autocomplete="off" spellcheck="false"></div>
          <div class="ld-results" data-a="results"></div></div>
        <div data-a="random"><div class="ld-srcs" data-a="srcs"></div>
          <div class="ld-hint">${tc("按下开始后轮盘转动。", "The wheel spins when you press Start.")}</div></div>
      </div>
      <div class="ld-card"><div class="ld-step"><i>2</i>${tc("怎么出去？", "How do you get out?")}</div>
        <div class="ld-choices" data-a="goals">${Object.entries(goalInfo()).map(([k, [t, sub, ico]]) =>
          `<button class="ld-choice" data-g="${k}"><b>${ico} ${t}</b><small>${sub}</small></button>`).join("")}</div>
        <div class="ld-opts" data-a="goalopt"></div>
        <div class="ld-hint" data-a="goalhint"></div></div>
      <div class="ld-card"><div class="ld-step"><i>3</i>${tc("热度", "Heat")}<span class="ld-heatsum" data-a="heatsum"></span>
          <button class="ld-link ld-clearheat" data-a="clearheat">${tc("清除", "Clear")}</button></div>
        <div class="ld-hint">${tc("各种条件让这一盘更难；每一点热度给分数加 20%。点击某个条件可提升一档，点圆点可直接选档。", "Conditions make the run harder; each point of heat adds 20% to your score. Click a condition to raise it a rank, or a dot to pick its rank.")}</div>
        <div class="ld-conds" data-a="conds"></div></div>
      </div>
      <div class="ld-runcard">
        <div class="ld-step">${tc("你的这一盘", "Your run")}</div>
        <div class="ld-rcwho" data-a="rcwho"></div>
        <div class="ld-rcheat"><span class="ld-bigflame">${FLAME}</span><div><b data-a="heat">0</b><small>${tc("热度", "heat")}</small></div>
          <span class="ld-grow"></span><div class="ld-rcx"><b data-a="mult">×1</b><small>${tc("分数", "score")}</small></div></div>
        <div class="ld-rcchips" data-a="rcchips"></div>
        <div class="ld-rcformula" data-a="formula"></div>
        <button class="ld-start" data-a="start">${LOCK_SVG} ${tc("开始这一盘", "Start run")}</button>
        <div class="ld-err" data-a="err"></div>
        <div class="ld-psave" data-a="psave"><button class="ld-link" data-a="savepreset">${tc("保存为预设", "Save as preset")}</button></div>
        <div class="ld-foot">${tc("锁定这台 Stash 上的所有设备 · 长按「放弃」5 秒可退出 ·", "Locks every device on this Stash · hold Give up for 5 s to quit ·")}
          <button class="ld-link ld-soundbtn" data-a="sound"></button></div>
      </div>
      </div>
      ${into ? "" : `<div class="ld-hist" data-a="hist"><div class="ld-empty">${tc("正在加载历史…", "Loading history…")}</div></div>
      <button class="ld-close" data-a="close">${tc("稍后再说", "Not now")}</button>`}`;
    const box = into ? into : modal(html);
    if (into) into.innerHTML = html;
    const $ = (a) => box.querySelector(`[data-a="${a}"]`);
    const err = (t) => { $("err").textContent = t || ""; };
    $("close")?.addEventListener("click", closeModal);
    let topRuns = [], bestHeat = 0, presets = [];
    readConfig().then((d) => {
      topRuns = (d.stats && d.stats.top) || [];
      bestHeat = (d.stats && d.stats.bestHeat) || 0;
      presets = d.presets || [];
      if (box.isConnected) { render(); renderPresets(); }
    });

    // ── presets (2.3, forum: "save preset run settings with custom names"):
    // who (or where a random pick comes from) and the whole setup, kept with
    // the history in Stash so every device has them
    let presetArmed = null, presetTimer = 0;
    const renderPresets = () => {
      const el = $("presets");
      if (!el) return;
      if (!presets.length) { el.innerHTML = ""; return; }
      el.innerHTML = `<span class="ld-plabel">${tc("预设", "Presets")}</span>` + presets.map((x) =>
        `<span class="ld-preset"><button class="ld-pplay" data-preset="${escapeHtml(x.id)}" title="${escapeHtml(presetLine(x))}">${escapeHtml(x.name)}</button>` +
        `<button class="ld-pdel${presetArmed === x.id ? " ld-armed" : ""}" data-pdel="${escapeHtml(x.id)}" aria-label="${tc("删除 ", "Delete ")}${escapeHtml(x.name)}">${presetArmed === x.id ? tc("再点一次删除", "Click again to delete") : "×"}</button></span>`).join("");
      el.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const x = presets.find((y) => y.id === b.dataset.preset);
        if (x) openStart({ setup: x.setup, target: x.target || undefined, src: x.src || undefined }, into);
      }));
      el.querySelectorAll("[data-pdel]").forEach((b) => b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = b.dataset.pdel;
        clearTimeout(presetTimer);
        if (presetArmed !== id) { presetArmed = id; renderPresets(); presetTimer = setTimeout(() => { presetArmed = null; renderPresets(); }, ARM_MS); return; }
        presetArmed = null;
        presets = presets.filter((y) => y.id !== id);
        renderPresets();
        updateConfig(({ presets: cur }) => ({ presets: (cur || []).filter((y) => y.id !== id) }))
          .then((cfg) => { presets = cfg.presets || presets; renderPresets(); })
          .catch((e) => err(tc(`预设未删除：${e.message}`, `Preset not deleted: ${e.message}`)));
      }));
    };
    const wirePresetSave = () => {
      $("savepreset")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (S.pick === "choose" && !(target && target.kind === S.kind)) { err(tc(`请先选一个${label()}，再保存预设。`, `Pick a ${label()} first, then save the preset.`)); return; }
        if (S.pick === "random" && !src) { err(tc("请先选择随机抽取的来源。", "Pick where the random pick comes from first.")); return; }
        const sug = S.pick === "choose" ? `${target.name} · ${goalInfo()[S.goal][0]}` : tc(`随机${label()} · ${goalInfo()[S.goal][0]}`, `Random ${label()} · ${goalInfo()[S.goal][0]}`);
        $("psave").innerHTML = `<input class="ld-pname" data-a="pname" maxlength="40" autocomplete="off" spellcheck="false" aria-label="${tc("预设名称", "Preset name")}">` +
          `<button class="ld-link" data-a="psok">${tc("保存", "Save")}</button><button class="ld-link" data-a="psno">${tc("取消", "Cancel")}</button>`;
        const inp = $("pname");
        inp.value = sug.slice(0, 40);
        inp.focus(); inp.select();
        const close = () => { $("psave").innerHTML = `<button class="ld-link" data-a="savepreset">${tc("保存为预设", "Save as preset")}</button>`; wirePresetSave(); };
        const save = () => {
          const name = inp.value.trim().slice(0, 40);
          if (!name) { err(tc("请给预设起个名字。", "Give the preset a name.")); return; }
          const x = presetOf(name, S, S.pick === "choose" ? target : null, S.pick === "random" ? src : null, Date.now());
          close();
          updateConfig(({ presets: cur }) => ({ presets: addPreset(cur || [], x) }))
            .then((cfg) => { presets = cfg.presets || presets; renderPresets(); ldToast(tc(`已保存“${name}”`, `Saved “${name}”`), "done"); })
            .catch((e) => err(tc(`预设未保存：${e.message}`, `Preset not saved: ${e.message}`)));
        };
        inp.addEventListener("keydown", (e) => {
          e.stopPropagation();                      // keep Stash and QuickTools keys out of the box
          if (e.key === "Enter") { e.preventDefault(); save(); }
          else if (e.key === "Escape") { e.preventDefault(); close(); }
        });
        $("psok").addEventListener("click", (e) => { e.stopPropagation(); save(); });
        $("psno").addEventListener("click", (e) => { e.stopPropagation(); close(); });
      });
    };
    wirePresetSave();
    const soundLabel = () => { $("sound").textContent = prefs().sound === false ? tc("音效关闭", "Sounds off") : tc("音效开启", "Sounds on"); };
    soundLabel();
    $("sound").addEventListener("click", (ev) => {
      ev.stopPropagation();
      setPref("sound", prefs().sound === false);
      soundLabel();
      if (prefs().sound !== false) sound("start");
    });

    // the guide: shown until "Got it", back with "How it works"
    const wireGuide = () => $("gotit")?.addEventListener("click", () => { setPref("guideSeen", true); $("guidebox").innerHTML = ""; });
    wireGuide();
    $("help").addEventListener("click", () => { $("guidebox").innerHTML = $("guidebox").innerHTML ? "" : guideHtml(); wireGuide(); });
    $("again")?.addEventListener("click", () => openStart(prefs().last, into));

    // ── who: search, or a random pick from favourites or a saved filter
    let results = [], hi = 0, seq = 0, timer = null, saved = [], favN = null, srcSeq = 0;
    const counts = {};
    const label = () => kl(S.kind);
    const renderResults = () => {
      const typed = $("q").value.trim();
      // the tags chosen so far, each with an x, and how they combine
      if (!typed && S.kind === "tag" && tagList.length) {
        const two = tagList.length > 1;
        $("results").innerHTML = `<div class="ld-tagpick">${tagList.map((x, i) => `${i ? `<span class="ld-tagjoin">${S.tagMode === "or" ? tc("或", "or") : tc("且", "and")}</span>` : ""}` +
            `<span class="ld-tagchip">${escapeHtml(x.name)}<button data-untag="${i}" aria-label="${tc("移除 ", "Remove ")}${escapeHtml(x.name)}">×</button></span>`).join("")}
            <span class="ld-tagmore">${tagList.length < 6 ? tc("搜索可再加一个", "search to add another") : ""}</span></div>
          ${two ? `<div class="ld-tagmode"><span class="ld-seg ld-mini"><button data-tm="and" class="${S.tagMode !== "or" ? "ld-on" : ""}">${tc("且", "AND")}</button>` +
            `<button data-tm="or" class="${S.tagMode === "or" ? "ld-on" : ""}">${tc("或", "OR")}</button></span>` +
            `<span class="ld-hint">${tagCount === null ? tc("统计中…", "Counting…") : !tagCount ? "" : !tagCount.s && !tagCount.i
              ? `<b class="ld-coral">${tc("没有任何场景或图片" + (S.tagMode === "or" ? "拥有其中任意一个" : "同时拥有全部") + "。", `No scene or image has ${S.tagMode === "or" ? "any" : "all"} of these.`)}</b>`
              : `${tagCount.s ? plural(tagCount.s, "scene", "scenes") : `${plural(tagCount.i, "image", "images")}${tc("\uff08仅有图片\uff09", " (images only)")}`} ${tc(S.tagMode === "or" ? "，拥有其中任意一个。" : "，同时拥有全部。", S.tagMode === "or" ? "with any of these." : "with all of these.")}`}</span></div>` : ""}`;
        $("results").querySelectorAll("[data-untag]").forEach((b) => b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          tagList.splice(+b.dataset.untag, 1);
          tagsChanged();
        }));
        $("results").querySelectorAll("[data-tm]").forEach((b) => b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          S.tagMode = b.dataset.tm;
          tagsChanged();
        }));
        return;
      }
      const list = typed ? results : (target && target.kind === S.kind ? [target] : []);
      if (!list.length) {
        $("results").innerHTML = typed ? `<div class="ld-hint">${tc(`没有带场景或图片的${label()}匹配“${escapeHtml(typed)}”。`, `No ${label()} with scenes or images matches “${escapeHtml(typed)}”.`)}</div>` : "";
        return;
      }
      hi = Math.min(hi, list.length - 1);
      $("results").innerHTML = list.map((p, i) =>
        `<div class="ld-res${i === hi && typed ? " ld-hi" : ""}${target && String(p.id) === target.id && target.kind === S.kind ? " ld-sel" : ""}" data-i="${i}">` +
        `<span class="ld-av">${avatarHtml(p.name, p.image_path)}</span><span class="ld-rname">${escapeHtml(p.name)}</span>` +
        `<span class="ld-rmeta">${imageOnly(p) ? `${plural(p.image_count, "image", "images")} · <i>${tc("仅有图片", "images only")}</i>`
          : p.scene_count !== undefined ? plural(p.scene_count, "scene", "scenes") : ""}</span><span class="ld-tick">✓</span></div>`).join("");
      $("results").querySelectorAll(".ld-res").forEach((el) => el.addEventListener("click", () => {
        pickTarget(list[+el.dataset.i]);
      }));
    };
    // The chosen tags as one target: the first tag's id and picture, all of them
    // in `tags`, how they combine in `mode`.
    const tagTarget = () => {
      if (!tagList.length) return null;
      if (tagList.length === 1) return { ...tagList[0], kind: "tag" };
      return { ...tagList[0], kind: "tag", name: tagsName(tagList, S.tagMode), tags: tagList.map((x) => ({ id: x.id, name: x.name })),
               mode: S.tagMode === "or" ? "or" : "and" };
    };
    const tagsChanged = () => {
      target = tagTarget();
      tagCount = null;
      err("");
      renderResults();
      render();
      if (tagList.length < 2) return;
      const mine = ++countSeq;
      Promise.all([countTagScenes(tagList, S.tagMode), countTagImages(tagList, S.tagMode)])
        .then(([n, ni]) => { if (mine === countSeq) { tagCount = { s: n, i: ni }; renderResults(); render(); } })
        .catch(() => { if (mine === countSeq) { tagCount = undefined; renderResults(); } });
    };
    const pickTarget = (p) => {
      if (S.kind === "tag") {
        if (!tagList.some((x) => x.id === String(p.id)) && tagList.length < 6) {
          tagList.push({ id: String(p.id), name: p.name, image_path: p.image_path, scene_count: p.scene_count, image_count: p.image_count });
        }
        $("q").value = "";
        results = [];
        tagsChanged();
        return;
      }
      target = { kind: S.kind, id: String(p.id), name: p.name, image_path: p.image_path, scene_count: p.scene_count, image_count: p.image_count };
      $("q").value = "";
      results = [];
      err("");
      renderResults();
      render();
    };
    $("q").addEventListener("input", () => {
      clearTimeout(timer);
      hi = 0;
      const term = $("q").value.trim();
      if (!term) { results = []; renderResults(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try { const r = await searchTargets(S.kind, term); if (mine === seq) { results = r; renderResults(); } }
        catch (e) { err(tc(`搜索失败：${e.message}`, `Search failed: ${e.message}`)); }
      }, 180);
    });
    $("q").addEventListener("keydown", (ev) => {
      ev.stopPropagation();                 // keep Stash and QuickTools keys out of the box
      const typed = $("q").value.trim();
      if (ev.key === "ArrowDown" && typed) { ev.preventDefault(); hi = Math.min(results.length - 1, hi + 1); renderResults(); }
      else if (ev.key === "ArrowUp" && typed) { ev.preventDefault(); hi = Math.max(0, hi - 1); renderResults(); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        if (typed && results[hi]) pickTarget(results[hi]);
        else if (!typed && target) start();
      }
      else if (ev.key === "Escape") closeModal();
    });

    const renderSources = () => {
      const k = S.kind;
      const row = (key, ico, name, meta, cls = "") =>
        `<div class="ld-res${src && srcKey(src) === key ? " ld-sel" : ""}${cls}" data-src="${escapeHtml(key)}">` +
        `<span class="ld-av">${ico}</span><span class="ld-rname">${escapeHtml(name)}</span>` +
        `<span class="ld-rmeta">${escapeHtml(meta)}</span><span class="ld-tick">✓</span></div>`;
      let html = row("fav", HEART, tc("收藏", "Favourites"), favN === null ? "…" : favN ? kp(k, favN) : `${tc("没有收藏的" + ((KIND_ZH[k] || {}).plural || k), `no favourite ${KINDS[k].plural}`)}`);
      html += saved.map((f) => {
        const c = counts[`${k}:${f.id}:${imagesOk(S) ? 1 : 0}`];
        const meta = c === undefined ? "…" : c === null ? tc("不可用", "can't use") : kp(k, c);
        return row(`f:${f.id}`, FUNNEL, f.name, meta, c === null ? " ld-cant" : "");
      }).join("");
      if (!saved.length) html += `<div class="ld-hint">${tc("已保存的" + kl(k) + "筛选也会显示在这里。", `Saved ${kl(k)} filters show up here too.`)}</div>`;
      $("srcs").innerHTML = html;
      $("srcs").querySelectorAll("[data-src]").forEach((el) => el.addEventListener("click", () => {
        const key = el.dataset.src;
        if (key === "fav") src = { type: "fav" };
        else { const f = saved.find((x) => `f:${x.id}` === key); if (f) src = { type: "filter", id: String(f.id), name: f.name }; }
        err("");
        renderSources();
        render();
      }));
    };
    const srcKey = (s) => (s.type === "fav" ? "fav" : `f:${s.id}`);
    const loadSources = () => {
      const k = S.kind, mine = ++srcSeq;
      favN = null; saved = [];
      renderSources();
      const img = imagesOk(S);
      favouritesOf(k, img).then((l) => { if (mine === srcSeq) { favN = l.length; renderSources(); } })
        .catch(() => { if (mine === srcSeq) { favN = 0; renderSources(); } });
      savedFiltersOf(k).then((l) => {
        if (mine !== srcSeq) return;
        saved = l;
        renderSources();
        for (const f of l) {
          const key = `${k}:${f.id}:${img ? 1 : 0}`;
          if (key in counts) continue;
          countFor(k, f, img).then((n) => { counts[key] = n; if (mine === srcSeq) renderSources(); })
            .catch(() => { counts[key] = null; if (mine === srcSeq) renderSources(); });
        }
      }).catch(() => {});
    };

    // the chosen target, or tag combination, has images and no scenes
    const pickedImageOnly = () => S.pick === "choose" && !!target && target.kind === S.kind &&
      (target.tags ? !!tagCount && !tagCount.s && tagCount.i > 0 : imageOnly(target));
    let lastImg = null;

    // ── the rest of the setup, redrawn from S
    const render = () => {
      // random picks: images-only targets join the pool only for the ways
      // out that can use them, so the counts change with the way out
      const img = imagesOk(S);
      if (lastImg !== null && img !== lastImg && S.pick === "random") loadSources();
      lastImg = img;
      const io = pickedImageOnly();
      box.querySelectorAll("[data-k]").forEach((b) => b.classList.toggle("ld-on", b.dataset.k === S.kind));
      box.querySelectorAll("[data-p]").forEach((b) => b.classList.toggle("ld-on", b.dataset.p === S.pick));
      $("choose").hidden = S.pick !== "choose";
      $("random").hidden = S.pick !== "random";
      $("q").placeholder = tc(`搜索${(KIND_ZH[S.kind] || {}).plural || "条目"}`, `Search ${KINDS[S.kind].plural}`);
      box.querySelectorAll("[data-g]").forEach((b) => b.classList.toggle("ld-on", b.dataset.g === S.goal));
      $("goalopt").innerHTML = S.goal === "finish" ? `<span>${tc("出局条件", "Get out after")}</span>${stepperHtml("os")}`
        : S.goal === "timer" ? `<span>${S.timerBy === "locked" ? tc("锁定", "Locked for") : tc("观看", "Watch for")}</span>${timeHtml("timerMin")}` +
            `<span class="ld-seg ld-mini"><button data-tb="watched" class="${S.timerBy !== "locked" ? "ld-on" : ""}">${tc("观看时间", "watched time")}</button>` +
            `<button data-tb="locked" class="${S.timerBy === "locked" ? "ld-on" : ""}">${tc("锁定时间", "locked time")}</button></span>`
        : `<span>${tc("观看", "Watch")}</span>${timeHtml("edgeMin")}<span>${tc("但不看完", "without finishing")}</span>`;
      const goal = goalOf(S);
      $("goalhint").textContent = S.goal === "finish"
        ? tc("像平时一样在 Stash 里按 O 键；Lockdown 会在几秒内察觉，任何页面、任何设备都行。", "Press the O button in Stash as usual; Lockdown notices within seconds, from any page or device.")
        : S.goal === "timer"
        ? (S.timerBy === "locked" ? tc("只要处于锁定状态，计时就一直在走。", "The clock runs whenever you're locked.") : tc("只有场景真正在播放的时间才算数。", "Only time a scene is actually playing counts.")) + tc(" O 不会让它提前结束。", " An O doesn't end it early.")
        : `${tc("只有场景播放的时间才算数。每次 O 都是一次失误，扣 100 分；", "Only time a scene plays counts. Every O is a slip that costs 100 points;")} ${slipText(goal)}.`;
      // the heat list: conditions for this way out (none for images only)
      const heat = io ? 0 : heatOf(S.conds, S.goal);
      const covered = (c) => c.k === "stay" && S.goal === "timer" && !!S.conds.one;   // One scene does it already
      const free = conditions().filter((c) => c.noHeat && condApplies(c, S.goal));
      $("conds").innerHTML = conditions().filter((c) => !c.noHeat && condApplies(c, S.goal)).map((c) => {
        const r = S.conds[c.k] || 0;
        return `<div class="ld-cond${r ? " ld-on" : ""}" data-cond="${c.k}">` +
          `<span class="ld-condico">${COND_ICON[c.k]}</span>` +
          `<span class="ld-condtxt"><b>${escapeHtml(c.name)}</b>${r ? `<em>${escapeHtml(c.ranks[r - 1])}</em>` : ""}<small>${escapeHtml(c.text)}</small></span>` +
          `<span class="ld-pips">${c.ranks.map((rk, i) => `<button class="ld-pip${i < r ? " ld-on" : ""}" data-pip="${i + 1}" ` +
            `title="${escapeHtml(rk)} · +${c.heat[i]} ${tc("热度", "heat")}" aria-label="${escapeHtml(c.name)}: ${escapeHtml(rk)}"></button>`).join("")}</span>` +
          `<span class="ld-condheat"${covered(c) && r ? ` title="${tc("单一场景已经让你停留在一个场景上", "One scene already keeps you on one scene")}"` : ""}>${r ? (covered(c) ? "+0" : `+${c.heat[r - 1]}`) : "0"}</span></div>`;
      }).join("") + (free.length ? `<div class="ld-noheat"><span>${tc("无热度", "No heat")}</span>${free.map((c) =>
          `<button class="ld-nhchip${S.conds[c.k] ? " ld-on" : ""}" data-cond="${c.k}" title="${escapeHtml(c.text)}"><i></i>${COND_ICON[c.k]} ${escapeHtml(c.name)}</button>`).join("")}
          <small>${tc("只是偏好，不是挑战", "a preference, not a challenge")}</small></div>` : "");
      $("conds").classList.toggle("ld-condsoff", io);
      if (io) $("conds").insertAdjacentHTML("afterbegin", `<div class="ld-hint ld-ionote">${escapeHtml(target.name)} ${tc("只有图片，没有场景", "has images only, no scenes")}: ` +
        `${imagesOk(S) ? tc("其中一张图片上的 O 也算数。条件是针对场景的，所以这次锁定不启用条件。", "an O on one of the images counts. Conditions are about scenes, so they're off for this run.") : tc("<b class=\"ld-coral\">选「完成」，或按锁定时间的「计时」。</b>", "<b class=\"ld-coral\">pick Finish, or Timer by locked time.</b>")}</div>`);
      $("heatsum").innerHTML = heat ? `${FLAME} ${heat}` : "";
      $("clearheat").hidden = !heat;
      box.querySelectorAll(".ld-stepper").forEach((st) => {
        const shown = SHOW[st.dataset.s](S[st.dataset.s]);
        const b = st.querySelector("b"), inp = st.querySelector("input");
        if (b) b.textContent = shown;
        if (inp && document.activeElement !== inp) inp.value = shown;
      });
      const who = S.pick === "choose"
        ? (target && target.kind === S.kind ? `<b>${escapeHtml(target.name)}</b>${S.kind === "performer" ? "" : ` (${label()})`}` : tc(`你挑选的${label()}`, `the ${label()} you pick`))
        : `${tc("随机", "a random")} ${label()}${tc("，来自 ", " from ")}${src ? (src.type === "fav" ? tc("你的收藏", "your favourites") : `“${escapeHtml(src.name)}”`) : "…"}`;
      // the run card: who, the deal, heat, what it is worth
      const tgt = S.pick === "choose" && target && target.kind === S.kind ? target : null;
      const way = briefing(S, "\u0000").deal.replace(/^Only \u0000, /, "").replace(/\.$/, "");
      $("rcwho").innerHTML = `<span class="ld-av ld-big">${tgt ? avatarHtml(tgt.name, tgt.image_path) : "<i>?</i>"}</span>` +
        `<div><b>${S.pick === "choose" ? (tgt ? escapeHtml(tgt.name) : tc(`挑一个${label()}`, `Pick a ${label()}`)) : who}</b><small>${escapeHtml(way)}</small></div>`;
      $("heat").textContent = String(heat);
      $("mult").textContent = `×${heatMult(heat)}`;
      $("rcchips").innerHTML = `<span class="ld-pill">${goalInfo()[S.goal][2]} ${escapeHtml(goalLabel(goal))}</span>` +
        (io ? `<span class="ld-pill">${tc("仅有图片", "images only")}</span>` : "") +
        conditions().filter((c) => !io && S.conds[c.k] && condApplies(c, S.goal))
          .map((c) => `<span class="ld-pill ld-condpill">${COND_ICON[c.k]} ${escapeHtml(c.ranks[S.conds[c.k] - 1])}</span>`).join("");
      const best = topRuns.filter((x) => goalType(x) === S.goal).reduce((a, x) => Math.max(a, x.score || 0), 0);
      $("formula").innerHTML = `${tc("计分：观看分钟数 × 10，每次跳过 −5（最多扣一半）", "Score: watched minutes × 10, −5 per skip (at most half)")}${S.goal === "edge" ? tc("，每次 O −100，加时分钟数 × 10", ", −100 per O, overtime minutes × 10") : ""}${tc("，出局 +100，", ", +100 for getting out, ")}` +
        `${tc("再乘以热度加成 " + heatMult(heat) + "（热度 " + heat + "）。", "× " + heatMult(heat) + " for heat " + heat + ".")}` +
        (bestHeat || best ? `<br>${bestHeat ? tc(`出局时的最高热度：<b>${bestHeat}</b>`, `Highest heat you got out of: <b>${bestHeat}</b>`) : ""}` +
          `${bestHeat && best ? " · " : ""}${best ? tc(`最佳${goalInfo()[S.goal][0]}分数：<b>${best.toLocaleString()}</b>`, `best ${goalInfo()[S.goal][0]} score: <b>${best.toLocaleString()}</b>`) : ""}` : "");
      setPref("setup", S);
    };

    box.addEventListener("click", (ev) => {
      // a condition: a dot sets its rank (the current top dot lowers it),
      // anywhere else on the row raises it one, past the last turns it off
      const row = ev.target.closest && ev.target.closest("[data-cond]");
      if (row && box.contains(row)) {
        const c = conditions().find((x) => x.k === row.dataset.cond);
        const pip = ev.target.closest("[data-pip]");
        const r = S.conds[c.k] || 0;
        const next = pip ? (+pip.dataset.pip === r ? r - 1 : +pip.dataset.pip) : (r + 1) % (c.ranks.length + 1);
        S.conds = { ...S.conds, [c.k]: next };
        if (!next) delete S.conds[c.k];
        err("");
        render();
        return;
      }
      const el = ev.target.closest && ev.target.closest("button");
      if (!el || !box.contains(el)) return;
      if (el.dataset.k) {
        if (S.kind !== el.dataset.k) { tagList = []; tagCount = null; }
        if (S.kind !== el.dataset.k) { S.kind = el.dataset.k; src = null; results = []; $("q").value = ""; loadSources(); renderResults(); }
      } else if (el.dataset.p) {
        S.pick = el.dataset.p;
        if (S.pick === "choose") setTimeout(() => $("q").focus(), 0);
      } else if (el.dataset.g) S.goal = el.dataset.g;
      else if (el.dataset.tb) S.timerBy = el.dataset.tb;
      else if (el.dataset.a === "clearheat") S.conds = {};
      else if (el.parentElement && el.parentElement.dataset.s && el.dataset.d) {
        const k = el.parentElement.dataset.s;
        S[k] = STEP[k](S[k], +el.dataset.d);
      } else return;
      err("");
      render();
    });

    // a typed time: taken as typed (whole minutes, 1 min to a day), on Enter
    // or leaving the box; something unreadable puts back what was there
    box.addEventListener("keydown", (ev) => {
      if (!ev.target.dataset || !ev.target.dataset.time) return;
      ev.stopPropagation();                         // Stash's and QuickTools' keys stay out
      if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
    });
    box.addEventListener("change", (ev) => {
      const k = ev.target.dataset && ev.target.dataset.time;
      if (!k) return;
      const v = parseMinutes(ev.target.value);
      if (v === null) { err(tc("输入时长，例如 45、90m、1h30 或 1:30。", "Type a time like 45, 90m, 1h30 or 1:30.")); render(); return; }
      const kept = Math.min(MAX_MIN, Math.max(MIN_MIN, v));
      S[k] = kept;
      err(kept !== v ? tc("时长从 1 分钟到 24 小时。", "Times go from 1 minute to 24 hours.") : "");
      render();
    });

    const start = async () => {
      err("");
      if (lock) { err(tc("已经有一个锁局在进行了。", "A lockdown is already running.")); return; }
      if (S.pick === "choose") {
        if (!target || target.kind !== S.kind) { err(`${tc("请先挑一个" + label() + "：", "Pick a " + label() + " first: ")}${tc("请在上方搜索一个。", "search for one above.")}`); $("q").focus(); return; }
        if (target.tags && tagCount && !tagCount.s && !tagCount.i) { err(tc(`没有任何场景或图片${S.tagMode === "or" ? "拥有其中任意一个" : "同时拥有全部"}。`, `No scene or image has ${S.tagMode === "or" ? "any" : "all"} of these tags.`)); return; }
        const io = pickedImageOnly();
        if (io && !imagesOk(S)) { err(`${target.name} ${tc("仅有图片", "has images only")}: ${tc("选「完成」，或按锁定时间的「计时」。", "pick Finish, or Timer by locked time.")}`); return; }
        const run = io ? { ...S, conds: {} } : S;
        setPref("last", { setup: { ...S }, target });
        begin(target, "chosen", run);
        return;
      }
      if (!src) { err(tc("请选择随机抽取的来源。", "Pick where the random pick comes from.")); return; }
      const btn = $("start");
      btn.disabled = true;
      try {
        const f = src.type === "filter" ? saved.find((x) => String(x.id) === src.id) : null;
        if (src.type === "filter" && !f) { err(tc("那个已保存的筛选器不见了。", "That saved filter is gone.")); return; }
        const list = src.type === "fav" ? await favouritesOf(S.kind, imagesOk(S)) : await targetsFor(S.kind, f, imagesOk(S));
        if (!list.length) { err(tc(`那里没有带${imagesOk(S) ? "场景或图片" : "场景"}的${kl(S.kind)}可供抽取。`, `No ${KINDS[S.kind].plural} with ${imagesOk(S) ? "scenes or images" : "scenes"} to pick from there.`)); return; }
        setPref("last", { setup: { ...S }, src });
        const how = src.type === "fav" ? tc("从收藏中随机", "random from favourites") : tc(`从“${src.name}”中随机`, `random from “${src.name}”`);
        spin(list.map((x) => ({ ...x, kind: S.kind })), how, { ...S });
      } catch (e) {
        err(`${tc("无法从中挑选：", "Can't pick from that:")} ${e.message}.`);
      } finally { if (btn.isConnected) btn.disabled = false; }
    };
    $("start").addEventListener("click", start);

    render();
    loadSources();
    renderResults();
    const ph = into && pageEl && pageEl.querySelector(".ld-pagehead");
    if (ph) { ph.querySelector(".ld-headslim")?.remove(); ph.insertBefore(box.querySelector(".ld-headslim"), ph.querySelector(".ld-tabs")); }
    if (here && !target) {
      targetById(here.kind, here.id).then((p) => {
        if (p && (p.scene_count > 0 || p.image_count > 0) && !target) {
          target = { kind: here.kind, id: String(p.id), name: p.name, image_path: p.image_path, scene_count: p.scene_count, image_count: p.image_count };
          if (here.kind === "tag") tagList = [{ ...target }];
          renderResults(); render();
        }
      }).catch(() => {});
    }
    if (S.pick === "choose") setTimeout(() => $("q").focus(), 0);

    if (!into) readConfig().then((data) => { if ($("hist")) renderPreview($("hist"), data); });
  }

  // How many a saved filter picks from, for its row. Performers are
  // counted by the query; studios and tags by listing (their scene counts
  // include what is under them, which the filter cannot ask for).
  async function countFor(kind, saved, images) {
    if (kind !== "performer" || images) return (await targetsFor(kind, saved, images)).length;
    const filter = toGraphQLFilter(saved.object_filter, await fieldTypesOf(kind));
    if (!filter.scene_count) filter.scene_count = { modifier: "GREATER_THAN", value: 0 };
    const d = await gql(`query ($x: PerformerFilterType, $f: FindFilterType) {
                           findPerformers(performer_filter: $x, filter: $f) { count } }`,
                        { x: filter, f: { per_page: 1, q: saved.find_filter?.q || undefined } });
    return d?.findPerformers?.count ?? 0;
  }

  // The dialog's history: tiles, the last 30 as a strip, the latest 5, and
  // the way into the full view.
  function renderPreview(box, data) {
    const { list, stats } = data;
    const entries = list.filter(isEntry);
    if (!stats.done && !stats.gaveUp) {
      box.innerHTML = `<div class="ld-empty">${tc("还没有锁局。你的水滴和 X 都会显示在这里。", "No lockdowns yet. Your drops and X's will show up here.")}</div>`;
      return;
    }
    const now = Date.now();
    box.innerHTML =
      `<div class="ld-hhead"><b>${tc("你的历史", "Your history")}</b><button class="ld-link ld-danger" data-a="clear">${TRASH} ${tc("清空历史", "Clear history")}</button></div>` +
      tilesHtml(stats) +
      `<div class="ld-strip" title="${tc("最近 " + Math.min(30, entries.length) + " 条，最早的在前", "Last " + Math.min(30, entries.length) + ", oldest first")}">` +
        entries.slice(-30).map((e) => `<span title="${escapeHtml(e.name || "")} · ${escapeHtml(fmtDuration(e.ms))}">${icon(e)}</span>`).join("") +
      `</div>` +
      `<div class="ld-total">${escapeHtml(fmtDuration(stats.totalMs))} ${tc("累计锁定", "locked in total")}</div>` +
      `<div class="ld-rows">${entries.slice(-5).reverse().map((e) => rowHtml(e, now)).join("")}</div>` +
      `<button class="ld-link ld-all" data-a="all">${tc("查看全部历史", "See all history")} (${stats.done + stats.gaveUp}) →</button>`;
    const rerender = (d) => renderPreview(box, d);
    wireRows(box.querySelector(".ld-rows"), rerender, () => entries);
    wireClear(box.querySelector('[data-a="clear"]'), stats.done + stats.gaveUp, rerender);
    box.querySelector('[data-a="all"]').addEventListener("click", () => openHistory(data));
  }

  // ── Full history ──────────────────────────────────────────────────────────

  const PAGE = 30;

  function openHistory(data, into) {
    if (!into && hasPage) { pageTab = "history"; showPage(); return; }
    let { list, stats } = data;
    let filter = "all", q = "", shown = PAGE;
    const html = `
      <div class="ld-head"><h3>${into ? "" : `<button class="ld-back" data-a="back" aria-label="${tc("返回", "Back")}">←</button> `}${tc("你的历史", "Your history")}</h3>
        <button class="ld-link ld-danger" data-a="clear">${TRASH} ${tc("清空历史", "Clear history")}</button></div>
      <div data-a="tiles"></div>
      <div class="ld-total" data-a="total"></div>
      <div class="ld-filters">
        <button class="ld-chip ld-on" data-r="all">${tc("全部", "All")}</button>
        <button class="ld-chip" data-r="done">${DROPS} ${tc("已出局", "Got out")}</button>
        <button class="ld-chip" data-r="gaveup">${CROSS} ${tc("已放弃", "Gave up")}</button>
        <span class="ld-sep"></span>
        <button class="ld-chip" data-r="finish">${tc("完成", "Finish")}</button>
        <button class="ld-chip" data-r="timer">${tc("计时", "Timer")}</button>
        <button class="ld-chip" data-r="edge">${tc("边缘", "Edge")}</button>
        <div class="ld-search ld-small">${SEARCH}<input data-a="q" placeholder="${tc("名称", "Name")}" autocomplete="off"></div>
      </div>
      <div data-a="list"></div>
      <div class="ld-foot">${tc("你最近的", "Your latest")} ${HISTORY_MAX} ${tc("个锁局会被保留。总计统计全部。", "lockdowns are kept. Totals count all of them.")}</div>`;
    const box = into ? into : modal(html);
    if (into) into.innerHTML = html; else box.classList.add("ld-tall");
    const $ = (a) => box.querySelector(`[data-a="${a}"]`);

    const render = () => {
      $("tiles").innerHTML = tilesHtml(stats);
      $("total").textContent = `${tc(`${stats.done + stats.gaveUp} 次锁定`, `${stats.done + stats.gaveUp} lockdowns`)} · ${fmtDuration(stats.totalMs)} ${tc("累计锁定", "locked in total")}`;
      const matching = filterEntries(list, filter, q);
      const groups = groupByMonth(matching);
      const now = Date.now();
      let left = shown, html = "";
      for (const g of groups) {
        if (left <= 0) break;
        html += `<div class="ld-month"><span>${escapeHtml(g.label)}</span>` +
          `<span class="ld-mcount">${g.done} ${tc("次出局", "got out")} · ${g.gaveUp} ${tc("次放弃", "gave up")}</span></div>`;
        const items = g.items.slice(0, left);
        html += items.map((e) => rowHtml(e, now)).join("");
        left -= items.length;
      }
      if (!matching.length) html = list.length ? emptyHtml(tc("没有匹配项。", "Nothing matches."), tc("换个筛选条件或名称试试。", "Try another filter or name."))
        : emptyHtml(tc("还没有锁局记录。", "No lockdowns yet."), tc("在第一个标签页开始一盘，每个锁局都会显示在这里。", "Start a run on the first tab; every lockdown shows up here."));
      html = notReadHtml(data) + html;
      if (matching.length > shown) html += `<button class="ld-more" data-a="more">${tc("再显示 " + Math.min(PAGE, matching.length - shown) + " 条", "Show " + Math.min(PAGE, matching.length - shown) + " more")}</button>`;
      $("list").innerHTML = html;
      $("more")?.addEventListener("click", () => { shown += PAGE; render(); });
    };
    const update = (d) => { list = d.list; stats = d.stats; render(); };

    $("back")?.addEventListener("click", () => openStart());
    box.querySelectorAll(".ld-chip").forEach((c) => c.addEventListener("click", () => {
      filter = c.dataset.r; shown = PAGE;
      box.querySelectorAll(".ld-chip").forEach((x) => x.classList.toggle("ld-on", x === c));
      render();
    }));
    $("q").addEventListener("input", () => { q = $("q").value; shown = PAGE; render(); });
    $("q").addEventListener("keydown", (ev) => ev.stopPropagation());
    wireRows($("list"), update, () => list);
    wireClear($("clear"), () => stats.done + stats.gaveUp, update);
    render();
  }

  // ═══ The Lockdown page ═════════════════════════════════════════════════════
  // A page of its own in Stash (2.1, the user: "give lock down its own page
  // ... so we can scale things properly"), registered with Stash's plugin
  // router. Tabs: the new run (or, while locked, the run in progress), the
  // leaderboard and the history. The page has no content of the library on
  // it, so the lock allows it (routeCheck). A Stash without plugin routes
  // keeps the 2.0 dialog.

  let pageEl = null, pageTab = "new", pagePrefill = null;
  const hasPage = (function registerPage() {
    const api = window.PluginApi;
    if (!api || !api.register || typeof api.register.route !== "function" || !api.React) return false;
    const R = api.React;
    function LockdownPage() {
      const ref = R.useRef(null);
      R.useEffect(() => {
        const el = ref.current;
        mountPage(el);
        return () => { if (pageEl === el) pageEl = null; };
      }, []);
      return R.createElement("div", { ref, className: "ld-page ld-modal" });
    }
    try { api.register.route(PAGE_PATH, LockdownPage); return true; }
    catch (e) { log(`${tc("页面未注册：", "Page not registered:")} ${e.message}`, "error"); return false; }
  })();

  function showPage() {
    if (location.pathname === PAGE_PATH && pageEl) renderPage();
    else navigate(PAGE_PATH);
  }

  function mountPage(el) {
    injectStyles();
    pageEl = el;
    const t = new URLSearchParams(location.search).get("tab");
    if (t && ["new", "board", "history"].includes(t)) pageTab = t;
    renderPage();
  }

  function renderPage() {
    if (!pageEl || !pageEl.isConnected) return;
    // The suite's page frame (B1): icon, title and a muted line on the left,
    // the tab strip on the right, each tab with its icon and its colour.
    const tabs = [["new", lock ? tc("你的这一盘", "Your run") : tc("新锁局", "New run"), LOCK_LINE, "#D14D41"], ["board", tc("排行榜", "Leaderboard"), CROWN_LINE, "#D0A215"],
                  ["history", tc("历史", "History"), HISTORY_LINE, "#8B7EC8"]];
    const sub = lock ? tc("已锁定到 " + lock.name, "Locked to " + lock.name) : tc("把 Stash 锁定到某位演员、工作室或标签，直到你出局", "Lock Stash to a performer, studio or tag until you get out");
    pageEl.innerHTML = `<div class="ld-pagehead"><div class="ld-ptitle"><h2>${LOCK_SVG} Lockdown</h2>` +
      `<span class="ld-psub">${escapeHtml(sub)}</span></div><div class="ld-tabs">` +
      tabs.map(([k, l, ico, c]) => `<button data-tab="${k}" class="${k === pageTab ? "ld-on" : ""}" style="--tc:${c}">${ico}<span>${l}</span></button>`).join("") +
      `</div></div><div class="ld-pagebody" data-a="pbody"></div>`;
    pageEl.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { pageTab = b.dataset.tab; renderPage(); }));
    const body = pageEl.querySelector('[data-a="pbody"]');
    if (pageTab === "new") {
      if (lock) renderLive(body);
      else { const pf = pagePrefill; pagePrefill = null; openStart(pf, body); }
    } else if (pageTab === "board") {
      body.innerHTML = loadingHtml(tc("正在读取你的排行榜…", "Reading your leaderboard…"));
      readConfig().then((d) => { if (body.isConnected) renderBoard(body, d); });
    } else {
      body.innerHTML = loadingHtml(tc("正在读取你的历史…", "Reading your history…"));
      readConfig().then((d) => { if (body.isConnected) openHistory(d, body); });
    }
  }

  function renderBoard(box, data) {
    let goal = "all";
    const now = Date.now();
    const draw = () => {
      const rows = boardRows((data.stats && data.stats.top) || [], goal);
      box.innerHTML = `<div class="ld-board"><div class="ld-filters">` +
        [["all", tc("全部", "All")], ["finish", tc("完成", "Finish")], ["timer", tc("计时", "Timer")], ["edge", tc("边缘", "Edge")]]
          .map(([g, l]) => `<button class="ld-chip${g === goal ? " ld-on" : ""}" data-g="${g}">${l}</button>`).join("") + `</div>` +
        (rows.length
          ? `<div class="ld-brow ld-bhead"><span>#</span><span>${tc("对局", "Run")}</span><span>${tc("观看", "Watched")}</span><span>${tc("跳过", "Skips")}</span><span>${tc("热度", "Heat")}</span><span>${tc("分数", "Score")}</span></div>` +
            rows.map((x, i) => `<div class="ld-brow"><span class="ld-rank r${i + 1}">${i + 1}</span>` +
              `<span class="ld-brun"><span class="ld-av">${avatarHtml(x.name, x.image)}</span><span><b>${escapeHtml(x.name || "?")}</b>` +

              `<small>${icon({ result: "done", goal: x.goal })} ${escapeHtml(goalLabel(x.goal))} · ${escapeHtml(fmtWhen(x.at || 0, now))}</small></span></span>` +
              `<span class="ld-blue">${escapeHtml(fmtMinutes((x.watchedMs || 0) / 60000))}</span><span>${x.skipsUsed || 0}</span>` +
              `<span class="ld-bheat">${typeof x.heat === "number" ? heatPill(x.heat) : ""}<span>${condIcons(x.conds, x.goal)}</span></span>` +
              `<span class="ld-bscore">${Number(x.score).toLocaleString()}</span></div>`).join("")
          : emptyHtml(goal === "all" ? tc("还没有计分的对局。", "No scored runs yet.") : tc(`还没有计分的${goalInfo()[goal][0]}对局。`, `No scored ${goalInfo()[goal][0]} runs yet.`),
                      tc("从锁局里出局后就会显示在这里。", "Get out of a lockdown and it shows up here."))) + notReadHtml(data) +
        `<div class="ld-foot">${tc("只有成功出局的对局才参与排名。2.1 之前的对局没有观看时长，也不计分。", "Only runs you got out of are ranked. Runs from before 2.1 have no watch time and aren't scored.")}</div></div>`;
      box.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => { goal = b.dataset.g; draw(); }));
    };
    draw();
  }

  // The run in progress, on the page's first tab while locked.
  function renderLive(box) {
    const st = edgeState(lock) || "";
    box.innerHTML = `<div class="ld-live" data-st="${st}">
      <div class="ld-rcwho"><span class="ld-av ld-big">${avatarHtml(lock.name, lock.image)}</span>
        <div><b>${escapeHtml(lock.name)}</b><small data-a="lvdeal"></small></div></div>
      ${st ? overCardHtml(st, "lv") : ""}
      <div class="ld-tiles">
        <div class="ld-tile"><b data-a="lvlocked"></b><span>${tc("已锁定", "locked")}</span></div>
        <div class="ld-tile"><b class="ld-blue" data-a="lvwatched"></b><span>${tc("已观看", "watched")}</span></div>
        <div class="ld-tile"><b data-a="lvskips"></b><span>${tc("已用跳过", "skips used")}</span></div>
        <div class="ld-tile"><b class="ld-gold" data-a="lvscore"></b><span>${st ? tc("分数已入账", "score banked") : tc("现在出局可得的分数", "score if you got out now")}</span></div>
      </div>
      <div class="ld-rcchips" data-a="lvrules"></div>
      <div data-a="lvmoments"></div>
      <div class="ld-lvrow"><button class="ld-start ld-lvgo" data-a="lvgo">${tc("回到", "Back to the")} ${lock.media === "images" ? tc("图片", "images") : tc("场景", "scenes")}</button>
        <button class="ld-start ld-lvgo ld-lvpics" data-a="lvpics" hidden>${PICS_ICON} ${tc("播放图片", "Play pictures")}</button></div>
      <div class="ld-foot">${st ? tc("你已出局：已入账的分数不会再丢。", "You're out: nothing banked can be lost now.") : tc("长按顶栏里的「放弃」5 秒即可退出。", "Hold Give up in the bar for 5 seconds to quit.")}</div></div>`;
    box.querySelector('[data-a="lvgo"]').addEventListener("click", () => navigate(listUrl(lock)));
    box.querySelector('[data-a="lvpics"]').addEventListener("click", playPictures);
    wireOver(box);
    box.querySelector('[data-a="lvmoments"]').addEventListener("click", (ev) => momentClick(ev));
    updateLive();
  }

  // 2.6: the Edge target reached (Keep going or Finish), or overtime under
  // way (Stop). On the run page and, off it, under the bar (`#ld-over`).
  function overCardHtml(st, p) {
    const cap = fmtClock(overtimeCap(lock));
    return st === "reached"
      ? `<div class="ld-otcard"><div class="ld-othead">${DROP}<b>${tc("边缘已达目标：你出局了", "Edge target reached: you're out")}</b></div>
          <div class="ld-otbank">${tc("分数已入账 ", "Score banked ")}<b class="ld-gold" data-a="${p}bank"></b></div>
          <p>${tc("继续加时：你每多看一分钟再加 10 分（乘以热度），最多再补", "Keep going for overtime: every minute you watch adds 10 more (times heat), up to")} ${cap} ${tc("。一次 O 会结束它，已入账的分数不会丢。", "more. An O ends it, and nothing banked is lost.")}</p>
          <div class="ld-otbtns"><button class="ld-start ld-otgo" data-a="otgo">${tc("继续（加时）", "Keep going (overtime)")}</button>
            <button class="ld-start ld-otfin" data-a="otfin">${tc("完成", "Finish")}</button></div></div>`
      : `<div class="ld-otcard ld-oton"><div class="ld-othead">${DROP}<b data-a="${p}ot"></b></div>
          <div class="ld-otmeter"><i data-a="${p}otbar"></i></div>
          <p>${tc("最多再 ", "Up to ")}${cap} ${tc("。一次 O 作为自然完成会结束它，已入账的分数不会丢。", "more. An O ends it as the natural finish; nothing banked is lost.")}</p>
          <div class="ld-otbtns"><button class="ld-start ld-otfin" data-a="otstop">${tc("停止加时", "Stop overtime")}</button></div></div>`;
  }
  function wireOver(box) {
    box.querySelectorAll('[data-a="otgo"]').forEach((b) => b.addEventListener("click", keepGoing));
    box.querySelectorAll('[data-a="otfin"]').forEach((b) => b.addEventListener("click", () => end("done")));
    box.querySelectorAll('[data-a="otstop"]').forEach((b) => b.addEventListener("click", () => end("done", tc("加时已停止。", "Overtime stopped."))));
  }
  // The live numbers of the card: the banked score, overtime and its meter.
  function updateOver(box, p) {
    if (!box || !lock) return;
    const set = (a, t) => { const el = box.querySelector(`[data-a="${a}"]`); if (el && el.textContent !== t) el.textContent = t; };
    const sc = scoreOf(entryFromLock(lock, "done", Date.now()));
    set(`${p}bank`, sc ? sc.total.toLocaleString() : "–");
    const ot = overtimeMs(lock);
    set(`${p}ot`, `${tc("加时 ", "Overtime ")}${fmtClock(ot)} (+${overtimePts(ot)})`);
    const bar = box.querySelector(`[data-a="${p}otbar"]`);
    const w = `${overtimeCap(lock) ? Math.round((ot / overtimeCap(lock)) * 100) : 0}%`;
    if (bar && bar.style.width !== w) bar.style.width = w;
  }
  function keepGoing() {
    if (edgeState(lock) !== "reached") return;
    lock = startOvertime(lock, Date.now());
    dirty = true;
    writeState(lock);
    saveProgress(true);
    ldToast(`${tc("加时：最多再", "Overtime: up to")} ${fmtClock(overtimeCap(lock))} ${tc("。一次 O 会结束它。", "more. An O ends it.")}`, true);
    renderBar();
    updateLive();
  }

  function updateLive() {
    const b = pageEl && pageEl.querySelector(".ld-live");
    if (!b || !lock) return;
    // the target reached or overtime begun (here or on another device)
    if (b.dataset.st !== (edgeState(lock) || "")) { renderLive(b.parentNode); return; }
    updateOver(b, "lv");
    const now = Date.now();
    const sc = scoreOf(entryFromLock(lock, "done", now));
    const set = (a, t) => { const el = b.querySelector(`[data-a="${a}"]`); if (el && el.textContent !== t) el.textContent = t; };
    const mh = momentsHtml(lock);
    const mb = b.querySelector('[data-a="lvmoments"]');
    if (mb && mb.dataset.k !== mh) { mb.dataset.k = mh; mb.innerHTML = mh; }
    const pb = b.querySelector('[data-a="lvpics"]');
    if (pb && pb.hidden !== !picsReady(lock)) pb.hidden = !picsReady(lock);
    set("lvdeal", typeof lock.heat === "number" ? `${goalLabel(lock.goal)} · heat ${lock.heat} · ×${heatMult(lock.heat)}`
                                                  : `${goalLabel(lock.goal)} · ${tc(DIFF_LABEL_ZH[lock.difficulty] || "经典", DIFF_LABEL[lock.difficulty] || "Classic")}`);
    set("lvlocked", fmtDuration(now - lock.startedAt));
    set("lvwatched", fmtDuration(lock.watchedMs || 0));
    set("lvskips", String(skipsUsed(lock)));
    set("lvscore", sc ? sc.total.toLocaleString() : "–");
    const chips = lock.conds
      ? (typeof lock.heat === "number" ? heatPill(lock.heat) : "") + conditions().filter((c) => lock.conds[c.k] && condApplies(c, goalType(lock)))
          .map((c) => `<span class="ld-pill ld-condpill">${COND_ICON[c.k]} ${escapeHtml(c.ranks[lock.conds[c.k] - 1])}</span>`).join("")
      : rulesLabels(lock.rules, lock.goal).map((r) => `<span class="ld-pill">${escapeHtml(r)}</span>`).join("");
    const rl = b.querySelector('[data-a="lvrules"]');
    if (rl && rl.innerHTML !== chips) rl.innerHTML = chips;
  }

  // ═══ Spin ══════════════════════════════════════════════════════════════════

  function spin(list, how, setup) {
    const pick = list[Math.floor(Math.random() * list.length)];   // decided now, shown last
    const box = modal(`<div class="ld-spin"><img alt=""><div class="ld-name"></div><div class="ld-msg">${tc("正在转动…", "Spinning…")}</div></div>`, true);
    const img = box.querySelector("img"), name = box.querySelector(".ld-name");
    const delays = spinSchedule(Math.min(26, Math.max(8, list.length * 3)));
    let i = 0;
    const show = (p) => { name.textContent = p.name; if (p.image_path) img.src = p.image_path; };
    const step = () => {
      if (i >= delays.length - 1) {
        show(pick);
        box.querySelector(".ld-spin").classList.add("ld-landed");
        box.querySelector(".ld-msg").textContent = tc("已锁定。", "Locked in.");
        setTimeout(() => begin(pick, how, setup), 1400);
        return;
      }
      show(list[Math.floor(Math.random() * list.length)]);
      setTimeout(step, delays[i++]);
    };
    step();
  }

  // ═══ Lock ══════════════════════════════════════════════════════════════════

  function resetChecks() {
    allowedCache.clear();
    itemCache.clear();
    lastPath = null;
    for (const el of document.querySelectorAll(".ld-ok, .ld-no")) el.classList.remove("ld-ok", "ld-no");
  }

  // t: { kind, id, name, image_path }.
  let beginning = false;
  async function begin(t, how, setup) {
    // Start pressed twice (or Enter) made two locks (review, 2.2)
    if (lock || beginning) return;
    beginning = true;
    try { await beginNow(t, how, setup); } finally { beginning = false; }
  }
  async function beginNow(t0, how, setup) {
    let S = normaliseSetup({ ...setup, kind: t0.kind });
    const t = { ...t0 };
    delete t.media;
    const multi = t.kind === "tag" && t.tags && t.tags.length > 1;
    const probe = { kind: t.kind, tid: String(t.id), ids: [String(t.id)], rules: rulesOf(S),
                    ...(multi ? { tags: t.tags, mode: t.mode } : {}) };
    let under = [String(t.id)], baseO = 0, groups = null;
    try {
      if (multi) { groups = await Promise.all(t.tags.map((x) => idsUnder("tag", x.id))); under = groups[0]; }
      else under = await idsUnder(t.kind, t.id);
    } catch (e) { log(`Sub-${t.kind}s not read: ${e.message}`, "error"); if (multi) groups = t.tags.map((x) => [String(x.id)]); }
    // No scenes (2.3): images only make an image run, for the ways out that
    // need no watching, with no conditions (they are all about scenes).
    try {
      const n = await sceneCount({ ...probe, ...(groups ? { groups } : {}) });
      if (!n) {
        const any = probe.rules && probe.rules.fresh ? await sceneCount({ ...probe, rules: { ...probe.rules, fresh: false } }) : 0;
        if (any) { ldToast(tc("那里没有未看过的场景可看；没有锁定。", "No unwatched scenes to watch there; nothing was locked.")); closeModal(); return; }
        const ni = await imageCount(probe);
        if (!ni) { ldToast(tc("那里没有场景或图片；没有锁定。", "No scenes or images there; nothing was locked.")); closeModal(); return; }
        if (!imagesOk(S)) { ldToast(tc("那里只有图片：可以用「完成」，或按锁定时间的「计时」。没有锁定。", "Only images there: they work with Finish, or Timer by locked time. Nothing was locked.")); closeModal(); return; }
        S = { ...S, conds: {} };
        probe.rules = rulesOf(S);
        probe.media = t.media = "images";
      }
    } catch (_) {}
    // Without a baseline every O the target ever had would count at the first
    // look (Finish over at once); without scenes nothing could ever count.
    try { baseO = await oRows(probe); }
    catch (e) { log(`${tc("O 基线读取失败：", "O baseline failed:")} ${e.message}`, "error"); ldToast(tc("无法从 Stash 读取 O 计数；没有锁定。请重试。", "Could not read the O counts from Stash; nothing was locked. Try again."), "error"); closeModal(); return; }
    lock = newLock(t, under, S, how, baseO, Date.now(), undefined, groups);
    confirmedId = null;
    resetChecks();
    writeState(lock);
    closeModal();
    sound("start");
    enforce(true);
    pushLock();
    renderPage();
    if (lock.rules.random) await goRandom();
    else navigate(listUrl(lock));
  }

  // Ends this lock everywhere: history and totals, and the active lock
  // cleared, in one write. Another device that already recorded it (same
  // id) is not counted twice; a newer lock started elsewhere is left alone.
  const endedIds = new Set();      // runs ended on this device, never adopted again
  // `note`: a line for the result card (overtime full, stopped, an O).
  // 2.6: a run past its Edge target always ends got out (endResult), and
  // the counted moments are checked first: a marker deleted since is dropped
  // from the list (its extra skip stays given). If that check fails or is
  // slow, they are all kept (never drop what may still be there).
  function end(result, note) {
    if (!lock) return;
    const done = lock;
    endedIds.add(done.id);
    lock = null;
    confirmedId = null;
    writeState(null);
    clearBar();
    resetChecks();
    const now = Date.now();
    const res = endResult(done, result);
    // the chime already played when the Edge target was reached
    if (!(res === "done" && done.over)) sound(res === "done" ? "out" : "giveup");
    const ready = done.moments && done.moments.length ? momentsNow(done.moments) : Promise.resolve(null);
    renderPage();
    ready.then((found) => recordEnd({ ...done, moments: keepMoments(done.moments, found) }, found, res, now, note));
  }

  // The markers of the scenes with a moment, read now: Map scene id ->
  // markers (an empty list for a scene that is gone), or null when the read
  // failed or took longer than 5 s.
  function momentsNow(moments) {
    const scenes = [...new Set(moments.map((m) => String(m.scene)))].filter((id) => /^\d+$/.test(id));
    if (!scenes.length) return Promise.resolve(null);
    const q = `query { ${scenes.map((id, i) => `a${i}: findScene(id: "${id}") { id scene_markers { id title seconds primary_tag { name } } }`).join(" ")} }`;
    const read = gql(q).then((d) => new Map(scenes.map((id, i) => [id, (d && d[`a${i}`] && d[`a${i}`].scene_markers) || []])));
    const slow = new Promise((ok) => setTimeout(() => ok(null), 5000));
    return Promise.race([read, slow]).catch((e) => { log(`${tc("瞬间未检查：", "Moments not checked:")} ${e.message}`, "error"); return null; });
  }

  function recordEnd(done, found, result, now, note) {
    updateConfig(({ list, stats, active }) => {
      const M = active && active.id === done.id ? mergeLock(active, done) : done;
      const L = M.moments ? { ...M, moments: keepMoments(M.moments, found) } : M;
      const out = {};
      if (!list.some((e) => e && e.id === done.id)) {
        const entry = entryFromLock(L, endResult(L, result), now);
        out.list = list.concat(entry);
        out.stats = addToStats(stats, entry);
      }
      if (!active || active.id === done.id) out.active = null;
      return out;
    }, false, true).then((cfg) => {
      const i = boardRows((cfg.stats && cfg.stats.top) || []).findIndex((x) => x.id === done.id);
      const el = document.querySelector('.ld-modal [data-a="place"]');
      if (el && i >= 0) el.textContent = `#${i + 1} ${tc("在你的排行榜上", "on your leaderboard")}`;
      if (pageTab !== "new") renderPage();
    }).catch((e) => {
      // A history that cannot be read must not keep every device locked.
      ldToast(`${tc("这一盘未能保存到你的历史：", "The run was not saved to your history:")} ${e.message}`, "error");
      updateConfig(({ active }) => (active && active.id === done.id ? { active: null } : {})).catch(() => {});
    });
    showResult(entryFromLock(done, result, now), done, now, note);
    renderPage();
  }

  // The result card: how it ended, the score's breakdown, the moments.
  function showResult(entry, done, now, note) {
    const result = entry.result;
    const g = goalType(entry);
    const title = result !== "done" ? tc("锁局已放弃", "Lockdown given up")
      : g === "timer" ? tc("服刑时长", "Time served") : g === "edge" ? tc("你坚持住了", "You held out") : tc("你出局了", "You got out");
    // overtime has its own line below
    const detail = entryDetail({ ...entry, overtimeMs: 0 });
    const sc = scoreOf(entry);
    const gl = entry.goal || {};
    const edgeW = g === "edge" && gl.watchMs ? Math.min(entry.watchedMs || 0, gl.watchMs) : entry.watchedMs;
    const scoreHtml = sc ? `<div class="ld-score">
        <div><span>${g === "edge" ? tc("目标", "Target") : tc("观看", "Watched")} ${escapeHtml(fmtDuration(edgeW))} ${tc("× 10/分", "× 10/min")}</span><b class="ld-blue">${sc.watched}</b></div>
        ${sc.overtime ? `<div><span>${tc("加时", "Overtime")} ${escapeHtml(fmtDuration(entry.overtimeMs))} ${tc("× 10/分", "× 10/min")}</span><b class="ld-blue">+${sc.overtime}</b></div>` : ""}
        <div><span>${tc("跳过", "Skips")} ${entry.skipsUsed} × −5${entry.skipsUsed * 5 > -sc.skips ? tc("（最多扣一半）", " (capped at half)") : ""}</span><b class="ld-coral">${sc.skips}</b></div>
        ${g === "edge" ? `<div><span>${tc("失误", "Slips")} ${entry.slips || 0} × −100</span><b class="ld-coral">${sc.slips}</b></div>` : ""}
        <div><span>${tc("已出局", "Got out")}</span><b>+${sc.out}</b></div>
        <div class="ld-mline"><span>${FLAME} ${tc("热度", "Heat")} ${sc.heat}</span><b>× ${sc.mult}</b></div>
        <div class="ld-total"><span>${tc("分数", "Score")}</span><b class="ld-gold">${sc.total.toLocaleString()}</b></div>
        <div class="ld-place" data-a="place"></div></div>` : "";
    const over = g === "edge" && entry.overtimeMs > 0
      ? `<div class="ld-msg ld-otline">${tc("目标", "Target")} ${escapeHtml(fmtClock(gl.watchMs || 0))} &middot; ${tc("加时", "Overtime")} ${escapeHtml(fmtClock(entry.overtimeMs))} (+${overtimePts(Math.min(entry.overtimeMs, gl.watchMs || 0))})</div>` : "";
    const box = modal(`<div class="ld-spin ${result === "done" ? "ld-won" : ""}">
        <div class="ld-endico">${icon(entry)}</div>
        <div class="ld-name">${title}</div>
        <div class="ld-msg">${escapeHtml(done.name)} &middot; ${tc("锁定", "locked")} ${fmtDuration(now - done.startedAt)}${entry.v >= 3 ? ` &middot; ${tc("观看", "watched")} ${fmtDuration(entry.watchedMs)}` : ""}${detail ? ` &middot; ${escapeHtml(detail)}` : ""}</div>
        ${over}${note ? `<div class="ld-msg ld-note">${escapeHtml(note)}</div>` : ""}</div>
        ${momentsHtml(entry) ? `<div class="ld-resmoments">${momentsHtml(entry)}</div>` : ""}
        ${scoreHtml}
        <button class="ld-close">${tc("关闭", "Close")}</button>`);
    box.querySelector(".ld-close").addEventListener("click", closeModal);
    box.addEventListener("click", (ev) => momentClick(ev, closeModal));
  }

  // The lock was ended on another device (or its history entry is there):
  // `result` is that entry's, when known.
  function endedElsewhere(result) {
    const name = lock && lock.name;
    if (result) sound(result === "done" ? "out" : "giveup");
    lock = null;
    confirmedId = null;
    writeState(null);
    clearBar();
    resetChecks();
    const box = modal(`<div class="ld-spin"><div class="ld-name">${tc("锁局结束", "Lockdown over")}</div>
        <div class="ld-msg">${escapeHtml(name || "")} &middot; ${tc("在另一台设备上结束", "ended on another device")}</div></div>
        <button class="ld-close">${tc("关闭", "Close")}</button>`);
    box.querySelector(".ld-close").addEventListener("click", closeModal);
    renderPage();
  }

  // A lock started on another device, or one that replaced ours.
  function adopt(remote) {
    lock = remote;
    confirmedId = remote.id;
    writeState(lock);
    resetChecks();
    closeModal();
    sound("start");
    enforce(true);
    renderPage();
    ldToast(tc(`已锁定到 ${lock.name}`, `Locked to ${lock.name}`) + ` ${tc("（在另一台设备上开始）", "(started on another device)")}`, true);
  }

  // `next`: the bar's Next scene button, which can cost a skip; a scene
  // ending or a bounce picks the next one for free.
  async function goRandom(next) {
    if (!lock) return;
    if (lock.one && lock.one.id) { navigate(`/scenes/${lock.one.id}`); return; }
    if (lock.current && stayBlocks("")) { ldToast(tc("坚持到底：先看完这个场景", "Stay to the end: finish this scene first")); navigate(`/scenes/${lock.current.id}`); return; }
    const cur = (/^\/scenes\/(\d+)/.exec(location.pathname) || [])[1];
    if (next === true && cur) {
      const d = nextSceneDecision(lock.scenes && lock.scenes[cur], skipBudget());
      if (!d.allow) { ldToast(tc("这个场景没有跳过次数了：继续看，或让它放完", "No skips left on this scene: watch on, or let it end")); return; }
      if (d.skip) {
        lock.scenes = { ...(lock.scenes || {}), [cur]: d.rec };
        writeState(lock);
        ldToast(tc(`下一个场景：用掉了一次跳过${d.left === 0 ? "" : `（那个场景还剩 ${d.left} 次）`}`, `Next scene: used a skip${d.left === 0 ? "" : ` (${d.left} left on that scene)`}`));
      }
    }
    try {
      const id = await randomScene(lock, cur);
      if (id) { navigate(`/scenes/${id}`); return; }
    } catch (e) { log(`${tc("随机场景失败：", "Random scene failed:")} ${e.message}`, "error"); }
    navigate(`/${KINDS[lock.kind].path}/${lock.tid}/galleries`, true);
  }

  // ── The bar ────────────────────────────────────────────────────────────────

  let bar = null, veil = null;

  function navHeight() {
    const nav = document.querySelector(".top-nav");
    return (nav && nav.offsetHeight) || 50;
  }

  function renderBar() {
    if (!lock) return;
    injectStyles();
    document.body.classList.add("ld-on");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ld-bar";
      veil = document.createElement("div");
      veil.id = "ld-veil";
      document.body.append(bar, veil);
    }
    if (!bar.isConnected) document.body.append(bar, veil);
    const h = navHeight();
    bar.style.height = h + "px";
    veil.style.top = h + "px";
    document.body.classList.toggle("ld-blind", !!(lock.rules && lock.rules.blind));
    const pics = picsReady(lock);
    const st = edgeState(lock) || "";
    syncOverPrompt(st);
    const key = `${lock.id}|${lock.rules && lock.rules.random}|${pics}|${st}`;
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    const base = `/${KINDS[lock.kind].path}/${lock.tid}`;
    bar.innerHTML =
      (lock.image ? `<img src="${escapeHtml(lock.image)}" alt="">` : "") +
      `<span class="ld-who">${tc("已锁定到 ", "Locked to ")}<b>${escapeHtml(lock.name)}</b>` +
        `${lock.kind !== "performer" ? `<small>${kl(lock.kind)}</small>` : ""}</span>` +
      `<span class="ld-goal ${goalType(lock)}"></span>` +
      `<span class="ld-time"></span><span class="ld-watch"></span><span class="ld-skips"></span>` +
      `<span class="ld-links">` +
        (hasPage ? `<a href="${PAGE_PATH}" data-a="link">${tc("对局", "Run")}</a>` : "") +
        (lock.media === "images" ? `<a href="${listUrl(lock)}" data-a="link">${tc("图片", "Images")}</a>`
          : lock.rules && lock.rules.random ? `<button data-a="random" title="${tc("另一个随机场景", "Another random scene")}${skipBudget() !== null ? tc("\uff08会用掉一次跳过\uff09", " (uses a skip)") : ""}">${tc("下一个场景", "Next scene")}</button>`
          : `<a href="${listUrl(lock)}" data-a="link">${tc("场景", "Scenes")}</a>`) +
        `<a href="${lock.groups ? tagsListUrl(lock, "galleries") : `${base}/galleries`}" data-a="link" class="ld-more">${tc("画廊", "Galleries")}</a>` +
        (lock.media === "images" ? "" : `<a href="${lock.groups ? tagsListUrl(lock, "images") : `${base}/images`}" data-a="link" class="ld-more">${tc("图片", "Images")}</a>`) +
        (pics ? `<button data-a="pics" class="ld-pics" title="${tc("把这一盘的图片当作幻灯片播放", "Play the pictures of this run as a slideshow")}">${PICS_ICON}<span>${tc("图片", "Pictures")}</span></button>` : "") +
      `</span>` +
      // 2.6: past the Edge target there is nothing to give up: the run's
      // own ways to end it take Give up's place
      (st === "reached"
        ? `<span class="ld-otbar"><button class="ld-otgo" data-a="otgo" title="${tc("继续观看：每分钟多加 10 分（乘以热度）", "Watch on: each minute adds 10 more, times heat")}">` +
            `<span class="ld-otlong">${tc("继续（加时）", "Keep going (overtime)")}</span><span class="ld-otshort">${tc("加时", "Overtime")}</span></button>` +
            `<button class="ld-otfin" data-a="otfin" title="${tc("在这里结束，分数入账", "End the run here with the score banked")}">${tc("完成", "Finish")}</button></span>`
        : st === "over"
        ? `<span class="ld-otbar"><button class="ld-otfin" data-a="otstop" title="${tc("在这里结束，全部入账", "End the run here with everything banked")}">` +
            `<span class="ld-otlong">${tc("停止加时", "Stop overtime")}</span><span class="ld-otshort">${tc("停止", "Stop")}</span></button></span>`
        : `<button class="ld-giveup" title="${tc("按住 5 秒即可结束锁局，但不算出局", "Hold for 5 seconds to end the lockdown without getting out")}">` +
            `<div class="ld-fill"></div><span>${tc("放弃（长按）", "Give up (hold)")}</span></button>`);
    bar.querySelectorAll('[data-a="link"]').forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault(); navigate(a.getAttribute("href"));
    }));
    bar.querySelector('[data-a="random"]')?.addEventListener("click", () => goRandom(true));
    bar.querySelector('[data-a="pics"]')?.addEventListener("click", playPictures);
    const gu = bar.querySelector(".ld-giveup");
    if (gu) wireGiveUp(gu);
    wireOver(bar);
    tick();
    showTip();
  }

  // 2.6: the Edge target reached: a card under the bar says so, with the
  // banked score and the two choices, until one is made (it never times
  // out into a loss). Not on the run page, which has the same card.
  function syncOverPrompt(st) {
    let p = document.getElementById("ld-over");
    const want = st === "reached" && location.pathname !== PAGE_PATH;
    if (!want) { if (p) p.remove(); return; }
    if (!p) {
      p = document.createElement("div");
      p.id = "ld-over";
      p.innerHTML = overCardHtml("reached", "pr");
      wireOver(p);
      document.body.appendChild(p);
    }
    p.style.top = navHeight() + 8 + "px";
    updateOver(p, "pr");
  }

  function wireGiveUp(btn) {
    const fill = btn.querySelector(".ld-fill");
    // A timer rather than requestAnimationFrame, which stalls in a hidden tab.
    let started = 0, iv = null;
    const stop = () => {
      started = 0;
      clearInterval(iv);
      fill.style.transition = "width .2s"; fill.style.width = "0";
      btn.querySelector("span").textContent = tc("放弃（长按）", "Give up (hold)");
    };
    const frame = () => {
      if (!started) return;
      const t = (Date.now() - started) / HOLD_MS;
      fill.style.width = Math.min(100, t * 100) + "%";
      btn.querySelector("span").textContent = t < 1 ? `${tc("继续按住… ", "Keep holding… ")}${Math.ceil((1 - t) * HOLD_MS / 1000)}` : tc("已放弃", "Given up");
      if (t >= 1) { started = 0; clearInterval(iv); end("gaveup"); }
    };
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      btn.setPointerCapture?.(ev.pointerId);
      started = Date.now();
      fill.style.transition = "none";
      clearInterval(iv);
      iv = setInterval(frame, 50);
    });
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(t, () => { if (started) stop(); });
  }

  // One-time tip the first time the bar appears.
  function showTip() {
    if (prefs().barTipSeen || document.getElementById("ld-tip") || !lock) return;
    const tip = document.createElement("div");
    tip.id = "ld-tip";
    tip.style.top = navHeight() + 8 + "px";
    tip.innerHTML = `${tc("只有 ", "Only ")}<b>${escapeHtml(lock.name)}</b> ${tc("直到你出局，所有设备同步。用这条顶栏里的链接", "until you get out, on every device. Use the links in this bar")} ` +
      `${tc("四处移动；长按", "to move around; hold")} <b>${tc("放弃", "Give up")}</b> ${tc("5 秒即可退出。", "for 5 seconds to quit.")} <button>${tc("知道了", "Got it")}</button>`;
    tip.querySelector("button").addEventListener("click", () => { setPref("barTipSeen", true); tip.remove(); });
    document.body.appendChild(tip);
  }

  // Says why a page did not open, or what just happened: the suite's one
  // toast, bottom centre, its left edge in the kind's colour (toastKind).
  // 2.3 put it in the body under the bar, so over a fullscreen player
  // ("Skip used", "Snapped", an O counted) it was never seen (audit A8): a
  // fixed child of the body is not painted over a fullscreen element. It
  // now goes into the fullscreen element when there is one (QuickTools'
  // mount()), and moves on fullscreenchange.
  let toastTimer = null;
  function ldToast(text, kind) {
    injectStyles();
    let t = document.getElementById("ld-toast");
    if (!t) { t = document.createElement("div"); t.id = "ld-toast"; t.setAttribute("role", "status"); }
    const host = toastHost(document);
    if (t.parentNode !== host) host.appendChild(t);
    const k = toastKind(kind);
    t.className = `ld-t-${k} ld-show`;
    t.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("ld-show"), TOAST_MS[k]);
  }
  document.addEventListener("fullscreenchange", () => {
    const t = document.getElementById("ld-toast");
    if (t && t.parentNode !== toastHost(document)) toastHost(document).appendChild(t);
  });

  // The bar's live parts: progress toward the way out, the clock, and the
  // skips left in the scene on screen.
  function tick() {
    if (!lock || !bar) return;
    const now = Date.now();
    const g = lock.goal || { type: "finish", os: 1 };
    const goal = bar.querySelector(".ld-goal"), time = bar.querySelector(".ld-time"), sk = bar.querySelector(".ld-skips");
    let html = "";
    if (g.type === "finish") {
      const need = g.os || 1;
      html = need === 1 ? tc("再来一次 O 就出局", "one O to get out") : tc(`${lock.os || 0} / ${need} 次 O`, `${lock.os || 0} of ${need} O's`);
      const minMs = (lock.rules && lock.rules.minMs) || 0;
      const wait = lock.slowBy === "watched" ? minMs - ((lock.watchedMs || 0) - (lock.slowFrom || 0)) : lock.startedAt + minMs - now;
      if (wait > 0) html += ` <small>${lock.slowBy === "watched" ? tc("再看 " + fmtClock(wait) + " 后计数", "count after " + fmtClock(wait) + " more watching") : tc(fmtClock(wait) + " 后计数", "count in " + fmtClock(wait))}</small>`;
    } else if (g.type === "timer") {
      html = g.by === "watched" ? `${fmtClock(g.ms - (lock.watchedMs || 0))} ${tc("的观看量剩余", "of watching left")}` : tc(fmtClock(lock.startedAt + g.ms - now) + " 后结束", fmtClock(lock.startedAt + g.ms - now) + " left");
    } else if (edgeState(lock) === "reached") {
      html = `<span class="ld-reachedtxt">${tc("已达目标", "target reached")} <small>${tc("分数已入账", "score banked")}</small></span>`;
    } else if (edgeState(lock) === "over") {
      const ot = overtimeMs(lock), cap = overtimeCap(lock);
      html = `${tc("加时 ", "Overtime ")}${fmtClock(ot)} (+${overtimePts(ot)})<span class="ld-meter ld-otm"><i style="width:${cap ? Math.round((ot / cap) * 100) : 0}%"></i></span>`;
    } else {
      const need = edgeNeedMs(lock), w = Math.min(need, lock.watchedMs || 0);
      html = `${tc("已观看 ", "watched ")}${fmtClock(w)}${tc(" / ", " of ")}${fmtClock(need)}<span class="ld-meter"><i style="width:${need ? Math.round((w / need) * 100) : 0}%"></i></span>`;
    }
    if (goal && goal.innerHTML !== html) goal.innerHTML = html;
    if (time) time.textContent = g.type === "finish" ? fmtDuration(now - lock.startedAt) : "";
    const watch = bar.querySelector(".ld-watch");
    if (watch) watch.textContent = g.type === "edge" ? "" : `${tc("已观看 ", "watched ")}${fmtClock(lock.watchedMs || 0)}`;
    if (pageEl) updateLive();
    const pr = document.getElementById("ld-over");
    if (pr) updateOver(pr, "pr");
    if (sk) {
      const budget = lock.rules ? lock.rules.skips : null, id = sceneHere();
      if (budget === null || budget === undefined || !id) { sk.textContent = ""; sk.className = "ld-skips"; }
      else {
        const rec = (lock.scenes || {})[id] || {};
        const left = skipsLeft(rec, budget);
        sk.textContent = budget === 0 && !rec.bonus ? tc("不能跳过", "no skipping") : tc(plural(left, "skip", "skips") + " 剩余", plural(left, "skip", "skips") + " left");
        sk.className = "ld-skips" + (left ? "" : " ld-zero");
      }
    }
    // 2.6: Edge waits at its target for Keep going or Finish; overtime ends
    // itself once full
    if (goalType(lock) === "edge") {
      if (!lock.over && goalReached(lock, now)) edgeReached(now);
      else if (overtimeFull(lock)) end("done", `${tc("加时已满：", "Overtime full:")} ${fmtClock(overtimeCap(lock))}${tc("，这是它能加的上限。", ", the most it adds.")}`);
    } else if (goalReached(lock, now)) end("done");
  }

  // The Edge target reached: out, the score banked, the choice offered.
  function edgeReached(now) {
    lock = reachEdge(lock, now);
    dirty = true;
    writeState(lock);
    saveProgress(true);
    sound("out");
    ldToast(tc("已达边缘目标：你出局了，分数已入账", "Edge target reached: you're out and the score is banked"), "done");
    renderBar();
    updateLive();
  }

  function clearBar() {
    clearWatched();
    document.body.classList.remove("ld-on", "ld-checking", "ld-blind");
    document.getElementById("ld-tip")?.remove();
    document.getElementById("ld-over")?.remove();
    bar?.remove(); veil?.remove();
    bar = null; veil = null;
  }

  // ── Enforcement ────────────────────────────────────────────────────────────

  const allowedCache = new Map();    // "lockid:scene:12" -> true/false
  let checkSeq = 0;
  let lastPath = null;

  async function enforce(force) {
    if (!lock) return;
    renderBar();
    const path = location.pathname;
    // The query counts too: a filter added on their Scenes tab changes only
    // the query, and it is exactly what can widen the list.
    const here = path + location.search;
    if (!force && here === lastPath) return;
    lastPath = here;
    const r = routeCheck(path, lock, lock.rules && lock.rules.random);
    if (r.ok) {
      // several tags: the Scenes list must keep their filter (and the
      // unplayed one), or its list view would show the whole library
      const listPage = { "/scenes": "scenes", "/images": "images", "/galleries": "galleries" }[path];
      if (lock.groups && listPage) {
        if (!keepsListFilter(location.search, lock, listPage)) { later(() => { lastPath = null; navigate(tagsListUrl(lock, listPage), true); }); return; }
        document.body.classList.remove("ld-checking");
        return;
      }
      const clean = stripRules(location.search, KINDS[lock.kind].rule);
      if (clean !== null) {
        document.body.classList.add("ld-checking");
        ldToast(tc(`锁定期间无法添加其他${(KIND_ZH[lock.kind] || {}).plural || lock.kind}`, `Other ${KINDS[lock.kind].plural} can't be added during a lockdown`));
        later(() => { lastPath = null; navigate(path + clean, true); });
        return;
      }
      document.body.classList.remove("ld-checking");
      return;
    }
    if (r.bounce) { bounce(); return; }
    if (r.check === "scene" && oneBlocks(r.id)) {
      document.body.classList.add("ld-checking");
      ldToast(tc("单一场景：这一盘只停留在一个场景", "One scene: this run stays on one scene"));
      later(() => { lastPath = null; navigate(`/scenes/${lock.one.id}`, true); });
      return;
    }
    if (r.check === "scene" && stayBlocks(r.id)) {
      document.body.classList.add("ld-checking");
      ldToast(tc("坚持到底：先看完这个场景", "Stay to the end: finish this scene first"));
      later(() => { lastPath = null; navigate(`/scenes/${lock.current.id}`, true); });
      return;
    }
    const key = `${lock.id}:${r.check}:${r.id}`;
    if (allowedCache.has(key)) {
      if (allowedCache.get(key)) { document.body.classList.remove("ld-checking"); if (r.check === "scene") sceneRec(r.id); }
      else bounce();
      return;
    }
    // Hide the page until we know, so a forbidden scene is never seen.
    document.body.classList.add("ld-checking");
    const seq = ++checkSeq, L = lock;
    let ok = false;
    try { ok = (await itemsMatch([{ kind: r.check, id: r.id }], L))[0]; }
    catch (e) { log(`${tc("检查失败（", "Check failed (")}${e.message}${tc("），按不允许处理", "), treating as not allowed")}`, "error"); }
    if (seq !== checkSeq || location.pathname + location.search !== here) return;
    // `lock` is a new object after every sync, O poll and save: the same run
    // is the same id. A different run: check again, or the veil stays up
    // and nothing counts (review, 2.2).
    if (!lock || lock.id !== L.id) { lastPath = null; return; }
    allowedCache.set(key, ok);
    // the one scene was deleted or no longer belongs: pick another rather
    // than be sent back to it for ever
    if (!ok && r.check === "scene" && lock.current && lock.current.id === String(r.id) && !lock.current.done) {
      lock.current = { ...lock.current, done: true };
      dirty = true; writeState(lock); saveProgress(true);
    }
    if (!ok && r.check === "scene" && lock.one && lock.one.id === String(r.id)) {
      lock.one = { ...lock.one, id: null };
      dirty = true; writeState(lock); saveProgress(true);
      ldToast(tc("本盘的场景没了：你接着播放的那个就是", "The run's scene is gone: the next one you play is the one"));
    }
    if (ok) {
      document.body.classList.remove("ld-checking");
      if (r.check === "scene") sceneRec(r.id);
    } else bounce();
  }

  // The router records a navigation in two steps: the URL, then the state
  // it renders. Redirecting inside the first step (as 1.0.0 did, from the
  // pushState wrapper) was overwritten by the second, so the forbidden page
  // rendered under an allowed URL. The veil goes up at once and the redirect
  // waits for the router to finish.
  function later(fn) { setTimeout(fn, 0); }

  function bounce() {
    document.body.classList.add("ld-checking");
    const random = lock.rules && lock.rules.random;
    const ownList = new RegExp(`^/${KINDS[lock.kind].path}/${lock.tid}(/scenes)?/?$`).test(location.pathname);
    ldToast(random && ownList ? tc("随机场景：随机而来", "Random scenes: they come at random")
                              : tc("已锁定到 " + lock.name + "：那个页面不属于它", "Locked to " + lock.name + ": that page isn't part of it"));
    later(() => {
      if (!lock) return;
      lastPath = null;                   // re-check wherever we land
      if (lock.rules && lock.rules.random) { goRandom(); return; }
      navigate(listUrl(lock), true);
    });
  }

  // ── Cards ──────────────────────────────────────────────────────────────────
  // Checked on every page while locked: anything that does not belong to
  // the target is removed from view (ld-no), the rest shown (ld-ok).

  const CARD_SEL = ".scene-card, .image-card, .gallery-card, .wall-item, .queue-scene-details";
  const itemCache = new Map();       // "lockid:scene:12" -> true/false
  let cardBusy = false;

  function cardOf(el) {
    return el.classList.contains("queue-scene-details") ? (el.closest("li") || el) : el;
  }

  async function scanCards() {
    if (!lock || cardBusy) return;
    const pending = [];
    for (const el of document.querySelectorAll(CARD_SEL)) {
      const card = cardOf(el);
      if (card.classList.contains("ld-ok") || card.classList.contains("ld-no")) continue;
      const hrefs = Array.from(card.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
      if (card.tagName === "A") hrefs.unshift(card.getAttribute("href"));
      const it = cardItem(el.className, hrefs);
      if (!it) { card.classList.add("ld-no"); continue; }
      const key = `${lock.id}:${it.kind}:${it.id}`;
      if (itemCache.has(key)) { card.classList.add(itemCache.get(key) ? "ld-ok" : "ld-no"); continue; }
      pending.push({ card, it, key });
    }
    if (!pending.length) return;
    cardBusy = true;
    const L = lock;
    try {
      const unique = [...new Map(pending.map((p) => [p.key, p.it])).entries()].slice(0, 120);
      const res = await itemsMatch(unique.map(([, it]) => it), L);
      if (lock && lock.id === L.id) unique.forEach(([key], i) => itemCache.set(key, !!res[i]));
    } catch (e) {
      log(`${tc("卡片检查失败：", "Card check failed:")} ${e.message}`, "error");     // they stay hidden
    } finally {
      cardBusy = false;
    }
    for (const p of pending) {
      if (itemCache.has(p.key)) p.card.classList.add(itemCache.get(p.key) ? "ld-ok" : "ld-no");
    }
  }

  // ── Progress: O's, watch time, skips ───────────────────────────────────────

  let dirty = false, lastSave = 0, saving = false, lastCache = 0;
  // 2.5.2 (user): time spent on pictures in Slideshow counts as watch time,
  // like a playing scene (Slideshow announces only time on screen, not
  // paused or away). While locked, pages outside the run are closed, so the
  // pictures are the run's. One announcement is capped at two minutes.
  window.addEventListener("slideshow:viewed", (ev) => {
    if (!lock) return;
    const ms = Math.min(Number(ev && ev.detail && ev.detail.ms) || 0, 120000);
    if (!(ms > 0)) return;
    lock.watchedMs = (lock.watchedMs || 0) + ms;
    dirty = true;
    writeState(lock);
  });

  // The scene's record in this lock (furthest point watched, skips used).
  // Made the first time an allowed scene opens; "unwatched only" lets a
  // scene with a record through even after Stash has counted its play.
  function sceneRec(id) {
    if (!lock) return null;
    if (!lock.scenes) lock.scenes = {};
    if (!lock.scenes[id]) { lock.scenes[id] = { ranges: [], skips: 0, t0: Date.now() }; dirty = true; writeState(lock); }
    return lock.scenes[id];
  }

  const sceneHere = () => (/^\/scenes\/(\d+)/.exec(location.pathname) || [])[1] || null;
  // The scene player's own video, not a card's hover preview.
  const isPlayer = (v) => v instanceof HTMLVideoElement && !!v.closest(".video-js") && !!sceneHere();
  const playerVideo = () => (sceneHere() ? document.querySelector(".video-js video") : null);

  // The sum of O counts over the target's scenes, polled: faster on a scene
  // page, where the O button is. An O pressed anywhere counts.
  let oBusy = false, lastOCheck = 0;
  async function checkO() {
    if (!lock || oBusy || document.visibilityState !== "visible") return;
    const onScene = !!sceneHere();
    if (Date.now() - lastOCheck < (onScene ? 2500 : 10000)) return;
    oBusy = true;
    lastOCheck = Date.now();
    const L = lock;
    try {
      const rows = await oRows(L);
      if (!lock || lock.id !== L.id) return;
      const r = applyO(lock, lock.oBase ? rows : rows.reduce((a, x) => a + x.o, 0), Date.now());
      const before = lock;
      lock = r.lock;
      if (lock.baseO !== before.baseO) writeState(lock);
      if (lock.os !== before.os || lock.slips !== before.slips || lock.early !== before.early) {
        dirty = true;
        saveProgress(true);
        const g = lock.goal || {};
        if (lock.slips > (before.slips || 0)) ldToast(g.slip === "reset" ? tc("一次 O：整个目标重来", "An O: the whole target again")
          : `${tc("一次 O：", "An O: ")}${fmtMinutes(Math.round((edgeNeedMs(lock) - edgeNeedMs(before)) / 60000))} ${tc("还需观看", "more to watch")}`);
        else if (lock.early > (before.early || 0)) ldToast(lock.slowBy === "watched"
          ? tc(`为时过早：看过 ${fmtMinutes(lock.rules.minMs / 60000)} 后 O 才计数。等待会重新开始。`, `Too early: O's count after ${fmtMinutes(lock.rules.minMs / 60000)} watched. The wait starts over.`)
          : tc(`为时过早：看过 ${fmtMinutes(lock.rules.minMs / 60000)} 后 O 才计数`, `Too early: O's count after ${fmtMinutes(lock.rules.minMs / 60000)}`));
        else if (!r.end && g.type === "finish") ldToast(tc(`${lock.os} / ${g.os} 次 O`, `${lock.os} of ${g.os} O's`), true);
      }
      if (r.end) end(r.end, before.over ? tc("一次 O 结束了它：自然完成，不算失误。", "An O ended it: the natural finish, not a slip.") : undefined);
    } catch (e) { log(`${tc("O 检查失败：", "O check failed:")} ${e.message}`); }
    finally { oBusy = false; }
  }

  // 2.6: moments. The open scene's markers, polled every 10 s while it is a
  // scene of the run on a tab on screen, and at once when the tab comes back
  // (`lastMark = 0`): one small query, whatever made the marker. The first
  // look at a scene in the run only learns what it already had.
  const MARK_POLL_MS = 10000;
  let markBusy = false, lastMark = 0;
  async function checkMarkers() {
    if (!lock || markBusy || lock.media === "images" || document.visibilityState !== "visible") return;
    const id = sceneHere();
    if (!id || allowedCache.get(`${lock.id}:scene:${id}`) !== true) return;
    const rec = lock.scenes && lock.scenes[id];
    if (!rec) return;
    if (Array.isArray(rec.marks) && Date.now() - lastMark < MARK_POLL_MS) return;
    markBusy = true;
    lastMark = Date.now();
    const runId = lock.id;
    try {
      const d = await gql(`query ($id: ID!) { findScene(id: $id) { id scene_markers { id title seconds created_at primary_tag { name } } } }`, { id });
      const list = d && d.findScene && d.findScene.scene_markers;
      if (!Array.isArray(list) || !lock || lock.id !== runId) return;
      const r = markersSeen(lock, id, list, Date.now());
      if (r.lock === lock) return;
      lock = r.lock;
      dirty = true;
      writeState(lock);
      const has = (k) => r.results.some((x) => x.result === k);
      if (has("counted")) {
        saveProgress(true);
        ldToast(skipBudget() !== null ? tc("发现瞬间：本场景 +1 次跳过", "Found a moment: +1 skip on this scene") : tc("发现一个瞬间", "Found a moment"), "done");
      } else if (has("one")) ldToast(tc("发现瞬间：本场景已计过一个", "Found a moment: already counted one on this scene"));
      else if (has("cap")) ldToast(`${MOMENTS_MAX} ${tc("个瞬间是一盘的上限", "moments is the most a run counts")}`);
      else if (has("early")) ldToast(`${tc("看满", "Moments count once you've watched")} ${MOMENT_WATCH_S / 60} ${tc("分钟后瞬间才计数", "minutes of the scene")}`);
    } catch (e) { log(`${tc("标记检查失败：", "Marker check failed:")} ${e.message}`); }
    finally { markBusy = false; }
  }

  // Watch time (every run since 2.1: it scores; Edge also needs it to get
  // out), only while the scene plays in a tab on screen; and the timeline:
  // playback between events, drags that ended, the watched parts drawn.
  let lastTrack = 0;
  function trackPlayback() {
    const now = Date.now();
    const dt = lastTrack ? Math.min(1000, now - lastTrack) : 0;
    lastTrack = now;
    if (!lock) return;
    const id = sceneHere(), v = id && playerVideo();
    if (drag && (!v || !scrubbing(v))) endDrag();
    if (!v || document.body.classList.contains("ld-checking") || allowedCache.get(`${lock.id}:scene:${id}`) !== true) return;
    observe(v, id);
    paintWatched(v, id);
    if (!v.paused && !v.ended && v.readyState >= 3 && document.visibilityState === "visible") {
      lock.watchedMs = (lock.watchedMs || 0) + dt;
      dirty = true;
    }
    if (dirty && now - lastCache > 5000) { lastCache = now; writeState(lock); }
  }

  // The timeline (2.0, the user's idea after the third skips fix): what has
  // actually played in a scene is kept as ranges and painted blue on the
  // progress bar. Seeking into a watched part is free; anywhere else costs
  // a skip; with none left the player stays where it was. This also closes
  // "seek back as much as you like": the stretch jumped over by a skip is
  // not watched, so going back into it costs one.
  //  - `cur` is where the player was a moment ago: the "from" of a seek and
  //    the start of the stretch playing now.
  //  - A timeline drag (video.js marks the player vjs-scrubbing) is judged
  //    once, when it ends (`drag`), so passing over unwatched parts on the
  //    way costs nothing and its many seeks cost one skip at most.
  //  - Our own jump back is known by where it lands (`snap`), never by a
  //    flag a user's seek could slip past.
  //  - A jump no seek event reported is caught by `observe`.
  //  - A seek with no click, key or wheel just before it is Stash placing
  //    the player (its resume point, a ?t= link from a card or a marker
  //    list), not the user: always free (user report, 2.1: starting a scene
  //    mid-way cost a skip, and once out of skips locked them out of the
  //    start). Starting at 0:00 is left to Stash's own setting for it.
  let cur = null, snap = null, drag = null, lastInput = 0;
  for (const t of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(t, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  }
  const byUser = () => Date.now() - lastInput < INPUT_MS;
  const scrubbing = (v) => { const p = v.closest(".video-js"); return !!(p && p.classList.contains("vjs-scrubbing")); };
  // A function declaration, not a const: the bar (renderBar) reads it, and a
  // run already active when the page loads draws the bar before this line
  // has run (2.5.1's Next scene button threw there and got no click handler).
  function skipBudget() { return lock && lock.rules && lock.rules.skips !== undefined ? lock.rules.skips : null; }
  const isSnap = (t) => !!(snap && Date.now() - snap.at < 3000 && Math.abs(t - snap.t) < 1);

  function sendBack(v, t, msg, good) {
    snap = { t, at: Date.now() };
    v.currentTime = t;
    if (msg) ldToast(msg, good);
  }

  // The scene's length and the snap distance: 12 px of the timeline in
  // seconds (2 s at least), so it feels the same on any length of scene.
  function durationOf(v) {
    const p = document.getElementById("VideoJsPlayer")?.player;
    let dur = v.duration;
    try { if (p && typeof p.duration === "function" && isFinite(p.duration()) && p.duration() > 0) dur = p.duration(); } catch (_) {}
    return dur;
  }
  function snapTolerance(v) {
    const holder = v.closest(".video-js")?.querySelector(".vjs-progress-holder");
    const dur = durationOf(v), w = holder ? holder.getBoundingClientRect().width : 0;
    return isFinite(dur) && dur > 0 && w > 0 ? Math.max(2, (dur * 12) / w) : 2;
  }

  // A seek from `from` to `to`, decided.
  function judge(v, id, from, to) {
    const budget = skipBudget();
    const rec = sceneRec(id);
    if (budget !== null) {
      const near = snapTarget(rangesOf(rec), to, snapTolerance(v));
      if (near !== null) { cur = { id, t: near }; sendBack(v, near, tc("吸附到已看过的部分", "Snapped to what you've watched"), true); return; }
    }
    const d = seekDecision(rec, to, budget);
    lock.scenes[id] = d.rec;
    if (d.allow) {
      cur = { id, t: to };
      if (d.skip) {
        dirty = true;
        writeState(lock);
        saveProgress(true);
        ldToast(d.left ? tc(`用掉一次跳过：${plural(d.left, "skip", "skips")}（本场景剩余）`, `Skip used: ${plural(d.left, "skip", "skips")} left in this scene`) : tc("本场景最后一次跳过已用掉", "Last skip in this scene used"));
      }
    } else {
      cur = { id, t: from };
      sendBack(v, from, budget === 0 && !rec.bonus ? tc("不可跳过：只能跳到已看过的部分", "No skipping: only the parts you've watched") : tc("尚未看过，且本场景已无跳过次数", "Not watched yet, and no skips left in this scene"));
    }
  }

  function endDrag() {
    const dr = drag;
    drag = null;
    if (!lock || !dr) return;
    const v = playerVideo();
    if (!v || sceneHere() !== dr.id || scrubbing(v)) return;
    if (isSnap(v.currentTime)) return;
    judge(v, dr.id, dr.from, v.currentTime);
  }

  // Playing on adds to the watched parts; a jump nobody reported is judged.
  function observe(v, id) {
    const t = v.currentTime;
    if (!isFinite(t) || v.seeking || scrubbing(v) || drag) return;
    if (!cur || cur.id !== id) {                               // where a scene opens is fine
      cur = { id, t };
      return;
    }
    const d = t - cur.t;
    if (d >= 0 && d <= 3) {
      if (d > 0) {
        const rec = sceneRec(id);
        rec.ranges = addRange(rangesOf(rec), cur.t, t);
        delete rec.far;
        dirty = true;
        trackStay(v, id, t);
        trackOne(id);
      }
      cur.t = t;
      return;
    }
    if (isSnap(t)) { cur.t = t; snap = null; return; }
    if (!byUser()) { cur.t = t; return; }                       // the player was placed, not sought
    judge(v, id, cur.t, t);
  }

  for (const t of ["pointerup", "pointercancel", "mouseup", "touchend"]) {
    document.addEventListener(t, () => { if (drag) setTimeout(endDrag, 80); }, true);
  }

  document.addEventListener("seeking", (ev) => {
    const v = ev.target;
    if (!lock || !isPlayer(v)) return;
    const id = sceneHere();
    if (!id) return;
    const to = v.currentTime, now = Date.now();
    if (isSnap(to)) { snap = null; cur = { id, t: to }; return; }
    const from = cur && cur.id === id ? cur.t : null;
    if (scrubbing(v)) { if (!drag || drag.id !== id) drag = { id, from: from === null ? to : from }; return; }
    // not known to belong yet: a record now would let a played scene through
    // "unwatched only" (review, 2.2)
    if (allowedCache.get(`${lock.id}:scene:${id}`) !== true) return;
    const rec = sceneRec(id);
    if (!rec) return;
    if (from === null || !byUser()) {
      cur = { id, t: to };
      return;
    }
    judge(v, id, from, to);
  }, true);

  document.addEventListener("timeupdate", (ev) => {
    const v = ev.target;
    if (!lock || !isPlayer(v)) return;
    const id = sceneHere();
    if (!id || allowedCache.get(`${lock.id}:scene:${id}`) !== true) return;
    observe(v, id);
  }, true);

  // The watched parts, painted on video.js's progress bar under the play
  // position. Redrawn only when they change.
  function paintWatched(v, id) {
    const box = v.closest(".video-js");
    const holder = box && box.querySelector(".vjs-progress-holder");
    const dur = durationOf(v);
    if (!holder || !isFinite(dur) || dur <= 0) return;
    let layer = holder.querySelector(".ld-watched");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "ld-watched";
      holder.insertBefore(layer, holder.querySelector(".vjs-play-progress") || holder.firstChild);
    }
    const ranges = rangesOf((lock.scenes || {})[id]);
    const key = `${id}|${Math.round(dur)}|${ranges.map((r) => r.join("-")).join(",")}`;
    if (layer.dataset.key === key) return;
    layer.dataset.key = key;
    layer.innerHTML = ranges.map(([s, e]) =>
      `<i style="left:${((s / dur) * 100).toFixed(3)}%;width:${((Math.max(0, Math.min(e, dur) - s) / dur) * 100).toFixed(3)}%"></i>`).join("");
  }
  function clearWatched() {
    document.querySelectorAll(".ld-watched").forEach((e) => e.remove());
    document.querySelectorAll("[data-ld-free]").forEach((e) => e.removeAttribute("data-ld-free"));
  }

  document.addEventListener("mousemove", (ev) => {
    const holder = ev.target.closest && ev.target.closest(".vjs-progress-holder");
    if (!holder || !lock || skipBudget() === null) return;
    const id = sceneHere(), v = holder.closest(".video-js")?.querySelector("video");
    if (!id || !v) return;
    const r = holder.getBoundingClientRect(), dur = durationOf(v);
    if (!r.width || !isFinite(dur) || dur <= 0) return;
    const t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * dur;
    const ranges = rangesOf((lock.scenes || {})[id]);
    holder.dataset.ldFree = watchedAt(ranges, t) || snapTarget(ranges, t, snapTolerance(v)) !== null ? "1" : "0";
  }, true);

  document.addEventListener("ratechange", (ev) => {
    const v = ev.target;
    if (!lock || !lock.rules || !lock.rules.speed || !isPlayer(v)) return;
    if (v.playbackRate > 1) { v.playbackRate = 1; ldToast(tc("本次锁定禁止快进", "No fast-forward in this lockdown")); }
  }, true);

  // "Stay to the end": the scene being watched (`lock.current`) must play to
  // its end before another opens. It becomes current once it plays, and is
  // done at its last seconds or its "ended".
  const stayOn = () => !!(lock && lock.rules && lock.rules.stay);
  function trackStay(v, id, t) {
    if (!stayOn()) return;
    const c = lock.current;
    if (!c || c.done) { if (!c || c.id !== id || !c.done) { lock.current = { id, done: false }; dirty = true; } }
    const dur = durationOf(v);
    if (lock.current && lock.current.id === id && !lock.current.done && isFinite(dur) && dur > 0 && t >= dur - 3) finishCurrent();
  }
  function finishCurrent() {
    if (!lock || !lock.current || lock.current.done) return;
    lock.current = { ...lock.current, done: true };
    dirty = true;
    saveProgress(true);
    if (stayOn()) ldToast(tc("场景一次看完：挑下一个", "Scene finished: pick the next one"), "done");
  }
  // A scene other than the one that must be finished first.
  const stayBlocks = (id) => stayOn() && !!lock.current && !lock.current.done && lock.current.id !== String(id);

  // One scene (2.2, user feedback: a condition for Timer): the first scene
  // played is the run's scene; no other opens; at its end it starts again
  // with its watched timeline cleared, so each play is watched like the
  // first (the user's choice; otherwise one pass makes every seek free).
  const oneOn = () => !!(lock && lock.rules && lock.rules.one && lock.one);
  function trackOne(id) {
    if (!oneOn() || lock.one.id) return;
    lock.one = { ...lock.one, id: String(id) };
    dirty = true; writeState(lock); saveProgress(true);
    ldToast(tc("单一场景：这就是整盘唯一的场景", "One scene: this is the scene for the whole run"), true);
  }
  const oneBlocks = (id) => oneOn() && !!lock.one.id && lock.one.id !== String(id);
  function loopOne(v, id) {
    const loops = (lock.one.loops || 0) + 1;
    lock.one = { ...lock.one, loops };
    // 2.6: the markers seen and a moment's extra skip stay with the scene
    const was = (lock.scenes || {})[id] || {};
    lock.scenes = { ...(lock.scenes || {}), [id]: { ranges: [], skips: 0, loop: loops, t0: Date.now(),
                                                   ...(was.marks ? { marks: was.marks } : {}), ...(was.bonus ? { bonus: was.bonus } : {}) } };
    dirty = true; writeState(lock); saveProgress(true);
    cur = { id, t: 0 };
    sendBack(v, 0, tc(`单一场景：第 ${loops + 1} 次播放`, `One scene: play ${loops + 1}`), true);
    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }

  // A file that will not play: Stay to the end lets go of it, and One scene
  // takes the next one played, rather than leaving only Give up.
  document.addEventListener("error", (ev) => {
    if (!lock || !(ev.target instanceof HTMLMediaElement) || !isPlayer(ev.target)) return;
    const id = sceneHere();
    if (!id) return;
    if (lock.current && lock.current.id === id && !lock.current.done) finishCurrent();
    if (lock.one && lock.one.id === id) { lock.one = { ...lock.one, id: null }; dirty = true; writeState(lock); saveProgress(true); }
  }, true);

  // Random scenes: when a scene ends, the next one is random too.
  document.addEventListener("ended", (ev) => {
    if (!lock || !isPlayer(ev.target)) return;
    if (oneOn() && lock.one.id && lock.one.id === sceneHere()) { loopOne(ev.target, lock.one.id); return; }
    if (lock.current && lock.current.id === sceneHere()) finishCurrent();
    if (lock.rules && lock.rules.random) goRandom();
  }, true);

  // ── Sync with Stash (every device) ─────────────────────────────────────────

  // Puts this lock into Stash, unless it already ended somewhere (its entry
  // is in the history) or another lock took its place (the next sync adopts
  // that one).
  function pushLock() {
    const mine = lock;
    if (!mine) return Promise.resolve();
    return updateConfig(({ list, active }) => {
      if (list.some((e) => e && e.id === mine.id)) return {};
      if (active && active.id !== mine.id) return {};
      return { active: active ? mergeLock(active, mine) : mine };
    }).then((cur) => { if (lock && cur.active && cur.active.id === lock.id) confirmedId = lock.id; })
      .catch((e) => log(`${tc("锁未能保存到 Stash：", "Lock not saved to Stash:")} ${e.message}`, "error"));
  }

  // Watch time, playheads and skips, merged into Stash's copy now and then.
  function saveProgress(force) {
    if (!lock || !dirty || saving || confirmedId !== lock.id) return;
    if (!force && Date.now() - lastSave < SAVE_MS) return;
    saving = true;
    dirty = false;
    lastSave = Date.now();
    const mine = lock;
    writeState(mine);
    updateConfig(({ active }) => (active && active.id === mine.id ? { active: mergeLock(active, mine) } : {}), true)
      .catch(() => { dirty = true; })
      .finally(() => { saving = false; });
  }

  // What Stash holds against what this page has: a lock started elsewhere
  // is adopted, one ended elsewhere ends here, the same lock is merged.
  let lastSync = 0, syncing = false;
  async function sync(force) {
    if (syncing) return;
    if (!force && (document.visibilityState !== "visible" ||
                   Date.now() - lastSync < (lock ? SYNC_LOCKED_MS : SYNC_IDLE_MS))) return;
    syncing = true;
    lastSync = Date.now();
    try {
      const cfg = await readConfig();
      if (cfg.failed) return;
      let remote = cfg.active;
      // A run that already ended (in the history, or ended here moments ago
      // while this read was out) is not taken up again: a write that raced
      // the end could leave it in `active` (review, 2.2). Clear it instead.
      if (remote && (endedIds.has(remote.id) || cfg.list.some((e) => e && e.id === remote.id))) {
        const ghost = remote.id;
        remote = null;
        if (!lock || lock.id !== ghost) updateConfig(({ active }) => (active && active.id === ghost ? { active: null } : {})).catch(() => {});
      }
      if (!lock) { if (remote) adopt(remote); return; }
      if (!remote) {
        // Gone from Stash: ended elsewhere if Stash had it, else not saved yet.
        const entry = cfg.list.find((e) => e && e.id === lock.id);
        if (confirmedId === lock.id || entry) endedElsewhere(entry && entry.result);
        else pushLock();
        return;
      }
      if (remote.id !== lock.id) { adopt(remote); return; }
      confirmedId = lock.id;
      lock = mergeLock(remote, lock);
      writeState(lock);
    } finally { syncing = false; }
  }

  // ── Nav button ─────────────────────────────────────────────────────────────

  // Stash's own nav icon classes, sized 1em by the stylesheet like its Font
  // Awesome icons (2.3 drew it 18 px inline). fx-keep-color: Flexoki paints
  // nav icons currentColor except these, and the lock stays red (§4.15).
  const ICON = `<svg class="nav-menu-icon fx-keep-color d-block d-xl-inline mb-2 mb-xl-0" viewBox="0 0 16 16" width="1em" height="1em" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;

  function ensureNav() {
    const nav = document.querySelector(".top-nav .navbar-collapse .navbar-nav");
    if (!nav || nav.querySelector(".ld-nav")) return;
    injectStyles();
    const item = document.createElement("div");
    item.className = "nav-link ld-nav col-4 col-sm-3 col-md-2 col-lg-auto";
    const a = document.createElement("a");
    a.href = "#";
    a.className = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column " +
                  "justify-content-between align-items-center btn btn-primary";
    a.innerHTML = ICON + "<span>Lockdown</span>";
    a.title = tc("把 Stash 锁定到某位演员、工作室或标签，直到你出局", "Lock Stash to a performer, studio or tag until you get out");
    a.addEventListener("click", (ev) => { ev.preventDefault(); a.blur(); if (hasPage) showPage(); else if (!lock) openStart(); });
    item.appendChild(a);
    nav.appendChild(item);
  }

  // ═══ Start ═════════════════════════════════════════════════════════════════

  // An open dialog owns the keyboard (modalKey). Window capture runs before
  // listeners further down; stopImmediatePropagation also stops window
  // listeners added after this one, and preventDefault tells those added
  // before (they check defaultPrevented). Keys typed into the dialog's boxes
  // are left to the boxes, which stop them themselves.
  window.addEventListener("keydown", (ev) => {
    const back = document.querySelector(".ld-modal-back");
    if (!back || ev.defaultPrevented) return;
    const t = ev.target;
    const typing = !!t && (t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") && t.type !== "checkbox"));
    const act = modalKey(ev, typing, back.dataset.sticky === "1");
    if (!act) return;
    ev.stopImmediatePropagation();
    if (act === "close") { ev.preventDefault(); closeModal(); }
    else if (act === "stop") ev.preventDefault();
  }, true);

  // Another tab of this browser started, changed or ended the lock.
  window.addEventListener("storage", (ev) => {
    if (ev.key !== STATE_KEY) return;
    const next = readState();
    const changed = !next || !lock || next.id !== lock.id;
    lock = changed ? next : mergeLock(next, lock);
    if (changed) { resetChecks(); confirmedId = null; pagePrefill = null; renderPage(); }
    if (lock) enforce(true); else clearBar();
  });

  // Check a route the moment the app changes it, before it renders, rather
  // than up to 250 ms later: a forbidden page should never flash up.
  for (const fn of ["pushState", "replaceState"]) {
    const orig = history[fn].bind(history);
    history[fn] = (...a) => { const r = orig(...a); if (lock) enforce(false); return r; };
  }
  window.addEventListener("popstate", () => { if (lock) enforce(false); });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { lastMark = 0; sync(true); }
    else if (lock) { writeState(lock); saveProgress(true); }
  });
  window.addEventListener("pagehide", () => { if (lock) { writeState(lock); saveProgress(true); } });

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // A timer, not requestAnimationFrame: rAF never fires in a hidden tab.
    setTimeout(() => { queued = false; ensureNav(); if (lock) { renderBar(); scanCards(); } }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    ensureNav();
    sync(false);
    if (!lock) return;
    enforce(false);
    trackPlayback();
    tick();
    checkO();
    checkMarkers();
    scanCards();
    saveProgress(false);
  }, 250);

  ensureNav();
  if (lock) enforce(true);
  sync(true);
})();
