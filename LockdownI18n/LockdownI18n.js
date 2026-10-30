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
  var PLUGIN_VERSION = '2.20.0-1';
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
  const DATA_KEYS = ["history", "stats", "active", "presets", "pics"];   // in Suite Data's store when it is installed (pics: 2.9)
  const STATE_KEY = "lockdownI18nState";   // this browser's copy of the active lock
  const PREF_KEY  = "lockdownI18nPrefs";   // { setup, last, guideSeen, barTipSeen }
  const HOLD_MS   = 5000;              // how long Give up must be held
  const ARM_MS    = 6000;              // "Click again to ..." stays armed this long (suite standard)
  const HISTORY_MAX = 200;
  const SYNC_LOCKED_MS = 5000;         // how often a locked page re-reads the lock (the polling tab)
  // 2.11 (review M5): an unlocked page looks for a lock every minute (it was
  // 20 s on every Stash tab of every user), and at once when the tab comes
  // back, gets focus or opens New run
  const SYNC_IDLE_MS = 60000;
  const SYNC_FOLLOW_MS = 30000;        // a locked tab that is not the polling one (it follows the storage event)
  const SYNC_FULL_MS = 60000;          // with Suite Data, a sync reads `active` alone; everything at most this often
  const O_SCENE_MS = 2500;             // the open scene's own O count (one small query)
  const O_FULL_SCENE_MS = 15000;       // every O of the target, on a scene page (the open scene catches the rest)
  const O_FULL_MS = 10000;             // and elsewhere
  const OWNER_KEY = "lockdownPollOwner";   // which tab of this browser polls while locked (single-owner tab lock)
  const OWNER_TTL_MS = 6000, OWNER_RENEW_MS = 2000;
  const PENDING_KEY = "lockdownPendingEnd";   // finished runs whose write has not landed yet (review M4)
  const GQL_TIMEOUT_MS = 20000;        // a request that never answers no longer freezes a loop (review M6)
  const SAVE_MS = 15000;              // progress (watch time, playhead) is written at most this often
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
    // 2.12 (user): Stash's Settings, every tab and sub-route, open during a
    // lock; the visit is noted in the run's history (enforce)
    if (isSettingsPath(p)) return { ok: true, settings: true };
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

  function isSettingsPath(pathname) {
    const p = String(pathname || "").replace(/\/+$/, "");
    return p === "/settings" || p.startsWith("/settings/");
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
      text: tc("场景不由你选：每个都是随机挑的，放完后下一个也一样。在全部放完之前不会重复同一个场景；双人锁定则轮流来。点「下一个场景」（播放器的下一个按钮）会再随机挑一个，且始终免费；跳过配额只用于在场景内拖动进度。", "You don't choose scenes: each one is picked at random, and so is the next when it ends. It never repeats a scene until all of them have played; a duo takes turns. Next scene (the player's next button) picks another one, always free; a Skip budget only counts seeking inside a scene.") },
    { k: "stay", name: tc("坚持到底", "Stay to the end"), heat: [2], ranks: [tc("每个场景都看完", "Finish every scene")],
      text: tc("一旦某个场景开始播放，在它放完（且看满 80%）之前不会打开别的场景。", "Once a scene plays, no other scene opens until it has played to the end, with most of it (80%) watched.") },
    // 2.13.0 (user): and the timeline's preview pictures are hidden, so the
    // frames ahead cannot be looked at either (previewGuard)
    { k: "speed", name: tc("禁止快进", "No fast-forward"), heat: [0.5], ranks: [tc("1 倍速、无预览", "1x speed, no previews")],
      text: tc("播放速度固定在 1 倍速，时间轴的预览图也一并隐藏：鼠标悬停在进度条上不会弹出画面，播放器下方的缩略图条也消失。", "Playback speed is held at 1x, and the timeline's preview pictures are hidden: no frame pops up when you hover over the seek bar, and the scrubber strip under the player is gone.") },
    // 2.13.0 (the user, after an interview): looking away from the playing
    // scene (the tab hidden, or the window losing focus to another app) for
    // more than EYES_GRACE_MS stops the clock and drains points (eyesCheck)
    { k: "eyes", name: tc("盯着画面", "Eyes on screen"), heat: [2], ranks: [tc("不许看别处", "No looking away")],
      text: tc("场景播放时，让 Stash 一直留在你眼前。切换标签页、最小化浏览器或点到别的应用超过 5 秒就算离开：这段时间不计入目标、也不计入观看得分，并且每 2 秒扣 1 分。视频仍会继续播放。", "While a scene plays, keep Stash in front of you. Switching tabs, minimising the browser or clicking into another app for more than 5 seconds counts as away: that time doesn't count toward your target or your watched score, and it costs a point every 2 seconds. The video keeps playing.") },
    // 2.12.2: Blind seeking is gone from here (RETIRED below)
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
    // 2.12 (user): the target is drawn around the time you set and kept from
    // you until the end, so watched time alone no longer tells how far it is
    { k: "hide", name: tc("隐藏目标", "Hidden target"), goal: "edge", heat: [1], ranks: [tc("目标保密", "Target hidden")],
      text: tc("真正的目标在你设定时长的附近（上下各四分之一）。进度条只给出大致提示（刚开始、过半、快到了）和已观看时长；出局后才揭晓。", "The real target is somewhere around the time you set (a quarter either way). The bar shows only a rough hint (early, about halfway, nearly there) and your watched time; the result reveals it.") },
    // 2.12 (user): Intiface Sync's Goon mode drives the build-up. It needs
    // Intiface Sync 1.49 (window.IntifaceSync.goon) and a click on Start the
    // toy; its heat counts only if Goon mode ran for TOY_SHARE of the watching
    { k: "toy", name: tc("玩具主导", "Toy in charge"), goal: "edge", heat: [2], ranks: [tc("Goon 模式驱动", "Goon mode drives it")], needs: "goon",
      text: tc("由 Intiface Sync 的 Goon 模式驱动进程。开局后按一次「启动玩具」；只有 Goon 模式运行了至少 80% 的观看时长，这份热度才算数。", "Intiface Sync's Goon mode drives the build-up. Press Start the toy once the run begins; the heat counts only if Goon mode ran for at least 80% of your watched time.") },
    // 2.2 (user feedback): Timer had no condition of its own, so its runs
    // could not reach the heat of Finish and Edge.
    { k: "one", name: tc("单一场景", "One scene"), goal: "timer", heat: [2], ranks: [tc("循环重播", "On repeat")],
      text: tc("整盘只有一个场景，每次放完都从头再来。你第一个播放的场景就是它（配合轮盘时则是随机一个）。", "The whole run is one scene, played again from the start each time it ends. The first scene you play is the one (with Roulette, a random one).") },
  ]);
  // 2.12.2 (user: "Blind seeking doesn't work, just remove it"): conditions
  // no new run can have. Hiding Stash's previews never held (they are drawn
  // in too many places), so the condition was taken out, not fixed. New
  // setups drop it (normaliseSetup, the conditions() loop); runs that had it
  // keep their recorded heat and score and show it by this name, and a run
  // without a stored heat still counts it (heatOf over anyCond()), so nothing
  // already played rescores. Stored presets are not rewritten (rule 5): they
  // load without it, with one notice (retiredIn), until saved again.
  const retiredConds = () => ([
    { k: "blind", name: tc("盲拖进度条（已停用）", "Blind seeking (retired)"), heat: [1], ranks: [tc("无预览", "No previews")], retired: true },
  ]);
  const anyCond = () => conditions().concat(retiredConds());
  // The retired conditions a stored setup, preset or history entry had on
  // (their names), for the notice when it is loaded. `s.retired` is what
  // setupFromEntry found on the entry before it dropped them.
  function retiredIn(s) {
    if (!s || typeof s !== "object") return [];
    const c = s.conds && typeof s.conds === "object" ? s.conds : {};
    const had = (k) => (Array.isArray(s.retired) && s.retired.includes(k)) || Number(c[k]) > 0 || (!s.conds && !!s[k]);
    return retiredConds().filter((r) => had(r.k)).map((r) => r.k);
  }
  const retiredNote = () => tc("盲拖进度条已移除；其余设置保留", "Blind seeking was removed; the rest of the setup is kept");
  const HEAT_STEP = 0.2;               // each point of heat: +20% score
  const SLOW_MIN = [0, 10, 20, 30];
  const HARSH_MIN = [10, 20, 30];      // 2.1's minutes, for its runs
  // What an O costs in Edge (2.2): a share of the target, or starting over.
  const SLIP = ["third", "half", "reset"];
  const SKIPS_AT = [null, 3, 1, 0];
  // 2.12: Hidden target draws the real one between these shares of the time
  // set; Toy in charge's heat needs Goon mode running this share of the
  // watched time (decided: started late or ended early, the toy was not in
  // charge, so the run scores without its +2)
  const HIDE_LO = 0.75, HIDE_HI = 1.25, TOY_SHARE = 0.8;
  const hiddenTarget = (min, r) => Math.max(MIN_MIN, Math.round(min * (HIDE_LO + (HIDE_HI - HIDE_LO) * Math.min(1, Math.max(0, Number(r) || 0)))));
  // Goon mode's own choices (Intiface Sync's G2_STYLES / G2_PACES ids); the
  // setup offers them, Lockdown passes them to goon.start
  const TOY_STYLES = [["climb", tc("稳步攀升", "Steady climb")], ["waves", tc("波浪", "Waves")], ["rhythm", tc("节奏", "Rhythm")], ["tease", tc("挑逗", "Tease")], ["coaster", tc("过山车", "Rollercoaster")], ["endurance", tc("耐力", "Endurance")]];
  const TOY_PACES = [["slow", tc("慢", "Slow")], ["normal", tc("常规", "Normal")], ["fast", tc("快", "Fast")]];
  // 2.13.0 (user): Goon mode starts from level 1 by default (3 before);
  // the setup's Level picker still sets any start level (toyLevelPrefs
  // moves a setup that only had the old default)
  const TOY_DEFAULT = { style: "waves", level: 1, pace: "normal" };
  function normaliseToy(t) {
    const x = t && typeof t === "object" ? t : {};
    return { style: TOY_STYLES.some(([k]) => k === x.style) ? x.style : TOY_DEFAULT.style,
             level: clamp(x.level, 1, 10, TOY_DEFAULT.level),
             pace: TOY_PACES.some(([k]) => k === x.pace) ? x.pace : TOY_DEFAULT.pace };
  }
  // 2.13.0 (user: "No fast-forward still shows the timeline preview on
  // hover"): under it the frames ahead are hidden too. The stylesheet does
  // it under body.ld-noff (renderBar); this sets the same inline with
  // !important on the elements themselves, which no rule of Stash's or a
  // theme's can undo, and takes it off again when the run ends (clearBar,
  // and the 250 ms loop once no such run is on). Blind seeking (2.1-2.12.1)
  // relied on its body class alone.
  const PREVIEW_SEL = ".video-js .vjs-vtt-thumbnail-display, .scrubber-wrapper";
  function previewGuardIn(doc, on) {
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    if (on) {
      for (const el of doc.querySelectorAll(PREVIEW_SEL)) {
        if (el.dataset.ldHid === "1" && el.style.getPropertyPriority("display") === "important") continue;
        el.dataset.ldHid = "1";
        el.style.setProperty("display", "none", "important");
      }
    } else {
      for (const el of doc.querySelectorAll("[data-ld-hid]")) { el.style.removeProperty("display"); delete el.dataset.ldHid; }
    }
  }

  // 2.13.0: this browser's stored setup and last setup carry Toy in
  // charge's level whether or not the user ever touched it (render stores the
  // whole setup), so the old default 3 is moved to 1 once (`toyL1`). A 3
  // chosen by hand before 2.13 moves too, once; presets (saved by name) and
  // history entries (Play again) keep theirs. null: nothing to change.
  function toyLevelPrefs(p) {
    if (!p || typeof p !== "object" || p.toyL1) return null;
    const fix = (s) => (s && typeof s === "object" && s.toy && typeof s.toy === "object" && Number(s.toy.level) === 3
      ? { ...s, toy: { ...s.toy, level: TOY_DEFAULT.level } } : s);
    const out = { ...p, toyL1: 1 };
    if (p.setup) out.setup = fix(p.setup);
    if (p.last && typeof p.last === "object" && p.last.setup) out.last = { ...p.last, setup: fix(p.last.setup) };
    return out;
  }
  const toyStyleName = (k) => (TOY_STYLES.find(([s]) => s === k) || [k, k])[1];
  // A run's toy: whether its heat counts. null for a run without Toy in charge.
  function toyEarned(L) {
    if (!L || !L.conds || !L.conds.toy || goalType(L) !== "edge") return null;
    const w = L.watchedMs || 0, ms = (L.toy && L.toy.ms) || 0;
    const share = w > 0 ? Math.min(1, ms / w) : 0;
    return { earned: w > 0 && share >= TOY_SHARE, share, ms, watched: w };
  }
  // Edge with a hidden target: how far, in three words, never a number.
  const edgeHint = (frac) => (frac < 0.35 ? tc("刚开始", "early") : frac < 0.75 ? tc("过半", "about halfway") : tc("快到了", "nearly there"));
  // 2.12.1 (decided, the 2.12.0 open point): past a hidden target the time
  // stays hidden until the result card: no watched time, overtime clock,
  // meter or score on the bar, the overtime card or the run page (each one
  // told the target by subtraction), only "past the target · keep going"
  const hiddenPast = (L) => !!(L && L.over && L.goal && L.goal.type === "edge" && L.goal.hidden);
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
      // 2.12: Toy in charge's Goon mode settings (kept whether it is on or not)
      toy: normaliseToy(x.toy),
      // 2.16: tag cards chosen by hand; null: the favourite tags
      cards: normaliseCardTags(x.cards),
    };
  }

  function heatOf(conds, goal) {
    const g = goal && goal.type ? goal.type : goal;
    const one = !!(conds && conds.one) && g === "timer";
    // anyCond(): a recorded run with a retired condition keeps its heat; a
    // new setup has none (normaliseSetup)
    return anyCond().reduce((h, c) => (condApplies(c, g) && conds && conds[c.k] && !(one && c.k === "stay")
      ? h + c.heat[conds[c.k] - 1] : h), 0);
  }
  const heatMult = (heat) => Math.round((1 + (heat || 0) * HEAT_STEP) * 100) / 100;

  function goalOf(setup) {
    // A Timer counts watched time (the default) or locked time.
    if (setup.goal === "timer") return setup.timerBy === "locked"
      ? { type: "timer", ms: setup.timerMin * 60000 } : { type: "timer", ms: setup.timerMin * 60000, by: "watched" };
    // 2.12: Hidden target marks the goal; newLock draws the real watchMs
    // (and keeps the time set as `about`)
    if (setup.goal === "edge") return { type: "edge", watchMs: setup.edgeMin * 60000, slip: SLIP[(setup.conds && setup.conds.harsh) || 0],
                                        ...(setup.conds && setup.conds.hide ? { hidden: true } : {}) };
    return { type: "finish", os: setup.os };
  }

  // What the enforcement reads; the minimum time only means something when
  // an O is the way out.
  function rulesOf(setup) {
    const c = setup.conds || {};
    return { skips: SKIPS_AT[c.skip || 0], speed: !!c.speed, random: !!c.roulette, fresh: !!c.fresh,
             minMs: setup.goal === "finish" ? SLOW_MIN[c.slow || 0] * 60000 : 0,
             stay: !!c.stay, one: setup.goal === "timer" && !!c.one,
             ...(setup.goal === "edge" && c.toy ? { toy: true } : {}),
             ...(c.eyes ? { eyes: true } : {}) };
  }

  // A history entry's setup, to play it again. Entries from 2.0 have rules
  // instead of conditions; from before 2.0 none: one O, maybe roulette.
  function setupFromEntry(e) {
    const g = (e && e.goal) || { type: "finish", os: 1 };
    const r = (e && e.rules) || { skips: null, speed: false, random: !!(e && e.roulette), fresh: false, minMs: 0 };
    // 2.12: a hidden target plays again at the time that was set (`about`);
    // Toy in charge whose heat did not count left the entry's conditions but
    // kept its settings (`toy`), so it comes back on
    const conds = { ...((e && e.conds) || condsFromRules(r, g)) };
    if (e && e.toy && g.type === "edge") conds.toy = 1;
    // 2.12.2: normaliseSetup drops a retired condition; `retired` says which,
    // for the notice (openStart), and is not part of the setup
    const gone = retiredIn({ conds });
    const out = normaliseSetup({
      kind: (e && e.kind) || "performer", pick: "choose",
      goal: g.type, os: g.os, timerMin: g.ms ? Math.round(g.ms / 60000) : undefined,
      timerBy: g.type === "timer" ? (g.by === "watched" ? "watched" : "locked") : undefined,
      edgeMin: g.about ? Math.round(g.about / 60000) : g.watchMs ? Math.round(g.watchMs / 60000) : undefined,
      conds,
      ...(e && e.toy ? { toy: e.toy } : {}),
      // 2.16: the tag cards chosen, when they were not the favourites
      ...(e && e.cardSet ? { cards: e.cardSet } : {}),
    });
    if (gone.length) out.retired = gone;
    return out;
  }

  const UNIT_ZH = { "O": "次O", "O's": "次O", skip: "次跳过", skips: "次跳过", scene: "个场景", scenes: "个场景", image: "张图片", images: "张图片", moment: "个瞬间", moments: "个瞬间", play: "次播放", plays: "次播放", card: "张牌", cards: "张牌" };
  const plural = (n, one, many) => tc(`${n} ${UNIT_ZH[one] || one}`, `${n} ${n === 1 ? one : many}`);

  // "Finish · 2 O's", "Timer · 1 h watched", "Edge · 30 min".
  function goalLabel(g) {
    if (!g || g.type === "finish") return tc(`完成 · ${plural((g && g.os) || 1, "O", "O's")}`, `Finish · ${plural((g && g.os) || 1, "O", "O's")}`);
    if (g.type === "timer") return tc(`计时 · ${fmtMinutes(g.ms / 60000)}${g.by === "watched" ? tc("（已观看）", " watched") : ""}`, `Timer · ${fmtMinutes(g.ms / 60000)}${g.by === "watched" ? tc("（已观看）", " watched") : ""}`);
    // 2.12: a hidden target before it is drawn (the setup) is "about" the
    // time set; a drawn one is shown as it is (history, board); during the
    // run the bar and the run page use liveGoalLabel
    if (g.hidden && !g.about) return tc(`边缘 · 约 ${fmtMinutes(g.watchMs / 60000)}`, `Edge · about ${fmtMinutes(g.watchMs / 60000)}`);
    return tc(`边缘 · ${fmtMinutes(g.watchMs / 60000)}`, `Edge · ${fmtMinutes(g.watchMs / 60000)}`);
  }
  const liveGoalLabel = (L) => (L && L.goal && L.goal.type === "edge" && L.goal.hidden ? tc("边缘 · 隐藏目标", "Edge · hidden target") : goalLabel(L && L.goal));

  // The rules in force, as short labels (run card, live run, briefing).
  function rulesLabels(rules, goal) {
    const r = rules || {};
    const out = [];
    if (r.skips !== null && r.skips !== undefined) out.push(r.skips === 0 ? tc("不能跳过", "no skips") : tc(`每场景 ${plural(r.skips, "skip", "skips")}`, `${plural(r.skips, "skip", "skips")} per scene`));
    if (r.random) out.push(tc("随机场景", "random scenes"));
    if (r.stay) out.push(tc("坚持到底", "stay to the end"));
    if (r.speed) out.push(tc("1 倍速、无预览", "1x speed, no previews"));
    if (r.blind) out.push(tc("盲拖进度条（已停用）", "blind seeking (retired)"));   // 2.12.2: only runs from before it was removed
    if (r.eyes) out.push(tc("盯着画面", "eyes on screen"));
    if (r.fresh) out.push(tc("仅未看过", "unwatched only"));
    if ((goal || {}).type === "finish" && r.minMs) out.push(tc(`看满 ${fmtMinutes(r.minMs / 60000)} 后 O 才计数`, `O's count after ${fmtMinutes(r.minMs / 60000)} watched`));
    if (r.one) out.push(tc("单一场景循环重播", "one scene on repeat"));
    if ((goal || {}).type === "edge" && goal.slip && goal.slip !== "third") out.push(goal.slip === "reset" ? tc("一次 O 就重新计时", "an O starts it over") : tc("每次 O 加一半", "each O adds half"));
    if ((goal || {}).type === "edge" && !goal.slip && goal.addMs && goal.addMs !== 600000) out.push(tc(`每次 O 加 ${fmtMinutes(goal.addMs / 60000)}`, `each O adds ${fmtMinutes(goal.addMs / 60000)}`));
    if ((goal || {}).type === "edge" && goal.hidden) out.push(tc("隐藏目标", "hidden target"));
    if ((goal || {}).type === "edge" && r.toy) out.push(tc("玩具主导", "toy in charge"));
    return out;
  }

  // What an O costs in Edge, in words. 2.1 runs carry fixed minutes (addMs).
  function slipText(g) {
    if (!g || !g.slip) return tc(`每次 O 加 ${fmtMinutes(((g && g.addMs) || 600000) / 60000)}`, `each O adds ${fmtMinutes(((g && g.addMs) || 600000) / 60000)}`);
    if (g.slip === "reset") return tc("一次 O 就重新计时", "an O starts it over");
    if (g.hidden) return tc(`每次 O 加目标的 ${g.slip === "half" ? tc("一半", "half") : tc("三分之一", "a third")}`, `each O adds ${g.slip === "half" ? tc("一半", "half") : tc("三分之一", "a third")} of it`);
    const add = g.slip === "half" ? g.watchMs / 2 : g.watchMs / 3;
    return tc(`每次 O 加${g.slip === "half" ? "一半" : "三分之一"}（${fmtMinutes(Math.round(add / 60000))}）`, `each O adds ${g.slip === "half" ? "half" : "a third"} (${fmtMinutes(Math.round(add / 60000))})`);
  }

  // The one-sentence deal before Start. `who` is the target's name, or a
  // "random ..." description.
  function briefing(setup, who) {
    const goal = goalOf(setup);
    const g = setup.goal === "finish" ? tc(`直到完成${setup.os === 1 ? tc("一次", "once") : tc(`${setup.os} 次`, `${setup.os} times`)}`, `until you finish ${setup.os === 1 ? "once" : `${setup.os} times`}`)
      : setup.goal === "timer" ? (setup.timerBy === "locked" ? tc(`锁定 ${fmtMinutes(setup.timerMin)}`, `for ${fmtMinutes(setup.timerMin)}`) : tc(`直到看满 ${fmtMinutes(setup.timerMin)}`, `until you've watched ${fmtMinutes(setup.timerMin)}`))
      : tc(`直到看满 ${goal.hidden ? tc(`约 ${fmtMinutes(setup.edgeMin)}（真实目标保密）`, `about ${fmtMinutes(setup.edgeMin)} (the real target is hidden)`) : fmtMinutes(setup.edgeMin)} 且没有结束，${slipText(goal)}`, `until you've watched ${goal.hidden ? `about ${fmtMinutes(setup.edgeMin)} (the real target is hidden)` : fmtMinutes(setup.edgeMin)} without finishing, ${slipText(goal)}`);
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
  const PIC_MS = 3000;                 // 2.9: a picture counts once it has been on screen this long
  const PICS_MAX = 100;                // and a run counts at most this many
  function scoreOf(e) {
    if (!e || e.result !== "done" || !(e.v >= 3)) return null;
    const g = e.goal || {};
    const wMs = g.type === "edge" && g.watchMs ? Math.min(e.watchedMs || 0, g.watchMs) : (e.watchedMs || 0);
    const watched = Math.round((wMs / 60000) * 10);
    const skips = -Math.min(SKIP_COST * (e.skipsUsed || 0), Math.floor(watched / 2));
    const slips = g.type === "edge" ? -100 * (e.slips || 0) : 0;
    const overtime = g.type === "edge" && e.overtimeMs > 0 ? Math.round((Math.min(e.overtimeMs, g.watchMs || 0) / 60000) * 10) : 0;
    const out = 100;
    // 2.9: one point per new picture viewed (PIC_MS on screen), at most
    // PICS_MAX a run; runs from before 2.9 have none and score as they did
    const pics = Math.min(PICS_MAX, Math.max(0, Math.floor(e.pics || 0)));
    const heat = typeof e.heat === "number" ? e.heat : heatOf(e.conds || condsFromRules(e.rules, g), g);
    const mult = heatMult(heat);
    // 2.11: the novelty bonus the run carried (`nov`, worked out at its
    // start); runs without it score exactly as before
    const nov = Math.min(NOV_MAX, Math.max(0, Number(e.nov) || 0));
    // 2.13.0: Eyes on screen: a point per EYES_PT_MS away past the grace
    // (before heat, like skips); the total never goes below 0
    const away = 0 - awayPts(awayMsOf(e));
    // 2.16: the hold cards passed (before heat, like pictures)
    const holds = Math.max(0, Math.floor(Number(e.holdPts) || 0));
    // 2.18: tag cards' markers (tagMatches)
    const tagm = Math.max(0, Math.floor(Number(e.tagPts) || 0));
    // 2.19: Stay cards (kept; a 2.19 run took off for broken ones, so it can
    // be below 0) and the Race (won or lost)
    const stays = Math.round(Number(e.stayPts) || 0), race = Math.round(Number(e.racePts) || 0);
    // 2.20: skip cards still in hand at the end
    const skipc = SKIP_CARD_PTS * Math.max(0, Math.floor(Number(e.skipCards && e.skipCards.kept) || 0));
    return { watched, skips, slips, overtime, pics, out, heat, mult, nov, away, holds, tagm, stays, race, skipc,
             total: Math.max(0, Math.round((watched + skips + slips + overtime + pics + out + away + holds + tagm + stays + race + skipc) * mult * (1 + nov))) };
  }

  // ── 2.16: cards in hand (user, in an interview: hold cards "should be out
  // of the way and be able to trigger when I want to ... they could also
  // expire"; tag cards "a set of tags that we can bring into the run as a
  // card to play. and they would refill as we watch more (cooldowns)").
  // Decided: a hold card is dealt every 10 watched minutes (a hand of 2 at
  // most) and expires 10 watched minutes later; the one hold is Eyes on
  // screen for 2 minutes of playing, +30 before heat. Tag cards are the
  // user's favourite tags by default (editable in the setup, 4 at most,
  // only tags the target has scenes with); one opens a scene of the target
  // with that tag (unseen this round first) and is back after 10 watched
  // minutes. Watched time drives all of it, so a pause neither deals nor
  // burns a card. `lock.hand`: { tags: [{ id, name, at }] (at: the watched
  // ms it is ready again, 0 now), holds: [{ k, until }], dealt, hold:
  // { k, from } (playing one), passed, failed, pts, rev }.
  const CARD_TAGS_MAX = 4, CARD_RECHARGE_MS = 10 * 60000;
  const SKIP_CARD_EVERY_MS = 10 * 60000, SKIP_CARD_MAX = 3, SKIP_CARD_PTS = 15;   // 2.20
  const HOLD_EVERY_MS = 10 * 60000, HOLD_LASTS_MS = 10 * 60000, HOLD_HAND = 2;
  const HOLD_KINDS = {
    eyes: { name: tc("盯着画面", "Eyes on screen"), ms: 2 * 60000, pts: 30, text: tc("连续播放 2 分钟，期间不切换标签页或应用", "2 minutes of playing without switching tabs or apps") },
    // 2.19 (user: "you have to watch minimum 5 min within the current open
    // scene. also a 10 min version"): Stay cards, dealt in the same deal.
    // Played on the scene on screen; its watched time counts (skips, pausing
    // and replays are fine). 2.20 (user: "the penalty of stay should be
    // removed it should only reward if complete"): opening another scene
    // only loses the card, nothing is taken off; the scene ending plays it
    // again (the "ended" listener) rather than Roulette's next.
    stay5: { name: tc("停留 5", "Stay 5"), ms: 5 * 60000, pts: 40, stay: true, text: tc("在本场景连续播放 5 分钟；打开别的场景就会失去它", "5 minutes of playing on this scene; opening another scene loses it") },
    stay10: { name: tc("停留 10", "Stay 10"), ms: 10 * 60000, pts: 100, stay: true, text: tc("在本场景连续播放 10 分钟；打开别的场景就会失去它", "10 minutes of playing on this scene; opening another scene loses it") },
  };
  // The deal picks one of these by the hand's seed and the deal's number,
  // so every device deals the same card. A run where another scene can't
  // be opened anyway (One scene, Stay to the end) deals only Eyes on screen.
  const HOLD_DEAL = ["eyes", "stay5", "stay10"];
  function dealKind(seed, due, stays) {
    if (!stays) return "eyes";
    let a = ((seed | 0) + Math.imul(due | 0, 0x9e3779b1)) | 0;
    a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a ^= a >>> 16;
    return HOLD_DEAL[(a >>> 0) % HOLD_DEAL.length];
  }
  // 2.19: the Race (Oddysee's forum idea, a card that has you finish
  // before a countdown ends; the user's choices: once a run, late; a fixed
  // 3 minutes of real time; +100 won, -50 lost, before heat). Dealt past
  // half a Timer, when Edge overtime starts (before it an O is a slip),
  // and in a Finish run after RACE_FINISH_AFTER_MS watched once O's count
  // (Slow burn done). An O that counts, seen by the O check within the 3
  // minutes (RACE_GRACE_MS for the check's own delay), wins it. A Timer
  // run goes on; in Finish and Edge the O usually ends the run, with the
  // bonus in it. `hand.race`: { st: "held" | "on" | "won" | "lost", from,
  // until, ms (how long it took) }.
  const RACE_MS = 3 * 60000, RACE_WIN = 100, RACE_LOSE = 50, RACE_GRACE_MS = 20000, RACE_FINISH_AFTER_MS = 15 * 60000;
  function raceDue(L, now) {
    if (!L || !L.goal) return false;
    const g = L.goal, w = L.watchedMs || 0;
    if (g.type === "timer") return g.by === "watched" ? w >= g.ms / 2 : (now || 0) - (L.startedAt || 0) >= g.ms / 2;
    if (g.type === "edge") return !!(L.over && L.over.on);
    if (w < RACE_FINISH_AFTER_MS) return false;
    const minMs = (L.rules && L.rules.minMs) || 0;
    if (!minMs) return true;
    return L.slowBy === "watched" ? w - (L.slowFrom || 0) >= minMs : (now || 0) - (L.startedAt || 0) >= minMs;
  }
  function handPlayRace(hand, now) {
    if (!hand || !hand.race || hand.race.st !== "held") return null;
    return { ...hand, race: { st: "on", from: now, until: now + RACE_MS }, rev: (hand.rev || 0) + 1 };
  }
  // An O that counted at `now`: the race won if it was still on (the same
  // hand when there was nothing to win).
  function raceWon(hand, now) {
    const r = hand && hand.race;
    if (!r || r.st !== "on" || now > r.until + RACE_GRACE_MS) return hand;
    return { ...hand, race: { ...r, st: "won", ms: Math.max(0, Math.min(RACE_MS, now - r.from)) }, racePts: (hand.racePts || 0) + RACE_WIN, rev: (hand.rev || 0) + 1 };
  }
  // 2.17: a tag card keeps its tag's picture (`image_path`, its preview on
  // the card), when the tag has a real one (tagPic)
  const cardPic = (t) => (tagPic(t && t.image_path) ? { image_path: tagPic(t.image_path) } : {});
  const normaliseCardTags = (v) => (Array.isArray(v) ? v.filter((t) => t && t.id).slice(0, CARD_TAGS_MAX)
    .map((t) => ({ id: String(t.id), name: String(t.name || "?"), ...cardPic(t) })) : null);
  // 2.19: `seed` picks what each deal brings (dealKind)
  const newHand = (tags, seed) => ({ tags: (tags || []).slice(0, CARD_TAGS_MAX).map((t) => ({ id: String(t.id), name: t.name || "?", ...cardPic(t), at: 0 })),
                               holds: [], dealt: 0, hold: null, passed: 0, failed: 0, pts: 0, rev: 0,
                               seed: typeof seed === "number" ? seed : Math.floor(Math.random() * 1e9) });
  // The hand at `w` watched ms: holds dealt and expired, a hold played and
  // kept to its time passed. Returns { hand, events: [{ t, k }] } (t:
  // "dealt" | "expired" | "passed" | "race-lost"); the hand is the same
  // object when nothing happened. 2.19 `o`: { stays (Stay cards can be
  // dealt), race (raceDue), now (wall clock, for the Race) }; 2.20 skips
  // (skip cards can be dealt: the run has a Skip budget).
  function handTick(hand, w, o) {
    if (!hand) return { hand, events: [] };
    const events = [];
    let h = hand;
    const edit = () => { if (h === hand) h = { ...hand, holds: hand.holds.slice(), tags: hand.tags.slice() }; return h; };
    if (h.hold && HOLD_KINDS[h.hold.k] && w - h.hold.from >= HOLD_KINDS[h.hold.k].ms) {
      const k = h.hold.k;
      edit(); h.hold = null; h.passed += 1;
      if (HOLD_KINDS[k].stay) { h.stayPts = (h.stayPts || 0) + HOLD_KINDS[k].pts; h.stayKept = (h.stayKept || 0) + 1; }
      else h.pts += HOLD_KINDS[k].pts;
      events.push({ t: "passed", k });
    }
    const live = h.holds.filter((c) => c.until > w);
    if (live.length !== h.holds.length) { edit(); events.push(...h.holds.filter((c) => c.until <= w).map((c) => ({ t: "expired", k: c.k }))); h.holds = live; }
    const due = Math.floor(Math.max(0, w) / HOLD_EVERY_MS);
    if (due > h.dealt) {
      edit();
      // a full hand lets the deal go by (the next comes 10 minutes later)
      if (h.holds.length < HOLD_HAND) {
        const k = dealKind(h.seed, due, !!(o && o.stays));
        h.holds.push({ k, until: due * HOLD_EVERY_MS + HOLD_LASTS_MS }); events.push({ t: "dealt", k });
      }
      h.dealt = due;
    }
    // 2.20: a skip card every SKIP_CARD_EVERY_MS watched, with a Skip budget
    // (o.skips); a full hand lets it go by
    const sdue = Math.floor(Math.max(0, w) / SKIP_CARD_EVERY_MS);
    if (o && o.skips && sdue > (h.sdealt || 0)) {
      edit();
      if ((h.sk || 0) < SKIP_CARD_MAX) { h.sk = (h.sk || 0) + 1; events.push({ t: "dealt", k: "skip" }); }
      h.sdealt = sdue;
    }
    if (o && o.race && !h.race) { edit(); h.race = { st: "held" }; events.push({ t: "dealt", k: "race" }); }
    if (h.race && h.race.st === "on" && o && o.now > h.race.until + RACE_GRACE_MS) {
      edit(); h.race = { ...h.race, st: "lost" }; h.racePts = (h.racePts || 0) - RACE_LOSE;
      events.push({ t: "race-lost", k: "race" });
    }
    if (h !== hand) h.rev = (hand.rev || 0) + 1;
    return { hand: h, events };
  }
  // Play the hold card at `i` (one at a time); null when it cannot be. A
  // Stay card needs the scene it is played on.
  function handPlayHold(hand, i, w, scene) {
    if (!hand || hand.hold || !hand.holds[i]) return null;
    const c = hand.holds[i], k = HOLD_KINDS[c.k];
    if (k && k.stay && !scene) return null;
    return { ...hand, holds: hand.holds.filter((_, j) => j !== i), hold: { k: c.k, from: w, ...(k && k.stay ? { scene: String(scene) } : {}) }, rev: (hand.rev || 0) + 1 };
  }
  // A hold broken. A Stay card broken is counted (stayBroke, for History);
  // 2.20: it costs nothing (2.19 took off half its points).
  function handBreakHold(hand) {
    if (!hand || !hand.hold) return hand;
    const k = HOLD_KINDS[hand.hold.k], out = { ...hand, hold: null, failed: (hand.failed || 0) + 1, rev: (hand.rev || 0) + 1 };
    if (k && k.stay) out.stayBroke = (hand.stayBroke || 0) + 1;
    return out;
  }
  // 2.20: skip cards (user: "every 10 minutes you should give 1 skip card
  // when used player can redeem one extra skip if they have used all their
  // skips in a scene. these skip cards remain in hand if unused turn into
  // points"; in the interview: dealt every 10 minutes watched, 3 in hand at
  // most, only with a Skip budget; +15 each left at the end, before heat;
  // a refused seek offers one). `hand.sk`: the cards in hand, `skUsed` the
  // ones played, `sdealt` the deals done (by 10 watched minutes, as holds).
  // Played, the scene on screen gets one more skip (`xs` in its record).
  function handPlaySkip(hand) {
    if (!hand || !(hand.sk > 0)) return null;
    return { ...hand, sk: hand.sk - 1, skUsed: (hand.skUsed || 0) + 1, rev: (hand.rev || 0) + 1 };
  }
  // Play a tag card: it is back after CARD_RECHARGE_MS more watching.
  // 2.18: `scene` and `now` (the scene it opened, when) are kept in `plays`
  // for the marker bonus (tagMatches); the last TAG_PLAYS_KEEP.
  function handPlayTag(hand, id, w, scene, now) {
    const i = hand ? hand.tags.findIndex((t) => t.id === String(id)) : -1;
    if (i < 0 || hand.tags[i].at > w) return null;
    const tags = hand.tags.slice();
    tags[i] = { ...tags[i], at: w + CARD_RECHARGE_MS };
    const out = { ...hand, tags, rev: (hand.rev || 0) + 1 };
    if (scene) out.plays = (Array.isArray(hand.plays) ? hand.plays : []).concat({ tag: tags[i].id, name: tags[i].name, scene: String(scene), at: now || 0 })
      .slice(-TAG_PLAYS_KEEP);
    return out;
  }
  // 2.18 (user: "if we have the cards of a certain tag, and then after
  // playing it, if we add a marker of that same tag in the scene we should
  // get some bonus points"): a marker added in the scene a tag card opened,
  // after it was played, whose primary tag or one of its tags is the card's
  // tag: +TAG_MATCH_PTS before heat, once per play. `markers` are the ones
  // just seen for the first time in scene `sid`. { hand, got: [tag names] }.
  const TAG_MATCH_PTS = 50, TAG_PLAYS_KEEP = 20;
  function tagMatches(hand, sid, markers, skewMs) {
    if (!hand || !Array.isArray(hand.plays) || !hand.plays.length) return { hand, got: [] };
    const id = String(sid), got = [];
    let h = hand;
    for (const m of markers || []) {
      if (!m) continue;
      const tags = [m.primary_tag].concat(m.tags || []).filter((t) => t && t.id !== undefined && t.id !== null).map((t) => String(t.id));
      const made = Date.parse(m.created_at || "");
      const i = h.plays.findIndex((x) => !x.done && x.scene === id && tags.includes(String(x.tag)) && (!isFinite(made) || made >= (x.at || 0) - (skewMs || 0)));
      if (i < 0) continue;
      const plays = h.plays.slice();
      plays[i] = { ...plays[i], done: String(m.id) };
      h = { ...h, plays, tagPts: (h.tagPts || 0) + TAG_MATCH_PTS, rev: (h.rev || 0) + 1 };
      got.push(plays[i].name);
    }
    return { hand: h, got };
  }
  const tagReadyIn = (t, w) => Math.max(0, (t && t.at ? t.at : 0) - w);
  // Ready cards, for the bar's badge.
  const handReady = (hand, w) => (hand ? hand.holds.length + hand.tags.filter((t) => !tagReadyIn(t, w)).length + (hand.race && hand.race.st === "held" ? 1 : 0) : 0);

  // ── 2.17: the new layout's pure parts (setup steps, run page, bar) ──
  // A tag's picture: Stash adds `default=true` to the URL of the placeholder
  // it draws for a tag without one, which counts as none (the tag's icon).
  function tagPic(url) {
    const u = url ? String(url) : "";
    return u && !/[?&]default=true(&|$)/i.test(u) ? u : "";
  }
  // Whether a picture moves (a GIF badge on the card): a GIF by its type or
  // name, a WebP by its VP8X header's animation flag (`head`: its first bytes).
  function picAnimated(url, type, head) {
    if (/^image\/gif\b/i.test(type || "") || /\.gif(\?|#|$)/i.test(url || "")) return true;
    if (!head || head.length < 21) return false;
    const s = (a, b) => String.fromCharCode(...Array.from(head.slice(a, b)));
    return s(0, 4) === "RIFF" && s(8, 12) === "WEBP" && s(12, 16) === "VP8X" && (head[20] & 0x02) === 0x02;
  }
  // The skips of the scene on screen as tokens: one a skip of its budget,
  // then one a bonus skip (a moment found there), then one a skip card
  // played there (2.20, `card`); the ones left first.
  // null: no Skip budget. `none`: no skipping (budget 0, no bonus).
  function skipTokens(rec, budget) {
    if (budget === null || budget === undefined) return null;
    const bonus = Math.max(0, (rec && rec.bonus) || 0), xs = Math.max(0, (rec && rec.xs) || 0), total = budget + bonus + xs, left = skipsLeft(rec, budget);
    return { total, left, bonus, xs, none: total === 0,
             list: Array.from({ length: total }, (_, i) => ({ on: i < left, bonus: i >= budget && i < budget + bonus, card: i >= budget + bonus })) };
  }
  // Whose scenes a card counts: "Mara's" (a performer's first name),
  // "their" (a duo), "Brand's" (a studio), "the" (tags).
  function ownerWord(t) {
    if (!t) return tc("这些", "the");
    if (duoOf(t)) return tc("他们的", "their");
    const n = String(t.name || "").trim();
    if (!n || t.kind === "tag") return tc("这些", "the");
    return tc(`${t.kind === "studio" ? n : n.split(/\s+/)[0]} 的`, `${t.kind === "studio" ? n : n.split(/\s+/)[0]}'s`);
  }
  // A tag card's line in the setup: how many of the target's scenes have it
  // (null while counted; 0: it is left out of the run).
  function cardCountText(n, total, t) {
    if (n === null || n === undefined) return tc("统计中…", "Counting…");
    const o = ownerWord(t);
    if (!n) return tc(`${o}场景一个都没有：本次对局不包含它`, `None of ${o} scenes: left out of this run`);
    return tc(`${o} ${total ? `${total.toLocaleString()} ` : ""}个场景中有 ${n} 个`, `${n} of ${o} ${total ? `${total.toLocaleString()} ` : ""}scenes`);
  }
  // A tag card in a run: its scenes (ids) and how many the run has not shown
  // yet (a tag card deals one of those first, deckPick with an empty deck).
  function tagCardStats(ids, scenes) {
    const recs = scenes || {}, list = ids || [];
    const fresh = list.filter((id) => { const r = recs[id]; return !(r && (r.at || r.t0)); }).length;
    return { n: list.length, fresh };
  }
  // 2.17: Body stats, a page tab while locked to a performer (one or a duo)
  // when Performers Toolkit offers its Body section (`bodyInto`); never for
  // a studio or tags. The performers, in order.
  const bodyTabOk = (L, pt) => !!L && (L.kind || "performer") === "performer" && !!pt && typeof pt.bodyInto === "function";
  const bodyIds = (L) => (duoOf(L) ? duoOf(L).slice(0, 2).map((p) => ({ id: String(p.id), name: p.name || "?" }))
    : L && L.tid ? [{ id: String(L.tid), name: L.name || "?" }] : []);
  // The cards popover right under its button (a viewport rect), inside the
  // window, its notch over the button's middle.
  function popPlace(r, vw, w) {
    const width = Math.max(200, Math.min(w, vw - 16));
    const left = Math.max(8, Math.min(vw - width - 8, r.right + 8 - width));
    const notch = Math.max(14, Math.min(width - 26, r.left + r.width / 2 - left - 6));
    return { left: Math.round(left), top: Math.round(r.bottom + 10), width: Math.round(width), notch: Math.round(notch) };
  }
  // The setup's four steps: the one being set is "now", the ones before it
  // (and any set already) "done", the ones not reached yet "next".
  function stepStates(cur, reached, valid) {
    return [1, 2, 3, 4].map((i) => (i === cur ? "now" : i <= reached && valid[i - 1] ? "done" : "next"));
  }
  // The deal in plain words, two lines: "Watch 30 min without finishing." /
  // "An O starts it over." `live`: a run's (a hidden target stays hidden).
  function dealWords(g, live) {
    if (!g || g.type === "finish") { const n = (g && g.os) || 1; return [n === 1 ? tc("完成一次即可出局。", "Finish once to get out.") : tc(`完成 ${n} 次即可出局。`, `Finish ${n} times to get out.`), ""]; }
    if (g.type === "timer") return [g.by === "watched" ? tc(`看满 ${fmtMinutes(g.ms / 60000)} 即可出局。`, `Watch ${fmtMinutes(g.ms / 60000)} to get out.`) : tc(`锁定 ${fmtMinutes(g.ms / 60000)}。`, `Locked for ${fmtMinutes(g.ms / 60000)}.`), tc("一次 O 不会让它提前结束。", "An O doesn't end it early.")];
    const s = slipText(g);
    const first = g.hidden ? (live ? tc("看满一段保密的时长且没有结束。", "Watch for a hidden time without finishing.") : tc(`看满约 ${fmtMinutes(g.watchMs / 60000)} 且没有结束（真实目标保密）。`, `Watch about ${fmtMinutes(g.watchMs / 60000)} without finishing (the real target is hidden).`))
      : tc(`看满 ${fmtMinutes(g.watchMs / 60000)} 且没有结束。`, `Watch ${fmtMinutes(g.watchMs / 60000)} without finishing.`);
    return [first, tc(`${s}。`, `${s.charAt(0).toUpperCase()}${s.slice(1)}.`)];
  }
  // The way out as it stands, in parts (2.17: the bar's progress and the run
  // page's big one are drawn from this): `cap` what it measures, `big` the
  // number, `of` what it is out of, `left` what is still to do, `pct` the
  // meter (null: none), `cls` the way out (the colour). A hidden target never
  // shows its length; past it nothing that would tell it.
  function goalParts(L, now, eyesAt) {
    const g = (L && L.goal) || { type: "finish", os: 1 }, w = (L && L.watchedMs) || 0;
    const p = { cap: "", big: "", of: "", left: "", pct: null, cls: g.type || "finish", short: "" };
    if (g.type === "finish") {
      const need = g.os || 1;
      p.cap = tc("锁定", "Locked"); p.big = fmtClock(now - L.startedAt);
      p.of = need === 1 ? tc("一个 O 即出局", "one O to get out") : tc(`${L.os || 0} / ${need} 个 O`, `${L.os || 0} of ${need} O's`);
      p.short = need === 1 ? tc("一个 O", "one O") : tc(`${L.os || 0}/${need} 个 O`, `${L.os || 0}/${need} O's`);
      const minMs = (L.rules && L.rules.minMs) || 0;
      const wait = L.slowBy === "watched" ? minMs - (w - (L.slowFrom || 0)) : L.startedAt + minMs - now;
      if (wait > 0) p.left = L.slowBy === "watched" ? tc(`再看 ${fmtClock(wait)} 后 O 才计数`, `O's count after ${fmtClock(wait)} more watching`) : tc(`再过 ${fmtClock(wait)} O 才计数`, `O's count in ${fmtClock(wait)}`);
    } else if (g.type === "timer") {
      if (g.by === "watched") { p.cap = tc("已观看", "Watched"); p.big = fmtClock(w); p.of = tc(`共 ${fmtClock(g.ms)} 已观看`, `of ${fmtClock(g.ms)} watched`); p.short = tc(`共 ${fmtClock(g.ms)}`, `of ${fmtClock(g.ms)}`);
        p.left = tc(`还剩 ${fmtClock(Math.max(0, g.ms - w))}`, `${fmtClock(Math.max(0, g.ms - w))} to go`); p.pct = g.ms ? Math.min(100, Math.round((w / g.ms) * 100)) : 0; }
      else {
        const done = Math.max(0, now - L.startedAt - awayMsOf(awayNowLock(L, eyesAt, now)));
        p.cap = tc("锁定", "Locked"); p.big = fmtClock(done); p.of = tc(`共 ${fmtClock(g.ms)} 锁定`, `of ${fmtClock(g.ms)} locked`); p.short = tc(`共 ${fmtClock(g.ms)}`, `of ${fmtClock(g.ms)}`);
        p.left = tc(`还剩 ${fmtClock(Math.max(0, g.ms - done))}`, `${fmtClock(Math.max(0, g.ms - done))} to go`); p.pct = g.ms ? Math.min(100, Math.round((done / g.ms) * 100)) : 0;
      }
    } else if (edgeState(L) === "reached") {
      p.cap = tc("已达边缘目标", "Edge target reached"); p.big = tc("出局", "Out"); p.of = tc("分数已入账", "score banked"); p.short = tc("出局", "out"); p.pct = 100; p.cls = "reached";
    } else if (edgeState(L) === "over") {
      const ot = overtimeMs(L), cap = overtimeCap(L), pts = overtimePts(overtimeScored(L));
      p.cap = tc("加时", "Overtime"); p.cls = "over";
      if (hiddenPast(L)) { p.big = tc("已超过目标", "Past the target"); p.of = tc("继续", "keep going"); p.short = tc("已超过", "past it"); }
      else if (overtimeFull(L)) { p.big = `+${pts}`; p.of = tc("加时已满、已入账 · 继续", "overtime full, banked · keep going"); p.short = tc("已满", "full"); p.pct = 100; }
      else { p.big = fmtClock(ot); p.of = tc(`加时（+${pts}）`, `overtime (+${pts})`); p.short = `+${pts}`; p.pct = cap ? Math.min(100, Math.round((ot / cap) * 100)) : 0; }
    } else if (g.hidden) {
      const need = edgeNeedMs(L);
      p.cap = tc("已观看（未结束）", "Watched without finishing"); p.big = fmtClock(w); p.of = tc("已观看", "watched"); p.short = tc("已观看", "watched"); p.left = edgeHint(need ? w / need : 0);
    } else {
      const need = edgeNeedMs(L), d = Math.min(need, w);
      p.cap = tc("已观看（未结束）", "Watched without finishing"); p.big = fmtClock(d); p.of = tc(`共 ${fmtClock(need)} 已观看`, `of ${fmtClock(need)} watched`); p.short = tc(`共 ${fmtClock(need)}`, `of ${fmtClock(need)}`);
      p.left = tc(`还剩 ${fmtClock(Math.max(0, need - d))}`, `${fmtClock(Math.max(0, need - d))} to go`); p.pct = need ? Math.round((d / need) * 100) : 0;
    }
    return p;
  }

  // ── 2.16: pace and milestones (interview: "Pace vs your best",
  // "Milestones"; feedback quiet: the bar and a soft sound, a toast only
  // for a new best) ─────────────────────────────────────────────────────────
  // The score to beat: the best got out of on this target with this way
  // out, else the best of this way out. `list` the history, `top` the
  // board (it outlives the history). { score, who } or null.
  function paceBest(list, top, L) {
    if (!L) return null;
    const g = goalType(L), key = perfKey({ ...L, pid: L.kind === "performer" ? L.tid : undefined });
    const runs = (list || []).concat(top || []).filter((e) => e && e.result !== "gaveup" && e.score > 0 && goalType(e) === g && e.id !== L.id);
    const mine = runs.filter((e) => perfKey(e) === key);
    const pick = (xs) => xs.reduce((a, e) => (!a || e.score > a.score ? e : a), null);
    const t = pick(mine);
    if (t) return { score: t.score, who: tc(`在 ${L.name}`, `on ${L.name}`) };
    const w = pick(runs);
    return w ? { score: w.score, who: tc(`来自 ${LB_WAY[g] || g}`, `of ${LB_WAY[g] || g}`) } : null;
  }
  // What is still to be said (each once a run): halfway, 5 and 1 minute
  // to go (a target of 10 minutes or more), "nearly there" for a hidden
  // target, and O's counting from now (Slow burn). [{ k, text }].
  function milestonesDue(L, now, said) {
    if (!L || !L.goal || L.media === "images") return [];
    const out = [], has = (k) => said && (said.has ? said.has(k) : said[k]);
    const add = (k, text) => { if (!has(k)) out.push({ k, text }); };
    const g = L.goal, w = L.watchedMs || 0;
    let need = 0, done = 0;
    if (g.type === "edge" && !L.over) { need = edgeNeedMs(L); done = Math.min(w, need); }
    else if (g.type === "timer") { need = g.ms || 0; done = g.by === "watched" ? w : now - L.startedAt; }
    if (g.type === "edge" && g.hidden) {
      if (!L.over && need && done / need >= 0.75) add("near", tc("快到了", "Nearly there"));
    } else if (need >= 10 * 60000) {
      const left = need - done;
      if (left <= 60000) add("one", tc("还剩 1 分钟", "1 minute to go"));
      else if (left <= 5 * 60000 && need >= 15 * 60000) add("five", tc("还剩 5 分钟", "5 minutes to go"));
      else if (done >= need / 2) add("half", tc("过半", "Halfway"));
    }
    const minMs = (L.rules && L.rules.minMs) || 0;
    if (g.type === "finish" && minMs > 0) {
      const wait = L.slowBy === "watched" ? minMs - (w - (L.slowFrom || 0)) : L.startedAt + minMs - now;
      if (wait <= 0) add("count", tc("O 从现在开始计数", "O's count from now"));
    }
    return out;
  }
  // 2.16: giving up in the first 2 minutes (and under 2 minutes watched) is
  // a cancel, not a loss: nothing is recorded (interview: "Run recap +
  // cancel grace"). A run past its Edge target is "done" (endResult).
  const CANCEL_MS = 2 * 60000;
  const cancelResult = (L, result, now) => (result === "gaveup" && L && !L.over && now - L.startedAt < CANCEL_MS &&
    (L.watchedMs || 0) < CANCEL_MS ? "cancelled" : result);
  // 2.16: what a run got out of set (the result card): a new best of its way
  // out (or on its target), the highest heat yet, the streak. `list` and
  // `stats` as saved with it.
  function recordsOf(entry, list, stats) {
    const out = [];
    const score = (e) => (e && e.score > 0 ? e.score : ((scoreOf(e) || {}).total || 0));
    const me = score(entry);
    if (!entry || entry.result !== "done" || !me) return out;
    const g = goalType(entry), key = perfKey(entry);
    const others = (list || []).concat((stats && stats.top) || []).filter((e) => e && e.id !== entry.id && e.result !== "gaveup" && e.score > 0 && goalType(e) === g);
    const wayBest = others.reduce((a, e) => Math.max(a, e.score), 0);
    const tBest = others.filter((e) => perfKey(e) === key).reduce((a, e) => Math.max(a, e.score), 0);
    if (wayBest > 0 && me > wayBest) out.push(tc(`新纪录 · ${LB_WAY[g] || g}`, `New best · ${LB_WAY[g] || g}`));
    else if (tBest > 0 && me > tBest) out.push(tc(`在 ${entry.name} 的最佳`, `Best on ${entry.name}`));
    const heats = (list || []).filter((e) => e && e.id !== entry.id && e.result === "done" && typeof e.heat === "number").map((e) => e.heat);
    if (typeof entry.heat === "number" && entry.heat > 0 && heats.length && entry.heat > Math.max(...heats)) out.push(tc(`至今最高热度 · ${entry.heat}`, `Highest heat yet · ${entry.heat}`));
    if (stats && stats.streak >= 2) out.push(tc(`连胜 ${stats.streak}`, `Streak ${stats.streak}`));
    return out;
  }
  // 2.16: the scene Roulette last showed (Back to your scene), or null.
  function lastShown(L) {
    let best = null, at = 0;
    for (const [id, r] of Object.entries((L && L.scenes) || {})) { const t = (r && (r.at || r.t0)) || 0; if (t > at) { at = t; best = id; } }
    return best;
  }

  // ── 2.13.0: Eyes on screen ──
  // Away is the run's tab hidden (another tab, the browser minimised) or its
  // window without focus (another app), on the tab where the run's scene
  // plays. Up to EYES_GRACE_MS of it is nothing; past that the whole rest of
  // the stretch counts: `away` { n, ms } on the lock and its entry (n: the
  // look-aways that counted, ms: their time past the grace).
  const EYES_GRACE_MS = 5000, EYES_PT_MS = 2000;
  const awayMsOf = (x) => Math.max(0, Number(x && x.away && x.away.ms) || 0);
  const awayPts = (ms) => Math.floor(Math.max(0, Number(ms) || 0) / EYES_PT_MS);
  // A look-away of `ms` that ended, added (unchanged within the grace).
  function awayAdd(away, ms) {
    const a = { n: 0, ms: 0, ...(away && typeof away === "object" ? away : {}) };
    const over = Math.round(Math.max(0, (Number(ms) || 0) - EYES_GRACE_MS));
    return over > 0 ? { n: (a.n || 0) + 1, ms: (a.ms || 0) + over } : a;
  }
  // The lock with a look-away still going counted so far (a locked-time
  // Timer must not run out while away); `since` is when it began, 0: none.
  function awayNowLock(L, since, now) {
    if (!L || !since) return L;
    const over = Math.max(0, now - since - EYES_GRACE_MS);
    return over > 0 ? { ...L, away: { n: (L.away && L.away.n) || 0, ms: awayMsOf(L) + over } } : L;
  }
  // "1 min 20 s", "45 s", "2 min"
  function fmtAway(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000)), m = Math.floor(s / 60), r = s % 60;
    return m ? (r ? tc(`${m} 分 ${r} 秒`, `${m} min ${r} s`) : tc(`${m} 分`, `${m} min`)) : tc(`${r} 秒`, `${r} s`);
  }
  // "Away 3× · 1 min 20 s · −40 points", or "clean" for a run with the
  // condition never broken; "" for a run without it.
  function awayText(e) {
    if (!e || !e.away) return "";
    const ms = awayMsOf(e);
    if (!ms) return tc("全程没离开", "clean");
    return tc(`离开画面 ${e.away.n || 1}× · ${fmtAway(ms)} · −${awayPts(ms)} 分`, `Away ${e.away.n || 1}× · ${fmtAway(ms)} · −${awayPts(ms)} ${awayPts(ms) === 1 ? "point" : "points"}`);
  }

  // ── 2.11: novelty bonus and the suggested next setup (review 3.4, 3.5) ──
  // The user kept playing the same presets: nothing rewarded trying another.
  // Each condition with heat, at a rank not used in the last NOV_RUNS runs of
  // that way out, adds 3% (at most 15%); the exact setup of the last run adds
  // nothing, and without an earlier run of that way out there is nothing to
  // compare with, so nothing. Worked out when the run starts and stored on it
  // (`nov`, `novK`), so the history never rescores it differently.
  const NOV_STEP = 0.03, NOV_MAX = 0.15, NOV_RUNS = 5;
  const condsOfEntry = (e) => (e && e.conds) || (e && e.rules ? condsFromRules(e.rules, e.goal) : {});
  function recentOfGoal(list, g) {
    return (list || []).filter((e) => e && typeof e.at === "number" && goalType(e) === g && (e.conds || e.rules))
      .sort((a, b) => b.at - a.at).slice(0, NOV_RUNS);
  }
  function novelty(conds, goal, list) {
    const g = goal && goal.type ? goal.type : goal;
    const prev = recentOfGoal(list, g).map(condsOfEntry);
    if (!prev.length) return { nov: 0, ks: [] };
    const c = conds || {};
    const ks = heatParts(c, g).filter((p) => p.heat > 0 && !prev.some((u) => (u[p.k] || 0) === c[p.k])).map((p) => p.k);
    return { nov: Math.min(NOV_MAX, Math.round(ks.length * NOV_STEP * 100) / 100), ks };
  }
  const novNames = (ks) => (ks || []).map((k) => (anyCond().find((c) => c.k === k) || { name: k }).name);
  // One change for the next run, from a finished entry and the history: the
  // condition used least in the last runs of that way out, raised one rank
  // (added if it was off), the cheapest such change first. null when every
  // condition is at its top, or for an image run (no conditions).
  function suggestNext(e, list) {
    if (!e || e.media === "images") return null;
    const g = goalType(e);
    // 2.12.2: from what the next run can have (a retired condition is left
    // out, or the heat it names would not be the run's)
    const conds = { ...condsOfEntry(e) };
    for (const r of retiredConds()) delete conds[r.k];
    const prev = recentOfGoal(list, g).map(condsOfEntry);
    const h0 = heatOf(conds, g);
    const opts = [];
    conditions().forEach((c, i) => {
      // 2.12: never one that needs a device (Toy in charge)
      if (c.noHeat || c.needs || !condApplies(c, g)) return;
      const r = conds[c.k] || 0;
      if (r >= c.ranks.length) return;
      const next = { ...conds, [c.k]: r + 1 };
      const h1 = heatOf(next, g);
      if (!(h1 > h0)) return;                    // Stay to the end next to One scene adds nothing
      opts.push({ c, r, next, h1, i, uses: prev.filter((u) => (u[c.k] || 0) > 0).length });
    });
    if (!opts.length) return null;
    opts.sort((a, b) => a.uses - b.uses || a.h1 - b.h1 || a.i - b.i);
    const o = opts[0];
    const what = o.r ? `${o.c.name} · ${o.c.ranks[o.r]}` : `+ ${o.c.name}`;
    return { k: o.c.k, conds: o.next, from: h0, to: o.h1, text: tc(`试试 ${what}：热度 ${h0} → ${o.h1}`, `Try ${what}: heat ${h0} → ${o.h1}`),
             mult: `×${heatMult(h0)} → ×${heatMult(o.h1)}` };
  }

  // ── The active lock ───────────────────────────────────────────────────────

  // `target`: { kind, id, name, image_path }; `idsUnder`: the target and,
  // for a studio or tag, everything under it.
  // Several tags (2.2): `target.tags` [{id, name}], `groups` each tag with
  // what is under it, `target.mode` "and" | "or". `ids` stays what a 2.1
  // device understands: with AND only the first tag's (stricter than
  // nothing), with OR all of them.
  // `rnd` (0..1, tests): where a hidden target lands; Math.random otherwise.
  function newLock(target, idsUnder, setup, how, baseO, now, id, groups, rnd) {
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
    // 2.12: Hidden target: the real one is drawn now, the time set kept as
    // `about` (Play again, the reveal); Toy in charge: Goon mode's settings,
    // the time it ran during watching and what it did (edges, cool-downs)
    if (L.goal.type === "edge" && L.goal.hidden) {
      const set = L.goal.watchMs;
      L.goal = { ...L.goal, about: set, watchMs: hiddenTarget(set / 60000, rnd === undefined ? Math.random() : rnd) * 60000 };
    }
    if (rules.toy) L.toy = { ...normaliseToy(setup.toy), ms: 0, edges: 0, cools: 0, starts: 0 };
    if (target.kind === "tag" && target.tags && target.tags.length > 1 && groups && groups.length === target.tags.length) {
      L.tags = target.tags.map((t) => ({ id: String(t.id), name: t.name }));
      L.mode = target.mode === "or" ? "or" : "and";
      L.groups = groups.map((g) => g.map(String));
      L.ids = L.mode === "or" ? [...new Set(L.groups.flat())] : L.groups[0];
      L.name = tagsName(L.tags, L.mode);
    }
    const duo = duoOf(target);
    if (duo) {
      L.duo = duoMembers(duo);
      L.tid = L.duo[0].id;
      L.ids = L.duo.map((p) => p.id);
      L.groups = L.ids.map((x) => [x]);
      L.mode = "or";
      L.name = duoName(L.duo);
      L.image = L.duo[0].image_path || L.image;
    }
    return L;
  }
  const tagsName = (tags, mode) => tags.map((t) => t.name).join(mode === "or" ? tc(" 或 ", " or ") : " + ");
  // 2.14: a duo (user: "pick 2 performers ... sometimes I have performers
  // that dont have many scenes"): `duo` [{id, name, image_path}], two
  // performers, and a scene, image or gallery of either belongs (the user's
  // choice: either, no "together only"). `ids` holds both, so a 2.13 device
  // enforces it as a performer with two ids; `groups` and mode "or" let the
  // several-tags paths (Stash's own lists and their filter) take it as is.
  const duoOf = (x) => (x && (x.kind || "performer") === "performer" && Array.isArray(x.duo) && x.duo.length > 1 ? x.duo : null);
  const duoMembers = (duo) => duo.slice(0, 2).map((p) => ({ id: String(p.id), name: p.name || "?", image_path: p.image_path || p.image || "" }));
  const duoName = (duo) => duo.map((p) => p.name || "?").join(" & ");
  // What makes a target, lock or entry several: its tags (2.2) or its duo
  // (2.14), to spread into a copy of it; {} for one.
  const setOf = (x) => (duoOf(x) ? { duo: duoMembers(x.duo) } : x && x.tags ? { tags: x.tags, mode: x.mode } : {});
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
    // 2.13.0: Eyes on screen: time away does not serve a locked-time Timer
    if (g.type === "timer") return g.by === "watched" ? (lock.watchedMs || 0) >= g.ms : now >= lock.startedAt + g.ms + awayMsOf(lock);
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
    const b = budget + (r.bonus || 0) + (r.xs || 0);
    if (watchedAt(r.ranges, to)) return { allow: true, skip: false, rec: r, left: b - r.skips };
    if (r.skips < b) return { allow: true, skip: true, rec: { ...r, skips: r.skips + 1 }, left: b - r.skips - 1 };
    return { allow: false, skip: false, rec: r, left: 0 };
  }

  // 2.12.1: what the end of a timeline drag does. `o`: { video, scrubbing,
  // media (the player's media is this scene's), allowed (the scene is known
  // to belong), snap (it landed where Lockdown sent it) }. "wait": still
  // scrubbing, asked again; "hold": judged once the scene is known; "judge";
  // "drop": nothing to judge (left the scene, our own jump back).
  function dragStep(dr, here, o) {
    if (!dr || here !== dr.id || !o || !o.video) return "drop";
    if (o.scrubbing) return "wait";
    if (!o.media || o.snap) return "drop";
    return o.allowed ? "judge" : "hold";
  }
  // A user's jump on a scene still being checked, kept as { id, from }: the
  // first one per scene (from where it was before any of them).
  const holdSeek = (held, id, from) => (held && held.id === String(id) ? held : { id: String(id), from: Number(from) || 0 });
  // The scene known to belong, now at `t`: whether a held jump is judged
  // (from where it started) or nothing happened (back where it was).
  function heldSeek(held, id, t) {
    if (!held || held.id !== String(id)) return { held, judge: false };
    return { held: null, judge: Math.abs((Number(t) || 0) - held.from) > SEEK_SLACK, from: held.from };
  }

  // 2.13.0 (user: "sometimes by mistake the beginning of the video counts as
  // a skip"). Stash places the player itself as a scene loads: `load()`, then
  // on ready `currentTime(resume_time)` (or a ?t= link's time), and a live
  // transcode is a source with `?start=` that can be swapped again when
  // direct play fails. 2.1-2.12 took any click, key or wheel in the last
  // second as the user's, so the click that opened the scene (a card, the
  // queue) or a second source right after it made Stash's own jump a skip,
  // from 0:00 to the resume point. Now:
  //  - an input is "player" (the timeline, the seek buttons, a seek key, the
  //    wheel over the player, a tap on the picture), "page" (anything else),
  //    or none (play / pause, the menus, volume, fullscreen, typing in a
  //    field, Lockdown's bar): play and pause never seek, so they never make
  //    a seek the user's;
  //  - while a load settles (SETTLE_MS after the player's loadstart, and
  //    after its first loadedmetadata / canplay), a seek is the user's only
  //    with a "player" input made after that load began;
  //  - otherwise as before: any input in the last INPUT_MS.
  // A loadstart that the user's own seek caused (a transcoded file reloads
  // its stream from the new point) is not a new load (loadIsSeek).
  const SETTLE_MS = 3000;
  const LOAD_META_MS = 30000;          // a transcode's first frames can take this long
  const SEEK_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "j", "J", "l", "L", ",", ".",
                     "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const NOSEEK_KEYS = [" ", "Spacebar", "k", "K", "f", "F", "m", "M", "Enter", "Escape", "Tab", "Shift", "Control", "Alt", "Meta",
                       "CapsLock", "MediaPlayPause", "MediaPlay", "MediaPause", "AudioVolumeUp", "AudioVolumeDown", "AudioVolumeMute"];
  // o: { type, key, on: "bar" | "play" | "video" | "player" | "page", touch, field }
  function inputKind(o) {
    if (!o || o.on === "bar") return "";
    if (o.type === "keydown") {
      if (o.field || NOSEEK_KEYS.includes(o.key)) return "";
      return SEEK_KEYS.includes(o.key) ? "player" : "page";
    }
    if (o.on === "play") return "";
    // a mouse click on the picture plays or pauses; two quick taps seek 10 s
    if (o.on === "video") return o.touch ? "player" : "";
    return o.on === "player" ? "player" : "page";
  }
  const gate0 = () => ({ input: 0, kind: "", loadAt: 0, metaAt: 0 });
  const gateInput = (g, now, kind) => (kind ? { ...g, input: now, kind } : g);
  function gateLoad(g, now, phase) {
    if (phase === "start") return { ...g, loadAt: now, metaAt: 0 };
    return g.loadAt && !g.metaAt && now - g.loadAt < LOAD_META_MS ? { ...g, metaAt: now } : g;
  }
  const settling = (g, now) => !!g.loadAt && (now - g.loadAt < SETTLE_MS || (!!g.metaAt && now - g.metaAt < SETTLE_MS));
  function gateUser(g, now) {
    if (!g || !g.input || now - g.input >= INPUT_MS) return false;
    if (!settling(g, now)) return true;
    return g.input > g.loadAt && g.kind === "player";
  }
  // A loadstart on the open scene's own media (there since `mediaAt`), with
  // the user's input after it: their seek reloading a transcoded stream, not
  // a new load. The click that opened the scene came before its media.
  const loadIsSeek = (g, now, sameScene, mediaAt) => !!sameScene && g.input > (mediaAt || 0) && gateUser(g, now);

  // Roulette's Next scene (2.5.1) under a skip budget (null: any): free
  // without one, one skip of the current scene's budget with one, refused
  // when that scene has none left. Returns { allow, skip, rec, left }.
  function nextSceneDecision(rec, budget) {
    const r = { skips: 0, ...(rec || {}) };
    if (budget === null || budget === undefined) return { allow: true, skip: false, rec: r };
    const b = budget + (r.bonus || 0) + (r.xs || 0);
    if (r.skips < b) return { allow: true, skip: true, rec: { ...r, skips: r.skips + 1 }, left: b - r.skips - 1 };
    return { allow: false, skip: false, rec: r, left: 0 };
  }
  // What Next scene says when it cannot go anywhere (2.8.2).
  function nextSceneText(why, fresh) {
    if (why === "skips") return tc("这个场景的跳过次数用完了：继续看，或等它放完", "No skips left on this scene: watch on, or let it end");
    return fresh ? tc("本盘已经没有其他未看的场景了", "No other unwatched scene left in this run") : tc("本盘没有其他场景了", "No other scene in this run");
  }
  // Which scene the player's media belongs to (2.8.2). Stash keeps the old
  // scene playing while it loads the next one, so for a moment the URL says
  // B while the video is still A: A's playhead read as B's made the source
  // swap look like the user seeking in B, which cost B a skip (or, under No
  // skips, sent B back to A's time), and A ending there picked yet another
  // scene. A source is the scene's that was open when it was first seen; a
  // new source (the swap, a quality change) belongs to the page it loads on.
  // `prev` { src, id } or null; returns the new one.
  function mediaOwner(prev, src, here) {
    if (!src) return prev;
    if (prev && prev.src === src) return prev;
    return { src, id: here || null };
  }
  // Skips left on a scene under a budget (null: no budget), its moment's
  // extra skip counted (2.6), and the skip cards played on it (2.20 `xs`).
  const skipsLeft = (rec, budget) => (budget === null || budget === undefined ? null
    : Math.max(0, budget + ((rec && rec.bonus) || 0) + ((rec && rec.xs) || 0) - ((rec && rec.skips) || 0)));

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
      label: `${m.title || tc("标记", "Marker")} ${fmtClock((Number(m.seconds) || 0) * 1000)}`,
    }));
  }

  // ── 2.6: Edge overtime ───────────────────────────────────────────────────
  // Reaching an Edge target gets the player out with the score banked; the
  // run then waits ("reached") for Keep going or Finish, and never ends on
  // its own there. Keep going is overtime ("over"): watching earns 10 a
  // minute again, times heat, up to the target's length once more; an O ends
  // it (the natural finish, not a slip), and so do Stop and Give up, always
  // as got out. `lock.over` = { at: reached, on: Keep going pressed (0 until
  // then), w0: the watch time then }.
  // 2.12 (user): a full overtime no longer ends the run. Scoring stops at the
  // cap ("Overtime full: +N banked · keep going"; no taper, time past it
  // scores nothing) and the lock holds until an O or Stop overtime.
  // `overtimeMs` is all the overtime watched (entries store it whole: "34
  // min (20 scored)"); `overtimeScored` the part that scores. A run from
  // before 2.12 never passed the cap, so it reads exactly as before.
  const edgeState = (L) => (L && L.over && L.goal && L.goal.type === "edge" ? (L.over.on ? "over" : "reached") : null);
  const overtimeCap = (L) => ((L && L.goal && L.goal.watchMs) || 0);
  function overtimeMs(L) {
    if (edgeState(L) !== "over") return 0;
    return Math.max(0, (L.watchedMs || 0) - (L.over.w0 || 0));
  }
  const overtimeScored = (L) => Math.min(overtimeCap(L), overtimeMs(L));
  const overtimeFull = (L) => edgeState(L) === "over" && overtimeMs(L) >= overtimeCap(L);
  const overtimePts = (ms) => Math.round(((ms || 0) / 60000) * 10);
  const reachEdge = (L, now) => (L.over ? L : { ...L, over: { at: now, on: 0, w0: 0 } });
  const startOvertime = (L, now) => (edgeState(L) === "reached" ? { ...L, over: { ...L.over, on: now, w0: L.watchedMs || 0 } } : L);
  // How a run that is out ends: never given up (Give up there, or on a
  // device that had not seen the target reached yet, banks the score).
  const endResult = (L, result) => (result === "gaveup" && L && L.over ? "done" : result);

  // 2.11 (review M1): One scene's scene across devices. Dropping it (it is
  // gone, or will not play) counts up `drop`; the copy that dropped more
  // has the newer word and its scene wins, null included, so a dropped
  // scene never comes back from a copy that still names it (2.10 merged
  // `b.id || a.id`: the stale id returned on the next save and the player
  // was bounced to the broken scene every few seconds). With the same count
  // the copy that knows the scene wins (the first play claimed it).
  function mergeOne(a, b) {
    const x = a || {}, y = b || {};
    const dx = x.drop || 0, dy = y.drop || 0;
    const out = { id: dx !== dy ? ((dx > dy ? x.id : y.id) || null) : (y.id || x.id || null), loops: Math.max(x.loops || 0, y.loops || 0) };
    if (dx || dy) out.drop = Math.max(dx, dy);
    return out;
  }
  const dropOne = (one) => ({ ...(one || {}), id: null, drop: ((one && one.drop) || 0) + 1 });

  // 2.11 (review M3): Stay to the end is done when the scene has really been
  // watched, not when the playhead is near its end (one drag did that):
  // 80% of it played, or all but 30 s for a scene under 2.5 minutes.
  const STAY_SHARE = 0.8, STAY_SLACK_S = 30;
  function stayCovered(ranges, dur) {
    if (!(dur > 0) || !isFinite(dur)) return { done: false, left: 0 };
    const need = Math.max(0, Math.min(STAY_SHARE * dur, dur - STAY_SLACK_S));
    const have = watchedSec(ranges);
    return { done: have >= need, left: Math.max(0, need - have) };
  }

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
    for (const k of ["os", "early", "slips", "slipMs", "watchedMs", "slowFrom", "settings"]) out[k] = Math.max(remote[k] || 0, local[k] || 0);
    if (!out.settings) delete out.settings;
    // 2.13.0: Eyes on screen's look-aways only grow (the playing device counts them)
    if (remote.away || local.away) out.away = { n: Math.max((remote.away && remote.away.n) || 0, (local.away && local.away.n) || 0),
                                                ms: Math.max(awayMsOf(remote), awayMsOf(local)) };
    // 2.12: Toy in charge's counts only grow (the device running Goon mode adds them)
    if (remote.toy || local.toy) {
      const a = remote.toy || {}, b = local.toy || {};
      out.toy = { ...a, ...b };
      for (const k of ["ms", "edges", "cools", "starts"]) out.toy[k] = Math.max(a[k] || 0, b[k] || 0);
    }
    // One scene: the copy that dropped the scene more often, else the one
    // that knows which scene it is; the most loops (mergeOne, 2.11)
    if (remote.one || local.one) out.one = mergeOne(remote.one, local.one);
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
      // 2.20: skip cards played on it (each device adds one at a time)
      if (o.xs || r.xs) m.xs = Math.max(o.xs || 0, r.xs || 0);
      // 2.15: last shown, for Roulette's deck
      if (o.at || r.at) m.at = Math.max(o.at || 0, r.at || 0);
      scenes[id] = m;
    }
    out.scenes = scenes;
    // 2.16: the hand that changed last (each change counts `rev` up)
    if (remote.hand || local.hand) out.hand = local.hand && (!remote.hand || (local.hand.rev || 0) >= (remote.hand.rev || 0)) ? local.hand : remote.hand;
    // 2.15: Roulette's rounds: the later start of each side's round
    if (remote.deck || local.deck) {
      out.deck = { ...(remote.deck || {}) };
      for (const [k, v] of Object.entries(local.deck || {})) out.deck[k] = Math.max(out.deck[k] || 0, v || 0);
    }
    if (remote.current && local.current && remote.current.id === local.current.id) {
      out.current = { ...local.current, done: !!(remote.current.done || local.current.done) };
    }
    // 2.6: moments grow like the rest (by marker id); a target reached on
    // either device is reached, at the earlier time, and overtime started on
    // either is on, from the earlier start
    if ((remote.moments && remote.moments.length) || (local.moments && local.moments.length)) out.moments = mergeMoments(remote.moments, local.moments);
    // 2.9: the pictures either device counted, at most PICS_MAX
    if ((remote.pics && remote.pics.length) || (local.pics && local.pics.length))
      out.pics = [...new Set([...(remote.pics || []), ...(local.pics || [])].map(String))].slice(0, PICS_MAX);
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
                             ...(e.overtimeMs > 0 ? { overtimeMs: e.overtimeMs } : {}),
                             // 2.9: kept for the same reason
                             ...(e.pics > 0 ? { pics: e.pics } : {}),
                             // 2.11: the novelty bonus, for the same reason
                             ...(e.nov > 0 ? { nov: e.nov, novK: e.novK || [] } : {}),
                             // 2.10: what the leaderboard's picture, breakdown, Open and Same
                             // setup again need once the history entry is gone (older runs
                             // borrow them from the history while it has them: boardEntry)
                             ...(e.tid || e.pid ? { tid: String(e.tid || e.pid) } : {}),
                             ...(typeof e.os === "number" ? { os: e.os } : {}),
                             ...(e.v >= 3 ? { moments: e.moments || [] } : {}),
                             ...setOf(e),
                             // 2.12: Same setup again brings Toy in charge back with its settings
                             ...(e.toy ? { toy: e.toy } : {}),
                             // 2.13.0: Eyes on screen's deduction, for rescoring and the breakdown
                             ...(e.away ? { away: e.away } : {}),
                             // 2.16: hold points, for rescoring
                             ...(e.holdPts > 0 ? { holdPts: e.holdPts } : {}),
                             ...(e.tagPts > 0 ? { tagPts: e.tagPts } : {}),
                             // 2.19: Stay cards and the Race
                             ...(e.stayPts ? { stayPts: e.stayPts } : {}), ...(e.stays ? { stays: e.stays } : {}),
                             ...(e.racePts ? { racePts: e.racePts } : {}), ...(e.race ? { race: e.race } : {}),
                             // 2.20: skip cards kept (scored) and played
                             ...(e.skipCards ? { skipCards: e.skipCards } : {}) });
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
  // 2.14: a duo is its own target, `p:3&12` (ids in order, so A & B and
  // B & A are the same pair), apart from each performer's own runs.
  const perfKey = (e) => (e.kind && e.kind !== "performer" ? `${e.kind.charAt(0)}:${e.tags && e.tags.length > 1 ? e.tags.map((t) => t.id).join(e.mode === "or" ? "|" : "+") : e.tid}`
                          : duoOf(e) ? `p:${duoIds(e.duo).join("&")}`
                          : e.pid || e.tid ? String(e.pid || e.tid) : `name:${e.name || "?"}`);
  const duoIds = (duo) => duo.map((p) => String(p.id)).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0));
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

  // 2.19.1 (user: show the cards used in History, "keep it light and
  // simple"): one line, "cards: 2 of 3 holds kept, Stay 5 kept, 3 tag cards
  // (1 marker), won the Race in 1:42". Holds are Eyes on screen (`holds`
  // counts Stay cards too, so theirs are taken off); "" with none played.
  function cardsText(e) {
    if (!e) return "";
    const st = e.stays || {}, h = e.holds || {}, out = [];
    const kept = Math.max(0, (h.passed || 0) - (st.kept || 0)), broke = Math.max(0, (h.failed || 0) - (st.broke || 0));
    if (kept || broke) out.push(tc(`${kept} / ${kept + broke} 张坚持牌守住`, `${kept} of ${plural(kept + broke, "hold", "holds")} kept`));
    if (st.kept) out.push(tc(`${st.kept} 张停留牌守住`, `${st.kept > 1 ? `${st.kept} Stay cards` : "a Stay card"} kept`));
    if (st.broke) out.push(tc(`${st.broke} 张停留牌破了`, `${st.broke > 1 ? `${st.broke} Stay cards` : "a Stay card"} broken`));
    const marks = Math.round((e.tagPts || 0) / TAG_MATCH_PTS);
    if (e.tagPlays) out.push(tc(`${e.tagPlays} 张标签牌${marks ? `（${marks} 个标记）` : ""}`, `${plural(e.tagPlays, "tag card", "tag cards")}${marks ? ` (${plural(marks, "marker", "markers")})` : ""}`));
    if (e.race) out.push(e.race.st === "won" ? tc(`在 ${fmtClock(e.race.ms || 0)} 内赢得竞赛`, `won the Race in ${fmtClock(e.race.ms || 0)}`) : tc("竞赛失败", "lost the Race"));
    // 2.20
    const sk = e.skipCards || {};
    if (sk.used) out.push(tc(`${sk.used} 张跳过牌已用`, `${plural(sk.used, "skip card", "skip cards")} used`));
    if (sk.kept) out.push(tc(`${sk.kept} 张跳过牌留着`, `${plural(sk.kept, "skip card", "skip cards")} kept`));
    return out.length ? tc(`牌：${out.join(", ")}`, `cards: ${out.join(", ")}`) : "";
  }
  // The small print under an entry's name: what happened along the way.
  function entryDetail(e) {
    if (!e || !e.goal) return tc("本次更新之前", "before this update");
    const out = [];
    const g = e.goal.type;
    if (g === "edge" && e.slips) {
      const gl = e.goal, share = gl.slip === "half" ? 1 / 2 : gl.slip === "third" ? 1 / 3 : 0;
      const add = e.slipMs !== undefined ? e.slipMs : gl.slip ? e.slips * share * (gl.watchMs || 0) : e.slips * (gl.addMs || 0);
      out.push(tc(gl.slip === "reset" ? `${e.slips} 次失误，重新计时` : `${e.slips} 次失误，+${fmtMinutes(Math.round(add / 60000))}`, gl.slip === "reset" ? `${plural(e.slips, "slip", "slips")}, started over` : `${plural(e.slips, "slip", "slips")}, +${fmtMinutes(Math.round(add / 60000))}`));
    }
    if (e.loops) out.push(tc(`${plural(e.loops + 1, "play", "plays")}同一个场景`, `${plural(e.loops + 1, "play", "plays")} of one scene`));
    if (g === "timer" && e.os) out.push(tc(`过程中 ${plural(e.os, "O", "O's")}`, `${plural(e.os, "O", "O's")} along the way`));
    if (g === "edge" && e.overtimeMs > 0) out.push(overtimeText(e));
    if (e.early) out.push(tc(`过早 ${plural(e.early, "O", "O's")}`, `${plural(e.early, "O", "O's")} too early`));
    if (e.skipsUsed) out.push(tc(`已用 ${plural(e.skipsUsed, "skip", "skips")}`, `${plural(e.skipsUsed, "skip", "skips")} used`));
    if (e.rules && e.rules.fresh) out.push(tc("仅未看过", "unwatched only"));
    // 2.12
    if (e.toy) out.push(toyText(e));
    if (e.away) out.push(awayMsOf(e) ? awayText(e).replace(/^Away/, "away") : tc("盯着画面：干净", "eyes on screen: clean"));   // 2.13.0
    const cards = cardsText(e);   // 2.19.1
    if (cards) out.push(cards);
    if (e.settings > 0) out.push(e.settings > 1 ? tc(`访问设置 ${e.settings} 次`, `visited Settings ${e.settings} times`) : tc("访问过设置", "visited Settings"));
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
    if (duoOf(L)) e.duo = duoMembers(L.duo);
    // 2.16: hold cards passed and broken; the tag cards chosen in the setup
    if (L.hand && L.hand.pts) e.holdPts = L.hand.pts;
    if (L.hand && L.hand.tagPts) e.tagPts = L.hand.tagPts;
    // 2.19: Stay cards kept and broken, and how the Race went (one still
    // running when the run ends counts for nothing)
    if (L.hand && (L.hand.stayKept || L.hand.stayBroke)) { e.stayPts = L.hand.stayPts || 0; e.stays = { kept: L.hand.stayKept || 0, broke: L.hand.stayBroke || 0 }; }
    if (L.hand && L.hand.race && (L.hand.race.st === "won" || L.hand.race.st === "lost")) {
      e.racePts = L.hand.racePts || 0;
      e.race = { st: L.hand.race.st, ...(L.hand.race.st === "won" ? { ms: L.hand.race.ms || 0 } : {}) };
    }
    if (L.hand && (L.hand.passed || L.hand.failed)) e.holds = { passed: L.hand.passed || 0, failed: L.hand.failed || 0 };
    // 2.19.1: how many tag cards were played (the hand keeps the last 20)
    if (L.hand && Array.isArray(L.hand.plays) && L.hand.plays.length) e.tagPlays = L.hand.plays.length;
    // 2.20: skip cards left in hand (each worth SKIP_CARD_PTS) and played
    if (L.hand && (L.hand.sk || L.hand.skUsed)) e.skipCards = { kept: L.hand.sk || 0, used: L.hand.skUsed || 0 };
    if (L.cardSet) e.cardSet = L.cardSet;
    if (L.media) e.media = L.media;
    if (L.slipMs) e.slipMs = Math.round(L.slipMs);
    if (L.one && L.one.loops) e.loops = L.one.loops;
    // 2.6: where the target was reached, the overtime watched, the moments
    if (L.over && L.over.at) e.reachedAt = L.over.at;
    if (edgeState(L) === "over") e.overtimeMs = Math.round(overtimeMs(L));
    if (L.moments && L.moments.length) e.moments = L.moments.map((m) => ({ scene: String(m.scene), marker: String(m.marker), title: m.title || "", seconds: m.seconds || 0 }));
    // 2.9: new pictures viewed
    if (L.pics && L.pics.length) e.pics = Math.min(PICS_MAX, L.pics.length);
    // 2.11: the novelty bonus it started with
    if (L.nov > 0) { e.nov = L.nov; e.novK = L.novK || []; }
    // 2.12: Settings opened during the run (allowed since 2.12, noted)
    if (L.settings > 0) e.settings = L.settings;
    // 2.13.0: Eyes on screen: the look-aways that counted ({ n: 0, ms: 0 }: clean)
    if (L.conds && L.conds.eyes && L.media !== "images") e.away = { n: (L.away && L.away.n) || 0, ms: Math.round(awayMsOf(L)) };
    // 2.12: Toy in charge. Its settings and what Goon mode did ride with the
    // entry; its heat (and its novelty share) count only when Goon mode ran
    // for TOY_SHARE of the watched time. Otherwise the entry is scored, ranked
    // and listed without the condition, as if it had been off.
    const ty = toyEarned(L);
    if (ty) {
      const t = L.toy || {};
      e.toy = { ...normaliseToy(t), ms: Math.round(ty.ms), edges: t.edges || 0, cools: t.cools || 0, earned: ty.earned };
      if (!ty.earned) {
        const conds = { ...(e.conds || {}) };
        delete conds.toy;
        e.conds = conds;
        if (typeof e.heat === "number") e.heat = heatOf(conds, e.goal);
        if (e.novK && e.novK.includes("toy")) {
          e.novK = e.novK.filter((k) => k !== "toy");
          e.nov = Math.min(NOV_MAX, Math.round(e.novK.length * NOV_STEP * 100) / 100);
          if (!(e.nov > 0)) { delete e.nov; delete e.novK; }
        }
      }
    }
    const sc = scoreOf(e);
    if (sc) e.score = sc.total;
    return e;
  }
  // "overtime 12:30 (+125)": the points before heat, as the breakdown shows
  // them. 2.12: past the cap, "overtime 34 min (20 scored)".
  const overtimeText = (e) => {
    const ot = e.overtimeMs || 0, cap = (e.goal && e.goal.watchMs) || 0;
    return cap && ot > cap ? tc(`加时 ${fmtMinutes(ot / 60000)}（${Math.round(cap / 60000)} 计分）`, `overtime ${fmtMinutes(ot / 60000)} (${Math.round(cap / 60000)} scored)`)
      : tc(`加时 ${fmtClock(ot)}（+${overtimePts(Math.min(ot, cap))}）`, `overtime ${fmtClock(ot)} (+${overtimePts(Math.min(ot, cap))})`);
  };

  // 2.12: "toy in charge: Waves, 24 of 30 min, 3 edges, 2 cool-downs" and,
  // when Goon mode ran for less than TOY_SHARE of the watching, "(no heat)".
  function toyText(e) {
    const t = e.toy || {};
    const bits = [toyStyleName(t.style || TOY_DEFAULT.style), tc(`${fmtMinutes((t.ms || 0) / 60000)} / ${fmtMinutes((e.watchedMs || 0) / 60000)} 在 Goon 下`, `${fmtMinutes((t.ms || 0) / 60000)} of ${fmtMinutes((e.watchedMs || 0) / 60000)} under Goon`)];
    if (t.edges) bits.push(tc(`${t.edges} 次边缘`, `${plural(t.edges, "edge", "edges")}`));
    if (t.cools) bits.push(tc(`${t.cools} 次冷却`, `${plural(t.cools, "cool-down", "cool-downs")}`));
    return tc(`玩具主导：${bits.join(", ")}${t.earned ? "" : ` （不计热度：低于 ${Math.round(TOY_SHARE * 100)}%）`}`, `toy in charge: ${bits.join(", ")}${t.earned ? "" : ` (no heat: under ${Math.round(TOY_SHARE * 100)}%)`}`);
  }

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
                         ...(target.tags ? { tags: target.tags.map((x) => ({ id: String(x.id), name: x.name })), mode: target.mode } : {}),
                         ...(duoOf(target) ? { duo: duoMembers(target.duo) } : {}) } : null;
    return { id: `p${now.toString(36)}`, name: String(name).trim().slice(0, 40), at: now, setup: normaliseSetup(setup),
             target: t, src: !t && src ? { type: src.type, ...(src.type === "filter" ? { id: String(src.id), name: src.name } : {}),
                                           ...(src.type === "rec" ? { chip: recChipOk(src.chip) } : {}) } : null };
  }
  function addPreset(list, x) {
    const k = x.name.toLowerCase();
    return [x].concat((list || []).filter((y) => String(y.name || "").toLowerCase() !== k)).slice(0, PRESETS_MAX);
  }
  // One line about a preset, for its tooltip.
  function presetLine(x) {
    const S = normaliseSetup(x.setup);
    const who = x.target ? x.target.name : x.src ? (x.src.type === "fav" ? tc(`来自收藏的随机${kl(S.kind)}`, `a random favourite ${kl(S.kind)}`) : x.src.type === "rec" ? tc(`随机推荐的${kl(S.kind)}（${recChipLabel(x.src.chip)}）`, `a random recommended performer (${recChipLabel(x.src.chip)})`) : tc(`从“${x.src.name}”中随机一个${kl(S.kind)}`, `a random ${kl(S.kind)} from “${x.src.name}”`)) : "?";
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
    // 2.9: the pictures earlier runs counted (`pics`), as stored and as a Set
    const pc = parsePics(mine.pics);
    return { list: r.list, stats: r.changed ? { ...full, top: r.top } : full, active: parseActive(mine.active), bad, presets: pr || [], presetsBad: pr === null, rescored: r.changed,
             pics: pc || [], picsBad: pc === null, picsSeen: pc === null ? new Set() : picsSet(mine.pics) };
  }

  // The whole new map for a change `next` ({ list?, stats?, active?,
  // presets? }; active null clears it), every other key riding through, or
  // null when there is nothing to change. A history, totals or presets that
  // did not parse are never replaced (rule 5): the change throws instead,
  // except one that only clears the active lock, so an unreadable history
  // can never leave every device locked.
  function packConfig(mine, cur, next) {
    if (!next || (!("list" in next) && !("stats" in next) && !("active" in next) && !("presets" in next) && !("pics" in next))) return null;
    if ((next.list || next.stats) && cur.bad) throw new Error(tc("已保存的历史无法读取，保持原样", "saved history could not be read; left as it was"));
    if (next.presets && cur.presetsBad) throw new Error(tc("已保存的预设无法读取，保持原样", "saved presets could not be read; left as they were"));
    if (next.pics && cur.picsBad) throw new Error(tc("已保存的图片记录无法读取，保持原样", "saved pictures could not be read; left as they were"));
    const input = { ...mine };
    if (next.list) input.history = JSON.stringify(next.list.slice(-HISTORY_MAX));
    if (next.stats) input.stats = JSON.stringify(next.stats);
    if ("active" in next) input.active = next.active ? JSON.stringify(next.active) : "";
    if (next.presets) input.presets = JSON.stringify(next.presets.slice(0, PRESETS_MAX));
    if (next.pics) input.pics = JSON.stringify(next.pics);
    return input;
  }

  // ── 2.9: points for pictures ───────────────────────────────────────────────
  // During a run each of the target's images on screen for PIC_MS (in
  // Slideshow, on its image page or in Stash's lightbox) is one point, at
  // most PICS_MAX a run, times heat; only a picture no earlier run counted.
  // `st`: { acc: { id: ms on screen so far }, run: ids counted this run,
  // earlier: Set of ids counted by runs before }; `belongs`: true, false, or
  // undefined while the check is out (the time is kept, the count waits).
  // Returns the new { acc, run } and why: counted | early | old | dup | cap | no | wait.
  function picTime(st, id, ms, belongs) {
    const k = String(id || "");
    const acc = { ...((st && st.acc) || {}) }, run = ((st && st.run) || []).map(String);
    if (!/^\d+$/.test(k)) return { acc, run, why: "no" };
    const earlier = (st && st.earlier) || new Set();
    if (run.includes(k)) return { acc, run, why: "dup" };
    if (earlier.has(k)) return { acc, run, why: "old" };
    acc[k] = (acc[k] || 0) + Math.max(0, Number(ms) || 0);
    if (acc[k] < PIC_MS) return { acc, run, why: "early" };
    if (belongs === false) return { acc, run, why: "no" };
    if (belongs !== true) return { acc, run, why: "wait" };
    if (run.length >= PICS_MAX) return { acc, run, why: "cap" };
    return { acc, run: run.concat(k), why: "counted" };
  }
  // The ids counted by earlier runs, kept compactly as Lockdown's data key
  // `pics`: [{ r: run id, at, ids }] oldest first, `ids` sorted and written
  // as base-36 steps ("1a.3.f"); past PICS_KEEP ids in all, the oldest runs
  // go (their pictures could then count again, a documented limit).
  const PICS_KEEP = 30000;
  function encodeIds(ids) {
    const n = [...new Set((ids || []).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x >= 0))].sort((a, b) => a - b);
    return n.map((x, i) => (i ? x - n[i - 1] : x).toString(36)).join(".");
  }
  function decodeIds(text) {
    const out = [];
    let at = 0;
    for (const p of String(text || "").split(".")) {
      if (!p) continue;
      const d = parseInt(p, 36);
      if (!Number.isFinite(d)) continue;
      at = out.length ? at + d : d;
      out.push(String(at));
    }
    return out;
  }
  // [] for none stored; null when stored but unreadable (never overwritten, rule 5)
  function parsePics(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((c) => c && typeof c === "object" && typeof c.ids === "string") : null;
    } catch (_) { return null; }
  }
  // The stored key as a Set of ids, worked out again only when it changed
  // (every 5 s sync reads it).
  let picsMemo = { raw: null, set: new Set() };
  function picsSet(raw) {
    if (picsMemo.raw === raw) return picsMemo.set;
    const set = new Set();
    for (const c of parsePics(raw) || []) for (const id of decodeIds(c.ids)) set.add(id);
    picsMemo = { raw, set };
    return set;
  }
  function addPicsChunk(chunks, runId, ids, now) {
    const list = (chunks || []).filter((c) => c && c.r !== runId);
    if (!ids || !ids.length) return list;
    let out = list.concat({ r: runId, at: now, ids: encodeIds(ids) });
    let total = out.reduce((a, c) => a + decodeIds(c.ids).length, 0);
    while (out.length > 1 && total > PICS_KEEP) { total -= decodeIds(out[0].ids).length; out = out.slice(1); }
    return out;
  }
  // "Pictures 23 · +23": the points before heat, as the breakdown shows them.
  const picsText = (n) => tc(`图片 ${n || 0} · +${Math.min(PICS_MAX, n || 0)}`, `Pictures ${n || 0} · +${Math.min(PICS_MAX, n || 0)}`);

  // ── 2.9: recommended performers ────────────────────────────────────────────
  // Four rankings for the setup's Recommended block and the Random pick
  // source, worked out from one performer list and the library's scenes
  // (play counts, O's, last played, studios): For you (your taste), Neglected
  // (liked, not watched for a long time), Backlog (most unwatched, by rating),
  // Discover (like your top performers, barely watched). Pure; the data is
  // read once and kept for a day (recFresh).
  // 2.11: version 2 (items carry their main studio and last play); older
  // caches are dropped and worked out again
  const REC_V = 4;                     // 2.14: the lists gained duos and mates; 2.15.1: Neglected from 3 months
  const REC_CHIPS = [["foryou", "For you"], ["neglected", "Neglected"], ["backlog", "Backlog"], ["discover", "Discover"], ["surprise", "Surprise me"], ["duos", "Duos"]];
  const REC_CHIPS_ZH = { foryou: "为你推荐", neglected: "久未光顾", backlog: "待看积压", discover: "发现新人", surprise: "给我惊喜", duos: "双人" };
  const REC_MATES = 5;                 // 2.14: partners kept per performer
  const REC_MATES_SHOW = 4;            // and shown under the chosen one
  const DUO_RANDOM = tc("双人要手动挑选：点一张双人卡，或者为随机挑选换一个列表。", "Duos are picked by hand: click a Duos card, or choose another list for Random pick.");
  const REC_MIN_SCENES = 3, REC_RECENT_MS = 7 * 86400000, REC_SHOW = 8, REC_SPIN = 20, REC_KEEP = 60;
  // 2.15.1 (user: "backlog and neglected should be counted from last 3
  // months. 7 days is too short"): those two leave out anyone locked to in
  // the last 3 months, and Neglected means not watched for 3 months
  const REC_LONG_MS = 90 * 86400000, REC_NEGLECT_DAYS = 90;
  const REC_LONG_CHIPS = new Set(["neglected", "backlog"]);
  const recChipOk = (k) => (REC_CHIPS.some(([c]) => c === k) ? k : "foryou");
  const recChipLabel = (k) => { const ok = recChipOk(k); return tc(REC_CHIPS_ZH[ok] || ok, (REC_CHIPS.find(([c]) => c === ok) || REC_CHIPS[0])[1]); };
  const DAY_MS = 86400000;

  // ── 2.11: recommendations that rotate (review §1; user: "refreshing ...
  // doesn't really change the results"). The lists were deterministic, ties
  // went by name and the cards were always the top 8, so Refresh (a whole
  // re-read of the library) worked out the same answer. Now the 8 cards are
  // drawn from the chip's pool (REC_KEEP) by score with a temperature
  // (Gumbel top-k: a softmax draw without replacement), seeded by the day,
  // the chip and how often Shuffle was pressed, so a redraw of the same
  // dialog is stable and Shuffle (no query) gives a new draw. A card shown
  // and not picked weighs less for three days (0.6 per showing, per
  // browser); For you and Backlog rest anyone played in the last days
  // (outside Lockdown too); at most 2 cards per studio; Surprise me is the
  // long tail no other chip reaches.
  const REC_T = 0.25, REC_SEEN_DECAY = 0.6, REC_SEEN_MS = 3 * DAY_MS, REC_SEEN_KEEP_MS = 14 * DAY_MS, REC_SEEN_MAX = 400;
  const REC_REST_DAYS = 3, REC_PER_STUDIO = 2, REC_WHEEL_SKIP = 5, REC_SURPRISE_MAX = 240, REC_TOP_OTHERS = 20;
  const REC_RESTS = new Set(["foryou", "backlog"]);
  function hashStr(s) {
    let h = 2166136261;
    const t = String(s);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // mulberry32: a small seeded generator in [0, 1)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const dayKey = (now) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const recDrawKey = (day, chip, n) => `${day}|${recChipOk(chip)}|${n || 0}`;
  // How often a card was shown without being picked (the last 3 days); the
  // draw being made (`key`) does not count against itself, so drawing it
  // again after a reload gives the same cards.
  function recSeenN(store, id, now, key) {
    const e = store && store.ids && store.ids[String(id)];
    if (!e || !(now - (e.at || 0) < REC_SEEN_MS)) return 0;
    return Math.max(0, (e.n || 0) - (key && e.k === key ? 1 : 0));
  }
  // Each item's log-weight: score normalised to 0..1 in the pool over the
  // temperature, less for each showing, rested after a recent play.
  function recWeights(pool, o) {
    const list = (pool || []).filter(Boolean);
    if (!list.length) return [];
    const sc = list.map((x) => Number(x.score) || 0);
    const lo = Math.min(...sc), hi = Math.max(...sc);
    const T = (o && o.T) || REC_T, now = (o && o.now) || 0;
    return list.map((x, i) => {
      const s = hi > lo ? (sc[i] - lo) / (hi - lo) : 1;
      const n = recSeenN(o && o.seen, x.id, now, o && o.key);
      const rest = o && o.rest && x.last > 0 ? 1 - Math.exp(-Math.max(0, now - x.last) / DAY_MS / REC_REST_DAYS) : 1;
      return { x, s, n, rest, lw: s / T + n * Math.log(REC_SEEN_DECAY) + Math.log(Math.max(1e-4, rest)) };
    });
  }
  // `k` cards: Gumbel top-k on the log-weights, at most REC_PER_STUDIO per
  // studio (filled up from the rest when a library is mostly one studio).
  // Ties never go by name: by a hash of the seed and the id.
  function recDraw(pool, o) {
    const rnd = mulberry32((o && o.seed) >>> 0);
    const keyed = recWeights(pool, o).map((w) => ({ ...w, g: w.lw - Math.log(-Math.log(Math.max(1e-12, rnd()))), h: hashStr(`${o && o.seed}:${w.x.id}`) }))
      .sort((a, b) => b.g - a.g || a.h - b.h);
    const k = (o && o.k) || REC_SHOW, cap = (o && o.perStudio) || REC_PER_STUDIO, per = {}, out = [], left = [];
    for (const w of keyed) {
      if (out.length >= k) break;
      const st = w.x.studio;
      if (st && (per[st] || 0) >= cap) { left.push(w); continue; }
      if (st) per[st] = (per[st] || 0) + 1;
      out.push(w);
    }
    for (const w of left) { if (out.length >= k) break; out.push(w); }
    return out.map((w) => w.x);
  }
  // The shown-cards store (localStorage lockdownRecSeen, a UI preference):
  // { v, ids: { id: { n, at, k } }, spins: [last wheel picks], shuf: { day, n: { chip: presses } } }.
  function recSeenPrune(store, now) {
    const src = store && typeof store === "object" ? store : {};
    const ids = {};
    Object.entries(src.ids && typeof src.ids === "object" ? src.ids : {}).filter(([, e]) => e && now - (e.at || 0) < REC_SEEN_KEEP_MS)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, REC_SEEN_MAX).forEach(([k, e]) => { ids[k] = e; });
    const day = dayKey(now);
    return { v: 1, ids, spins: (Array.isArray(src.spins) ? src.spins : []).map(String).slice(0, REC_WHEEL_SKIP),
             shuf: src.shuf && src.shuf.day === day ? { day, n: { ...(src.shuf.n || {}) } } : { day, n: {} } };
  }
  // Cards shown by the draw `key`: counted once per draw, however often it is drawn.
  function recSeenAdd(store, ids, key, now) {
    const s = recSeenPrune(store, now);
    let changed = false;
    for (const id of ids || []) {
      const k = String(id), e = s.ids[k];
      if (e && e.k === key) continue;
      s.ids[k] = { n: e && now - (e.at || 0) < REC_SEEN_MS ? (e.n || 0) + 1 : 1, at: now, k: key };
      changed = true;
    }
    return { store: s, changed };
  }
  // A card picked or a lock started to them: their showings are forgotten.
  const recSeenPick = (store, id, now) => { const s = recSeenPrune(store, now); delete s.ids[String(id)]; return s; };
  // The wheel's last picks, newest first.
  const recSpinAdd = (store, id, now) => {
    const s = recSeenPrune(store, now);
    s.spins = [String(id)].concat(s.spins.filter((x) => x !== String(id))).slice(0, REC_WHEEL_SKIP);
    return s;
  };
  const recShuffle = (store, chip, now) => { const s = recSeenPrune(store, now); const c = recChipOk(chip); s.shuf.n[c] = (s.shuf.n[c] || 0) + 1; return s; };
  // The Recommended wheel: the pool without its last REC_WHEEL_SKIP picks,
  // weighted like the cards (exp of the log-weight, not the raw score,
  // whose spread was nearly flat), the best REC_SPIN.
  function recWheel(pool, store, o) {
    const skip = new Set((store && store.spins) || []);
    const left = (pool || []).filter((x) => x && !skip.has(String(x.id)));
    const ws = recWeights(left.length ? left : pool, o);
    if (!ws.length) return [];
    const top = Math.max(...ws.map((w) => w.lw));
    return ws.map((w) => ({ ...w.x, score: Math.exp(w.lw - top) })).sort((a, b) => b.score - a.score).slice(0, REC_SPIN);
  }
  // "worked out 6 h ago"
  function agoText(at, now) {
    const m = Math.max(0, Math.round((now - at) / 60000));
    return m < 1 ? tc("刚刚", "just now") : m < 60 ? tc(`${m} 分钟前`, `${m} min ago`) : m < 1440 ? tc(`${Math.round(m / 60)} 小时前`, `${Math.round(m / 60)} h ago`) : tc(`${Math.round(m / 1440)} 天前`, `${Math.round(m / 1440)} days ago`);
  }

  // Ratings Toolkit's overall on 1-5 (its overall(): the weighted mean of the
  // group means, a "not sure" score counting half), or null.
  function rtOverall(crit, c) {
    if (!crit || !Array.isArray(crit.groups) || !Array.isArray(crit.items) || !c) return null;
    let tot = 0, wsum = 0;
    for (const g of crit.groups) {
      const w = Number.isFinite(+g.weight) ? +g.weight : 1;
      let s = 0, n = 0;
      for (const i of crit.items) {
        const e = i && i.group === g.id ? c[i.id] : null;
        if (!e || !Number.isInteger(e.s) || e.s < 1 || e.s > 5) continue;
        const ww = e.ns ? 0.5 : 1;
        s += e.s * ww; n += ww;
      }
      if (n && w > 0) { tot += (s / n) * w; wsum += w; }
    }
    return wsum ? tot / wsum : null;
  }
  // Ratings Toolkit's data keys (JSON text) -> { performer id: overall 1-5 }.
  // Anything unreadable is no scores (the Stash rating is used then).
  function rtFives(scoresRaw, critRaw) {
    const out = {};
    try {
      const sc = typeof scoresRaw === "string" ? JSON.parse(scoresRaw) : scoresRaw;
      const cr = typeof critRaw === "string" ? JSON.parse(critRaw) : critRaw;
      if (!sc || typeof sc !== "object" || !cr) return out;
      for (const [pid, r] of Object.entries(sc)) {
        const f = rtOverall(cr, r && r.c);
        if (f !== null) out[String(pid)] = Math.round(f * 100) / 100;
      }
    } catch (_) {}
    return out;
  }

  // Scene rows -> per performer: scenes, played ones, unplayed ones, plays,
  // O's, the last play (ms) and scenes per studio; plus the library's totals.
  function recAggregate(scenes) {
    const per = {}, studioNames = {};
    let plays = 0, os = 0;
    for (const s of scenes || []) {
      if (!s) continue;
      const pc = Math.max(0, s.play_count || 0), o = Math.max(0, s.o_counter || 0);
      const last = s.last_played_at ? Date.parse(s.last_played_at) || 0 : 0;
      plays += pc; os += o;
      const sid = s.studio && s.studio.id ? String(s.studio.id) : null;
      if (sid && s.studio.name) studioNames[sid] = s.studio.name;
      const cast = (s.performers || []).map((p) => String(p.id));
      for (const p of s.performers || []) {
        const k = String(p.id);
        const a = per[k] || (per[k] = { n: 0, played: 0, unplayed: 0, plays: 0, os: 0, last: 0, studios: {}, with: {} });
        a.n++; a.plays += pc; a.os += o;
        // 2.14: who they are in scenes with, for the duo suggestions
        for (const c of cast) if (c !== k) a.with[c] = (a.with[c] || 0) + 1;
        if (pc > 0 || last) a.played++; else a.unplayed++;
        if (last > a.last) a.last = last;
        if (sid) a.studios[sid] = (a.studios[sid] || 0) + 1;
      }
    }
    return { per, studioNames, plays, os };
  }

  const stars = (f) => tc(`${(Math.round(f * 10) / 10).toFixed(1)} 分`, `${(Math.round(f * 10) / 10).toFixed(1)} rating`);
  // Every performer's numbers, then the four lists, best first (REC_KEEP
  // each). `perfs`: [{ id, name, image_path, scene_count, image_count,
  // rating100, favorite, tags: [{ id, name }] }]; `fives`: Ratings Toolkit's.
  // Anyone with fewer than REC_MIN_SCENES scenes is left out.
  function recLists(perfs, agg, fives, now) {
    const A = agg || { per: {}, studioNames: {}, plays: 0, os: 0 };
    const usual = A.plays > 0 ? A.os / A.plays : 0;
    const rows = [];
    for (const p of perfs || []) {
      if (!p || p.id === undefined || p.id === null) continue;
      const id = String(p.id), a = A.per[id] || { n: 0, played: 0, unplayed: 0, plays: 0, os: 0, last: 0, studios: {} };
      const n = Math.max(a.n, p.scene_count || 0);
      if (n < REC_MIN_SCENES) continue;
      const five = fives && typeof fives[id] === "number" ? fives[id] : null;
      const q = five !== null ? (five - 1) / 4 : typeof p.rating100 === "number" && p.rating100 > 0 ? p.rating100 / 100 : null;
      const rating = five !== null ? five : q !== null ? p.rating100 / 20 : null;
      const oRate = a.plays > 0 ? a.os / a.plays : 0;
      // 2.11: smoothed toward the library's usual (5 plays' worth), so one
      // lucky play no longer tops For you; the card still says the real rate
      const oSm = a.plays > 0 ? (a.os + usual * 5) / (a.plays + 5) : 0;
      const oRel = a.plays > 0 && usual > 0 ? Math.min(2, oSm / usual) / 2 : 0.25;
      rows.push({ p, id, a, n, q, q0: q === null ? 0.35 : q, rating, oRate, oRel, fav: p.favorite ? 1 : 0,
                  unplayed: Math.max(0, n - a.played) });
    }
    // what works for you: the top performers' common tags and studios
    const base = (r) => 0.5 * r.q0 + 0.3 * r.oRel + 0.2 * r.fav;
    const top = rows.filter((r) => r.q !== null || r.a.plays > 0 || r.fav).sort((x, y) => base(y) - base(x)).slice(0, 15);
    const topIds = new Set(top.map((r) => r.id));
    const tagN = {}, tagName = {}, stN = {};
    for (const r of top) {
      for (const t of r.p.tags || []) { const k = String(t.id); tagN[k] = (tagN[k] || 0) + 1; tagName[k] = t.name; }
      for (const [sid, c] of Object.entries(r.a.studios)) stN[sid] = (stN[sid] || 0) + c;
    }
    const topTags = new Set(Object.keys(tagN).filter((k) => tagN[k] >= 2).sort((x, y) => tagN[y] - tagN[x]).slice(0, 12));
    const topStudios = new Set(Object.keys(stN).sort((x, y) => stN[y] - stN[x]).slice(0, 8));
    for (const r of rows) {
      const tags = (r.p.tags || []).map((t) => String(t.id));
      const shared = tags.filter((t) => topTags.has(t));
      const inSt = Object.entries(r.a.studios).filter(([sid]) => topStudios.has(sid));
      const stShare = r.a.n ? inSt.reduce((x, [, c]) => x + c, 0) / r.a.n : 0;
      r.aff = 0.5 * Math.min(1, shared.length / Math.max(1, Math.min(5, tags.length))) + 0.5 * stShare;
      const bestSt = inSt.sort((x, y) => y[1] - x[1])[0];
      r.like = bestSt && A.studioNames[bestSt[0]] ? A.studioNames[bestSt[0]] : shared.length ? tagName[shared[0]] : "";
    }
    // 2.11: the main studio (at most 2 cards each) and the last play (the rest)
    const mainStudio = (r) => { const b = Object.entries(r.a.studios).sort((x, y) => y[1] - x[1])[0]; return b ? b[0] : null; };
    const item = (r, score, why) => ({ id: r.id, name: r.p.name || "?", image_path: r.p.image_path || "", scene_count: r.n,
      image_count: r.p.image_count || 0, unplayed: r.unplayed, score: Math.round(score * 1000) / 1000, why: why.filter(Boolean).slice(0, 3).join(" · "),
      studio: mainStudio(r), last: r.a.last || 0 });
    const rate = (r) => (r.rating !== null ? stars(r.rating) : "");
    const days = (r) => (r.a.last ? Math.floor((now - r.a.last) / DAY_MS) : null);
    // ties by a hash of the id (seeded by the day), not A to Z (review §1)
    const dk = dayKey(now);
    const tie = (x, y) => hashStr(`${dk}:${x.id}`) - hashStr(`${dk}:${y.id}`);
    const best = (list) => list.sort((x, y) => y.score - x.score || tie(x, y)).slice(0, REC_KEEP);
    const foryou = best(rows.map((r) => item(r, 0.45 * r.q0 + 0.25 * r.oRel + 0.15 * r.fav + 0.15 * r.aff,
      [rate(r), r.oRate >= 0.05 ? tc(`每次播放 ${(Math.round(r.oRate * 10) / 10).toFixed(1)} 次O`, `${(Math.round(r.oRate * 10) / 10).toFixed(1)} O's a play`) : "", r.fav ? tc("收藏", "favourite") : "",
       !r.fav && r.aff >= 0.5 && r.like ? tc(`与你常看的一致：${r.like}`, `like your top: ${r.like}`) : ""])));
    const neglected = best(rows.filter((r) => (r.fav || (r.q !== null && r.q >= 0.7)) && r.a.played > 0)
      .map((r) => ({ r, d: days(r) === null ? 365 : days(r) })).filter((x) => x.d >= REC_NEGLECT_DAYS)
      .map(({ r, d }) => item(r, (0.5 + r.q0 + 0.3 * r.fav) * Math.min(d, 365),
        [rate(r) || (r.fav ? tc("收藏", "favourite") : ""), days(r) === null ? tc("很久没看了", "not watched in a long time") : tc(`${d} 天没看`, `not watched in ${d} days`), r.unplayed ? tc(`${r.unplayed} 个未看`, `${r.unplayed} unwatched`) : ""])));
    const backlog = best(rows.filter((r) => r.unplayed > 0).map((r) => item(r, r.unplayed * (0.4 + r.q0) * (r.fav ? 1.2 : 1),
      [rate(r), tc(`${r.unplayed} 个未看`, `${r.unplayed} unwatched`), r.a.played ? tc(`已看 ${r.a.played}/${r.n}`, `${r.a.played} of ${r.n} watched`) : tc("从未看过", "never watched")])));
    const discover = best(rows.filter((r) => !topIds.has(r.id) && r.aff > 0 && r.a.played / r.n <= 0.25)
      .map((r) => item(r, r.aff * (1 - r.a.played / r.n) * (0.6 + 0.4 * r.q0),
        [r.like ? tc(`与你常看的一致：${r.like}`, `like your top: ${r.like}`) : tc("与你常看的演员相似", "like your top performers"), rate(r), r.a.played ? tc(`已看 ${r.a.played}/${r.n}`, `${r.a.played} of ${r.n} watched`) : tc("从未看过", "never watched")])));
    // 2.11: Surprise me (the exploration in epsilon-greedy): anyone eligible
    // in none of the other chips' top 20, all alike; a day's sample of them
    // when there are many (the cache stays small)
    const others = new Set([foryou, neglected, backlog, discover].flatMap((l) => l.slice(0, REC_TOP_OTHERS).map((x) => x.id)));
    const surprise = rows.filter((r) => !others.has(r.id)).map((r) => item(r, 1, [tc("换个口味", "something different"), rate(r),
        r.a.played ? tc(`已看 ${r.a.played}/${r.n}`, `${r.a.played} of ${r.n} watched`) : tc(`${r.n} 个场景，从未看过`, `${r.n} scenes, never watched`)]))
      .sort(tie).slice(0, REC_SURPRISE_MAX);
    const { duos, mates } = recDuos(rows, { foryou, neglected, backlog, discover }, days, tie);
    return { foryou, neglected, backlog, discover, surprise, duos, mates };
  }

  // 2.14: duos, suggested, never drawn at random (the user: "duos are hand
  // picked but it helps to suggest them. for example the performers who I
  // might like but neglected in the library"). A partner comes from
  // Neglected, Backlog or Discover (someone you might like and have left
  // alone); how close they are to the other one decides who goes with whom:
  // scenes together first, then the same main studio, then shared tags.
  // `mates`: for every eligible performer, up to REC_MATES partners as
  // [id, scenes together, "t" | "s" | "g"]; `duos`: For you's best each
  // with their closest partner (a pair once, a partner at most twice).
  function recDuos(rows, L, days, tie) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const pool = new Map();
    const add = (list, ng) => list.forEach((x, i) => {
      if (pool.has(x.id) || !byId.has(x.id)) return;
      const r = byId.get(x.id), d = days(r);
      pool.set(x.id, { x, r, w: 1 - i / Math.max(1, list.length), ng: ng(r, d) });
    });
    add(L.neglected, (r, d) => (d === null ? tc("很久没看了", "not watched in a long time") : tc(`已经 ${d} 天没看`, `not watched in ${d} days`)));
    add(L.backlog, (r) => (r.a.played ? tc(`${r.unplayed} 个未看`, `${r.unplayed} unwatched`) : tc("从未看过", "never watched")));
    add(L.discover, (r) => (r.a.played ? tc(`已看 ${r.a.played}/${r.n}`, `${r.a.played} of ${r.n} watched`) : tc("从未看过", "never watched")));
    const tagSet = new Map(rows.map((r) => [r.id, new Set((r.p.tags || []).map((t) => String(t.id)))]));
    const main = new Map(rows.map((r) => { const b = Object.entries(r.a.studios).sort((x, y) => y[1] - x[1])[0]; return [r.id, b ? b[0] : null]; }));
    const cands = [...pool.values()];
    const close = (r, c) => {
      const n = (r.a.with && r.a.with[c.r.id]) || 0;
      if (n) return { v: 0.6 + 0.1 * Math.min(4, n), n, k: "t" };
      if (main.get(r.id) && main.get(r.id) === main.get(c.r.id)) return { v: 0.4, n: 0, k: "s" };
      const A = tagSet.get(r.id), B = tagSet.get(c.r.id);
      if (!A.size || !B.size) return null;
      let both = 0;
      for (const t of A) if (B.has(t)) both++;
      const j = both / (A.size + B.size - both);
      return j >= 0.2 ? { v: 0.5 * j, n: 0, k: "g" } : null;
    };
    const mates = {}, best = {};
    for (const r of rows) {
      const got = [];
      for (const c of cands) {
        if (c.r.id === r.id) continue;
        const k = close(r, c);
        if (k) got.push({ c, k, score: k.v * (0.5 + 0.5 * c.w) });
      }
      got.sort((x, y) => y.score - x.score || tie(x.c.x, y.c.x));
      const top = got.slice(0, REC_MATES);
      if (top.length) { mates[r.id] = top.map((g) => [g.c.r.id, g.k.n, g.k.k]); best[r.id] = top; }
    }
    const duos = [], seen = new Set(), used = {};
    for (const a of L.foryou.slice(0, 30)) {
      for (const g of best[a.id] || []) {
        const key = duoIds([{ id: a.id }, { id: g.c.x.id }]).join("&");
        if (seen.has(key) || (used[g.c.x.id] || 0) >= 2) continue;
        seen.add(key); used[g.c.x.id] = (used[g.c.x.id] || 0) + 1;
        const b = g.c.x, mini = (x) => ({ id: x.id, name: x.name, image_path: x.image_path, scene_count: x.scene_count,
                                          image_count: x.image_count, unplayed: x.unplayed });
        duos.push({ id: key, duo: [mini(a), mini(b)], name: `${a.name} & ${b.name}`, score: Math.round(a.score * g.score * 1000) / 1000,
                    why: [mateWhy(g.k.k, g.k.n), `${b.name}: ${g.c.ng}`].join(" · "), studio: a.studio, last: Math.max(a.last || 0, b.last || 0),
                    scene_count: (a.scene_count || 0) + (b.scene_count || 0), unplayed: (a.unplayed || 0) + (b.unplayed || 0) });
        break;
      }
    }
    duos.sort((x, y) => y.score - x.score || tie(x, y));
    return { duos: duos.slice(0, REC_KEEP), mates };
  }
  const mateWhy = (k, n) => (k === "t" ? tc(`${n} 个共同场景`, `${n} ${n === 1 ? "scene" : "scenes"} together`) : k === "s" ? tc("同一工作室", "same studio") : tc("标签相似", "similar tags"));
  // The partners shown under a chosen performer (Pair with): their cards
  // from the lists, each with why they go together. `recs` the cached
  // lists; leaves out whoever is excluded (recShown's rules) and `notId`.
  function mateCards(recs, id, recent, fresh) {
    const lists = recs && recs.lists;
    if (!lists || !lists.mates) return [];
    const find = new Map();
    for (const k of ["neglected", "backlog", "discover"]) for (const x of lists[k] || []) if (!find.has(x.id)) find.set(x.id, { x, k });
    const out = [];
    for (const [mid, n, k] of lists.mates[String(id)] || []) {
      const f = find.get(String(mid));
      if (!f || !recShown([f.x], recent, fresh).length) continue;
      const tail = f.k === "neglected" ? f.x.why.split(" · ").find((w) => /^(?:not watched|很久没看|已经)/.test(w)) : f.k === "backlog" ? tc(`${f.x.unplayed} 个未看`, `${f.x.unplayed} unwatched`) : tc("你可能也会喜欢", "you might like them");
      out.push({ ...f.x, why: [mateWhy(k, n), tail].filter(Boolean).join(" · ") });
    }
    return out;
  }
  // Performers with a Lockdown run that started in the last 7 days (`ms`:
  // another span; 3 months for Neglected and Backlog, 2.15.1).
  function recentPerformers(list, now, ms) {
    const out = new Set();
    for (const e of list || []) {
      if (!e || typeof e.at !== "number" || now - e.at > (ms || REC_RECENT_MS)) continue;
      if ((e.kind || "performer") !== "performer") continue;
      if (duoOf(e)) for (const p of e.duo) out.add(String(p.id));       // 2.14: both of a duo
      else if (e.tid || e.pid) out.add(String(e.tid || e.pid));
    }
    return out;
  }
  // A list as the setup shows it: without the recent ones, and with
  // Unwatched only, only those with an unwatched scene.
  function recShown(items, recent, fresh) {
    // 2.14: a duo card is out when either of the two ran lately
    const ids = (x) => (Array.isArray(x.duo) ? x.duo.map((p) => String(p.id)) : [String(x.id)]);
    return (items || []).filter((x) => x && !(recent && ids(x).some((i) => recent.has(i))) && (!fresh || x.unplayed > 0));
  }
  // One of `list` by its `score` (r in [0, 1)); all zero: uniform.
  function weightedPick(list, r) {
    if (!list || !list.length) return null;
    const w = list.map((x) => Math.max(0, Number(x && x.score) || 0));
    const sum = w.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return list[Math.min(list.length - 1, Math.floor(r * list.length))];
    let at = r * sum;
    for (let i = 0; i < list.length; i++) { at -= w[i]; if (at < 0) return list[i]; }
    return list[list.length - 1];
  }
  // A day's cache of the lists, per browser (localStorage `lockdownRecs`).
  const recFresh = (c, now) => !!c && c.v === REC_V && typeof c.at === "number" && now - c.at < DAY_MS && now >= c.at && !!c.lists;

  // ── 2.9: the player's own "next" controls under Roulette ──────────────────
  // Stash's skip buttons (video.js, shown with a queue), the queue panel's
  // controls and Lockdown's own button in the control bar all mean Next
  // scene; so do Stash's "p n" / "p p" / "p r" queue keys (queueKey).
  const NEXT_SEL = ".video-js .vjs-skip-button, .video-js .vjs-icon-next-item, .video-js .vjs-icon-previous-item, .queue-controls button, .ld-vjsnext";
  // Which image is on screen in Stash's own viewer: the lightbox's (its
  // footer links the image) or the image page's; null for none, or for a
  // lightbox showing something without that link.
  function pictureHere(pathname, lightboxHref, lightboxOpen) {
    const m = /\/images\/(\d+)/.exec(lightboxHref || "");
    if (m) return m[1];
    if (lightboxOpen) return null;
    const p = /^\/images\/(\d+)\/?$/.exec(pathname || "");
    return p ? p[1] : null;
  }
  function queueKey(prev, key, now) {
    return !!prev && prev.key === "p" && now - prev.at < 1500 && (key === "n" || key === "p" || key === "r");
  }

  // ── The suite's toast: kinds, how long each stays, where it is mounted ────
  // `kind` true was 2.3's "good" (blue), false or nothing its plain warning.
  const TOAST_MS = { info: 3000, done: 3000, warn: 4000, error: 8000 };
  // 2.16: long texts stay longer: 50 ms a character past 40, at most 9 s
  const toastMs = (k, text) => Math.min(Math.max(TOAST_MS[k] || 3000, 9000), (TOAST_MS[k] || 3000) + Math.max(0, String(text || "").length - 40) * 50);
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

  // ── 2.10: the leaderboard, "Hall of fame" ────────────────────────────────
  // The approved redesign (mockup canvas "Lockdown leaderboard": Main,
  // Expanded, EdgeFilter, Empty, Phone): a podium 2-1-3 with big pictures, a
  // records strip, places 4-12 as wide rows (Show more to 20) that open the
  // score's breakdown. Everything here is pure (data in, data or markup out)
  // and sits above the test hook so the tests reach it; `renderBoard` below
  // does the clicks and the one portrait query.
  const LB_ROWS = 12;                  // places shown before Show more
  const LB_MAX = 20;                   // and after it
  // The heat meter is as long as the most heat a run can have: every
  // condition at its top rank for the way out that allows the most (Edge
  // since 2.12, with Hidden target and Toy in charge: 12.5 since 2.12.2
  // took Blind seeking out, 13.5 before; Finish 10.5), so a full meter
  // means a run nobody can top. Only conditions(): a retired one is no
  // longer reachable (an old run above it fills the meter).
  const HEAT_MAX = Math.max(...["finish", "timer", "edge"].map((g) =>
    heatOf(conditions().reduce((o, c) => { o[c.k] = c.ranks.length; return o; }, {}), g)));
  const LB_SEGS = Math.ceil(HEAT_MAX);
  const LB_GOALS = [["all", "All"], ["finish", "Finish"], ["timer", "Timer"], ["edge", "Edge"]];
  const LB_GOALS_ZH = { all: "全部", finish: "完成", timer: "计时", edge: "边缘" };
  const LB_WAY = { finish: "Finish", timer: "Timer", edge: "Edge" };
  const lbGoal = (g) => tc(LB_GOALS_ZH[g] || g, (LB_GOALS.find(([k]) => k === g) || [g, g])[1]);
  // Line icons on the 16 grid (the suite's), for the board only.
  const lbIc = (d, cls) => `<svg class="ld-lbic${cls ? " " + cls : ""}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
  const LB_FLAME = '<path d="M8 1.5c.6 2.6 3.8 4 3.8 7.6a3.8 3.8 0 0 1-7.6 0c0-1.7.8-2.8 1.7-3.6.2 1.2.8 2 1.5 2.3C7.1 6 7.1 3.8 8 1.5z"/>';
  const LB_DROP = '<path d="M8 2c2.5 3.2 4 5.4 4 7.3A4 4 0 0 1 4 9.3C4 7.4 5.5 5.2 8 2z"/>';
  const LB_CUP = '<path d="M5 2.5h6v3a3 3 0 0 1-6 0zM5 3.5H2.8a2.2 2.2 0 0 0 2.4 2.6M11 3.5h2.2a2.2 2.2 0 0 1-2.4 2.6M8 8.5v3M5.5 13.5h5"/>';
  const LB_LOCK = '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>';
  const LB_CROWN = '<path d="M2 5l3 3 3-5 3 5 3-3-1.2 7.5H3.2z"/>';
  const LB_CHEV = '<path d="M4 6l4 4 4-4"/>';
  const lbNum = (n) => Math.round(Number(n) || 0).toLocaleString();

  // The first day of this month, local time ("This month" is the runs
  // started since then, by their stored `at`).
  function monthStart(now) {
    const d = new Date(now);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const inPeriod = (x, period, now) => period !== "month" || (typeof x.at === "number" && x.at >= monthStart(now));

  // A board run with what the history still knows about it. Runs slimmed
  // before 2.10 kept no target id, O's or moments; the history entry of the
  // same id has them while it is in the list (the last 200). The board's own
  // fields win; nothing is written back.
  function boardEntry(x, h) {
    if (!h) return x;
    const out = { ...x };
    if (!out.tid && (h.tid || h.pid)) out.tid = String(h.tid || h.pid);
    if (out.os === undefined && typeof h.os === "number") out.os = h.os;
    if (!("moments" in out) && h.v >= 3) out.moments = h.moments || [];
    if (!out.tags && h.tags) { out.tags = h.tags; out.mode = h.mode; }
    if (!out.duo && duoOf(h)) out.duo = h.duo;
    if (!out.image && h.image) out.image = h.image;
    return out;
  }

  // What the board shows for a way out and a period: the counts per way out
  // (in the period), the ranked runs (at most 20), the podium in its 2-1-3
  // order, the rows after it (9, or up to 20 with `more`), and how many
  // Show more would add. `#1` gets the personal best pill under All and All
  // time; the newest run on the whole board is the latest.
  function boardView(top, o) {
    o = o || {};
    const goal = o.goal || "all", period = o.period || "all", now = o.now || Date.now();
    const byId = new Map(((o.list) || []).filter((e) => e && e.id).map((e) => [String(e.id), e]));
    const all = boardRows(top, "all").map((x) => boardEntry(x, byId.get(String(x.id))));
    const per = all.filter((x) => inPeriod(x, period, now));
    const counts = {};
    for (const [g] of LB_GOALS) counts[g] = per.filter((x) => g === "all" || goalType(x) === g).length;
    const rows = per.filter((x) => goal === "all" || goalType(x) === goal);
    let latest = null;
    for (const x of all) if (typeof x.at === "number" && (!latest || x.at > latest.at)) latest = x;
    const first = rows.length ? rows[0].score : 1;
    const ranked = rows.slice(0, LB_MAX).map((x, i) => ({
      x, rank: i + 1, pct: Math.max(4, Math.round((x.score / first) * 100)),
      latest: !!latest && x.id === latest.id, best: i === 0 && goal === "all" && period === "all",
      behind: i > 0 ? rows[i - 1].score - x.score : 0,
    }));
    const podium = [ranked[1], ranked[0], ranked[2]].filter(Boolean);
    const restAll = ranked.slice(3);
    const rest = o.more ? restAll : restAll.slice(0, LB_ROWS - 3);
    return { goal, period, counts, ranked, podium, rest, more: restAll.length - rest.length, total: rows.length, all: all.length };
  }

  // The most locked target with its key in the totals (bare id for a
  // performer, "s:<id>" a studio, "t:<id>" a tag), as mostLocked picks it.
  function mostLockedEntry(stats) {
    let best = null;
    for (const [key, v] of Object.entries((stats && stats.perf) || {})) {
      if (!v || !v.n) continue;
      if (!best || v.n > best.n || (v.n === best.n && String(v.name) < String(best.name))) best = { key, name: v.name, n: v.n };
    }
    return best;
  }
  // A totals key as a target: { kind, id } (several tags: no single id).
  function keyTarget(key) {
    const k = String(key || "");
    if (/^s:\d+$/.test(k)) return { kind: "studio", id: k.slice(2) };
    if (/^t:/.test(k)) return { kind: "tag", id: /^t:\d+$/.test(k) ? k.slice(2) : "" };
    if (/^p:\d+(&\d+)+$/.test(k)) return { kind: "performer", id: "", duo: k.slice(2).split("&") };   // 2.14: a duo
    if (/^\d+$/.test(k)) return { kind: "performer", id: k };
    return { kind: "performer", id: "" };
  }

  // The records strip, from the lifetime totals: highest heat got out of,
  // longest edge, best streak and the one running now, the most locked
  // target, and every run got out of or given up.
  function boardRecords(stats) {
    const st = { ...EMPTY_STATS, ...(stats || {}) };
    return { heat: st.bestHeat || 0, edgeMs: st.longestEdgeMs || 0, best: st.bestStreak || 0, now: st.streak || 0,
             done: st.done || 0, gaveUp: st.gaveUp || 0, runs: (st.done || 0) + (st.gaveUp || 0), most: mostLockedEntry(st) };
  }

  // 2.19: "2 kept · 1 broken"; "won in 1:42" | "lost"
  const staysText = (x) => (x ? [x.kept ? tc(`${x.kept} 张守住`, `${x.kept} kept`) : "", x.broke ? tc(`${x.broke} 张失败`, `${x.broke} broken`) : ""].filter(Boolean).join(" · ") : "");
  const raceText = (x) => (!x ? "" : x.st === "won" ? tc(`用时 ${fmtClock(x.ms || 0)} 获胜`, `won in ${fmtClock(x.ms || 0)}`) : tc("输了", "lost"));
  // How a run's score adds up, line by line, from scoreOf (the same rule
  // the run was scored with). A board run whose stored score differs (an
  // Edge run from before 2.5.1 keeps its old score) shows the stored one,
  // with `old` set.
  function scoreLines(x) {
    const sc = scoreOf({ ...x, result: "done", v: 3 });
    if (!sc) return null;
    const g = x.goal || {};
    const wMs = g.type === "edge" && g.watchMs ? Math.min(x.watchedMs || 0, g.watchMs) : (x.watchedMs || 0);
    const lines = [{ k: tc("观看", "Watched"), d: `${fmtMinutes(wMs / 60000)} × 10`, v: sc.watched, c: "cy" }];
    if (sc.overtime) lines.push({ k: tc("加时", "Overtime"), d: `${fmtMinutes(Math.min(x.overtimeMs, g.watchMs || 0) / 60000)} × 10`, v: sc.overtime, c: "ma" });
    if (sc.skips) lines.push({ k: tc("跳过", "Skips"), d: `${x.skipsUsed} × ${SKIP_COST}${-sc.skips < SKIP_COST * x.skipsUsed ? tc(", 最多一半", ", at most half") : ""}`, v: sc.skips, c: "re" });
    if (sc.slips) lines.push({ k: tc("边缘目标前的O", "O's before the Edge target"), d: `${x.slips} × 100`, v: sc.slips, c: "re" });
    if (sc.pics) lines.push({ k: tc("图片", "Pictures"), d: tc(`${sc.pics} 张新图`, `${sc.pics} new`), v: sc.pics, c: "" });
    // 2.13.0: Eyes on screen's deduction
    if (sc.away) lines.push({ k: tc("离开画面", "Away"), d: `${(x.away && x.away.n) || 1}× · ${fmtAway(awayMsOf(x))}`, v: sc.away, c: "re" });
    // 2.16: hold cards passed
    if (sc.holds) lines.push({ k: tc("坚持牌", "Holds"), d: `${sc.holds / HOLD_KINDS.eyes.pts} × ${HOLD_KINDS.eyes.pts}`, v: sc.holds, c: "cy" });
    if (sc.tagm) lines.push({ k: tc("标签牌标记", "Tag card markers"), d: `${sc.tagm / TAG_MATCH_PTS} × ${TAG_MATCH_PTS}`, v: sc.tagm, c: "ma" });
    // 2.19
    if (sc.stays || x.stays) lines.push({ k: tc("停留牌", "Stay cards"), d: staysText(x.stays), v: sc.stays, c: sc.stays < 0 ? "re" : "cy" });
    if (sc.race || x.race) lines.push({ k: tc("竞赛牌", "Race"), d: raceText(x.race), v: sc.race, c: sc.race < 0 ? "re" : "or" });
    // 2.20
    if (sc.skipc) lines.push({ k: tc("跳过牌保留", "Skip cards kept"), d: `${x.skipCards.kept} × ${SKIP_CARD_PTS}`, v: sc.skipc, c: "cy" });
    lines.push({ k: tc("出局", "Got out"), d: "", v: sc.out, c: "gr" });
    const sub = lines.reduce((a, l) => a + l.v, 0);
    const stored = typeof x.score === "number" ? x.score : sc.total;
    return { lines, sub, heat: sc.heat, mult: sc.mult, nov: sc.nov, novK: x.novK || [], total: stored, computed: sc.total, old: stored !== sc.total };
  }

  // The conditions a run had on, with what each added to its heat.
  function heatParts(conds, goal) {
    const g = goal && goal.type ? goal.type : goal;
    const one = !!(conds && conds.one) && g === "timer";
    return anyCond().filter((c) => conds && conds[c.k] && condApplies(c, g) && !(one && c.k === "stay"))
      .map((c) => ({ k: c.k, name: c.name, rank: c.ranks[conds[c.k] - 1] || "", heat: c.heat[conds[c.k] - 1] || 0 }));
  }
  // A condition as a chip: the Skip budget by its rank ("No skips", "1 skip
  // per scene"), the others by name.
  const condChip = (p) => (p.k === "skip" ? p.rank.charAt(0).toUpperCase() + p.rank.slice(1) : p.name);
  const runConds = (x) => heatParts(x.conds || (x.rules ? condsFromRules(x.rules, x.goal) : {}), x.goal);
  const runHeat = (x) => (typeof x.heat === "number" ? x.heat : heatOf(x.conds || condsFromRules(x.rules, x.goal), x.goal));

  // "Edge · 45 min · heat 6 · 2 moments · Roulette, No skips": how it was won.
  function howLine(x) {
    const bits = [goalLabel(x.goal), tc(`热度 ${runHeat(x)}`, `heat ${runHeat(x)}`)];
    const m = (x.moments || []).length;
    if (m) bits.push(plural(m, "moment", "moments"));
    const c = runConds(x).slice(0, 2).map(condChip);
    if (c.length) bits.push(c.join(", "));
    return bits.join(" · ");
  }

  // ── Pictures ──
  // Performers have their picture on the run (`image`, the target's
  // image_path when it started). Old runs without one, and the most locked
  // tile, are looked up in ONE query by ids for everything on screen
  // (performers and studios together); tags never are (a lettered card,
  // the user's choice). `cache` maps "kind:id" to a path ("" for none).
  const picKey = (kind, id) => `${kind || "performer"}:${id}`;
  function portraitNeeds(items, cache) {
    const need = { performer: [], studio: [] };
    for (const it of items || []) {
      if (!it || it.image || !it.id) continue;
      const kind = it.kind || "performer";
      if (!need[kind] || (cache && cache.has(picKey(kind, it.id)))) continue;
      if (!need[kind].includes(String(it.id))) need[kind].push(String(it.id));
    }
    return need;
  }
  function portraitQuery(need) {
    const p = (need && need.performer) || [], s = (need && need.studio) || [];
    if (!p.length && !s.length) return null;
    const vars = [], parts = [], variables = {};
    if (p.length) { vars.push("$p: [ID!]"); parts.push("p: findPerformers(ids: $p, filter: { per_page: -1 }) { performers { id image_path } }"); variables.p = p; }
    if (s.length) { vars.push("$s: [ID!]"); parts.push("s: findStudios(ids: $s, filter: { per_page: -1 }) { studios { id image_path } }"); variables.s = s; }
    return { query: `query (${vars.join(", ")}) { ${parts.join(" ")} }`, variables };
  }
  // The answer into the cache; ids asked for and not found get "" so they
  // are not asked again this session.
  function portraitFill(cache, need, d) {
    for (const r of (d && d.p && d.p.performers) || []) cache.set(picKey("performer", r.id), r.image_path || "");
    for (const r of (d && d.s && d.s.studios) || []) cache.set(picKey("studio", r.id), r.image_path || "");
    for (const kind of ["performer", "studio"]) for (const id of (need && need[kind]) || []) if (!cache.has(picKey(kind, id))) cache.set(picKey(kind, id), "");
    return cache;
  }
  const lbPics = new Map();            // this session's looked-up pictures
  const runPic = (x, cache) => x.image || (x.tid && (cache || lbPics).get(picKey(x.kind, x.tid))) || "";

  // A picture's frame: a performer's photo from the top (faces show), a
  // studio's logo on a light plate, a tag as a big lettered card; with no
  // picture a performer gets their initial on a tinted ground.
  const LB_HUES = ["pu", "cy", "re", "bl", "ye", "ma", "gr", "or"];
  const hueOf = (s) => LB_HUES[[...String(s || "")].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % LB_HUES.length];
  function lbPicHtml(kind, name, img, big, duo) {
    const nm = escapeHtml(name || "?");
    // 2.14: a duo, the two photos side by side
    if (duo && duo.length > 1) return `<span class="ld-lbduo">${duo.slice(0, 2).map((p) => lbPicHtml("performer", p.name, p.image_path || "", big)).join("")}</span>`;
    if (kind === "studio") {
      return `<span class="ld-lbplate${big ? " ld-big" : ""}">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : `<b>${nm}</b>`}` +
        `${big ? `<small>${tc("工作室", "Studio")}</small>` : ""}</span>`;
    }
    if (kind === "tag") return `<span class="ld-lbtag${big ? " ld-big" : ""}">${big ? `<small>${tc("标签", "Tag")}</small>` : ""}<b>${nm}</b></span>`;
    return img ? `<img class="ld-lbphoto" src="${escapeHtml(img)}" alt="" loading="lazy">`
      : `<span class="ld-lbinit" style="--h:var(--sx-${hueOf(name)}-d)">${escapeHtml(String(name || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;
  }
  // 2.17 (user: "rounded rectangles in Stash's 2:3 performer-card shape,
  // never circles"): a picture as a portrait. `size`: xl 200×300 (the setup's
  // run panel), l 150×225 (the run page), m 76×114 (the chosen one), s 44×66
  // (Goes well with), h 36×54 (History, Recommended), b 30×44 (the bar), xs
  // 24×36 (search rows), xxs (a duo's chips). A duo is two overlapping; a
  // studio its logo on a plate, a tag its picture (not Stash's placeholder),
  // else their icon; a performer without a picture a silhouette.
  const PF_ICON = {
    performer: '<svg class="ld-pfsil" viewBox="0 0 40 60" aria-hidden="true"><circle cx="20" cy="24" r="9"/><path d="M3 60c0-12 7.5-21 17-21s17 9 17 21z"/></svg>',
    studio: '<svg class="ld-pfico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="8" height="8" rx="1.2"/><path d="M10.5 7.2l3-1.8v6.2l-3-1.8"/></svg>',
    tag: '<svg class="ld-pfico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z"/><circle cx="5.4" cy="5.4" r="0.9"/></svg>',
  };
  function pfHtml(x, name, image, size, kind) {
    const k = kind || (x && x.kind) || "performer", sz = size || "h";
    const duo = k === "performer" ? duoOf(x) : null;
    if (duo) return `<span class="ld-pf2 ld-pf2-${sz}">${duo.slice(0, 2).map((p) => pfHtml(null, p.name, p.image_path || p.image, sz, "performer")).join("")}</span>`;
    const src = k === "tag" ? tagPic(image) : image ? String(image) : "";
    const t = escapeHtml(name || "");
    if (src) return `<span class="ld-pf ld-pf-${sz}${k === "studio" ? " ld-pfplate" : ""}" title="${t}"><img src="${escapeHtml(src)}" alt="" loading="lazy"></span>`;
    return `<span class="ld-pf ld-pf-${sz} ld-pfnone${k === "performer" ? "" : " ld-pfkind"}" title="${t}">${PF_ICON[k] || PF_ICON.performer}</span>`;
  }
  const wayHtml = (x, cls) => `<span class="ld-lbway ld-way-${goalType(x)}${cls ? " " + cls : ""}">${escapeHtml(goalLabel(x.goal))}</span>`;
  function meterHtml(h) {
    let s = "";
    for (let i = 0; i < LB_SEGS; i++) s += `<i class="${h >= i + 1 ? "ld-on" : h > i ? "ld-half" : ""}"></i>`;
    // 2.12.2: a run from before Blind seeking was retired can be above the
    // max now; its meter is full and the title says no "of"
    return `<span class="ld-lbmeter" title="${tc(`热度 ${h}${h <= HEAT_MAX ? ` / ${HEAT_MAX}` : ""}`, `Heat ${h}${h <= HEAT_MAX ? ` of ${HEAT_MAX}` : ""}`)}">${s}</span>`;
  }
  const heatRow = (h) => `<span class="ld-lbheat">${lbIc(LB_FLAME, "ld-lbflame")}<b>${tc("热度 " + h, "Heat " + h)}</b>${meterHtml(h)}<em>×${heatMult(h)}</em></span>`;
  const kindLabel = (x) => (x.kind === "studio" ? tc("工作室", "Studio") : x.kind === "tag" ? tc("标签", "Tag") : "");
  const shortDate = (at, now) => (typeof at === "number" ? fmtWhen(at, now).replace(/\s\d{1,2}:\d{2}(\s?[AP]M)?$/i, "") : "");

  function podiumHtml(v, now, cache, open) {
    return `<section class="ld-lbpod" aria-label="${tc("领奖台", "Podium")}"><div class="ld-lbpodrow" data-a="pod">` + v.podium.map((r) => {
      const x = r.x, h = runHeat(x), kl = kindLabel(x);
      return `<div class="ld-lbstep ld-s${r.rank}"><article class="ld-lbpc ld-p${r.rank}${r.latest ? " ld-latest" : ""}${open === x.id ? " ld-open" : ""}" ` +
        `data-open="${escapeHtml(x.id)}" role="button" tabindex="0" aria-expanded="${open === x.id}" aria-label="${escapeHtml(tc(`第 ${r.rank} 名：${x.name || "?"}，${lbNum(x.score)}`, `Place ${r.rank}: ${x.name || "?"}, ${lbNum(x.score)}`))}">` +
        `<div class="ld-lbpic">${lbPicHtml(x.kind, x.name, runPic(x, cache), true, duoOf(x))}` +
          `<div class="ld-lbcap"><b>${escapeHtml(x.name || "?")}</b><span>${escapeHtml([kl, tc(`锁定 ${fmtMinutes((x.ms || 0) / 60000)}`, `${fmtMinutes((x.ms || 0) / 60000)} locked`)].filter(Boolean).join(" · "))}</span></div>` +
          `<span class="ld-lbmedal" aria-label="${tc(`第 ${r.rank} 名`, `Place ${r.rank}`)}">${r.rank}</span>${wayHtml(x, "ld-onpic")}` +
          `${r.best ? `<span class="ld-lbpb">${tc("个人最佳", "Personal best")}</span>` : ""}${r.latest ? `<span class="ld-lbnew">${tc("最新一局", "Latest run")}</span>` : ""}</div>` +
        `<div class="ld-lbscore"><b>${lbNum(x.score)}</b><span${typeof x.at === "number" ? ` title="${escapeHtml(fmtStamp(x.at))}"` : ""}>${escapeHtml(shortDate(x.at, now))}</span></div>` +
        heatRow(h) +
        `<div class="ld-lbhow">${escapeHtml(howLine(x))}</div></article>` +
        `<div class="ld-lbplinth" aria-hidden="true">${r.rank}</div></div>`;
    }).join("") + `</div>` +
      (v.podium.length > 1 ? `<div class="ld-lbdots" aria-hidden="true">${v.podium.map((r, i) => `<i class="${i === 0 ? "ld-on" : ""}"></i>`).join("")}</div>` : "") + `</section>`;
  }

  function recordsHtml(rec, cache) {
    const tile = (hue, ico, big, small) => `<div class="ld-lbtile"><span class="ld-lbtico" style="--h:var(--sx-${hue});--ht:var(--sx-${hue}-tx)">${lbIc(ico)}</span>` +
      `<span><b>${big}</b><small>${small}</small></span></div>`;
    const m = rec.most, mt = m ? keyTarget(m.key) : null;
    const mImg = mt && mt.id ? (cache || lbPics).get(picKey(mt.kind, mt.id)) || "" : "";
    return `<section class="ld-lbrec" aria-label="${tc("纪录", "Records")}"><div class="ld-lbcapt">${tc("纪录", "Records")}</div><div class="ld-lbtiles">` +
      tile("or", LB_FLAME, rec.heat ? tc(`热度 ${rec.heat}`, `Heat ${rec.heat}`) : "–", tc("出局时拿到的最高热度", "highest heat got out of")) +
      tile("ma", LB_DROP, rec.edgeMs ? escapeHtml(fmtMinutes(rec.edgeMs / 60000)) : "–", tc("最长的一次边缘", "longest edge")) +
      tile("ye", LB_CUP, rec.best ? tc(`${rec.best} 连胜`, `${rec.best} in a row`) : "–", tc(`最佳连胜${rec.now ? ` · 当前 ${rec.now}` : ""}`, `best streak${rec.now ? ` · now ${rec.now}` : ""}`)) +
      (m ? `<div class="ld-lbtile ld-lbmost"><span class="ld-lbthumb ld-k-${mt.kind}">${lbPicHtml(mt.kind, m.name, mImg, false)}</span>` +
             `<span><b>${escapeHtml(m.name)}</b><small>${tc(`锁定最多 · ${m.n} 次`, `most locked to · ${plural(m.n, "time", "times")}`)}</small></span></div>`
         : tile("pu", LB_CROWN, "–", tc("锁定最多", "most locked to"))) +
      tile("re", LB_LOCK, tc(`${rec.runs} 次对局`, plural(rec.runs, "run", "runs")), tc(`${rec.done} 次出局 · ${rec.gaveUp} 次放弃`, `${rec.done} got out · ${rec.gaveUp} gave up`)) +
      `</div></section>`;
  }

  function rowHtml2(r, now, open, cache) {
    const x = r.x, h = runHeat(x), kl = kindLabel(x);
    const chips = runConds(x).slice(0, 3).map((p) => `<span class="ld-lbcond" title="${escapeHtml(`${p.name}: ${p.rank}`)}">${escapeHtml(condChip(p))}</span>`).join("");
    const small = [shortDate(x.at, now), tc(`${fmtMinutes((x.watchedMs || 0) / 60000)} 观看`, `${fmtMinutes((x.watchedMs || 0) / 60000)} watched`),
                   x.skipsUsed ? plural(x.skipsUsed, "skip", "skips") : tc("未跳过", "no skips"), x.pics > 0 ? tc(`${x.pics} 张图片`, plural(x.pics, "picture", "pictures")) : ""].filter(Boolean).join(" · ");
    return `<div class="ld-lbitem${open ? " ld-open" : ""}"><button type="button" class="ld-lbrow${r.latest ? " ld-latest" : ""}" data-open="${escapeHtml(x.id)}" aria-expanded="${open}">` +
      `<span class="ld-lbrank">${r.rank}</span>` +
      `<span class="ld-lbthumb ld-k-${escapeHtml(x.kind || "performer")}">${lbPicHtml(x.kind, x.name, runPic(x, cache), false, duoOf(x))}</span>` +
      `<span class="ld-lbmain"><span class="ld-lbname"><b>${escapeHtml(x.name || "?")}</b>${kl ? `<small>${kl}</small>` : ""}` +
        `${r.latest ? `<span class="ld-lbnew">${tc("最新一局", "Latest run")}</span>` : ""}</span>` +
        `<span class="ld-lbchips">${wayHtml(x)}${chips}</span><span class="ld-lbsmall">${escapeHtml(small)}</span>` +
        `<span class="ld-lbbar ld-lbbar2"><i style="width:${r.pct}%"></i></span></span>` +
      `<span class="ld-lbhot">${heatRow(h)}</span>` +
      `<span class="ld-lbpts"><b>${lbNum(x.score)}</b><span class="ld-lbbar"><i style="width:${r.pct}%"></i></span><small>${tc(`第 1 名的 ${r.pct}%`, `${r.pct}% of #1`)}</small><em class="ld-lbph">${tc("热度 " + h, "Heat " + h)}</em></span>` +
      `${lbIc(LB_CHEV, "ld-lbchev")}</button>${open ? moreHtml(r, now) : ""}</div>`;
  }

  // The opened row: how the score adds up, and the run.
  function moreHtml(r, now) {
    const x = r.x, sl = scoreLines(x), parts = runConds(x);
    const sign = (v) => (v < 0 ? `−${lbNum(-v)}` : `+${lbNum(v)}`);
    const sum = sl ? sl.lines.map((l) => `<span>${escapeHtml(l.k)}</span><span class="ld-lbd">${escapeHtml(l.d)}</span>` +
        `<span class="ld-lbv${l.c ? ` ld-c-${l.c}` : ""}">${sign(l.v)}</span>`).join("") +
      `<span class="ld-lbsub">${tc("热度前", "Before heat")}</span><span class="ld-lbsub"></span><span class="ld-lbv ld-lbsub ld-hi">${lbNum(sl.sub)}</span>` +
      `<span class="ld-c-or">${tc("热度 " + sl.heat, "Heat " + sl.heat)}</span><span class="ld-lbd">${tc("每点 +20%", "+20% a point")}</span><span class="ld-lbv ld-c-or">×${sl.mult}</span>` +
      // 2.11: the novelty bonus, when the run had one
      (sl.nov > 0 ? `<span class="ld-c-cy">${tc("新颖度", "Novelty")}</span><span class="ld-lbd">${escapeHtml(tc(novNames(sl.novK).join("、") || "新条件", novNames(sl.novK).join(", ") || "new conditions"))}${tc("，每项 +3%", ", +3% each")}</span>` +
        `<span class="ld-lbv ld-c-cy">×${Math.round((1 + sl.nov) * 100) / 100}</span>` : "") +
      `<span class="ld-lbtot">${tc("得分", "Score")}</span><span></span><span class="ld-lbv ld-lbtot">${lbNum(sl.total)}</span>` : "";
    const from = parts.filter((p) => p.heat).map((p) => `${p.name} (${p.rank}, +${p.heat})`);
    const note = [from.length ? tc(`热度来自 ${from.length > 1 ? from.slice(0, -1).join("、") + " 和 " + from[from.length - 1] : from[0]}。`, `Heat came from ${from.length > 1 ? from.slice(0, -1).join(", ") + " and " + from[from.length - 1] : from[0]}.`) : tc("没有热度：这是一盘免费局。", "No heat: a free run."),
                  r.behind > 0 ? tc(`距离第 ${r.rank - 1} 名还差 ${r.behind} 分。`, `${plural(r.behind, "point", "points")} short of #${r.rank - 1}.`) : "",
                  sl && sl.old ? tc(`按旧规则计分（今日相当于 ${lbNum(sl.computed)}）。`, `Scored under an older rule (${lbNum(sl.computed)} today).`) : ""].filter(Boolean).join(" ");
    const fact = (big, small, c) => `<div class="ld-lbfact"><b${c ? ` class="ld-c-${c}"` : ""}>${escapeHtml(String(big))}</b><span>${small}</span></div>`;
    const links = momentLinks(x);
    const K = KINDS[x.kind] || KINDS.performer;
    const openHref = x.tid && !(x.tags && x.tags.length > 1) && !duoOf(x) ? `/${K.path}/${encodeURIComponent(x.tid)}` : "";
    return `<div class="ld-lbmore"><div class="ld-lbcol"><div class="ld-lbcapt">${tc("得分怎么算的", "How the score adds up")}</div><div class="ld-lbsum">${sum}</div>` +
        `<div class="ld-lbnote">${escapeHtml(note)}</div></div>` +
      `<div class="ld-lbcol"><div class="ld-lbcapt">${tc("这一局", "The run")}</div><div class="ld-lbfacts">` +
        fact(fmtMinutes((x.watchedMs || 0) / 60000), tc("观看", "watched"), "cy") + fact(x.skipsUsed || 0, tc("已跳过", "skips used")) +
        (typeof x.os === "number" ? fact(x.os, tc("次O", "O's"), "bl") : "") + (Array.isArray(x.moments) ? fact(x.moments.length, tc("瞬间", "moments")) : "") +
        fact(x.pics || 0, tc("图片", "pictures")) + fact(fmtMinutes((x.ms || 0) / 60000), tc("锁定", "locked")) + `</div>` +
        (links.length ? `<div class="ld-lbmom"><span>${tc(`找到 ${plural(links.length, "moment", "moments")}`, `Found ${plural(links.length, "moment", "moments")}`)}</span>` +
          links.map((l) => `<a class="ld-mlink" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join("") + `</div>` : "") +
        (typeof x.at === "number" ? `<div class="ld-lbwhen">${escapeHtml(fmtStamp(x.at))}</div>` : "") +
        `<div class="ld-lbacts">${openHref ? `<a class="ld-lbbtn" href="${escapeHtml(openHref)}" data-lbopen="1">${tc(`打开 ${x.name || "?"}`, `Open ${x.name || "?"}`)}</a>` : ""}` +
        `<button type="button" class="ld-lbbtn" data-again="${escapeHtml(x.id)}">${tc("再来同一套设置", "Same setup again")}</button></div></div></div>`;
  }

  function emptyBoardHtml(v) {
    const title = v.all === 0 ? tc("还没有计分的对局", "No scored runs yet") : v.period === "month" && v.goal === "all" ? tc("本月还没有对局", "No runs this month")
      : tc(`还没有${v.goal === "all" ? "" : lbGoal(v.goal) + "类"}计分对局${v.period === "month" ? "（本月）" : ""}`, `No scored ${v.goal === "all" ? "" : LB_WAY[v.goal] + " "}runs${v.period === "month" ? " this month" : " yet"}`);
    return `<section class="ld-lbempty" aria-label="${tc("领奖台（空）", "Podium, empty")}"><div class="ld-lbpodrow" aria-hidden="true">` +
      `<div class="ld-lbstep ld-s2"><div class="ld-lbghost">2</div><div class="ld-lbplinth"></div></div>` +
      `<div class="ld-lbstep ld-s1"><div class="ld-lbghost ld-g1">${lbIc(LB_CROWN)}</div><div class="ld-lbplinth"></div></div>` +
      `<div class="ld-lbstep ld-s3"><div class="ld-lbghost">3</div><div class="ld-lbplinth"></div></div></div>` +
      `<div class="ld-lbetext"><b>${escapeHtml(title)}</b><span>${tc("从一场锁局中出局，就会出现在这里。只有出局的对局才参与排名", "Get out of a lockdown and it shows up here. Only runs you got out of are ranked")}` +
      `${v.all === 0 ? tc("，所以你完成的第一盘会直接登上榜首", ", so the first one you finish takes the top spot") : ""}。</span>` +
      `<button type="button" class="ld-lbbtn ld-pri" data-a="lbstart">${lbIc(LB_LOCK)}${tc("开始一盘", "Start a run")}</button></div></section>`;
  }

  // The whole tab. `s`: { goal, period, more, open (a run id) }; `notice`:
  // markup above the foot (an unreadable history).
  function boardHtml(top, list, stats, s, now, cache, notice) {
    const v = boardView(top, { goal: s.goal, period: s.period, more: s.more, now, list });
    const rec = boardRecords(stats);
    const label = v.period === "month" ? new Date(now).toLocaleDateString(undefined, { month: "long" }) : tc("全部时间", "All time");
    const sub = v.all === 0 ? tc("还没有排名", "Nothing ranked yet") : tc(`${label} · 共 ${v.total} 盘排名`, `${label} · ${plural(v.total, "run", "runs")} ranked`);
    const chips = LB_GOALS.map(([g, l]) => `<button type="button" class="ld-lbchip${g === v.goal ? " ld-on" : ""}" data-g="${g}" aria-pressed="${g === v.goal}">${lbGoal(g)} <b>${v.counts[g]}</b></button>`).join("");
    const periods = [["month", tc("本月", "This month")], ["all", tc("全部时间", "All time")]].map(([p, l]) =>
      `<button type="button" class="ld-lbper${p === v.period ? " ld-on" : ""}" data-p="${p}" aria-pressed="${p === v.period}">${l}</button>`).join("");
    const last = v.ranked.length ? 3 + v.rest.length : 0;
    return `<div class="ld-lb"><div class="ld-lbhead"><div><div class="ld-lbkicker">${tc("名人堂", "Hall of fame")}</div>` +
        `<h3 class="ld-lbtitle">${v.goal === "all" ? tc("你的最佳对局", "Your best runs") : tc(`你的最佳${lbGoal(v.goal)}对局`, `Your best ${LB_WAY[v.goal]} runs`)}</h3><div class="ld-lbsubl">${escapeHtml(sub)}</div></div>` +
        `<div class="ld-lbctl"><div class="ld-lbchips2" role="group" aria-label="${tc("出口方式", "Way out")}">${chips}</div>` +
        `<div class="ld-lbpers" role="group" aria-label="${tc("时间范围", "Period")}">${periods}</div></div></div>` +
      (v.ranked.length ? podiumHtml(v, now, cache, s.open) : emptyBoardHtml(v)) +
      // a podium run opened shows its breakdown under the podium
      v.podium.filter((r) => r.x.id === s.open).map((r) => `<div class="ld-lbitem ld-open ld-lbpodmore">${moreHtml(r, now)}</div>`).join("") +
      (rec.runs ? recordsHtml(rec, cache) : "") +
      (v.rest.length ? `<section class="ld-lblist" aria-label="${tc(`第 4 到 ${last} 名`, `Places 4 to ${last}`)}"><div class="ld-lblhead"><div class="ld-lbcapt">${tc(`第 4 到 ${last} 名`, `Places 4 to ${last}`)}</div>` +
          `<span>${tc("点开一盘可以看到得分怎么算的", "Click a run to see how its score adds up")}</span></div>` +
          v.rest.map((r) => rowHtml2(r, now, s.open === r.x.id, cache)).join("") +
          (v.more > 0 ? `<button type="button" class="ld-lbbtn ld-lbshow" data-a="lbmore">${tc(`再显示 ${v.more} 盘`, `Show ${v.more} more`)}</button>` : "") + `</section>` : "") +
      (notice || "") +
      `<div class="ld-lbfoot">${tc(`只有出局的对局才参与排名：每种出口方式取你的前 ${LB_MAX} 名。2.1 之前的对局没有观看时长，不计分。`, `Only runs you got out of are ranked: your ${LB_MAX} best of each way out. Runs from before 2.1 have no watch time and aren't scored.`)}</div></div>`;
  }

  // ── 2.11: decisions pulled out of the loops, so they are tested ───────────

  // Whether an item belongs, from a check's answer (review M2): a check that
  // failed (Stash busy, a network blip, logged out, a timeout) is not a
  // "no". It is never cached, keeps the veil up and is tried again; only a
  // definite answer is cached, and only a definite "no" lets go of Stay to
  // the end's or One scene's scene (2.10 cached the failure as "no" for the
  // whole run and released the condition).
  function belongVerdict(ok, failed) {
    if (failed) return { allow: false, cache: false, release: false, retry: true };
    return ok ? { allow: true, cache: true, release: false, retry: false } : { allow: false, cache: true, release: true, retry: false };
  }
  // The wait before try n (1, 2, ...): base, doubling, at most max.
  const backoffMs = (n, base, max) => (n > 0 ? Math.min(max, base * Math.pow(2, n - 1)) : 0);

  // The end of a run, as one change to Stash's copy (recordEnd and its
  // retries): the entry, the totals and the pictures, unless the history
  // already has this run (another device, or an earlier try that landed:
  // never counted twice), and the active lock cleared when it is this run.
  function endChange(cur, done, found, result, now) {
    const { list, stats, active, pics, picsBad } = cur;
    const M = active && active.id === done.id ? mergeLock(active, done) : done;
    const L = M.moments ? { ...M, moments: keepMoments(M.moments, found) } : M;
    const out = {};
    // 2.16: a cancel (the first 2 minutes) leaves no entry and no count
    if (result !== "cancelled" && !list.some((e) => e && e.id === done.id)) {
      const entry = entryFromLock(L, endResult(L, result), now);
      out.list = list.concat(entry);
      out.stats = addToStats(stats, entry);
      // 2.9: a run got out of uses up its pictures: no later run counts
      // them again (a given-up run scored nothing for them, so they stay new)
      if (entry.result === "done" && L.pics && L.pics.length && !picsBad) out.pics = addPicsChunk(pics, done.id, L.pics, now);
    }
    if (!active || active.id === done.id) out.active = null;
    return out;
  }
  // Runs whose end has not been written yet (review M4), newest first, one
  // per run id: localStorage lockdownPendingEnd until the write lands.
  const pendingAdd = (list, p) => [p].concat((list || []).filter((x) => x && x.id !== p.id));
  const pendingDrop = (list, id) => (list || []).filter((x) => x && x.id !== id);

  // What a sync has to read (review M5): with Suite Data, the active lock
  // alone, unless the history is needed (a lock gone from Stash: ended
  // elsewhere, with which result; a lock to take up: not one that ended)
  // or the last full read is SYNC_FULL_MS old.
  function syncPlan(lockId, remote, ended, sinceFull) {
    if (!(sinceFull < SYNC_FULL_MS)) return "full";
    if (!remote) return lockId ? "full" : "light";
    if (remote.id === lockId) return "light";
    return ended && ended.has(remote.id) ? "light" : "full";
  }
  // What a sync does with what it read (2.0's rules, unchanged): a run that
  // already ended (in the history, or here) is not taken up and its ghost is
  // cleared (`clear`); none here: adopt Stash's; gone from Stash: ended
  // elsewhere when Stash had it (or the history has it), else push it; a
  // different run: adopt it; the same: merge. `list` null: not read.
  function syncDecision(local, remote, list, ended, confirmedId) {
    const inList = (id) => !!list && list.some((e) => e && e.id === id);
    let r = remote || null, ghost = null;
    if (r && ((ended && ended.has(r.id)) || inList(r.id))) { ghost = r.id; r = null; }
    const clear = ghost && (!local || local.id !== ghost) ? ghost : null;
    if (!local) return { act: r ? "adopt" : "none", remote: r, clear };
    if (!r) {
      const entry = (list && list.find((e) => e && e.id === local.id)) || null;
      return { act: confirmedId === local.id || entry ? "ended" : "push", entry, remote: null, clear };
    }
    return { act: r.id !== local.id ? "adopt" : "merge", remote: r, clear };
  }

  // One tab per browser polls while locked (review M5d): the tab on screen
  // that holds `lockdownPollOwner` ({ tab, at, vis }), renewed every 2 s; a
  // hidden owner lets go, a stale one (closed tab) lapses after 6 s. The
  // others follow through the storage event of the lock's copy.
  function pollOwner(cur, me, visible, now) {
    const c = cur && typeof cur === "object" ? cur : null;
    const mine = !!c && c.tab === me;
    if (!visible) return { own: false, write: mine && c.vis ? { tab: me, at: now, vis: false } : null };
    const live = !!c && !!c.tab && !!c.vis && now - (c.at || 0) < OWNER_TTL_MS;
    if (live && !mine) return { own: false, write: null };
    const write = !mine || !c.vis || now - (c.at || 0) >= OWNER_RENEW_MS ? { tab: me, at: now, vis: true } : null;
    return { own: true, write };
  }
  // How often each poll runs: an unlocked page looks for a lock every
  // minute; locked, the polling tab syncs every 5 s and reads every O of
  // the target every 10 s (15 s on a scene page, where the open scene's own
  // count is read every 2.5 s and calls for the full read when it moved);
  // another tab syncs every 30 s and reads only its open scene's count.
  function pollIntervals(locked, own, onScene) {
    if (!locked) return { sync: SYNC_IDLE_MS, oFull: 0, oScene: 0 };
    return { sync: own ? SYNC_LOCKED_MS : SYNC_FOLLOW_MS, oFull: own ? (onScene ? O_FULL_SCENE_MS : O_FULL_MS) : 0, oScene: onScene ? O_SCENE_MS : 0 };
  }
  // The O check now: "full" (every O of the target), "scene" (the open
  // scene's count), or null. `s`: { now, lastFull, lastScene, own, onScene,
  // hasBase (per-scene counts, 2.2), allowed (the open scene belongs) }.
  function oCheckPlan(s) {
    const iv = pollIntervals(true, s.own, s.onScene);
    if (iv.oFull && s.now - (s.lastFull || 0) >= iv.oFull) return "full";
    if (iv.oScene && s.hasBase && s.allowed && s.now - (s.lastScene || 0) >= iv.oScene) return "scene";
    return null;
  }
  // The open scene's count against what the run last saw (oBase holds the
  // scenes with an O; none is 0): a change calls for the full read.
  const oSceneMoved = (oBase, sid, count) => !!oBase && typeof count === "number" && count !== (oBase[String(sid)] || 0);

  // A request with a time limit (review M6): `run(signal)` is aborted and
  // the promise rejects after `ms`, so a hung request can no longer hold a
  // busy flag (sync, O's, saving, cards) until a reload.
  function fetchWithin(run, ms, T) {
    // wrapped: called as t.set(...), the browser's own setTimeout throws "Illegal invocation"
    const t = T || { set: (f, n) => setTimeout(f, n), clear: (x) => clearTimeout(x), AC: typeof AbortController !== "undefined" ? AbortController : null };
    const ac = t.AC ? new t.AC() : null;
    let timer = null;
    const late = new Promise((_, no) => {
      timer = t.set(() => { try { if (ac) ac.abort(); } catch (_) {} no(new Error(`Stash did not answer in ${Math.round(ms / 1000)} s`)); }, ms);
    });
    return Promise.race([Promise.resolve().then(() => run(ac ? ac.signal : undefined)), late]).finally(() => t.clear(timer));
  }

  // ── 2.12: Toy in charge, through Intiface Sync's Goon mode API ───────────
  // `window.IntifaceSync.goon` (Intiface Sync 1.49): available() -> {ok, why},
  // start(opts) -> Promise<{ok, why}> (needs a user click: `userGesture`),
  // end({source}), state() -> {running, level, stage, style}, on(event, fn)
  // -> unsubscribe, events start / end / edge / cooldown / stage. Lockdown
  // only asks it to start (from a click, never by itself) and to end; the
  // device's safety stays Intiface Sync's. Without it, or an older one, the
  // condition is shown off ("needs Intiface Sync 1.49").
  const TOY_NEEDS = "needs Intiface Sync 1.49";
  function goonApi() {
    const I = typeof window !== "undefined" ? window.IntifaceSync : null;
    const g = I && I.goon;
    return g && ["available", "start", "end", "state", "on"].every((f) => typeof g[f] === "function") ? g : null;
  }
  // One per page: which run the toy was started for, whether Goon mode is
  // running for it, the event subscriptions. `getApi` is goonApi (a stub in
  // the tests). `cb`: { isCurrent(id), edge(), cool(), stage(x), ended(x) }.
  function toyController(getApi) {
    let runId = null, running = false, unsub = [], pending = null;
    const api = () => { try { return getApi(); } catch (_) { return null; } };
    const unsubAll = () => { for (const u of unsub) { try { u(); } catch (_) {} } unsub = []; };
    function status() {
      const g = api();
      if (!g) return { ok: false, missing: true, why: TOY_NEEDS };
      try { const a = g.available(); return a && a.ok ? { ok: true } : { ok: false, why: (a && a.why) || tc("Intiface Sync 尚未就绪", "Intiface Sync is not ready") }; }
      catch (e) { return { ok: false, why: (e && e.message) || tc("Intiface Sync 尚未就绪", "Intiface Sync is not ready") }; }
    }
    function subscribe(g, cb) {
      const on = (ev, fn) => { try { const u = g.on(ev, fn); if (typeof u === "function") unsub.push(u); } catch (_) {} };
      on("start", () => { running = true; });
      on("end", (x) => { if (!running) return; running = false; if (cb.ended) cb.ended(x); });
      on("edge", (x) => { if (running && cb.edge) cb.edge(x); });
      on("cooldown", (x) => { if (running && cb.cool) cb.cool(x); });
      on("stage", (x) => { if (cb.stage) cb.stage(x); });
    }
    // Call it straight from the click handler: the browser's gesture must
    // still be fresh when Intiface Sync asks for the device.
    function start(L, cb) {
      const c = cb || {};
      if (!L || !L.toy) return Promise.resolve({ ok: false, why: tc("本次对局没有玩具主导", "this run has no Toy in charge") });
      const g = api();
      if (!g) return Promise.resolve({ ok: false, missing: true, why: TOY_NEEDS });
      const st = status();
      if (!st.ok) return Promise.resolve(st);
      if (running && runId === L.id) return Promise.resolve({ ok: true, already: true });
      if (pending) return pending;
      if (runId !== L.id) { unsubAll(); runId = L.id; subscribe(g, c); }
      let p;
      // a start that did not happen leaves nothing to end later
      const failed = (why) => { if (!running) { unsubAll(); runId = null; } return { ok: false, why }; };
      try { p = g.start({ style: L.toy.style, level: L.toy.level, pace: L.toy.pace, base: null, source: "lockdown", userGesture: true }); }
      catch (e) { return Promise.resolve(failed((e && e.message) || tc("Goon 模式未启动", "Goon mode did not start"))); }
      pending = Promise.resolve(p).then((r) => {
        if (!r || !r.ok) return failed((r && r.why) || tc("Goon 模式未启动", "Goon mode did not start"));
        // the run ended (or another took its place) while Goon mode started
        if ((c.isCurrent && !c.isCurrent(L.id)) || runId !== L.id) { try { g.end({ source: "lockdown" }); } catch (_) {} return { ok: false, why: tc("对局已结束", "the run is over") }; }
        running = true;
        return { ok: true };
      }, (e) => failed((e && e.message) || String(e))).finally(() => { pending = null; });
      return pending;
    }
    // Every way a run ends comes here (end, ended elsewhere, replaced, another
    // tab): Goon mode is ended for the run it was started for.
    function stop() {
      if (!runId) return false;
      const g = api();
      unsubAll();
      runId = null; running = false;
      if (g) { try { g.end({ source: "lockdown" }); } catch (_) {} }
      return true;
    }
    // Each tick: the run gone or replaced ends the toy; Goon mode ended
    // without an event (an older build, a missed one) stops the count.
    function follow(L) {
      if (runId && (!L || L.id !== runId)) return stop();
      if (running) {
        const g = api();
        let s = null;
        try { s = g ? g.state() : null; } catch (_) {}
        if (!g || (s && s.running === false)) running = false;
      }
      return false;
    }
    const live = (L) => running && !!L && L.id === runId;
    const state = () => { const g = api(); try { return g && running ? g.state() : null; } catch (_) { return null; } };
    return { status, start, stop, follow, live, state, get runId() { return runId; } };
  }

  if (window.__LOCKDOWN_I18N_TEST__) {
    window.__LockdownI18nTest = { suiteData, DATA_KEYS, unpack, packConfig, toastKind, toastHost, modalKey, TOAST_MS, routeCheck, enumOf, toGraphQLFilter, spinSchedule, fmtDuration, fmtClock, fmtMinutes,
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
                              conditions, retiredConds, anyCond, retiredIn, retiredNote, presetLine, DEFAULT_SETUP, parseMinutes, stepMinutes, slipText, sceneFilterFor, listUrl, perfKey, keepsListFilter,
                              pickOther, mediaOwner, nextSceneText,
                              PIC_MS, PICS_MAX, PICS_KEEP, picTime, encodeIds, decodeIds, parsePics, picsSet, addPicsChunk, picsText,
                              REC_CHIPS, REC_MIN_SCENES, REC_SPIN, recChipOk, rtOverall, rtFives, recAggregate, recLists, recentPerformers, recShown, weightedPick, recFresh,
                              NEXT_SEL, queueKey, pictureHere,
                              LB_ROWS, LB_MAX, HEAT_MAX, LB_SEGS, monthStart, inPeriod, boardEntry, boardView, mostLockedEntry, keyTarget, boardRecords,
                              scoreLines, heatParts, condChip, howLine, portraitNeeds, portraitQuery, portraitFill, picKey, runPic, lbPicHtml,
                              meterHtml, podiumHtml, recordsHtml, rowHtml2, moreHtml, emptyBoardHtml, boardHtml,
                              // 2.11
                              mergeOne, dropOne, stayCovered, novelty, novNames, suggestNext, NOV_STEP, NOV_MAX, NOV_RUNS,
                              hashStr, mulberry32, dayKey, recDrawKey, recSeenN, recWeights, recDraw, recSeenPrune, recSeenAdd, recSeenPick,
                              recSpinAdd, recShuffle, recWheel, agoText, REC_SHOW, REC_KEEP, REC_PER_STUDIO, REC_WHEEL_SKIP, REC_TOP_OTHERS, REC_RESTS,
                              belongVerdict, backoffMs, endChange, pendingAdd, pendingDrop, syncPlan, syncDecision, pollOwner, pollIntervals,
                              oCheckPlan, oSceneMoved, fetchWithin, SYNC_IDLE_MS, SYNC_LOCKED_MS, SYNC_FOLLOW_MS, SYNC_FULL_MS, OWNER_TTL_MS, GQL_TIMEOUT_MS,
                              // 2.12
                              isSettingsPath, overtimeScored, hiddenTarget, HIDE_LO, HIDE_HI, TOY_SHARE, TOY_STYLES, TOY_PACES, TOY_DEFAULT, TOY_NEEDS,
                              normaliseToy, toyEarned, toyText, edgeHint, liveGoalLabel, goonApi, toyController,
                              // 2.12.1
                              hiddenPast, dragStep, holdSeek, heldSeek, barLinks, SEEK_SLACK, SKIPS_AT,
                              // 2.13.0
                              inputKind, gate0, gateInput, gateLoad, gateUser, loadIsSeek, settling, SETTLE_MS, INPUT_MS, toyLevelPrefs, previewGuardIn, PREVIEW_SEL,
                              EYES_GRACE_MS, EYES_PT_MS, awayAdd, awayPts, awayMsOf, awayNowLock, fmtAway, awayText, goalReached,
                              // 2.14
                              duoOf, duoName, duoMembers, duoIds, setOf, recDuos, mateCards, mateWhy, REC_MATES, DUO_RANDOM,
                              // 2.15
                              deckPick,
                              // 2.16
                              handTick, handPlayHold, handBreakHold, handPlayTag, handReady, tagReadyIn, newHand, normaliseCardTags, HOLD_KINDS,
                              HOLD_DEAL, dealKind, raceDue, handPlayRace, raceWon, RACE_MS, RACE_WIN, RACE_LOSE, RACE_GRACE_MS, RACE_FINISH_AFTER_MS,
                              staysText, raceText, cardsText, handPlaySkip, SKIP_CARD_EVERY_MS, SKIP_CARD_MAX, SKIP_CARD_PTS,
                              CARD_RECHARGE_MS, HOLD_EVERY_MS, HOLD_LASTS_MS, HOLD_HAND, CARD_TAGS_MAX, paceBest, milestonesDue, cancelResult, CANCEL_MS, lastShown,
                              goalHtml, recordsOf,
                              // 2.17
                              tagPic, picAnimated, skipTokens, ownerWord, cardCountText, tagCardStats, bodyTabOk, bodyIds, popPlace, stepStates,
                              dealWords, goalParts, pfHtml, cardPic,
                              // 2.18
                              tagMatches, TAG_MATCH_PTS, TAG_PLAYS_KEEP, paceParts };
    return;
  }

  // 2.12: Toy in charge's one controller for this page (toyController)
  const toyCtl = toyController(goonApi);

  // ═══ Stash ═════════════════════════════════════════════════════════════════

  // 2.11: every request has a time limit (fetchWithin, GQL_TIMEOUT_MS; the
  // recommendations' scene pages 60 s). Suite Data's calls go through here
  // too (the shared client's `o.gql`), so they have it as well.
  async function gql(query, variables, ms) {
    const json = await fetchWithin(async (signal) => {
      const res = await fetch("/graphql", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }), signal,
      });
      try { return await res.json(); }
      catch { throw new Error(`Stash returned ${res.status}${res.status === 401 ? ": logged out?" : ""}`); }
    }, ms || GQL_TIMEOUT_MS);
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
    const duo = duoOf(L);
    const f = duo ? { performers: { value: duo.map((p) => String(p.id)), modifier: "INCLUDES" } }
      : L.kind === "studio" ? { studios: { value: one, modifier: "INCLUDES", depth: -1 } }
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

  // ── 2.9: recommended performers: the data ──────────────────────────────────
  // Read lazily, when the setup opens on performers: one performer list, the
  // library's scenes in pages of 5000 (play count, O's, last played, studio,
  // performers: no query per performer), and Ratings Toolkit's scores when it
  // is installed (through Suite Data, read only). The lists are kept for the
  // session and a day in localStorage (`lockdownRecs`, REC_V), so opening
  // New run again asks Stash nothing. "Update" works them out again (2.11; Shuffle only draws again).
  const REC_KEY = "lockdownRecs";
  let recMem = null, recLoading = null;
  function recCached() {
    const now = Date.now();
    if (recFresh(recMem, now)) return recMem;
    try { const c = JSON.parse(localStorage.getItem(REC_KEY) || "null"); if (recFresh(c, now)) return (recMem = c); } catch (_) {}
    return null;
  }
  function loadRecs(force) {
    if (!force) { const c = recCached(); if (c) return Promise.resolve(c); }
    if (recLoading) return recLoading;
    recLoading = computeRecs().then((c) => {
      recMem = c;
      try { localStorage.setItem(REC_KEY, JSON.stringify(c)); } catch (_) {}
      return c;
    }).finally(() => { recLoading = null; });
    return recLoading;
  }
  async function computeRecs() {
    const [perfs, scenes, fives] = await Promise.all([recPerformers(), recScenes(), recFives()]);
    return { v: REC_V, at: Date.now(), lists: recLists(perfs, recAggregate(scenes), fives, Date.now()), rt: Object.keys(fives).length };
  }
  async function recPerformers() {
    const d = await gql(`query ($x: PerformerFilterType) { findPerformers(performer_filter: $x, filter: { per_page: -1 }) {
                           performers { id name image_path scene_count image_count rating100 favorite tags { id name } } } }`,
                        { x: { scene_count: { modifier: "GREATER_THAN", value: REC_MIN_SCENES - 1 } } });
    return d?.findPerformers?.performers ?? [];
  }
  async function recScenes() {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const d = await gql(`query ($f: FindFilterType) { findScenes(filter: $f) { count
                             scenes { play_count o_counter last_played_at studio { id name } performers { id } } } }`,
                          { f: { per_page: 5000, page, sort: "id", direction: "ASC" } }, 60000);
      const r = d?.findScenes, list = r?.scenes ?? [];
      out.push(...list);
      if (!list.length || out.length >= (r.count || 0)) break;
    }
    return out;
  }
  async function recFives() {
    try {
      const d = await gql(CONFIG_Q, { p: ["RatingsToolkit"] });
      const m = await SD.overlay("RatingsToolkit", d?.configuration?.plugins?.RatingsToolkit || {});
      return rtFives(m.scores, m.criteria);
    } catch (_) { return {}; }
  }

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
    if (duoOf(L)) src.duo = duoMembers(L.duo).map((p) => ({ id: p.id, name: p.name }));
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
  // 2.16/2.17: how many of a run's scenes have each tag: one aliased count
  // query of target ∩ tag (`AND: { tags }` on sceneFilterFor, so a tag
  // lock's own filter is kept). The cards at the start, the setup's counts.
  async function countCardTags(probe, tags, fresh) {
    if (!tags || !tags.length) return [];
    const base = sceneFilterFor(probe, fresh);
    const vars = {};
    tags.forEach((x, i) => { vars[`x${i}`] = { ...base, AND: { tags: { value: [String(x.id)], modifier: "INCLUDES", depth: -1 } } }; });
    const d = await gql(`query (${tags.map((_, i) => `$x${i}: SceneFilterType`).join(", ")}) { ${tags.map((_, i) =>
      `c${i}: findScenes(scene_filter: $x${i}, filter: { per_page: 0 }) { count }`).join(" ")} }`, vars);
    return tags.map((_, i) => (d && d[`c${i}`] && d[`c${i}`].count) || 0);
  }
  // 2.17: a run's tag cards, their scenes (ids) and the tags' pictures, in
  // one query; for the cards' counts ("14 scenes · 9 not shown yet")
  async function cardScenes(L, tags) {
    if (!tags || !tags.length) return { ids: {}, pics: {} };
    const base = sceneFilterFor(L, L.rules && L.rules.fresh);
    const vars = {};
    tags.forEach((x, i) => { vars[`x${i}`] = { ...base, AND: { tags: { value: [String(x.id)], modifier: "INCLUDES", depth: -1 } } }; });
    // the pictures apart: a hand from before 2.17 has none, and a Stash
    // without findTags(ids:) still gets its counts
    const [d, tg] = await Promise.all([
      gql(`query (${tags.map((_, i) => `$x${i}: SceneFilterType`).join(", ")}) { ${tags.map((_, i) =>
        `c${i}: findScenes(scene_filter: $x${i}, filter: { per_page: -1 }) { scenes { id } }`).join(" ")} }`, vars, 60000),
      gql(`query ($t: [ID!]) { findTags(ids: $t, filter: { per_page: -1 }) { tags { id image_path } } }`, { t: tags.map((x) => String(x.id)) }).catch(() => null),
    ]);
    const ids = {}, pics = {};
    tags.forEach((x, i) => { ids[String(x.id)] = ((d && d[`c${i}`] && d[`c${i}`].scenes) || []).map((s) => String(s.id)); });
    for (const t of (tg && tg.findTags && tg.findTags.tags) || []) pics[String(t.id)] = tagPic(t.image_path);
    return { ids, pics };
  }
  // How many scenes a run would have to choose from.
  async function sceneCount(L) {
    const d = await gql(`query ($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: 0 }) { count } }`,
                        { x: sceneFilterFor(L, L.rules && L.rules.fresh) });
    return d?.findScenes?.count ?? 0;
  }

  // { id, only }: a scene other than `notId`, or id null with `only` when
  // `notId` is all there is (2.8.2: it used to hand the current scene back,
  // and Next scene "opened" the page already open, with no word why).
  function pickOther(list, notId) {
    const ids = (list || []).map((s) => String(s.id));
    const other = ids.find((id) => notId == null || id !== String(notId));
    return { id: other || null, only: !other && ids.length > 0 };
  }

  // 2.15: Roulette's deck (user: "do not show the scenes I already watched
  // in the run until I reached the end of the scenes count then it can loop
  // again"; for a duo "swap between their videos and if one has more videos
  // than the other it should distribute the weights so both are seen
  // equally"). A round deals every scene once: a scene opened in the run
  // since its side's round began (its record's `at`, by any path, not only
  // Roulette) is not dealt again until every other one has been; then that
  // side starts a new round (`L.deck[side]` = when it began). A duo has a
  // side per performer: the next scene comes from the one with less
  // watched time in the run (a scene with both counts for both), the one
  // shown longer ago on a tie, so they get equal time whoever has more
  // scenes; the one with fewer starts its next round sooner. Anything else
  // is one side, "all". `all`: [{ id, who: [performer ids] }]; `r` in [0, 1).
  // Returns { id, only, side, deck } (deck: the lock's, changed or not).
  function deckPick(all, L, notId, r, now) {
    const duo = duoOf(L);
    const sides = duo ? duo.map((p) => String(p.id)) : ["all"];
    const scenes = (all || []).filter((x) => x && x.id);
    const recs = (L && L.scenes) || {};
    const deck = { ...((L && L.deck) || {}) };
    const of = (side) => (side === "all" ? scenes : scenes.filter((x) => (x.who || []).includes(side)));
    const shownAt = (id) => { const x = recs[id]; return x ? x.at || x.t0 || 0 : 0; };
    const not = notId == null ? null : String(notId);
    const usable = sides.filter((sd) => of(sd).some((x) => x.id !== not));
    if (!usable.length) return { id: null, only: scenes.length > 0, side: null, deck };
    let side = usable[0];
    if (usable.length > 1) {
      const watched = (sd) => of(sd).reduce((a, x) => a + (recs[x.id] ? watchedSec(rangesOf(recs[x.id])) : 0), 0);
      const last = (sd) => of(sd).reduce((a, x) => Math.max(a, shownAt(x.id)), 0);
      const w = usable.map((sd) => ({ sd, w: watched(sd), t: last(sd) }));
      // within half a minute of each other counts as even
      w.sort((a, b) => (Math.abs(a.w - b.w) > 30 ? a.w - b.w : 0) || a.t - b.t);
      side = w[0].w === w[1].w && w[0].t === w[1].t ? usable[Math.min(usable.length - 1, Math.floor(r * usable.length))] : w[0].sd;
    }
    const since = deck[side] || 0;
    let pool = of(side).filter((x) => x.id !== not && !(shownAt(x.id) && shownAt(x.id) >= since));
    let fresh = false;
    if (!pool.length) {
      deck[side] = now;                 // every scene of this side dealt: a new round
      pool = of(side).filter((x) => x.id !== not);
      fresh = true;
    }
    const pick = pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
    // 2.16: where the round is ("scene 7 of 40 this round")
    const total = of(side).length;
    return { id: pick.id, only: false, side, deck, round: { n: fresh ? 1 : total - pool.length + 1, of: total } };
  }

  // 2.15: Roulette deals from a deck (deckPick): the target's scenes, ids
  // only (and, for a duo, who is in each), read at each pick so a scene
  // added or played (Unwatched only) is taken into account.
  // 2.16: the list is kept a minute (Next scene is instant; the deck itself
  // says what was shown), and with Unwatched only played out the run's own
  // scenes are dealt (`dry`), rather than landing on Galleries unsaid.
  let dealCache = null;
  async function randomScene(L, notId) {
    const duo = duoOf(L), fresh = !!(L.rules && L.rules.fresh), key = `${L.id}|${fresh}`;
    const rows = (d, k) => (d?.[k]?.scenes ?? []).map((x) => ({ id: String(x.id), who: (x.performers || []).map((p) => String(p.id)) }));
    let all = dealCache && dealCache.key === key && Date.now() - dealCache.at < 60000 ? dealCache.all : null;
    if (!all) {
      const d = await gql(`query ($x: SceneFilterType, $f: FindFilterType) { findScenes(scene_filter: $x, filter: $f) {
                             scenes { id${duo ? " performers { id }" : ""} } } }`,
                          { x: sceneFilterFor(L, fresh), f: { per_page: -1 } }, 60000);
      all = rows(d, "findScenes");
      dealCache = { key, at: Date.now(), all };
    }
    let dry = false;
    const mine = Object.keys(L.scenes || {}).filter((id) => /^\d+$/.test(id));
    if (fresh && !all.filter((x) => x.id !== String(notId)).length && mine.length) {
      const d = await gql(`query ($i: [ID!]) { findScenes(ids: $i, filter: { per_page: -1 }) { scenes { id${duo ? " performers { id }" : ""} } } }`, { i: mine });
      all = rows(d, "findScenes");
      dry = true;
    }
    return { ...deckPick(all, L, notId, Math.random(), Date.now()), dry };
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
      if (Object.keys(fresh).length && !(await put(fresh, tc("从插件设置复制", "copied from the plugin settings")))) {
        // another tab copied first: what it wrote stands, the rest goes in
        const left = {};
        Object.keys(fresh).forEach((k) => { if (!S.revs[k]) left[k] = fresh[k]; });
        if (Object.keys(left).length) await put(left, tc("从插件设置复制", "copied from the plugin settings"));
      }
      for (const k of back) {
        const base = S.revs[k], theirs = S.vals[k];
        if (mk.revs && mk.revs[k] === base) {
          await put({ [k]: { value: mine[k], base } }, tc("在 Suite Data 关闭期间更改", "changed while Suite Data was off"));
        } else {
          // both moved on: the store's version stays, the other is a backup
          if (await put({ [k]: { value: mine[k], base } }, tc("保留自插件设置", "kept from the plugin settings")))
            await put({ [k]: { value: theirs, base: S.revs[k] } }, tc("保留存储版本", "store version kept"));
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
      tell(`${name}: ${tc("Suite Data 已关闭", "Suite Data is off")}; ${tc("使用插件设置里的副本", "using the copy in the plugin settings")}${mk.at ? tc(" 自 ", " from ") + new Date(mk.at).toLocaleString() : ""}.`);
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
    return writeMine((mine) => { const cur = unpack(mine); return packConfig(mine, cur, fn(cur) || {}); }, quiet, mirror).then(unpack).then(seenFrom);
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
    try { return seenFrom(unpack(await SD.read())); }
    catch (_) { return { list: [], stats: { ...EMPTY_STATS, perf: {}, wins: {} }, active: undefined, failed: true, presets: [] }; }
  }

  // 2.11 (review M5a): the active lock alone, from Suite Data's store, for
  // the sync: one small `get` with `keys` (as Tasks Toolkit's kitRun reads
  // one key), instead of this plugin's whole config (history, totals,
  // presets, the pictures; 100-200 KB) plus every stored key each 5 s. The
  // shared client (suiteData) is not changed: it stays identical in every
  // plugin. Only while the client is in "store" mode; null means "read it
  // all" (no Suite Data, not answering, or the key not in the store).
  async function readActive() {
    if (SD.mode() !== "store") return null;
    try {
      const d = await gql(`mutation ($a: Map) { runPluginOperation(plugin_id: "SuiteData", args: $a) }`,
                          { a: { mode: "get", plugin: PLUGIN_ID, keys: JSON.stringify(["active"]) } });
      const r = d && d.runPluginOperation;
      const it = r && r.items && r.items.active;
      if (!it || typeof it.rev !== "number") return null;
      return { active: parseActive(it.value) };
    } catch (e) { log(`Light sync read failed: ${e.message}`); return null; }
  }

  // 2.11: the shown-cards store of the recommendations (a UI preference,
  // per browser; anything unreadable is a fresh one)
  const REC_SEEN_KEY = "lockdownRecSeen";
  function recSeenLoad() {
    try { return recSeenPrune(JSON.parse(localStorage.getItem(REC_SEEN_KEY) || "null"), Date.now()); }
    catch (_) { return recSeenPrune(null, Date.now()); }
  }
  function recSeenSave(s) { try { localStorage.setItem(REC_SEEN_KEY, JSON.stringify(s)); } catch (_) {} }

  // 2.11 (review M4): finished runs waiting for their write, per browser
  function pendingRead() {
    try { const v = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => x && x.id && x.done) : []; }
    catch (_) { return []; }
  }
  function pendingWrite(list) {
    try { if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list)); else localStorage.removeItem(PENDING_KEY); }
    catch (e) { log(`Could not keep the finished run: ${e.message}`, "error"); }
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

  // 2.13.0: Toy in charge's old default level, moved once (toyLevelPrefs)
  try { const np = toyLevelPrefs(prefs()); if (np) localStorage.setItem(PREF_KEY, JSON.stringify(np)); } catch (_) {}
  let lock = readState();
  let confirmedId = null;   // the lock id Stash is known to hold
  // 2.9: the pictures earlier runs counted (data key `pics`), from the last read
  let picEarlier = new Set();
  // 2.11: and the history from the last read (the result card's suggestion)
  let lastList = [];
  const seenFrom = (u) => { if (u && u.picsSeen && !u.picsBad) picEarlier = u.picsSeen; if (u && Array.isArray(u.list) && !u.failed) lastList = u.list; return u; };

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

    // See-through panels (2026-10-25, a forum request: a theme with a slideshow
    // of background pictures, covered by the plugins' solid panels). One
    // switch for the whole suite, read from the page: <html data-sx-glass>
    // (Suite Data's setting "See-through panels" sets it) or, without it, the
    // CSS property --sx-glass on <html> (a theme or Stash's Custom CSS:
    // `:root { --sx-glass: 1; }`). Off, absent or 0: nothing changes. On: the
    // surfaces (bg, bg2, slab, ui, raise) are the same colours at that
    // opacity, so the page shows through every panel without a plugin doing
    // anything; text is lifted until it reads 4.5:1 on a panel laid over a
    // mid-grey picture, with a soft shadow for brighter ones; anything with a
    // floating role (dialog, tooltip, menu, listbox, status, alert) or a
    // navigation role (a bar that sticks over the content as it scrolls) keeps
    // solid surfaces, so a popup never shows the page through it.
    //   value: on / 1 / true (GLASS_A), an opacity (0.6 or 60%), off / 0
    const GLASS_A = 0.65, GLASS_KEYS = ["bg", "bg2", "slab", "ui", "raise"];
    const GLASS_TEXT = ["tx", "tx1b", "tx2", "grey", "hi"].concat(Object.keys(HUES).map((h) => h + "-tx"));
    const GLASS_SOLID = '[role="dialog"], [role="alertdialog"], [role="tooltip"], [role="menu"], [role="listbox"], [role="status"], [role="alert"], [role="navigation"]';
    function glassAlpha(v) {
      const s = String(v == null ? "" : v).trim().toLowerCase().replace(/^["']|["']$/g, "");
      if (!s || /^(0|off|no|none|false)$/.test(s)) return 0;
      if (/^(1|on|yes|true)$/.test(s)) return GLASS_A;
      let n = parseFloat(s);
      if (!isFinite(n) || n <= 0) return 0;
      if (/%$/.test(s) || n > 1) n /= 100;
      return Math.round(Math.min(0.95, Math.max(0.35, n)) * 100) / 100;
    }
    // the tokens see-through at opacity a: surfaces as rgba, text fitted against them over mid-grey
    function glassTokens(t, mode, a) {
      const g = Object.assign({}, t), dark = mode !== "light";
      const behind = (k) => hex(over(parse(t[k]).slice(0, 3).concat(a), "#808080"));
      const against = [behind("bg"), behind("ui")];
      GLASS_TEXT.forEach((k) => { if (t[k]) g[k] = fit(t[k], against, 4.5, dark); });
      GLASS_KEYS.forEach((k) => { const c = parse(t[k]); if (c) g[k] = "rgba(" + c.slice(0, 3).map(clamp).join(", ") + ", " + a + ")"; });
      return g;
    }
    function glassCss(t, mode, scope, a) {
      const sc = scope || ":root", is = ":is(" + sc + ")", fl = ":is(" + GLASS_SOLID + ")";
      const shadow = mode === "light" ? "0 0 2px rgba(255,255,255,0.7)" : "0 1px 2px rgba(0,0,0,0.55)";
      const see = tokensCss(glassTokens(t, mode, a), mode, sc).replace(/\n\}$/, "\n  --sx-glass: " + a + ";\n  text-shadow: " + shadow + ";\n}");
      const solid = tokensCss(t, mode, is + fl + ", " + is + " " + fl + ", " + fl + " " + is).replace(/\n\}$/, "\n  text-shadow: none;\n}");
      return see + "\n" + solid;
    }
    // the switch as the page has it now (0 when off)
    function glassOf() {
      try {
        const h = document.documentElement, at = h.getAttribute ? h.getAttribute("data-sx-glass") : null;
        return glassAlpha(at != null && at !== "" ? at : getComputedStyle(h).getPropertyValue("--sx-glass"));
      } catch (_) { return 0; }
    }

    const T = { t: Object.assign({}, FLEX), mode: "flexoki", glass: 0, FLEX, HUES, STASH, parse, hex, over, mix, lum, contrast, fit, derive, tokensCss, glassAlpha, glassTokens, glassCss, GLASS_A };
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
      const g = glassOf();
      const next = (g ? glassCss(r.t, r.mode, o.scope, g) : tokensCss(r.t, r.mode, o.scope)) + (o.extra ? "\n" + o.extra({ t: r.t, mode: r.mode, mix, fit, contrast }) : "");
      T.t = r.t; T.mode = r.mode; T.glass = g;
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
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme", "data-fx-accent", "data-sx-glass"] });
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme"] });
        document.querySelectorAll('link[rel~="stylesheet"]').forEach((n) => { if (!n.sheet) watchLink(n); });
        const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
        if (mq && mq.addEventListener) mq.addEventListener("change", soon);
      } catch (_) {}
      return T;
    };
    return T;
  }
  // Every element Lockdown draws sits under one of these: the nav button,
  // the lock bar and the veil under it, dialogs (their backdrop), the page
  // (.ld-page is also .ld-modal), the Edge card under the bar, the first-lock
  // tip, the toast (moved into a fullscreen player) and, on video.js's
  // timeline, the watched parts and the holder whose tooltip turns blue.
  // The extras are the two see-through hue fills: the Give up hold and a
  // row armed for removal (red), the glows of a landed or won spin and of
  // the watched parts (red, blue); exact with Flexoki on.
  const THEME = suiteTheme({ id: "lockdown",
    scope: ".ld-nav, #ld-bar, #ld-veil, .ld-modal-back, .ld-modal, #ld-over, #ld-tip, #ld-toast, .ld-watched, .vjs-progress-holder[data-ld-free], .ld-holdchip",
    extra: (X) => {
      const fx = X.mode === "flexoki";
      const a = (h, al) => { const n = (i) => parseInt(h.slice(i, i + 2), 16); return "rgba(" + n(1) + "," + n(3) + "," + n(5) + "," + al + ")"; };
      const v = {
        "re55": fx ? "rgba(209,77,65,.55)" : a(X.t.re, 0.55), "re60": fx ? "rgba(209,77,65,.6)" : a(X.t.re, 0.6),
        "re18": fx ? "rgba(209,77,65,.18)" : a(X.t.re, 0.18),
        "bl60": fx ? "rgba(67,133,190,.6)" : a(X.t.bl, 0.6), "bl75": fx ? "rgba(67,133,190,.75)" : a(X.t.bl, 0.75),
      };
      return ".ld-nav, #ld-bar, #ld-veil, .ld-modal-back, .ld-modal, #ld-over, #ld-tip, #ld-toast, .ld-watched, .vjs-progress-holder[data-ld-free] { " +
        Object.keys(v).map((k) => "--ld-" + k + ": " + v[k] + ";").join(" ") + " }";
    } });

  // ═══ Styles ════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("lockdown-styles")) return;
    THEME.start();
    const s = document.createElement("style");
    s.id = "lockdown-styles";
    s.textContent = `
/* Flexoki dark (as Insights). Red #D14D41 is the lock, blue #4385BE an O,
   coral #E8705F a give-up, cyan #3AA99F a timer served. Difficulty runs
   green, yellow, orange, red. Only colours and shadows live here besides
   the enforcement rules, which must not change.
   Colours are suiteTheme tokens (var(--sx-*), --ld-* for the see-through
   fills): these values with Flexoki on, the active theme's otherwise. */
.ld-nav .ld-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--sx-re);
  margin-left: 5px; vertical-align: middle; box-shadow: 0 0 6px var(--sx-re); }
/* The nav button stays Stash's own; only the lock picks up the accent. */
.ld-nav a svg { color: var(--sx-re); width: 1em; height: 1em; }
/* Stash spaces its own Font Awesome nav icons from the label; ours is a plain
   svg, so it needs the gap itself, but only where icon and label share a line */
@media (min-width: 1200px) { .ld-nav .nav-menu-icon { margin-right: .4em; } }
body.ld-on .top-nav { visibility: hidden !important; }
#ld-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 1065; display: flex; align-items: center; gap: 12px;
  padding: 0 14px; background: var(--sx-ui); background: linear-gradient(90deg, color-mix(in srgb, var(--sx-re) 20%, var(--sx-bg2)), var(--sx-ui) 60%);
  border-bottom: 2px solid var(--sx-re);
  color: var(--sx-tx); font-size: 14px; box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 12px 24px -10px rgba(0,0,0,calc(.65*var(--sx-k))); }
#ld-bar .ld-who { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
#ld-bar .ld-who b { font-size: 15px; color: var(--sx-hi); }
#ld-bar .ld-who small { color: var(--sx-tx2); font-size: 12px; margin-left: 4px; }
/* 2.17: the progress group: the time big, "of 30:00 watched", the meter;
   the way out's colour: Finish blue (an O), Timer yellow, Edge cyan */
#ld-bar .ld-prog { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; flex: 0 1 230px; font-variant-numeric: tabular-nums; }
#ld-bar .ld-pgt { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; }
#ld-bar .ld-pgt b { color: var(--sx-hi); font-size: 16px; font-weight: 700; }
#ld-bar .ld-pgt span { color: var(--sx-tx2); font-size: 12px; }
#ld-bar .ld-pgt .ld-pgshort { display: none; }
#ld-bar .ld-prog small { color: var(--sx-tx2); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ld-bar .ld-g-finish b { color: var(--sx-bl-tx); }
#ld-bar .ld-g-timer b { color: var(--sx-ye); }
#ld-bar .ld-g-reached b, #ld-bar .ld-g-over b { color: var(--sx-gr-tx); }
#ld-bar .ld-meter { display: block; width: 100%; height: 6px; border-radius: 3px; background: var(--sx-bg2); overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
#ld-bar .ld-meter i { display: block; height: 100%; background: var(--sx-cy); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
#ld-bar .ld-meter.ld-g-timer i { background: var(--sx-ye); }
#ld-bar .ld-meter.ld-g-reached i, #ld-bar .ld-meter.ld-g-over i { background: var(--sx-gr); }
/* 2.17 (user: "can skips show more visually? like a resource"): the skips
   in a small well, a token a skip: orange left, dashed spent */
#ld-bar .ld-skips { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; flex: none;
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k))); }
#ld-bar .ld-skips[hidden] { display: none; }
#ld-bar .ld-skcap { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--sx-tx2); font-weight: 700; white-space: nowrap; }
#ld-bar .ld-skips.ld-zero .ld-skcap { color: var(--sx-re-tx); }
#ld-bar .ld-sktoks { display: inline-flex; gap: 3px; }
#ld-bar .ld-sktok { width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  background: transparent; border: 1px dashed var(--sx-ui3); color: var(--sx-tx3); }
#ld-bar .ld-sktok.ld-on { background: color-mix(in srgb, var(--sx-or) 26%, var(--sx-ui)); border: 1px solid color-mix(in srgb, var(--sx-or) 60%, transparent); color: var(--sx-or); }
#ld-bar .ld-sktok.ld-bonus.ld-on { border-color: var(--sx-ma); color: var(--sx-ma-tx); background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui)); }
#ld-bar .ld-sktok.ld-xs.ld-on { border-color: var(--sx-cy); color: var(--sx-cy); background: color-mix(in srgb, var(--sx-cy) 22%, var(--sx-ui)); }
#ld-bar .ld-sktok .ld-ico { width: 12px; height: 12px; }
#ld-bar a, #ld-bar button { background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2);
  border-top-color: var(--sx-ui3); color: var(--sx-tx); border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
  padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
/* one row, one height: the theme's and Stash's own link and button rules
   made them tall and wrapped "Random scene" (user screenshot, 2.2) */
#ld-bar .ld-links a, #ld-bar .ld-links button, #ld-bar .ld-giveup { display: inline-flex; align-items: center; justify-content: center;
  height: 30px; min-height: 0; margin: 0; padding: 0 12px; line-height: 1; white-space: nowrap; box-sizing: border-box; }
#ld-bar a:hover, #ld-bar button:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); }
#ld-bar .ld-links { display: flex; align-items: center; gap: 6px; flex: none; }
#ld-bar .ld-giveup { margin-left: 4px; position: relative; overflow: hidden; border-color: var(--sx-re-d); color: var(--sx-re-tx);
  user-select: none; touch-action: none; flex: none; }
#ld-bar .ld-giveup:hover { border-color: var(--sx-re); color: var(--sx-hi); }
#ld-bar .ld-giveup .ld-fill { position: absolute; inset: 0; width: 0; background: var(--ld-re55); }
#ld-bar .ld-giveup span { position: relative; }
/* 2.5: Play pictures (Slideshow); cyan is play across the suite */
#ld-bar .ld-pics .ld-ico { width: 14px; height: 14px; color: var(--sx-cy); margin-right: 6px; flex: none; }
@media (max-width: 760px) {
  #ld-bar { gap: 8px; padding: 0 8px; font-size: 13px; }
  #ld-bar .ld-links .ld-more { display: none; }
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
  #ld-bar .ld-links .ld-pics, #ld-bar .ld-picn { display: none; }
  #ld-bar .ld-links a, #ld-bar .ld-links button, #ld-bar .ld-giveup { padding: 0 8px; }
}
#ld-veil { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1064; background: var(--sx-bg); display: none; }
/* Every card stays invisible until it is known to belong to the target, so
   a list that somehow widens never shows anything else. */
body.ld-on .scene-card:not(.ld-ok), body.ld-on .image-card:not(.ld-ok),
body.ld-on .gallery-card:not(.ld-ok), body.ld-on .wall-item:not(.ld-ok),
body.ld-on li:has(> .queue-scene-details):not(.ld-ok),
body.ld-on li:has(.queue-scene-details):not(.ld-ok) { visibility: hidden !important; }
body.ld-on .ld-no { display: none !important; }
body.ld-checking #ld-veil { display: block; }
.ld-modal-back { position: fixed; inset: 0; z-index: 1070; background: rgba(0,0,0,calc(.65*var(--sx-k))); display: flex;
  align-items: center; justify-content: center; }
.ld-modal { width: 540px; max-width: calc(100vw - 24px); max-height: calc(100vh - 32px); overflow-y: auto;
  background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-radius: 12px; color: var(--sx-tx); padding: 16px 18px;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k))); scrollbar-color: var(--sx-ui3) transparent; }
.ld-modal h3 { margin: 0 0 4px; font-size: 19px; color: var(--sx-hi); }
.ld-modal .ld-sub { color: var(--sx-tx2); font-size: 13px; margin-bottom: 14px; }
.ld-modal button, .ld-modal select { font: inherit; font-size: 14px; border-radius: 8px; }
.ld-modal .ld-err { color: var(--sx-ye); font-size: 12px; min-height: 1.2em; margin-top: 6px; }
.ld-modal .ld-hist { border-top: 1px solid var(--sx-ui3); margin-top: 12px; padding-top: 12px; font-size: 12px; color: var(--sx-tx1b); }
.ld-modal .ld-empty { color: var(--sx-tx2); text-align: center; padding: 6px 0; }
/* the suite's empty state: a raised card, one bold line and one muted line */
.ld-emptycard { margin: 8px 0; padding: 18px 16px; border-radius: 12px; text-align: center; color: var(--sx-tx2); font-size: 13px; line-height: 1.5;
  background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 12px 24px -10px rgba(0,0,0,calc(.65*var(--sx-k))); }
.ld-emptycard b { display: block; color: var(--sx-hi); font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.ld-emptycard span { display: block; }
/* loading: what is read, over Insights' thin sliding bar */
.ld-loading { padding: 40px 0; text-align: center; color: var(--sx-tx2); font-size: 13px; }
.ld-lbar { width: 260px; max-width: 80%; height: 6px; margin: 14px auto 0; background: var(--sx-bg2); border-radius: 3px; overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
.ld-lbar i { display: block; width: 40%; height: 100%; background: var(--sx-re); border-radius: 3px; animation: ldSlide 1.1s ease-in-out infinite; }
@keyframes ldSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.ld-notice { margin: 8px 0; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; color: var(--sx-tx);
  background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-left: 3px solid var(--sx-re); }
.ld-ico { width: 16px; height: 16px; flex: none; vertical-align: middle; }
.ld-drop path { fill: var(--sx-bl); }
.ld-drop .ld-shine { fill: none; stroke: rgba(255,255,255,.75); stroke-width: 1.1; stroke-linecap: round; }
.ld-x path { fill: none; stroke: var(--sx-re-tx); stroke-width: 2.4; stroke-linecap: round; }
.ld-clock circle, .ld-clock path { fill: none; stroke: var(--sx-cy); stroke-width: 1.8; stroke-linecap: round; }
.ld-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.ld-tile { background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 8px; padding: 8px 6px 7px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k)));
  text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
.ld-tile .ld-ico { width: 18px; height: 18px; margin-bottom: 1px; }
.ld-tile b { font-size: 17px; color: var(--sx-hi); font-variant-numeric: tabular-nums; line-height: 1.15; }
.ld-tile span { font-size: 10.5px; color: var(--sx-tx2); line-height: 1.25; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 100%; }
.ld-wins { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 8px; font-size: 11px; color: var(--sx-tx2); }
.ld-wins .ld-long { margin-left: auto; }
.ld-pill { font-size: 11px; padding: 0 7px; border-radius: 6px; border: 1px solid var(--sx-ui3); color: var(--sx-tx1b);
  white-space: nowrap; line-height: 17px; }
.ld-d-easy { color: var(--sx-gr); border-color: color-mix(in srgb, var(--sx-gr) 45%, transparent); }
.ld-d-normal { color: var(--sx-ye); border-color: color-mix(in srgb, var(--sx-ye) 45%, transparent); }
.ld-d-hard { color: var(--sx-or); border-color: color-mix(in srgb, var(--sx-or) 45%, transparent); }
.ld-d-hardcore { color: var(--sx-re); border-color: color-mix(in srgb, var(--sx-re) 45%, transparent); }
.ld-d-custom { color: var(--sx-pu); border-color: color-mix(in srgb, var(--sx-pu) 45%, transparent); }
.ld-strip { display: flex; flex-wrap: wrap; gap: 3px; margin: 10px 0 2px; }
.ld-strip .ld-ico { width: 14px; height: 14px; }
.ld-total { font-size: 11px; color: var(--sx-tx2); margin: 6px 0 4px; }
.ld-rows { display: flex; flex-direction: column; gap: 2px; }
.ld-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; }
.ld-row:hover { background: var(--sx-ui2); }
.ld-row.gaveup .ld-rname { color: var(--sx-tx1b); }
/* 2.17: .ld-av holds the sources' icons; pictures are portraits (.ld-pf) */
.ld-av { flex: none; display: inline-flex; }
.ld-lbduo { position: absolute; inset: 0; display: flex; }
.ld-lbduo > .ld-lbphoto, .ld-lbduo > .ld-lbinit { position: relative; inset: auto; flex: 1 1 50%; min-width: 0; width: 50%; height: 100%; }
.ld-lbduo > * + * { border-left: 2px solid var(--sx-bg2); }
.ld-rmain { flex: 1; min-width: 0; }
.ld-rname { display: block; color: var(--sx-tx); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-rname small { color: var(--sx-tx2); font-size: 11px; margin-left: 4px; }
.ld-rsub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; margin-top: 2px; }
.ld-rsub em { font-style: normal; color: var(--sx-tx2); font-size: 11px; }
.ld-rend { text-align: right; flex: none; }
.ld-rtime { display: block; font-variant-numeric: tabular-nums; color: var(--sx-tx1b); }
.ld-row.gaveup .ld-rtime { color: var(--sx-re-tx); }
.ld-rwhen { display: block; color: var(--sx-tx2); font-size: 11px; }
.ld-more { margin-top: 6px; width: 100%; padding: 5px; background: none; border: 1px dashed var(--sx-ui3);
  border-radius: 6px; color: var(--sx-tx2); font: inherit; font-size: 12px; cursor: pointer; }
.ld-more:hover { color: var(--sx-hi); border-color: var(--sx-tx3); }
.ld-modal .ld-close { margin-top: 12px; width: 100%; padding: 7px; background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui));
  color: var(--sx-tx2); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); cursor: pointer; }
.ld-modal .ld-close:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); }
.ld-spin { text-align: center; padding: 10px 0 4px; }
.ld-spin img, .ld-spin video { width: 150px; height: 225px; border-radius: 14px; object-fit: cover; border: 3px solid var(--sx-ui3);
  background: var(--sx-bg2); box-shadow: 0 12px 24px -10px rgba(0,0,0,calc(.65*var(--sx-k))); }
.ld-spin .ld-name { font-size: 22px; font-weight: 700; margin-top: 12px; min-height: 1.3em; color: var(--sx-hi); }
.ld-spin.ld-landed img, .ld-spin.ld-landed video { border-color: var(--sx-re); box-shadow: 0 0 24px var(--ld-re60); }
.ld-spin.ld-won img, .ld-spin.ld-won video { border-color: var(--sx-bl); box-shadow: 0 0 24px var(--ld-bl60); }
.ld-spin .ld-msg { color: var(--sx-tx2); font-size: 13px; margin-top: 6px; min-height: 1.2em; }

.ld-modal.ld-tall { max-height: calc(100vh - 32px); }
.ld-modal .ld-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.ld-modal .ld-head h3 { display: flex; align-items: center; gap: 7px; margin: 0; }
.ld-lock { width: 19px; height: 19px; }
.ld-lock rect { fill: var(--sx-re); }
.ld-lock path { stroke: var(--sx-re); stroke-width: 1.6; }
.ld-modal .ld-link { background: none; border: 0; padding: 0; color: var(--sx-bl-tx); font: inherit; font-size: 13px;
  cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.ld-modal .ld-head .ld-link:first-of-type { margin-left: auto; }
.ld-modal .ld-link:hover { text-decoration: underline; color: var(--sx-bl-tx); }
.ld-modal .ld-danger { color: var(--sx-re-tx); }
.ld-modal .ld-danger.ld-armed { color: var(--sx-on); background: var(--sx-re); background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d));
  border-radius: 6px; padding: 2px 8px; font-weight: 600; text-decoration: none; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-guide { background: var(--sx-ui); background: color-mix(in srgb, var(--sx-bl) 10%, var(--sx-bg2));
  border: 1px solid color-mix(in srgb, var(--sx-bl) 35%, transparent); border-radius: 8px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  padding: 10px 12px; margin-bottom: 12px; font-size: 13px; color: var(--sx-tx); }
.ld-guide ol { margin: 6px 0 4px; padding-left: 20px; line-height: 1.6; }
.ld-guide .ld-link { display: block; margin-left: auto; }
.ld-card { background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 10px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.35*var(--sx-k))); padding: 11px 12px; margin-bottom: 8px; }
.ld-step { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--sx-tx2); margin-bottom: 8px; }
.ld-step i { width: 19px; height: 19px; border-radius: 50%; background: var(--sx-ui2); color: var(--sx-tx); font-style: normal;
  font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
.ld-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.ld-choices.ld-four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.ld-choice { text-align: left; padding: 8px 10px; background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
  border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); cursor: pointer; min-width: 0; }
.ld-choice:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); }
.ld-choice b { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
.ld-choice small { display: block; color: var(--sx-tx2); font-size: 11.5px; margin-top: 1px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.ld-choice .ld-ico { width: 16px; height: 16px; color: var(--sx-tx2); }
.ld-choice.ld-on { border-color: var(--sx-re); background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-re) 16%, var(--sx-ui));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
.ld-choice.ld-on .ld-ico { color: var(--sx-re); }
.ld-seg { display: inline-flex; gap: 2px; padding: 2px; margin-top: 9px; background: var(--sx-bg); border: 1px solid var(--sx-ui2);
  border-radius: 8px; }
.ld-seg button { background: none; border: 0; color: var(--sx-tx2); padding: 4px 12px; font-size: 13px; cursor: pointer; }
.ld-seg button.ld-on { background: var(--sx-ui3); color: var(--sx-hi); }
.ld-seg.ld-mini { margin-top: 0; }
.ld-seg.ld-mini button { padding: 2px 9px; font-size: 12px; }
.ld-opts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 9px; font-size: 13px; }
.ld-opts small { color: var(--sx-tx2b); font-size: 12px; }
.ld-stepper { display: inline-flex; align-items: center; border: 1px solid var(--sx-ui3); border-radius: 7px; overflow: hidden; }
.ld-stepper button { background: var(--sx-ui); border: 0; border-radius: 0; color: var(--sx-tx1b); width: 26px; padding: 2px 0;
  font-size: 15px; cursor: pointer; }
.ld-stepper button:hover { color: var(--sx-hi); background: var(--sx-ui2); }
.ld-stepper b { font-weight: 600; font-size: 13px; padding: 2px 10px; min-width: 64px; text-align: center;
  font-variant-numeric: tabular-nums; color: var(--sx-hi); }
.ld-fine { margin-top: 8px; }
.ld-fine summary { font-size: 12px; color: var(--sx-tx2); cursor: pointer; }
.ld-fine summary:hover { color: var(--sx-tx); }
.ld-frow { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px; }
.ld-frow > span { flex: 1; min-width: 0; }
.ld-frow small { color: var(--sx-tx2b); font-size: 12px; margin-left: 4px; }
.ld-sw { flex: none; width: 26px; height: 15px; border-radius: 8px; background: var(--sx-ui3); position: relative; border: 0;
  cursor: pointer; padding: 0; }
.ld-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%;
  background: var(--sx-tx2); transition: left .15s; }
.ld-sw.ld-on { background: var(--sx-re); }
.ld-sw.ld-on::after { left: 13px; background: var(--sx-paper); }
.ld-search { position: relative; margin-top: 8px; }
.ld-search .ld-ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--sx-tx2); }
.ld-search input { width: 100%; box-sizing: border-box; background: var(--sx-bg); color: var(--sx-tx); border: 1px solid var(--sx-deep);
  border-bottom-color: var(--sx-ui2); box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k)));
  border-radius: 8px; padding: 8px 10px 8px 32px; font: inherit; font-size: 14px; outline: none; }
.ld-search input::placeholder { color: var(--sx-tx2b); }
.ld-search input:focus { border-color: var(--sx-re); }
.ld-search.ld-small { flex: 0 1 150px; margin: 0 0 0 auto; }
.ld-search.ld-small input { padding: 5px 8px 5px 28px; font-size: 12px; }
.ld-results { margin-top: 4px; }
/* a short list, so a search doesn't push the rest of the setup off screen */
.ld-page .ld-results { max-height: 260px; overflow-y: auto; }
/* 2.17: but not the chosen card and who goes well with them */
.ld-page .ld-results:has(.ld-chosen) { max-height: none; overflow: visible; }
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
.ld-res:hover, .ld-res.ld-hi { background: var(--sx-ui); }
.ld-res.ld-sel { border-color: var(--sx-re); background: var(--sx-ui); background: color-mix(in srgb, var(--sx-re) 12%, var(--sx-ui)); color: var(--sx-hi); }
.ld-res .ld-rname { flex: 1; }
.ld-res .ld-rmeta { color: var(--sx-tx2); font-size: 12px; }
.ld-res .ld-tick { color: var(--sx-re); visibility: hidden; font-weight: 700; }
.ld-res.ld-sel .ld-tick { visibility: visible; }
.ld-hint { color: var(--sx-tx2); font-size: 12px; padding: 6px 2px; }
.ld-srcs { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.ld-srcs .ld-res .ld-ico { color: var(--sx-tx2); }
.ld-srcs .ld-res.ld-cant { opacity: .55; }
.ld-brief { display: flex; align-items: center; gap: 12px; margin-top: 4px; padding: 11px 12px; border-radius: 10px;
  background: var(--sx-ui); background: color-mix(in srgb, var(--sx-re) 12%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-re) 40%, var(--sx-deep)); }
.ld-brief > div { flex: 1; min-width: 0; font-size: 13px; line-height: 1.5; color: var(--sx-hi); }
.ld-brief > div small { display: block; color: var(--sx-tx1b); font-size: 12px; }
.ld-modal .ld-start { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; font-size: 15px;
  font-weight: 600; color: var(--sx-on); background: var(--sx-re); background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d));
  border: 1px solid var(--sx-line2); box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 2px 6px rgba(0,0,0,calc(.5*var(--sx-k))); cursor: pointer; }
.ld-modal .ld-start:hover { filter: brightness(1.08); }
.ld-modal .ld-start .ld-ico rect { fill: var(--sx-bg); }
.ld-modal .ld-start .ld-ico path { stroke: var(--sx-bg); }
.ld-foot { font-size: 11px; color: var(--sx-tx2b); text-align: center; margin-top: 8px; }
.ld-modal .ld-foot .ld-soundbtn { font-size: 11px; display: inline; }
.ld-hhead { display: flex; align-items: center; margin-bottom: 8px; }
.ld-hhead b { font-size: 14px; color: var(--sx-hi); }
.ld-hhead .ld-link { margin-left: auto; }
.ld-crown path { fill: var(--sx-ye); }
.ld-flame path { fill: var(--sx-or); }
.ld-tile.ld-tname b { font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-rbtn { background: none; border: 0; color: var(--sx-tx2); cursor: pointer; padding: 0 2px; font: inherit; font-size: 12px;
  visibility: hidden; min-width: 18px; white-space: nowrap; }
.ld-row:hover .ld-rbtn, .ld-row.ld-confirm .ld-del { visibility: visible; }
.ld-again:hover { color: var(--sx-bl-tx); }
.ld-del:hover { color: var(--sx-re-tx); }
.ld-row.ld-confirm { background: var(--ld-re18); }
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
.ld-row.ld-confirm .ld-del { color: var(--sx-on); background: var(--sx-re); background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d));
  border-radius: 6px; padding: 2px 8px; font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-all { margin-top: 8px; }
.ld-filters { display: flex; align-items: center; gap: 6px; margin: 10px 0 6px; flex-wrap: wrap; }
.ld-filters .ld-sep { width: 1px; align-self: stretch; background: var(--sx-ui3); margin: 2px 2px; }
.ld-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--sx-bg2); border: 1px solid var(--sx-deep);
  border-bottom-color: var(--sx-ui2); color: var(--sx-tx1b);
  border-radius: 8px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.ld-chip:hover { color: var(--sx-hi); }
.ld-chip .ld-ico { width: 12px; height: 12px; }
.ld-chip.ld-on { background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-re) 22%, var(--sx-ui2));
  border-color: color-mix(in srgb, var(--sx-re) 50%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); color: var(--sx-hi); }
.ld-month { display: flex; align-items: center; font-size: 11px; color: var(--sx-tx2); padding: 12px 6px 4px;
  border-bottom: 1px solid var(--sx-ui3); margin-bottom: 2px; }
.ld-month .ld-mcount { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; }
.ld-month .ld-ico { width: 11px; height: 11px; }
.ld-back { background: none; border: 0; color: var(--sx-tx1b); font: inherit; font-size: 18px; cursor: pointer; padding: 0 4px 0 0; }
.ld-back:hover { color: var(--sx-hi); }
#ld-tip { position: fixed; left: 50%; transform: translateX(-50%); z-index: 1066; max-width: min(560px, calc(100vw - 32px));
  background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px); border: 1px solid var(--sx-re);
  border-radius: 12px; padding: 9px 12px; color: var(--sx-tx); font-size: 13px;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k))); }
#ld-tip button { margin-left: 8px; background: var(--sx-re); background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d));
  border: 1px solid var(--sx-line2); color: var(--sx-on); border-radius: 8px; padding: 3px 10px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
#ld-toast { position: fixed; left: 50%; top: 60px; transform: translateX(-50%); z-index: 1080;
  max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box; padding: 9px 14px; color: var(--sx-tx); font-size: 13px; line-height: 1.45;
  background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-left: 3px solid var(--c, var(--sx-ye)); border-radius: 12px;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k)));
  opacity: 0; pointer-events: none; transition: opacity .2s; }
#ld-toast.ld-show { opacity: 1; }
#ld-toast.ld-act { pointer-events: auto; display: flex; align-items: center; gap: 12px; }
#ld-toast .ld-tact { flex: none; padding: 4px 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
  color: var(--sx-or); background: color-mix(in srgb, var(--sx-or) 16%, var(--sx-ui)); border: 1px solid color-mix(in srgb, var(--sx-or) 55%, transparent); }
#ld-toast .ld-tact:hover { background: color-mix(in srgb, var(--sx-or) 26%, var(--sx-ui)); }
#ld-toast.ld-t-info { --c: var(--sx-bl); }
#ld-toast.ld-t-done { --c: var(--sx-gr); }
#ld-toast.ld-t-warn { --c: var(--sx-ye); }
#ld-toast.ld-t-error { --c: var(--sx-re); }
/* The Lockdown page reuses the dialog's styles (.ld-modal) without its box. */
.ld-modal.ld-page { width: auto; max-width: 1180px; max-height: none; overflow: visible; margin: 24px auto 48px;
  padding: 18px 18px 28px; background: var(--sx-bg); border: 1px solid var(--sx-deep); border-top-color: var(--sx-slab); border-radius: 16px;
  box-shadow: 0 20px 50px -20px rgba(0,0,0,calc(.7*var(--sx-k))); box-sizing: border-box; }
.ld-pagehead { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.ld-ptitle { display: flex; align-items: baseline; gap: 4px 12px; flex-wrap: wrap; min-width: 0; }
.ld-psub { color: var(--sx-tx2); font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.ld-pagehead h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 22px; font-weight: 700; color: var(--sx-hi); }
.ld-pagehead h2 .ld-lock { width: 22px; height: 22px; }
.ld-tabs { display: flex; gap: 4px; margin-left: auto; padding: 4px; border-radius: 11px;
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: inset 0 2px 4px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-modal .ld-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: none;
  border: 1px solid transparent; color: var(--sx-tx1b); padding: 6px 13px; border-radius: 8px; font-size: 14px; cursor: pointer; white-space: nowrap; }
.ld-tabs button .ld-ico { color: var(--tc); opacity: .75; }
.ld-tabs button:hover { color: var(--sx-hi); }
.ld-modal .ld-tabs button.ld-on { color: var(--sx-hi); background: var(--sx-ui2); background: color-mix(in srgb, var(--tc) 24%, var(--sx-ui));
  border-color: color-mix(in srgb, var(--tc) 55%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,calc(.4*var(--sx-k))); }
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
.ld-runcard { background: var(--sx-ui); background: color-mix(in srgb, var(--sx-re) 10%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-re) 40%, var(--sx-deep));
  border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; }
.ld-rcwho { display: flex; align-items: center; gap: 12px; margin: 4px 0 10px; }
.ld-rcwho b { display: block; font-size: 16px; color: var(--sx-hi); }
.ld-rcwho small { display: block; color: var(--sx-tx1b); font-size: 12.5px; }
.ld-rcchips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
.ld-rcchips .ld-pill { font-size: 11.5px; line-height: 20px; display: inline-flex; align-items: center; gap: 4px; }
.ld-rcchips .ld-pill .ld-ico { width: 13px; height: 13px; }
.ld-rcmult { display: flex; align-items: baseline; gap: 8px; padding: 9px 12px; border-radius: 8px; background: var(--sx-bg); }
.ld-rcmult span { flex: 1; color: var(--sx-tx2); }
.ld-rcmult b { font-size: 24px; color: var(--sx-ye); font-variant-numeric: tabular-nums; }
.ld-rcformula { color: var(--sx-tx2); font-size: 12px; line-height: 1.55; margin: 8px 0 10px; }
.ld-rcformula b { color: var(--sx-tx); font-weight: 600; }
.ld-runcard .ld-start { width: 100%; justify-content: center; }
.ld-blue { color: var(--sx-bl) !important; }
.ld-gold { color: var(--sx-ye) !important; }
.ld-coral { color: var(--sx-re-tx) !important; }
/* 2.13.0: Eyes on screen never broken, a green chip on the result card */
.ld-clean { display: inline-block; padding: 1px 9px; border-radius: 6px; font-size: 12px; font-weight: 600;
  color: var(--sx-gr-tx); border: 1px solid color-mix(in srgb, var(--sx-gr) 50%, transparent);
  background: color-mix(in srgb, var(--sx-gr) 14%, transparent); }
.ld-bonus { font-style: normal; color: var(--sx-ye); font-size: 12px; margin-left: auto; padding-right: 6px; }
.ld-frow > span .ld-ico { width: 14px; height: 14px; color: var(--sx-tx2); margin-right: 3px; vertical-align: -2px; }
.ld-scorepill { color: var(--sx-ye); border-color: color-mix(in srgb, var(--sx-ye) 45%, transparent); font-variant-numeric: tabular-nums; }
.ld-live { max-width: 720px; }
.ld-live .ld-tiles { margin: 8px 0 12px; }
.ld-live .ld-lvgo { width: auto; margin: 4px 0 8px; }
.ld-live .ld-lvrow { display: flex; flex-wrap: wrap; gap: 8px; }
.ld-live .ld-lvpics[hidden] { display: none; }
.ld-modal .ld-start.ld-lvpics { color: var(--sx-tx); background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border-top-color: var(--sx-ui3);
  box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-modal .ld-start.ld-lvpics:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); filter: none; }
.ld-modal .ld-start.ld-lvpics .ld-ico path { stroke: var(--sx-cy); }
.ld-live .ld-foot { text-align: left; }
.ld-endico .ld-ico { width: 40px; height: 40px; }
.ld-score { background: var(--sx-bg2); border: 1px solid var(--sx-ui2); border-radius: 10px; padding: 10px 12px; margin-top: 10px; font-size: 13px; }
.ld-score > div { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
.ld-score .ld-mline { border-top: 1px solid var(--sx-ui2); margin-top: 4px; padding-top: 6px; color: var(--sx-tx1b); }
.ld-score .ld-total { font-size: 16px; }
.ld-score .ld-total b { font-size: 18px; }
.ld-score .ld-place { justify-content: center; color: var(--sx-ye); font-size: 12.5px; }
.ld-score .ld-place:empty { display: none; }
.ld-suggest { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 10px;
  padding: 8px 12px; border-radius: 10px; background: var(--sx-bg2); border: 1px dashed var(--sx-ui3); font-size: 13px; color: var(--sx-tx1b); }
.ld-suggest small { color: var(--sx-tx2); }
.ld-suggest .ld-ico { width: 13px; height: 13px; vertical-align: -2px; color: var(--sx-or); }
.ld-recfoot .ld-recago { margin-left: 6px; color: var(--sx-tx2); }
.ld-novline { color: var(--sx-cy-tx); }
.ld-heatsum { margin-left: 6px; color: var(--sx-or); font-weight: 700; display: inline-flex; align-items: center; gap: 3px; }
.ld-heatsum .ld-ico { width: 13px; height: 13px; }
.ld-clearheat { margin-left: auto; font-size: 12px !important; }
.ld-conds { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
.ld-cond { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto 30px; gap: 10px; align-items: center; padding: 8px 9px;
  border-radius: 8px; border: 1px solid transparent; cursor: pointer; user-select: none; }
.ld-cond:hover { background: var(--sx-ui); }
.ld-cond.ld-on { background: var(--sx-ui); background: color-mix(in srgb, var(--sx-or) 10%, var(--sx-bg2)); border-color: color-mix(in srgb, var(--sx-or) 35%, transparent); }
.ld-condico .ld-ico { width: 18px; height: 18px; color: var(--sx-tx2); }
.ld-cond.ld-on .ld-condico .ld-ico { color: var(--sx-or); }
.ld-condtxt b { font-weight: 600; color: var(--sx-hi); font-size: 13.5px; }
.ld-condtxt em { font-style: normal; color: var(--sx-or); font-size: 12.5px; margin-left: 8px; }
.ld-condtxt small { display: block; color: var(--sx-tx2); font-size: 11.5px; line-height: 1.35; margin-top: 1px; }
.ld-pips { display: inline-flex; gap: 5px; }
.ld-modal .ld-pip { width: 13px; height: 13px; padding: 0; border-radius: 50%; border: 1.5px solid var(--sx-tx3); background: none; cursor: pointer; }
.ld-modal .ld-pip:hover { border-color: var(--sx-or); }
.ld-modal .ld-pip.ld-on { background: var(--sx-or); border-color: var(--sx-or); }
.ld-noheat { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--sx-ui2); }
.ld-noheat > span { color: var(--sx-tx2); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.ld-noheat small { color: var(--sx-tx2b); font-size: 11.5px; }
.ld-nhchip { display: inline-flex; align-items: center; gap: 6px; background: var(--sx-bg2); color: var(--sx-tx1b); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
  border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 13px; }
.ld-nhchip i { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid var(--sx-tx3); flex: none; }
.ld-nhchip.ld-on { color: var(--sx-hi); }
.ld-nhchip.ld-on i { background: var(--sx-re); border-color: var(--sx-re); }
.ld-nhchip .ld-ico { width: 14px; height: 14px; }
.ld-tagpick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 2px; }
.ld-tagchip { display: inline-flex; align-items: center; gap: 4px; background: var(--sx-ui2); color: var(--sx-hi); border-radius: 8px; padding: 3px 4px 3px 10px; font-size: 13.5px; }
.ld-tagchip button { background: none; border: 0; color: var(--sx-tx2); cursor: pointer; font-size: 15px; padding: 0 4px; }
.ld-tagchip button:hover { color: var(--sx-re-tx); }
.ld-tagjoin { color: var(--sx-re); font-size: 11px; font-weight: 700; text-transform: uppercase; }
/* 2.3: presets above the setup, saving one under Start */
.ld-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
.ld-presets:empty { display: none; }
.ld-plabel { color: var(--sx-tx2); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-right: 4px; }
.ld-preset { display: inline-flex; align-items: center; background: var(--sx-ui); border: 1px solid var(--sx-line); border-top-color: var(--sx-ui3); border-radius: 8px; overflow: hidden; }
.ld-pplay { background: none; border: 0; color: var(--sx-hi); font-size: 13.5px; padding: 4px 6px 4px 12px; cursor: pointer; }
.ld-pplay:hover { color: var(--sx-paper); text-decoration: underline; text-underline-offset: 2px; }
.ld-pdel { background: none; border: 0; color: var(--sx-tx2); font-size: 14px; padding: 4px 10px 4px 4px; cursor: pointer; }
.ld-pdel:hover { color: var(--sx-re-tx); }
.ld-pdel.ld-armed { font-size: 12px; font-weight: 600; color: var(--sx-on); background: var(--sx-re); background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d));
  padding: 4px 10px; margin-left: 2px; border-radius: 0; }
.ld-pdel.ld-armed:hover { color: var(--sx-on); }
.ld-psave { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 8px; }
.ld-pname { flex: 1 1 auto; min-width: 0; background: var(--sx-bg); color: var(--sx-tx); border: 1px solid var(--sx-deep); border-radius: 8px; padding: 5px 9px; font-size: 13.5px; }
.ld-pname:focus { outline: none; border-color: var(--sx-re); }
/* 2.3: a target with images only has no conditions */
.ld-condsoff .ld-cond, .ld-condsoff .ld-noheat { opacity: .35; pointer-events: none; }
.ld-ionote { margin: 0 0 8px; }
.ld-rmeta i { color: var(--sx-tx2); font-style: normal; }
.ld-tagmore { color: var(--sx-tx2b); font-size: 12px; }
.ld-rcwho.ld-hero { gap: 16px; align-items: center; }
.ld-rcwho.ld-hero b { font-size: 20px; }
/* 2.16: how the score works, folded */
.ld-howscore { margin-top: 6px; }
.ld-howscore summary { cursor: pointer; color: var(--sx-bl-tx, var(--sx-bl)); font-size: 12.5px; list-style: none; }
.ld-howscore summary::-webkit-details-marker { display: none; }
.ld-howscore summary::before { content: "▸ "; }
.ld-howscore[open] summary::before { content: "▾ "; }
.ld-howscore > div { margin-top: 6px; }
.ld-rcbest { color: var(--sx-tx1b); }
/* 2.16: the setup's tag cards */
.ld-cardtags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.ld-cardtags .ld-plabel { margin-right: 2px; }
.ld-cardnote { flex-basis: 100%; margin: 2px 0 0; font-size: 11.5px; }
/* 2.16: the bar's pace and milestones, the hand */
#ld-bar .ld-pace { font-size: 12px; color: var(--sx-tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 240px; }
#ld-bar .ld-pace.ld-up { color: var(--sx-ye); font-weight: 600; }
#ld-bar .ld-pace.ld-flash { color: var(--sx-hi); font-weight: 600; animation: ld-flashin .5s ease-out; }
@keyframes ld-flashin { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
#ld-bar .ld-handbtn { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 9px; margin: 0; flex: none;
  border-radius: 8px; border: 1px solid var(--sx-line); background: var(--sx-ui); color: var(--sx-tx1b); cursor: pointer; }
#ld-bar .ld-handbtn.ld-hasready { color: var(--sx-hi); border-color: color-mix(in srgb, var(--sx-cy) 60%, var(--sx-line)); }
#ld-bar .ld-handbtn .ld-ico { width: 16px; height: 16px; }
#ld-bar .ld-handn { font-size: 12px; min-width: 8px; }
/* 2.17 (user: it showed at the top right): right under the cards button
   (placeHand sets left, top and the notch), fixed in the window */
#ld-bar .ld-handpop { position: fixed; top: 60px; right: 10px; z-index: 1070; width: min(340px, calc(100vw - 16px)); box-sizing: border-box;
  background: var(--sx-bg2); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-radius: 12px; padding: 12px;
  box-shadow: var(--sx-float); max-height: calc(100vh - 80px); overflow-y: auto; scrollbar-color: var(--sx-ui3) transparent; }
#ld-bar .ld-handpop::before { content: ""; position: absolute; top: -7px; left: var(--notch, 290px); width: 12px; height: 12px; transform: rotate(45deg);
  background: var(--sx-bg2); border-left: 1px solid var(--sx-edge); border-top: 1px solid var(--sx-edge); }
#ld-bar .ld-handpop[hidden] { display: none; }
.ld-pcs { display: flex; flex-direction: column; gap: 6px; }
.ld-pc { position: relative; display: flex; align-items: center; gap: 10px; text-align: left; width: 100%; box-sizing: border-box; padding: 8px 10px;
  border-radius: 10px; border: 1px solid var(--sx-line); background: var(--sx-ui); color: var(--sx-tx); font: inherit; cursor: pointer; overflow: hidden; }
.ld-pc:hover:not([disabled]) { border-color: var(--sx-ui3); background: var(--sx-ui2); }
.ld-pc[disabled] { opacity: .55; cursor: default; }
.ld-pc > span:last-of-type { display: flex; flex-direction: column; min-width: 0; }
.ld-pc b { color: var(--sx-hi); font-size: 13.5px; font-weight: 600; }
.ld-pc small { color: var(--sx-tx2); font-size: 11.5px; }
.ld-pcico { flex: none; display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 8px;
  background: color-mix(in srgb, var(--sx-cy) 18%, var(--sx-ui)); color: var(--sx-cy); }
.ld-pctag .ld-pcico { background: color-mix(in srgb, var(--sx-ma) 18%, var(--sx-ui)); color: var(--sx-ma); }
.ld-pcico .ld-ico { width: 16px; height: 16px; }
.ld-pc.ld-pcon { border-color: color-mix(in srgb, var(--sx-cy) 60%, var(--sx-line)); cursor: default; }
.ld-pcbar { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--sx-cy); }
.ld-handfoot { margin: 8px 0 0; font-size: 11.5px; }
.ld-handpage { margin: 12px 0; }
.ld-handhead { display: flex; align-items: center; gap: 6px; color: var(--sx-tx2); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 6px; }
.ld-handpage .ld-pcs { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
/* 2.16: the run page's way out, big; pace; the round */
.ld-lvgoal { margin: 12px 0 4px; padding: 12px 14px; border-radius: 12px; background: var(--sx-bg2); border: 1px solid var(--sx-deep);
  font-size: 18px; color: var(--sx-hi); font-variant-numeric: tabular-nums; }
.ld-lvgoal:empty { display: none; }
.ld-lvgoal small { font-size: 13px; color: var(--sx-tx2); }
.ld-lvgoal .ld-meter { display: block; height: 8px; margin-top: 8px; width: 100%; border-radius: 6px; background: var(--sx-ui3); overflow: hidden; }
.ld-lvgoal .ld-meter i { display: block; height: 100%; background: var(--sx-cy); }
.ld-lvpace { color: var(--sx-ye); font-size: 13px; min-height: 18px; margin: 0 2px 6px; }
.ld-lvround { color: var(--sx-tx2); font-size: 12px; text-align: center; margin-top: 6px; }
.ld-lvround:empty { display: none; }
.ld-lvalt { background: var(--sx-ui2) !important; color: var(--sx-tx) !important; }
.ld-otlater { margin-left: auto; }
/* 2.16: the result card: records, the run's scenes, Same setup again */
.ld-recchips { display: flex; justify-content: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.ld-recchips:empty { display: none; }
.ld-recchip { padding: 3px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--sx-ye);
  background: color-mix(in srgb, var(--sx-ye) 14%, var(--sx-ui)); border: 1px solid color-mix(in srgb, var(--sx-ye) 40%, transparent); }
.ld-storybox:empty { display: none; }
.ld-storyhead { color: var(--sx-tx2); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin: 12px 0 4px; }
.ld-story { margin: 0; padding-left: 22px; font-size: 13px; color: var(--sx-tx2); max-height: 190px; overflow: auto; }
.ld-story li { padding: 2px 0; }
.ld-story li span { float: right; font-variant-numeric: tabular-nums; color: var(--sx-tx2); margin-left: 8px; }
.ld-story .ld-storymore { list-style: none; color: var(--sx-tx2b); }
.ld-resbtns { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.ld-resbtns .ld-close { margin: 0; flex: 1; }
.ld-resbtns .ld-link { white-space: nowrap; flex: none; }
/* 2.16: History as a table */
.ld-htable { width: 100%; border-collapse: collapse; font-size: 13px; }
.ld-htable th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--sx-tx2);
  padding: 6px 8px; border-bottom: 1px solid var(--sx-line); white-space: nowrap; }
.ld-htable td { padding: 7px 8px; border-bottom: 1px solid var(--sx-deep); vertical-align: middle; }
.ld-htable tr.ld-row { display: table-row; }
.ld-htable tr.ld-row:hover td { background: var(--sx-ui2); }
.ld-htable tr.ld-row.ld-confirm td { background: var(--ld-re18); }
.ld-htable .ld-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ld-htable .ld-hmonth th { padding-top: 16px; color: var(--sx-tx2); text-transform: none; letter-spacing: 0; font-size: 12px; border-bottom-color: var(--sx-line); }
.ld-htable .ld-hmonth .ld-mcount { float: right; font-weight: 400; }
.ld-hwho { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ld-hname { display: flex; flex-direction: column; min-width: 0; }
.ld-hname b { color: var(--sx-hi); font-weight: 600; }
.ld-hname small, .ld-hname .ld-moments { color: var(--sx-tx2); font-size: 11.5px; display: block; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 440px; }
@media (max-width: 640px) { .ld-hname small, .ld-hname .ld-moments { max-width: 46vw; } }
.ld-hico .ld-ico { width: 16px; height: 16px; }
.ld-hwhen { white-space: nowrap; color: var(--sx-tx2); }
.ld-hgave { color: var(--sx-re-tx); }
.ld-hact { white-space: nowrap; text-align: right; }
.ld-htable tr.ld-row:hover .ld-rbtn, .ld-htable tr.ld-row.ld-confirm .ld-del { visibility: visible; }
@media (max-width: 640px) { .ld-htable .ld-hopt { display: none; } .ld-htable td, .ld-htable th { padding: 6px 4px; } }
/* 2.14: a duo's chips carry their faces; Pair with someone and who goes well with them */
.ld-tagchip .ld-pf { margin-left: -6px; }
.ld-pairrow { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 6px 2px 2px; }
.ld-pairrow .ld-hint { margin: 0; }
.ld-matehead { color: var(--sx-tx2); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin: 10px 2px 6px; }
.ld-tagmode { display: flex; align-items: center; gap: 10px; margin: 2px 2px 4px; }
.ld-tagmode .ld-hint { margin: 0; }
.ld-timebox input.ld-time { width: 92px; text-align: center; background: var(--sx-bg2); color: var(--sx-hi); border: 0; font: inherit; font-weight: 600; padding: 4px 6px; outline: none; }
.ld-timebox input.ld-time:focus { box-shadow: inset 0 0 0 1px var(--sx-re); }
.ld-condheat { text-align: right; color: var(--sx-tx2b); font-variant-numeric: tabular-nums; font-weight: 600; }
.ld-cond.ld-on .ld-condheat { color: var(--sx-or); }
.ld-rcheat { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; background: var(--sx-bg); margin-bottom: 10px; }
.ld-rcheat .ld-bigflame .ld-ico { width: 30px; height: 30px; }
.ld-rcheat b { display: block; font-size: 26px; line-height: 1; color: var(--sx-or); font-variant-numeric: tabular-nums; }
.ld-rcheat small { color: var(--sx-tx2); font-size: 11.5px; }
.ld-rcheat .ld-grow { flex: 1; }
.ld-rcheat .ld-rcx { text-align: right; }
.ld-rcheat .ld-rcx b { color: var(--sx-ye); font-size: 20px; }
.ld-heatpill { color: var(--sx-or); border-color: color-mix(in srgb, var(--sx-or) 45%, transparent); display: inline-flex; align-items: center; gap: 3px; }
.ld-heatpill .ld-ico { width: 11px; height: 11px; }
.ld-condpill { color: var(--sx-hi); }
.ld-condpill .ld-ico { color: var(--sx-or); }
.ld-score .ld-mline .ld-ico { width: 13px; height: 13px; vertical-align: -2px; }
.ld-drop path { fill: var(--sx-bl); }
/* The parts of a scene watched in this lock, on video.js's progress bar. */
.ld-watched { position: absolute; inset: 0; pointer-events: none; }
.ld-watched i { position: absolute; top: 0; bottom: 0; min-width: 3px; background: var(--sx-bl);
  box-shadow: 0 0 4px var(--ld-bl75); }
/* Hovering the timeline: the time tooltip turns blue where a click is free
   (watched, or close enough to snap onto a watched part). */
.video-js .vjs-progress-holder[data-ld-free="1"] .vjs-mouse-display .vjs-time-tooltip,
.video-js .vjs-progress-holder[data-ld-free="1"] .vjs-time-tooltip { background: var(--sx-bl) !important; color: var(--sx-on) !important; }
/* While locked the bar reads blue = watched, grey = not, the dot = here: the
   played-so-far fill would cover the watched parts behind the playhead. */
body.ld-on .video-js .vjs-play-progress { background: transparent !important; }
/* 2.13.0 (user): No fast-forward hides the frames ahead too: the sprite
   picture over the timeline on hover (Stash's vttThumbnails plugin, which
   shows it by inline opacity and background) and the scrubber strip under
   the player. The time tooltip stays: a time shows no picture. Also set
   inline by previewGuard, in case a later Stash draws them its own way. */
body.ld-noff .video-js .vjs-vtt-thumbnail-display, body.ld-noff .scrubber-wrapper {
  display: none !important; opacity: 0 !important; background: none !important; }
@media (max-width: 560px) {
  .ld-choices.ld-four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ld-choice small { white-space: normal; }
  .ld-brief { flex-direction: column; align-items: stretch; }
}
/* 2.6: Edge overtime. Cyan is Edge's colour (the bar's goal, its meter):
   the card says the target is reached and the score banked, Keep going is
   the cyan primary, Finish / Stop overtime the plain button. The card sits
   under the bar like the first-lock tip (#ld-over), or on the run page. */
.ld-otcard { background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-left: 3px solid var(--sx-cy); border-radius: 12px;
  padding: 12px 14px; margin: 4px 0 12px; color: var(--sx-tx); font-size: 13px; line-height: 1.5;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 12px 24px -10px rgba(0,0,0,calc(.65*var(--sx-k))); }
.ld-otcard .ld-othead { display: flex; align-items: center; gap: 8px; }
.ld-otcard .ld-othead b { font-size: 15px; color: var(--sx-hi); font-variant-numeric: tabular-nums; }
.ld-otcard .ld-othead .ld-ico { width: 18px; height: 18px; color: var(--sx-cy); fill: var(--sx-cy); flex: none; }
.ld-otcard .ld-otbank { margin-top: 4px; color: var(--sx-tx1b); }
.ld-otcard .ld-otbank b { font-size: 18px; margin-left: 6px; font-variant-numeric: tabular-nums; }
.ld-otcard p { margin: 6px 0 10px; color: var(--sx-tx2); font-size: 12.5px; }
.ld-otcard .ld-otbtns { display: flex; flex-wrap: wrap; gap: 8px; }
.ld-otcard .ld-otmeter { height: 6px; border-radius: 6px; margin-top: 8px; overflow: hidden;
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-otcard .ld-otmeter i { display: block; height: 100%; width: 0; background: var(--sx-cy); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-otcard .ld-start { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px; font: inherit; font-size: 14px;
  font-weight: 600; border-radius: 8px; cursor: pointer; border: 1px solid var(--sx-line2); }
.ld-otcard .ld-start.ld-otgo, .ld-modal .ld-start.ld-otgo { color: var(--sx-on); background: var(--sx-cy); background: linear-gradient(180deg, var(--sx-cy), var(--sx-cy-d));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 2px 6px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-otcard .ld-start.ld-otfin, .ld-modal .ld-start.ld-otfin { color: var(--sx-tx); background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui));
  border-top-color: var(--sx-ui3); box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-otcard .ld-start:hover { filter: brightness(1.08); }
#ld-over { position: fixed; right: 14px; z-index: 1066; width: min(400px, calc(100vw - 28px)); }
#ld-over .ld-otcard { margin: 0; box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k))); }
#ld-bar .ld-otbar { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
#ld-bar .ld-otbar button { display: inline-flex; align-items: center; justify-content: center; height: 30px; min-height: 0; margin: 0;
  padding: 0 12px; line-height: 1; white-space: nowrap; box-sizing: border-box; }
#ld-bar .ld-otbar .ld-otgo { color: var(--sx-on); font-weight: 600; background: var(--sx-cy); background: linear-gradient(180deg, var(--sx-cy), var(--sx-cy-d));
  border-top-color: var(--sx-cy-tx); }
#ld-bar .ld-otbar .ld-otgo:hover { color: var(--sx-on); filter: brightness(1.08); }
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
.ld-moments { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin-top: 3px; font-size: 12px; color: var(--sx-tx1b); }
.ld-moments .ld-ico { width: 13px; height: 13px; color: var(--sx-ma); flex: none; }
.ld-moments a.ld-mlink { color: var(--sx-hi); text-decoration: none; border-bottom: 1px dotted var(--sx-tx2); }
.ld-moments a.ld-mlink:hover { color: var(--sx-ma-l); border-bottom-color: var(--sx-ma); }
.ld-moments > i { color: var(--sx-tx2b); font-style: normal; }
.ld-resmoments { background: var(--sx-bg2); border: 1px solid var(--sx-ui2); border-radius: 10px; padding: 8px 12px; margin-top: 10px; }
.ld-resmoments .ld-moments { margin: 0; font-size: 12.5px; }
.ld-live [data-a="lvmoments"] .ld-moments { margin: -4px 0 10px; }
.ld-spin .ld-msg.ld-otline { color: var(--sx-cy); font-variant-numeric: tabular-nums; }
.ld-spin .ld-msg.ld-note { color: var(--sx-tx1b); }
/* 2.12: a full overtime holds the lock (green: banked); the hidden target's
   hint and its reveal; Toy in charge (magenta, the suite's intimate colour):
   the bar's Start the toy, the run page's card, the setup's pickers, and the
   condition shown off without Intiface Sync 1.49 */
#ld-bar .ld-otfull { color: var(--sx-gr-tx); white-space: nowrap; }
#ld-bar .ld-otfull small { color: var(--sx-tx2); font-size: 12px; }
#ld-bar .ld-hint3 { color: var(--sx-tx2); font-size: 12px; margin-left: 4px; }
.ld-spin .ld-msg.ld-reveal { color: var(--sx-hi); }
.ld-spin .ld-msg.ld-reveal b { color: var(--sx-cy); }
#ld-bar .ld-toybtn .ld-ico { width: 14px; height: 14px; color: var(--sx-ma); margin-right: 6px; flex: none; }
#ld-bar .ld-toybtn { border-color: var(--sx-ma-d); }
@media (max-width: 760px) {
  #ld-bar .ld-toybtn { padding: 0 9px; }
  #ld-bar .ld-toybtn span { display: none; }
  #ld-bar .ld-toybtn .ld-ico { margin-right: 0; }
}
.ld-toycard { background: var(--sx-bg2); border: 1px solid var(--sx-ui2); border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; }
.ld-toycard.ld-on { border-color: color-mix(in srgb, var(--sx-ma) 45%, transparent); }
.ld-toycard .ld-toyhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ld-toycard .ld-toyhead b { color: var(--sx-hi); }
.ld-toycard .ld-toyhead span { color: var(--sx-tx2); font-size: 12.5px; }
.ld-toycard .ld-ico { width: 15px; height: 15px; color: var(--sx-ma); flex: none; }
.ld-toycard p { margin: 4px 0 0; color: var(--sx-tx1b); font-size: 12.5px; }
.ld-toycard p.ld-toynums { color: var(--sx-tx2); font-variant-numeric: tabular-nums; }
.ld-toycard .ld-toyact { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.ld-toycard .ld-toygo { display: inline-flex; align-items: center; gap: 7px; }
.ld-hint.ld-toyno { color: var(--sx-ye-tx); }
.ld-toyopts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 9px 10px 41px; font-size: 12.5px; color: var(--sx-tx1b); }
.ld-toyopts select { margin-left: 4px; font: inherit; color: var(--sx-tx); background: var(--sx-bg2); border: 1px solid var(--sx-ui2); border-radius: 8px; padding: 3px 6px; }
.ld-toyopts .ld-toyst { flex-basis: 100%; margin: 0; }
.ld-cond.ld-condna { opacity: .6; cursor: not-allowed; }
.ld-condtxt em.ld-na { color: var(--sx-tx2); }
@media (max-width: 576px) { .ld-toyopts { padding-left: 9px; } }
/* 2.9: pictures viewed; the recommended performers; the player's Next scene */
#ld-bar .ld-picn { color: var(--sx-bl-tx); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
#ld-bar .ld-picn:empty { display: none; }
/* 2.12.1: Stash settings (a cog, its name in the title) and, under 760 px,
   a "..." menu with every link of the bar; under 600 px the links are only
   there, so Give up stays on a 375 px phone with Start the toy */
#ld-bar .ld-links a.ld-gear { padding: 0 8px; }
#ld-bar .ld-gear .ld-ico, #ld-bar .ld-menubtn .ld-ico { width: 15px; height: 15px; flex: none; }
#ld-bar .ld-links .ld-menubtn { display: none; padding: 0 8px; }
#ld-bar .ld-barmenu { position: absolute; top: calc(100% + 4px); right: 8px; min-width: 180px; z-index: 2; display: flex; flex-direction: column;
  padding: 4px; background: var(--sx-ui); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 10px;
  box-shadow: 0 10px 24px -6px rgba(0,0,0,calc(.7*var(--sx-k))); }
#ld-bar .ld-barmenu[hidden] { display: none; }
#ld-bar .ld-barmenu a { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 0; background: none; box-shadow: none;
  border-radius: 7px; color: var(--sx-tx); font-size: 13.5px; }
#ld-bar .ld-barmenu a:hover, #ld-bar .ld-barmenu a:focus-visible { background: var(--sx-ui2); color: var(--sx-hi); }
#ld-bar .ld-barmenu .ld-ico { width: 15px; height: 15px; color: var(--sx-tx2); }
@media (max-width: 760px) { #ld-bar .ld-links .ld-menubtn { display: inline-flex; } }
@media (min-width: 761px) { #ld-bar .ld-barmenu { display: none; } }
@media (max-width: 600px) { #ld-bar .ld-links a { display: none; } }
@media (max-width: 480px) { #ld-bar .ld-gulong { display: none; } }
@media (max-width: 340px) { #ld-bar .ld-bwho { display: none; } }
.ld-rpics { display: block; margin-top: 2px; font-size: 11px; color: var(--sx-bl-tx); }
.ld-lvpicn { color: var(--sx-bl-tx); font-size: 13px; margin: -4px 0 8px; font-variant-numeric: tabular-nums; }
.ld-lvpicn:empty { display: none; }
.ld-recs { margin-top: 12px; border-top: 1px solid var(--sx-ui2); padding-top: 10px; }
.ld-rechead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.ld-rechead .ld-plabel { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--sx-tx2); margin-right: 2px; }
.ld-rechead .ld-filters { margin: 0; }
.ld-reclist { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px; }
.ld-reccard { display: flex; align-items: center; gap: 10px; text-align: left; padding: 6px 8px; border-radius: 8px; cursor: pointer;
  background: var(--sx-bg2); border: 1px solid var(--sx-ui2); color: var(--sx-tx); font: inherit; min-width: 0; }
.ld-reccard:hover, .ld-reccard:focus-visible { border-color: var(--sx-ui3); background: var(--sx-ui); outline: none; }
.ld-reccard.ld-sel { border-color: var(--sx-re); background: color-mix(in srgb, var(--sx-re) 12%, var(--sx-ui)); }
.ld-reccard > span:last-child { display: flex; flex-direction: column; min-width: 0; }
.ld-reccard b { color: var(--sx-hi); font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-reccard small { color: var(--sx-tx2); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-recs .ld-hint .ld-link { font-size: 12px; }
.video-js .ld-vjsnext { cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.video-js .ld-vjsnext svg { pointer-events: none; }
/* 2.10: the leaderboard (Hall of fame). Gold, silver and bronze are
   Flexoki yellow, the light greys and dark orange through the tokens;
   Stash's own font, weight and size for the drama. Text on pictures sits on
   a fixed dark scrim in light text, so it reads on any picture and theme. */
.ld-lb { --ld-gold: var(--sx-ye); --ld-gold-l: var(--sx-ye-l); --ld-gold-d: var(--sx-ye-d);
  --ld-silver: var(--sx-tx1b); --ld-silver-l: var(--sx-hi); --ld-silver-d: var(--sx-tx2);
  --ld-bronze: var(--sx-or-d); --ld-bronze-l: var(--sx-or-tx); --ld-bronze-d: var(--sx-or-d);
  display: flex; flex-direction: column; gap: 22px; color: var(--sx-tx); font-size: 14px; line-height: 1.43; }
.ld-lbic { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.ld-lb button, .ld-lb a { font: inherit; color: inherit; }
.ld-lbhead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ld-lbkicker, .ld-lbcapt { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; color: var(--sx-tx2); }
.ld-lbkicker { color: var(--sx-ye-tx); }
.ld-modal .ld-lbtitle { margin: 2px 0; font-size: 30px; font-weight: 800; color: var(--sx-hi); letter-spacing: -.01em; line-height: 1.15; }
.ld-lbsubl { font-size: 13px; color: var(--sx-tx2); }
.ld-lbctl { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.ld-lbchips2 { display: flex; gap: 6px; flex-wrap: wrap; }
.ld-lb .ld-lbchip { display: inline-flex; align-items: center; gap: 6px; background: var(--sx-bg2); color: var(--sx-tx1b); border: 1px solid var(--sx-deep);
  border-bottom-color: var(--sx-ui2); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; min-height: 34px; }
.ld-lbchip b { font-variant-numeric: tabular-nums; color: var(--sx-tx2); font-weight: 600; }
.ld-lb .ld-lbchip:hover { color: var(--sx-hi); }
.ld-lb .ld-lbchip.ld-on { color: var(--sx-hi); background: color-mix(in srgb, var(--sx-re) 22%, var(--sx-ui2)); border-color: color-mix(in srgb, var(--sx-re) 55%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.ld-lbchip.ld-on b { color: var(--sx-hi); }
.ld-lbpers { display: flex; gap: 4px; padding: 3px; border-radius: 10px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.ld-lb .ld-lbper { background: none; border: 1px solid transparent; color: var(--sx-tx1b); border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.ld-lb .ld-lbper:hover { color: var(--sx-hi); }
.ld-lb .ld-lbper.ld-on { color: var(--sx-hi); background: color-mix(in srgb, var(--sx-ye) 24%, var(--sx-ui)); border-color: color-mix(in srgb, var(--sx-ye) 55%, transparent); }
.ld-lb .ld-lbchip:focus-visible, .ld-lb .ld-lbper:focus-visible, .ld-lb .ld-lbrow:focus-visible, .ld-lb .ld-lbbtn:focus-visible, .ld-lbpc:focus-visible
  { outline: 2px solid var(--sx-bl); outline-offset: 2px; }
/* way-out badges: Finish green, Timer cyan, Edge magenta */
.ld-lbway { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; border-radius: 6px; padding: 2px 8px; white-space: nowrap; border: 1px solid;
  --w: var(--sx-gr); --wt: var(--sx-gr-tx); }
.ld-lbway.ld-way-timer { --w: var(--sx-cy); --wt: var(--sx-cy-tx); }
.ld-lbway.ld-way-edge { --w: var(--sx-ma); --wt: var(--sx-ma-tx); }
.ld-lbway { color: var(--wt); background: color-mix(in srgb, var(--w) 16%, var(--sx-bg2)); border-color: color-mix(in srgb, var(--w) 45%, transparent); }
.ld-lbway.ld-onpic { color: var(--sx-paper); background: rgba(16,15,15,.85); border-color: var(--w); }
.ld-lbway.ld-onpic::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--w); }
.ld-lbcond { font-size: 11px; color: var(--sx-tx1b); background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
  border-radius: 6px; padding: 1px 7px; white-space: nowrap; }
/* the heat meter: one segment a point of heat, as long as the most heat a run can have */
.ld-lbheat { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ld-lbheat .ld-lbflame { color: var(--sx-or-tx); }
.ld-lbheat b { font-size: 13px; color: var(--sx-hi); font-weight: 600; }
.ld-lbheat em { font-style: normal; margin-left: auto; font-size: 13px; font-weight: 700; color: var(--sx-or-tx); font-variant-numeric: tabular-nums; }
.ld-lbmeter { display: flex; gap: 2px; }
.ld-lbmeter i { width: 7px; height: 12px; border-radius: 2px; background: var(--sx-ui3); }
.ld-lbmeter i.ld-on { background: linear-gradient(180deg, var(--sx-or-tx), var(--sx-re)); }
.ld-lbmeter i.ld-half { background: linear-gradient(90deg, var(--sx-or) 50%, var(--sx-ui3) 50%); }
/* the podium, 2-1-3 on stepped plinths */
.ld-lbpod { padding-top: 26px; border-radius: 14px; background: radial-gradient(ellipse 60% 70% at 50% 35%, color-mix(in srgb, var(--ld-gold) 13%, transparent), transparent 70%); }
.ld-lbpodrow { display: flex; justify-content: center; align-items: flex-end; gap: 26px; }
.ld-lbstep { display: flex; flex-direction: column; }
.ld-lbpc { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 12px; cursor: pointer; box-sizing: border-box;
  background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px); border: 1px solid var(--sx-line); border-radius: 12px 12px 0 0; box-shadow: var(--sx-sh); }
.ld-lbpc.ld-p1 { width: 316px; border-top: 2px solid var(--ld-gold);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ld-gold) 35%, transparent), 0 30px 80px -30px color-mix(in srgb, var(--ld-gold) 45%, transparent), var(--sx-sh); }
.ld-lbpc.ld-p2 { width: 262px; border-top: 2px solid var(--ld-silver); }
.ld-lbpc.ld-p3 { width: 262px; border-top: 2px solid var(--ld-bronze); }
.ld-lbpc.ld-latest { outline: 1px solid color-mix(in srgb, var(--sx-bl) 70%, transparent); }
.ld-lbpc.ld-open { background: var(--sx-ui2); }
.ld-lbpic { position: relative; width: 100%; aspect-ratio: 2 / 3; border-radius: 9px; overflow: hidden; border: 1px solid var(--sx-deep); background: var(--sx-bg2); box-sizing: border-box; }
.ld-lbphoto { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center top; display: block; }
.ld-lbinit { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 800; color: var(--sx-hi);
  background: linear-gradient(165deg, color-mix(in srgb, var(--h) 80%, var(--sx-bg2)) 0%, var(--sx-bg2) 82%); font-size: 26px; }
.ld-lbpic .ld-lbinit { font-size: 96px; padding-bottom: 40px; }
/* a studio's logo on a light plate; a tag as a big lettered card */
.ld-lbplate { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 6px 4px; box-sizing: border-box;
  background: linear-gradient(165deg, var(--sx-ui2), var(--sx-bg)); }
.ld-lbplate img, .ld-lbplate b { width: 100%; box-sizing: border-box; border-radius: 5px; background: linear-gradient(180deg, #F2F0E5, #DAD8CE);
  box-shadow: 0 4px 12px rgba(0,0,0,calc(.45*var(--sx-k))), inset 0 1px 0 #FFF; }
.ld-lbplate img { max-height: 60%; object-fit: contain; padding: 6px 4px; display: block; }
.ld-lbplate b { color: #161514; font-size: 8px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; text-align: center; padding: 10px 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-lbplate.ld-big { flex-direction: column; padding: 18px; }
.ld-lbplate.ld-big img, .ld-lbplate.ld-big b { border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,calc(.6*var(--sx-k))), inset 0 1px 0 #FFF; }
.ld-lbplate.ld-big img { max-height: 40%; padding: 26px 18px 34px; }
.ld-lbplate.ld-big b { font-size: 17px; letter-spacing: .16em; padding: 30px 14px 38px; white-space: normal; }
.ld-lbplate.ld-big small { margin-top: -26px; font-size: 9.5px; letter-spacing: .3em; font-weight: 600; color: #161514; opacity: .7; text-transform: uppercase; position: relative; }
.ld-lbtag { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 4px; text-align: center; box-sizing: border-box;
  background: repeating-linear-gradient(135deg, rgba(255,255,255,.03) 0 12px, transparent 12px 24px), linear-gradient(165deg, color-mix(in srgb, var(--sx-pu-d) 55%, var(--sx-bg2)), var(--sx-bg2)); }
.ld-lbtag b { font-size: 13px; line-height: 1.05; font-weight: 800; color: var(--sx-hi); overflow-wrap: break-word; max-width: 100%; }
.ld-lbtag.ld-big { align-items: flex-start; text-align: left; padding: 22px 22px 80px; gap: 10px; }
.ld-lbtag.ld-big small { font-size: 11px; letter-spacing: .24em; color: var(--sx-tx1b); font-weight: 700; text-transform: uppercase; }
.ld-lbtag.ld-big b { font-size: 40px; line-height: 1.02; letter-spacing: -.02em; }
.ld-lbcap { position: absolute; left: 0; right: 0; bottom: 0; padding: 40px 14px 12px; background: linear-gradient(180deg, transparent, rgba(16,15,15,.92)); }
.ld-lbcap b { display: block; font-size: 20px; font-weight: 700; color: var(--sx-paper); line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-lbcap span { font-size: 12px; color: rgba(255,252,240,.75); }
.ld-lbmedal { position: absolute; left: 10px; top: 10px; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  font-weight: 800; font-size: 20px; color: var(--sx-on); border: 2px solid rgba(16,15,15,.6); box-shadow: 0 4px 12px rgba(0,0,0,calc(.6*var(--sx-k))), inset 0 2px 0 rgba(255,255,255,.35);
  background: radial-gradient(circle at 35% 30%, var(--ld-silver-l), var(--ld-silver) 60%, var(--ld-silver-d)); }
.ld-p1 .ld-lbmedal { width: 54px; height: 54px; font-size: 24px; background: radial-gradient(circle at 35% 30%, var(--ld-gold-l), var(--ld-gold) 60%, var(--ld-gold-d)); }
.ld-p3 .ld-lbmedal { background: radial-gradient(circle at 35% 30%, var(--ld-bronze-l), var(--ld-bronze) 60%, var(--ld-bronze-d)); }
.ld-lbpic .ld-lbway { position: absolute; right: 10px; top: 12px; }
.ld-lbpb, .ld-lbnew { font-size: 11px; font-weight: 700; border-radius: 6px; padding: 2px 8px; white-space: nowrap; }
.ld-lbpb { position: absolute; left: 10px; top: 72px; color: var(--sx-on); background: var(--ld-gold-l); }
.ld-lbnew { color: var(--sx-on); background: var(--sx-bl); }
.ld-lbpic .ld-lbnew { position: absolute; right: 10px; top: 42px; }
.ld-lbscore { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ld-lbscore b { font-size: 36px; font-weight: 800; color: var(--sx-hi); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -.02em; }
.ld-p1 .ld-lbscore b { font-size: 46px; color: var(--sx-ye-tx); }
.ld-lbscore span { font-size: 12px; color: var(--sx-tx2); }
.ld-lbhow { font-size: 12.5px; color: var(--sx-tx1b); line-height: 1.45; border-top: 1px solid var(--sx-ui2); padding-top: 10px; }
.ld-lbplinth { display: flex; align-items: flex-start; justify-content: center; border-radius: 0 0 12px 12px; font-weight: 800; font-variant-numeric: tabular-nums;
  border: 1px solid var(--sx-deep); border-top: 0; height: 40px; font-size: 28px; color: var(--ld-bronze-l);
  background: linear-gradient(180deg, color-mix(in srgb, var(--ld-bronze) 22%, var(--sx-bg2)), var(--sx-bg2)); }
.ld-s1 .ld-lbplinth { height: 92px; font-size: 44px; color: var(--ld-gold); background: linear-gradient(180deg, color-mix(in srgb, var(--ld-gold) 26%, var(--sx-bg2)), var(--sx-bg2)); }
.ld-s2 .ld-lbplinth { height: 60px; font-size: 34px; color: var(--ld-silver); background: linear-gradient(180deg, color-mix(in srgb, var(--ld-silver) 18%, var(--sx-bg2)), var(--sx-bg2)); }
.ld-lbdots { display: none; justify-content: center; gap: 6px; margin-top: 6px; }
.ld-lbdots i { width: 8px; height: 8px; border-radius: 50%; background: var(--sx-ui3); transition: width .15s; }
.ld-lbdots i.ld-on { width: 22px; border-radius: 3px; background: var(--ld-gold); }
/* the empty board: dashed spots where the podium will stand */
.ld-lbempty { display: flex; flex-direction: column; align-items: center; gap: 26px; padding: 26px 0 8px; }
.ld-lbghost { width: 262px; height: 300px; border-radius: 12px 12px 0 0; border: 1px dashed var(--sx-ui3); border-bottom: 0; box-sizing: border-box;
  background: color-mix(in srgb, var(--sx-bg2) 60%, transparent); display: flex; align-items: center; justify-content: center; color: var(--sx-tx2); font-size: 44px; font-weight: 800; }
.ld-lbghost.ld-g1 { width: 316px; height: 380px; border-color: color-mix(in srgb, var(--ld-gold) 45%, transparent); color: color-mix(in srgb, var(--ld-gold) 70%, var(--sx-bg2)); }
.ld-lbghost .ld-lbic { width: 54px; height: 54px; stroke-width: 1; }
.ld-s3 .ld-lbghost { height: 260px; }
.ld-lbempty .ld-lbplinth { background: var(--sx-bg2); }
.ld-lbetext { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
.ld-lbetext b { font-size: 17px; color: var(--sx-hi); }
.ld-lbetext span { font-size: 13px; color: var(--sx-tx2); max-width: 470px; }
.ld-lb .ld-lbbtn { display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
  border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 8px; padding: 7px 13px; font-size: 13px; box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
  cursor: pointer; text-decoration: none; min-height: 36px; box-sizing: border-box; }
.ld-lb .ld-lbbtn:hover { color: var(--sx-hi); text-decoration: none; }
.ld-lb .ld-lbbtn.ld-pri { background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d)); color: var(--sx-on); font-weight: 600; font-size: 14px; min-height: 40px; margin-top: 10px; }
/* records */
.ld-lbrec { display: flex; flex-direction: column; gap: 10px; }
.ld-lbtiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.ld-lbtile { display: flex; gap: 12px; align-items: center; padding: 14px 16px; border-radius: 12px; min-width: 0;
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: var(--sx-well); }
.ld-lbtile > span:last-child { min-width: 0; }
.ld-lbtile b { display: block; font-size: 22px; font-weight: 800; color: var(--sx-hi); line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-lbtile small { display: block; font-size: 12px; color: var(--sx-tx2); }
.ld-lbtico { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex: none; border: 1px solid; box-sizing: border-box;
  color: var(--ht); background: color-mix(in srgb, var(--h) 16%, var(--sx-bg2)); border-color: color-mix(in srgb, var(--h) 45%, transparent); }
.ld-lbtico .ld-lbic { width: 20px; height: 20px; }
.ld-lbtile.ld-lbmost { padding: 8px 14px 8px 8px; }
.ld-lbmost b { font-size: 17px; }
.ld-lbtile .ld-lbthumb { width: 44px; height: 66px; }
/* places 4 to 20 */
.ld-lblist { display: flex; flex-direction: column; gap: 8px; }
.ld-lblhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ld-lblhead span { font-size: 12px; color: var(--sx-tx2); }
.ld-lb .ld-lbrow { display: grid; grid-template-columns: 48px 64px minmax(0, 1fr) 150px 200px 20px; align-items: center; gap: 16px; width: 100%; text-align: left;
  cursor: pointer; padding: 10px 16px 10px 10px; border-radius: 12px; font-size: 14px; color: var(--sx-tx); box-sizing: border-box;
  background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); box-shadow: var(--sx-sh); }
.ld-lb .ld-lbrow:hover { border-top-color: var(--sx-tx3); }
.ld-lb .ld-lbrow.ld-latest { box-shadow: 0 0 0 1px color-mix(in srgb, var(--sx-bl) 55%, transparent), var(--sx-sh); }
.ld-lbitem.ld-open .ld-lbrow { border-radius: 12px 12px 0 0; background: var(--sx-ui2); }
.ld-lbitem.ld-open .ld-lbchev { transform: rotate(180deg); }
.ld-lbrank { font-size: 22px; font-weight: 800; color: var(--sx-tx1b); text-align: center; font-variant-numeric: tabular-nums; }
.ld-lbthumb { position: relative; display: block; width: 64px; height: 96px; border-radius: 8px; overflow: hidden; border: 1px solid var(--sx-deep); background: var(--sx-bg2); flex: none; box-sizing: border-box; }
.ld-lbmain { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ld-lbname { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.ld-lbname b { font-size: 16px; color: var(--sx-hi); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.ld-lbname small { font-size: 11px; color: var(--sx-tx2); }
.ld-lbchips { display: flex; gap: 6px; flex-wrap: wrap; }
.ld-lbsmall { font-size: 12px; color: var(--sx-tx2); }
.ld-lbhot .ld-lbheat em { margin-left: 0; font-size: 12px; }
.ld-lbhot .ld-lbmeter { order: 3; flex-basis: 100%; }
.ld-lbhot .ld-lbflame { width: 14px; height: 14px; }
.ld-lbpts { display: flex; flex-direction: column; gap: 7px; }
.ld-lbpts b { font-size: 24px; font-weight: 800; color: var(--sx-hi); font-variant-numeric: tabular-nums; text-align: right; line-height: 1; }
.ld-lbpts small { font-size: 11px; color: var(--sx-tx2); text-align: right; }
.ld-lbpts .ld-lbph { display: none; font-style: normal; font-size: 11px; font-weight: 600; color: var(--sx-or-tx); text-align: right; }
.ld-lbbar { display: block; height: 6px; border-radius: 3px; background: var(--sx-bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); overflow: hidden; }
.ld-lbbar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--sx-re-d), var(--sx-re-tx)); }
.ld-lbbar.ld-lbbar2 { display: none; }
.ld-lbchev { color: var(--sx-tx2); transition: transform .15s; }
.ld-lb .ld-lbshow { align-self: center; margin-top: 6px; }
/* the opened run */
.ld-lbmore { border-radius: 0 0 12px 12px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-top: 0; box-shadow: var(--sx-well);
  padding: 18px 20px 20px 132px; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; }
.ld-lbpodmore .ld-lbmore { border-radius: 12px; border-top: 1px solid var(--sx-deep); padding-left: 20px; }
.ld-lbcol { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ld-lbsum { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 16px; row-gap: 7px; font-size: 13px; align-items: baseline; color: var(--sx-tx1b); }
.ld-lbd { color: var(--sx-tx2); font-size: 12px; text-align: right; }
.ld-lbv { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; color: var(--sx-tx); }
.ld-lbsub { border-top: 1px solid var(--sx-ui3); padding-top: 7px; }
.ld-lbv.ld-hi { color: var(--sx-hi); }
.ld-lbtot { color: var(--sx-hi); font-weight: 700; font-size: 15px; }
.ld-lbv.ld-lbtot { font-weight: 800; font-size: 20px; }
.ld-lb .ld-c-cy { color: var(--sx-cy-tx); } .ld-lb .ld-c-ma { color: var(--sx-ma-tx); } .ld-lb .ld-c-re { color: var(--sx-re-tx); }
.ld-lb .ld-c-gr { color: var(--sx-gr-tx); } .ld-lb .ld-c-or { color: var(--sx-or-tx); } .ld-lb .ld-c-bl { color: var(--sx-bl-tx); }
.ld-lbnote, .ld-lbwhen { font-size: 12px; color: var(--sx-tx2); line-height: 1.5; }
.ld-lbfacts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.ld-lbfact { background: var(--sx-ui); border-radius: 9px; padding: 8px 10px; min-width: 0; }
.ld-lbfact b { display: block; font-size: 17px; font-weight: 700; color: var(--sx-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-lbfact span { font-size: 11px; color: var(--sx-tx2); }
.ld-lbmom { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.ld-lbmom span { color: var(--sx-tx1b); }
.ld-lb .ld-lbmom a { color: var(--sx-bl-tx); text-decoration: none; }
.ld-lb .ld-lbmom a:hover { text-decoration: underline; }
.ld-lbacts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }
.ld-lbfoot { font-size: 12px; color: var(--sx-tx2); text-align: center; border-top: 1px solid var(--sx-ui2); padding-top: 14px; }
@media (max-width: 960px) {
  /* the podium becomes a swipe row, #1 first, with dots */
  .ld-lbpod { padding-top: 6px; background: none; }
  .ld-lbpod .ld-lbpodrow { justify-content: flex-start; align-items: stretch; gap: 14px; overflow-x: auto; scroll-snap-type: x mandatory;
    padding: 6px 18px 14px; margin: 0 -18px; scrollbar-width: none; }
  .ld-lbpod .ld-lbpodrow::-webkit-scrollbar { display: none; }
  .ld-lbpod .ld-lbstep { flex: none; scroll-snap-align: center; }
  .ld-lbpod .ld-s1 { order: 0; } .ld-lbpod .ld-s2 { order: 1; } .ld-lbpod .ld-s3 { order: 2; }
  .ld-lbpod .ld-lbpc { width: 272px !important; height: 100%; border-radius: 12px; }
  .ld-lbpod .ld-lbplinth { display: none; }
  .ld-lbdots { display: flex; }
  .ld-lb .ld-lbrow { grid-template-columns: 36px 48px minmax(0, 1fr) 110px; }
  .ld-lbhot, .ld-lbchev, .ld-lbpts .ld-lbbar, .ld-lbpts small { display: none; }
  .ld-lb .ld-lbrow .ld-lbthumb { width: 48px; height: 72px; }
  .ld-lbmore { padding: 16px; grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 575.98px) {
  .ld-lb { gap: 18px; }
  .ld-modal .ld-lbtitle { font-size: 26px; }
  .ld-lbctl, .ld-lbchips2 { flex-wrap: nowrap; }
  .ld-lbctl { overflow-x: auto; margin: 0 -12px; padding: 0 12px; scrollbar-width: none; width: calc(100% + 24px); box-sizing: border-box; }
  .ld-lb .ld-lbchip, .ld-lb .ld-lbper { min-height: 40px; flex: none; }
  .ld-lbpod .ld-lbpodrow { margin: 0 -12px; padding: 6px 12px 14px; }
  .ld-lbpod .ld-lbscore b { font-size: 34px; }
  .ld-lbtiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .ld-lbtile { padding: 12px; }
  .ld-lbtico { display: none; }
  .ld-lbtile b { font-size: 18px; }
  .ld-lbtile.ld-lbmost { grid-column: span 2; order: 4; }
  .ld-lbtile:last-child { order: 3; }
  .ld-lb .ld-lbrow { grid-template-columns: 28px 44px minmax(0, 1fr) auto; gap: 10px; padding: 8px 12px 8px 6px; border-radius: 9px; min-height: 44px; }
  .ld-lb .ld-lbrow .ld-lbthumb { width: 44px; height: 66px; border-radius: 7px; }
  .ld-lbrank { font-size: 17px; }
  .ld-lbname b { font-size: 15px; }
  .ld-lbchips .ld-lbcond, .ld-lbsmall { display: none; }
  .ld-lbbar.ld-lbbar2 { display: block; height: 3px; margin-top: 3px; }
  .ld-lbpts b { font-size: 18px; }
  .ld-lbpts .ld-lbph { display: block; }
  .ld-lb .ld-lbrow .ld-lbtag b { font-size: 10px; }
  .ld-lbfacts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ld-lbempty .ld-lbpodrow { gap: 8px; }
  .ld-lbghost { width: 90px; height: 120px; font-size: 28px; }
  .ld-lbghost.ld-g1 { width: 110px; height: 160px; }
  .ld-s3 .ld-lbghost { height: 100px; }
  .ld-lbempty .ld-lbplinth { height: 24px; }
}
/* ── 2.17: the new layout ──
   Portraits (user: "rounded rectangles in Stash's 2:3 performer-card shape,
   never circles"); a studio's logo on a light plate, a tag's picture, else
   their icon; a duo two overlapping. */
.ld-pf { flex: none; position: relative; display: inline-flex; align-items: flex-end; justify-content: center; overflow: hidden; box-sizing: border-box;
  width: 36px; height: 54px; border-radius: 8px; background: linear-gradient(180deg, color-mix(in srgb, var(--sx-ma) 26%, var(--sx-ui2)) 0, var(--sx-ui2) 100%);
  color: color-mix(in srgb, var(--sx-hi) 22%, transparent); }
.ld-pf img { width: 100%; height: 100%; object-fit: cover; object-position: center top; display: block; }
.ld-pf.ld-pfplate { align-items: center; padding: 3px; background: linear-gradient(180deg, #F2F0E5, #DAD8CE); }
.ld-pf.ld-pfplate img { object-fit: contain; object-position: center; }
.ld-pfsil { width: 72%; fill: currentColor; display: block; }
.ld-pf.ld-pfkind { align-items: center; background: var(--sx-bg2); border: 1px solid var(--sx-ui3); color: var(--sx-tx2); }
.ld-pfico { width: 45%; height: auto; max-width: 28px; }
.ld-pf-xl { width: 200px; height: 300px; border-radius: 14px; }
.ld-pf-l { width: 150px; height: 225px; border-radius: 14px; }
.ld-pf-m { width: 76px; height: 114px; border-radius: 10px; box-shadow: 0 0 0 2px var(--sx-re); }
.ld-pf-s { width: 44px; height: 66px; border-radius: 8px; }
.ld-pf-h { width: 36px; height: 54px; border-radius: 8px; }
.ld-pf-b { width: 30px; height: 44px; border-radius: 6px; box-shadow: 0 0 0 2px var(--sx-re); }
/* 2.18 (user: the header picture "needing a bit of padding on top and bottom") */
#ld-bar .ld-pf-b, #ld-bar .ld-pf2-b > .ld-pf { height: min(44px, calc(var(--ld-barh, 56px) - 18px)); width: calc(min(44px, calc(var(--ld-barh, 56px) - 18px)) * 2 / 3); }
/* 2.18 (user: "make the background of the selected lockdown performer red so
   it pops out a bit more (not in the leader board and history though)"):
   the run's own pictures (setup panel, chosen card, run page, bar) on red;
   cut-out pictures show it, others keep their own ground */
.ld-pf.ld-pf-xl, .ld-pf.ld-pf-l, .ld-pf.ld-pf-m, .ld-pf.ld-pf-b, .ld-pf2-xl > .ld-pf, .ld-pf2-l > .ld-pf, .ld-pf2-m > .ld-pf, .ld-pf2-b > .ld-pf {
  background: radial-gradient(120% 90% at 50% 25%, color-mix(in srgb, var(--sx-re) 85%, #fff 0%) 0, var(--sx-re-d) 100%); }
.ld-pf-xs { width: 24px; height: 36px; border-radius: 6px; }
.ld-pf-xxs { width: 16px; height: 24px; border-radius: 6px; }
.ld-pf-xl, .ld-pf-l { border: 3px solid var(--sx-re);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--sx-re) 16%, transparent), 0 18px 44px -12px color-mix(in srgb, var(--sx-re) 70%, transparent); }
.ld-pf2 { flex: none; display: inline-flex; align-items: center; }
.ld-pf2 > .ld-pf + .ld-pf { margin-left: -12px; box-shadow: 0 0 0 2px var(--sx-bg); }
.ld-pf2-xl > .ld-pf { width: 150px; height: 225px; } .ld-pf2-xl > .ld-pf + .ld-pf { margin-left: -60px; margin-top: 60px; }
.ld-pf2-l > .ld-pf { width: 116px; height: 174px; } .ld-pf2-l > .ld-pf + .ld-pf { margin-left: -44px; margin-top: 44px; }
.ld-pf2-m > .ld-pf + .ld-pf { margin-left: -30px; }
.ld-pf2-b > .ld-pf + .ld-pf { margin-left: -14px; }
.ld-pf2-xl > .ld-pf + .ld-pf, .ld-pf2-l > .ld-pf + .ld-pf { box-shadow: 0 0 0 4px var(--sx-bg2), 0 18px 44px -12px color-mix(in srgb, var(--sx-re) 70%, transparent); }
.ld-cap { display: block; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--sx-tx2); }
.ld-cap.ld-capre { color: var(--sx-re-tx); }
.ld-muted { color: var(--sx-tx2); }
.ld-hi { color: var(--sx-hi) !important; }
.ld-orange { color: var(--sx-or) !important; }
.ld-cyan { color: var(--sx-cy) !important; }
.ld-modal .ld-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
  background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3);
  border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-modal .ld-btn:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); }
.ld-modal .ld-xbtn { background: none; border: 0; color: var(--sx-tx2); padding: 4px; cursor: pointer; display: inline-flex; border-radius: 8px; }
.ld-modal .ld-xbtn:hover { color: var(--sx-re-tx); background: var(--sx-ui2); }
/* the setup: two columns, the steps and a sticky Your run panel */
.ld-page .ld-setup { grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; }
.ld-setupmain { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ld-card.ld-stepc { margin: 0; padding: 16px 18px; border-radius: 12px; background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); box-shadow: var(--sx-sh); }
.ld-card.ld-stepc.ld-cur { border-color: color-mix(in srgb, var(--sx-re) 55%, var(--sx-line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--sx-re) 35%, transparent), var(--sx-sh); }
.ld-sh { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.ld-snum { width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex: none; box-sizing: border-box; }
.ld-snum .ld-ico { width: 16px; height: 16px; }
.ld-snum.ld-done { background: color-mix(in srgb, var(--sx-gr) 30%, var(--sx-ui2)); color: var(--sx-hi); border: 1px solid color-mix(in srgb, var(--sx-gr) 55%, transparent); }
.ld-snum.ld-now { background: var(--sx-re); color: var(--sx-on); }
.ld-snum.ld-next { background: var(--sx-bg2); color: var(--sx-tx2); border: 1px solid var(--sx-deep); }
.ld-stitle { font-size: 17px; font-weight: 700; color: var(--sx-hi); }
.ld-ssum { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--sx-tx1b); min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
.ld-ssum b { color: var(--sx-hi); font-weight: 600; }
.ld-ssum .ld-heatsum { margin: 0; color: var(--sx-tx1b); font-weight: 400; gap: 6px; }
.ld-ssum .ld-heatsum b { color: var(--sx-or); font-weight: 700; }
.ld-ssum .ld-heatsum .ld-ico { width: 16px; height: 16px; }
.ld-ssum .ld-clearheat { margin: 0; }
/* the tiles: Performer / Studio / Tag, Finish / Timer / Edge */
.ld-choices.ld-tiles3 { gap: 8px; }
.ld-choice.ld-tile3 { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; color: var(--sx-tx1b);
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: none; }
.ld-choice.ld-tile3 b { color: var(--sx-hi); font-size: 14px; }
.ld-choice.ld-tile3 small { font-size: 12px; white-space: normal; padding-right: 18px; }
.ld-choice.ld-tile3.ld-on { color: var(--sx-tx); background: color-mix(in srgb, var(--sx-re) 18%, var(--sx-ui)); border-color: color-mix(in srgb, var(--sx-re) 60%, transparent); }
.ld-tick3 { position: absolute; top: 10px; right: 10px; width: 18px; height: 18px; border-radius: 6px; background: var(--sx-re); color: var(--sx-on);
  display: none; align-items: center; justify-content: center; }
.ld-tick3 .ld-ico { width: 12px; height: 12px; }
.ld-choice.ld-on .ld-tick3 { display: inline-flex; }
.ld-choice.ld-tile3.ld-on .ld-tick3 .ld-ico { color: var(--sx-on); }
.ld-pickrow { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.ld-pickrow .ld-seg { margin: 0; }
.ld-pickrow .ld-search { flex: 1 1 220px; margin: 0; }
.ld-pickrow .ld-search[hidden] { display: none; }
/* the one chosen, as a card */
.ld-chosen { display: flex; align-items: center; gap: 14px; margin-top: 10px; padding: 12px; border-radius: 12px;
  background: color-mix(in srgb, var(--sx-re) 10%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-re) 40%, transparent); }
.ld-chmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ld-chmain > b { color: var(--sx-hi); font-weight: 700; font-size: 16px; }
.ld-chmain small { font-size: 12.5px; color: var(--sx-tx2); }
.ld-chosen .ld-tagpick { padding: 0; }
.ld-mates.ld-reclist { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.ld-reccard { padding: 8px 10px; border-radius: 10px; border-color: var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.ld-reccard b { font-size: 13.5px; }
.ld-recs { margin-top: 14px; padding-top: 12px; }
/* the way out's options in a well; the time big */
.ld-opts.ld-optwell { margin-top: 12px; padding: 12px; border-radius: 10px; gap: 12px; color: var(--sx-tx1b);
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.ld-optwell .ld-stepper b, .ld-optwell .ld-timebox input.ld-time { font-size: 18px; }
.ld-optwell .ld-stepper button { width: 30px; padding: 4px 0; }
/* Heat: the meter, the conditions as a grid of tiles */
.ld-heatbar { margin: -2px 0 6px; }
.ld-heatbar .ld-lbmeter { display: flex; gap: 3px; }
.ld-heatbar .ld-lbmeter i { flex: 1; height: 10px; border-radius: 2px; background: var(--sx-bg2); box-shadow: inset 0 0 0 1px var(--sx-deep); }
.ld-heatbar .ld-lbmeter i.ld-on { background: var(--sx-or); box-shadow: none; }
.ld-heatbar .ld-lbmeter i.ld-half { background: linear-gradient(90deg, var(--sx-or) 50%, var(--sx-bg2) 50%); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sx-or) 50%, transparent); }
.ld-conds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.ld-conds > .ld-toyopts, .ld-conds > .ld-noheat, .ld-conds > .ld-ionote { grid-column: 1 / -1; }
.ld-cond { grid-template-columns: 28px minmax(0, 1fr) auto auto; padding: 10px 12px; border-radius: 10px;
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.ld-cond:hover { background: var(--sx-ui); }
.ld-cond.ld-on { background: color-mix(in srgb, var(--sx-or) 14%, var(--sx-ui)); border-color: color-mix(in srgb, var(--sx-or) 50%, transparent); }
.ld-cond .ld-condtxt em { margin-left: 6px; font-size: 12px; font-weight: 600; }
.ld-cond .ld-condheat { min-width: 32px; }
.ld-cond .ld-condtxt small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ld-modal .ld-pip { width: 11px; height: 11px; }
.ld-noheat { margin-top: 2px; padding-top: 10px; }
/* cards in your hand: playing cards */
.ld-pcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 12px; align-items: stretch; }
.ld-pcard { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 200px; padding: 14px; box-sizing: border-box;
  border-radius: 12px; text-align: left; font: inherit; color: var(--sx-tx); overflow: hidden;
  background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 80px);
  border: 1px solid var(--sx-line); border-top: 3px solid var(--c, var(--sx-ui3)); box-shadow: var(--sx-sh); }
.ld-modal button.ld-pcard { cursor: pointer; }
.ld-modal button.ld-pcard:hover:not([disabled]) { border-color: color-mix(in srgb, var(--c) 45%, var(--sx-line)); border-top-color: var(--c); }
.ld-modal button.ld-pcard[disabled] { cursor: default; }
.ld-pcard.ld-off { opacity: .5; border-top-color: var(--sx-ui3); }
.ld-pcard.ld-off .ld-pkind, .ld-pcard.ld-off .ld-pico { color: var(--sx-tx2); }
.ld-pkind { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--c); font-weight: 700; }
.ld-pico { width: 34px; height: 34px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--c); background: color-mix(in srgb, var(--c) 18%, var(--sx-bg2)); }
.ld-pico .ld-ico { width: 18px; height: 18px; }
.ld-pcname { font-size: 16px; font-weight: 700; color: var(--sx-hi); line-height: 1.2; overflow-wrap: anywhere; }
.ld-pmeta { font-size: 12px; color: var(--sx-tx2); line-height: 1.4; }
.ld-pmeta b { color: var(--sx-hi); }
.ld-pbar { display: block; height: 5px; border-radius: 3px; background: var(--sx-bg2); overflow: hidden; margin-top: auto; }
.ld-pbar i { display: block; height: 100%; background: var(--c); }
.ld-pprev { position: relative; display: flex; align-items: center; justify-content: center; height: 86px; margin: -4px -4px 4px; border-radius: 8px; overflow: hidden; flex: none;
  background: linear-gradient(135deg, color-mix(in srgb, var(--c) 34%, var(--sx-ui2)), var(--sx-bg2)); }
.ld-pprev img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ld-gif { position: absolute; top: 6px; left: 6px; font-size: 10px; font-weight: 800; letter-spacing: .04em; padding: 1px 5px; border-radius: 6px;
  background: rgba(16,15,15,.82); color: var(--sx-paper); }
.ld-modal .ld-px { position: absolute; top: 8px; right: 8px; z-index: 1; display: inline-flex; padding: 3px; border: 0; border-radius: 6px; cursor: pointer;
  color: var(--sx-tx2); background: color-mix(in srgb, var(--sx-bg2) 70%, transparent); }
.ld-modal .ld-px:hover { color: var(--sx-re-tx); }
.ld-px .ld-ico { width: 13px; height: 13px; }
.ld-modal .ld-pcard.ld-padd { align-items: center; justify-content: center; text-align: center; cursor: pointer; box-shadow: none;
  background: var(--sx-bg2); border: 1px dashed var(--sx-ui3); border-top: 1px dashed var(--sx-ui3); color: var(--sx-tx2); }
.ld-modal .ld-pcard.ld-padd:hover { color: var(--sx-hi); border-color: var(--sx-tx3); }
.ld-padd .ld-ico { width: 22px; height: 22px; }
.ld-paddt { color: var(--sx-tx1b); font-weight: 600; }
.ld-pcard.ld-pcnote { justify-content: center; box-shadow: none; background: var(--sx-bg2); border-top-width: 1px; }
.ld-cardadd { margin-top: 10px; }
.ld-cardadd[hidden] { display: none; }
.ld-cardfoot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.ld-cardfoot .ld-hint { padding: 0; }
/* the run panel */
.ld-page .ld-runcard { top: 66px; }
.ld-runcard { display: flex; flex-direction: column; gap: 14px; padding: 20px; border-radius: 14px; margin: 0;
  background: var(--sx-ui); background: linear-gradient(180deg, color-mix(in srgb, var(--sx-re) 14%, var(--sx-raise)) 0, var(--sx-ui) 180px);
  border: 1px solid color-mix(in srgb, var(--sx-re) 35%, var(--sx-line)); box-shadow: var(--sx-float); }
.ld-runcard .ld-rcwho.ld-hero { flex-direction: column; text-align: center; gap: 12px; margin: 0; }
.ld-runcard .ld-rcwho.ld-hero b { font-size: 24px; font-weight: 700; }
.ld-runcard .ld-rcwho small { font-size: 13px; margin-top: 2px; }
.ld-rcheat { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0; background: none; margin: 0; }
.ld-rct { padding: 12px; border-radius: 10px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.ld-rct b { display: inline-block; font-size: 26px; font-weight: 700; line-height: 1.1; vertical-align: middle; }
.ld-rct small { display: block; }
.ld-rct .ld-bigflame .ld-ico { width: 20px; height: 20px; vertical-align: middle; margin-right: 4px; }
.ld-rcheat .ld-rcx { text-align: right; }
.ld-rcheat .ld-rcx b { font-size: 26px; }
.ld-rcchips { margin: 0; }
.ld-cardpill { color: var(--sx-ma-tx); border-color: color-mix(in srgb, var(--sx-ma) 45%, transparent); }
.ld-cardpill .ld-ico { color: var(--sx-ma); }
.ld-runcard .ld-start { padding: 14px; font-size: 16px; border-radius: 10px; }
.ld-runcard .ld-start .ld-ico { width: 18px; height: 18px; }
.ld-runcard .ld-err:empty { display: none; }
.ld-runcard .ld-rcformula { margin: 0; display: flex; flex-direction: column; gap: 4px; padding-top: 10px; border-top: 1px solid var(--sx-ui2); font-size: 12.5px; color: var(--sx-tx1b); }
.ld-runcard .ld-rcformula:empty { display: none; }
.ld-rcline { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--sx-tx1b); }
.ld-rcline b { font-variant-numeric: tabular-nums; }
.ld-rcfoot { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.ld-rcfoot > div:first-child:has(details[open]) { flex-basis: 100%; order: 2; }
.ld-rcfoot .ld-howscore { margin: 0; color: var(--sx-tx2); font-size: 12px; line-height: 1.55; }
.ld-rcfoot .ld-psave { margin: 0; }
.ld-runcard .ld-foot { margin: 0; }
@media (max-width: 1100px) { .ld-page .ld-setup { grid-template-columns: minmax(0, 1fr) 300px; } .ld-pf-xl { width: 160px; height: 240px; }
  .ld-pf2-xl > .ld-pf { width: 120px; height: 180px; } }
@media (max-width: 900px) { .ld-page .ld-setup { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) {
  .ld-conds { grid-template-columns: minmax(0, 1fr); }
  .ld-ssum { margin-left: 42px; justify-content: flex-start; }
  .ld-chosen { flex-wrap: wrap; }
  .ld-chosen .ld-btn { order: 3; }
  .ld-pf-m { width: 60px; height: 90px; }
  .ld-runcard .ld-rcwho.ld-hero { flex-direction: row; text-align: left; }
  .ld-pf-xl { width: 96px; height: 144px; border-width: 2px; }
  .ld-pf2-xl > .ld-pf { width: 76px; height: 114px; } .ld-pf2-xl > .ld-pf + .ld-pf { margin-left: -30px; margin-top: 30px; }
}
/* the page while locked: the lock pill; Body stats */
.ld-lockpill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 8px; font-size: 12.5px; color: var(--sx-hi); white-space: nowrap;
  background: color-mix(in srgb, var(--sx-re) 16%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-re) 45%, transparent); font-variant-numeric: tabular-nums; }
.ld-lockpill i { width: 7px; height: 7px; border-radius: 50%; background: var(--sx-re); }
@media (max-width: 575.98px) { .ld-pagehead .ld-tabs { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); } }
.ld-body { display: flex; flex-direction: column; }
.ld-bodysec + .ld-bodysec { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--sx-ui2); }
.ld-bodyhead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.ld-bodyhead b { color: var(--sx-hi); font-size: 16px; }
.ld-bodyhead .ld-hint { padding: 0; }
.ld-bodyhead .ld-link { margin-left: auto; text-decoration: none; }
/* the run page */
.ld-live { max-width: none; }
.ld-lvhero { display: grid; grid-template-columns: auto minmax(0, 1fr) 300px; gap: 24px; align-items: center; padding: 22px; border-radius: 14px; margin-bottom: 18px;
  background: var(--sx-ui); background: linear-gradient(120deg, color-mix(in srgb, var(--sx-re) 16%, var(--sx-ui)) 0, var(--sx-ui) 55%);
  border: 1px solid color-mix(in srgb, var(--sx-re) 30%, var(--sx-line)); box-shadow: var(--sx-sh); }
.ld-lvwho { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ld-lvname { font-size: 30px; font-weight: 700; color: var(--sx-hi); line-height: 1.15; overflow-wrap: anywhere; }
.ld-lvdeal { font-size: 14px; color: var(--sx-tx1b); margin-bottom: 6px; }
.ld-lvprog { display: flex; flex-direction: column; gap: 8px; padding: 16px; border-radius: 12px; min-width: 0;
  background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: var(--sx-well); }
.ld-lvprog .ld-pgt { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.ld-lvprog .ld-pgt b { font-size: 40px; font-weight: 700; color: var(--sx-hi); line-height: 1; }
.ld-lvprog .ld-pgt span { color: var(--sx-tx2); font-size: 15px; }
.ld-lvprog .ld-pgt.ld-g-finish b { color: var(--sx-bl-tx); }
.ld-lvprog .ld-pgt.ld-g-reached b, .ld-lvprog .ld-pgt.ld-g-over b { color: var(--sx-gr-tx); }
.ld-track { display: block; height: 10px; border-radius: 5px; overflow: hidden; background: var(--sx-bg); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.ld-track i { display: block; height: 100%; background: var(--sx-cy); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-track.ld-g-timer i { background: var(--sx-ye); }
.ld-track.ld-g-reached i, .ld-track.ld-g-over i { background: var(--sx-gr); }
.ld-pgfoot { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--sx-tx2); flex-wrap: wrap; }
.ld-pgpace.ld-up, .ld-pgpace { color: var(--sx-ye); }
.ld-lvgrid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
.ld-lvmain, .ld-lvside { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ld-live .ld-tiles.ld-lvtiles { margin: 0; gap: 10px; }
.ld-lvtiles .ld-tile { align-items: flex-start; text-align: left; padding: 12px 14px; border-radius: 10px; }
.ld-lvtiles .ld-tile b { font-size: 22px; }
.ld-lvtiles .ld-tile span { font-size: 11.5px; }
.ld-lvcard { padding: 16px; border-radius: 12px; background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); box-shadow: var(--sx-sh); }
.ld-lvtabs { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.ld-lvtabs .ld-tabs { margin-left: 0; }
.ld-lvtabnote { margin-left: auto; padding: 0; }
.ld-lvscenes { display: flex; flex-direction: column; gap: 10px; }
.ld-lvch { color: var(--sx-hi); font-size: 15px; }
.ld-live .ld-lvscenes .ld-lvgo { width: 100%; margin: 0; justify-content: center; padding: 12px; font-size: 15px; border-radius: 10px; }
.ld-live .ld-lvscenes .ld-lvrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ld-live .ld-lvscenes .ld-lvrow .ld-lvgo { padding: 9px; font-size: 14px; }
.ld-live .ld-lvscenes .ld-lvrow > :only-child { grid-column: 1 / -1; }
.ld-live .ld-lvrow .ld-lvpics[hidden] { display: none; }
.ld-modal .ld-start.ld-lvalt { color: var(--sx-tx); background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)) !important; border-top-color: var(--sx-ui3); box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k))); }
.ld-modal .ld-start.ld-lvalt:hover { color: var(--sx-hi); filter: none; }
.ld-lvround { display: flex; flex-direction: column; gap: 6px; text-align: left; margin: 0; }
.ld-lvround .ld-rcline b { color: var(--sx-hi); font-weight: 600; }
.ld-lvround .ld-track { height: 6px; }
.ld-lvside .ld-toycard { margin: 0; padding: 16px; border-radius: 12px; background: var(--sx-ui); background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); box-shadow: var(--sx-sh); }
.ld-lvside .ld-foot { text-align: center; }
.ld-handpage { margin: 0; }
.ld-handpage .ld-pcards { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
.ld-handpage .ld-pcard { min-height: 210px; }
.ld-pfoot { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--sx-tx2); }
.ld-play { padding: 4px 10px; border-radius: 6px; background: var(--c); color: var(--sx-on); font-weight: 700; font-size: 12px; white-space: nowrap; }
.ld-play.ld-gogrey, .ld-go.ld-gogrey { background: var(--sx-ui3); color: var(--sx-hi); }
.ld-soon { color: var(--sx-ye) !important; }
.ld-pline { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--sx-bg2); }
.ld-pline i { display: block; height: 100%; background: var(--c); }
.ld-pline.ld-soon i { background: var(--sx-ye); }
.ld-pcard.ld-pwait { opacity: .6; }
.ld-pcard.ld-plive { align-items: center; text-align: center; border-color: color-mix(in srgb, var(--c) 60%, var(--sx-line));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 40%, transparent), 0 12px 30px -12px color-mix(in srgb, var(--c) 60%, transparent); }
.ld-ring { position: relative; width: 64px; height: 64px; margin: 4px 0; }
.ld-ring svg { display: block; }
.ld-ring circle { fill: none; stroke-width: 6; }
.ld-ringbg { stroke: var(--sx-bg2); }
.ld-ringfg { stroke: var(--sx-cy); stroke-linecap: round; transition: stroke-dashoffset .9s linear; }
.ld-ring b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--sx-hi); font-variant-numeric: tabular-nums; font-size: 14px; }
.ld-pcard.ld-pwon, .ld-pcard.ld-plost { align-items: center; text-align: center; justify-content: center; }
.ld-pcard.ld-pwon { background: linear-gradient(180deg, color-mix(in srgb, var(--sx-gr) 22%, var(--sx-ui)), var(--sx-ui) 120px); animation: ld-flashin .5s ease-out; }
.ld-pcard.ld-plost { opacity: .7; }
.ld-pbig { width: 46px; height: 46px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--c);
  background: color-mix(in srgb, var(--c) 18%, var(--sx-bg2)); }
.ld-pbig .ld-ico { width: 22px; height: 22px; }
.ld-ppts { font-size: 26px; color: var(--sx-gr-tx); }
@media (max-width: 1000px) { .ld-lvhero { grid-template-columns: auto minmax(0, 1fr); } .ld-lvhero .ld-lvprog { grid-column: 1 / -1; } }
@media (max-width: 860px) { .ld-lvgrid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 575.98px) {
  .ld-lvhero { gap: 14px; padding: 14px; }
  .ld-lvhero .ld-pf-l, .ld-lvhero .ld-pf2-l > .ld-pf { width: 80px; height: 120px; border-width: 2px; }
  .ld-lvhero .ld-pf2-l > .ld-pf + .ld-pf { margin-left: -30px; margin-top: 30px; }
  .ld-lvname { font-size: 22px; }
  .ld-live .ld-tiles.ld-lvtiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ld-handpage .ld-pcards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ld-lvprog .ld-pgt b { font-size: 32px; }
}
/* the bar: who, a divider, how far; Your run apart; Give up last */
#ld-bar { gap: 14px; }
#ld-bar .ld-bwho { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 0 1 auto; }
#ld-bar .ld-who { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
#ld-bar .ld-who b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ld-bar .ld-who small { margin: 0; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ld-bar .ld-bdiv { width: 1px; align-self: stretch; margin: 10px 0; background: var(--sx-ui3); flex: none; }
#ld-bar .ld-pace { color: var(--sx-ye); flex: 0 1 auto; }
/* 2.18: the score beside the best */
#ld-bar .ld-pace:not(.ld-flash) { display: inline-flex; align-items: center; gap: 7px; color: var(--sx-tx2); font-size: 12px; }
#ld-bar .ld-psc b { color: var(--sx-ye); font-size: 14px; font-variant-numeric: tabular-nums; }
#ld-bar .ld-pbest b { color: var(--sx-hi); font-variant-numeric: tabular-nums; }
#ld-bar .ld-pbest.ld-up { color: var(--sx-ye); font-weight: 600; }
#ld-bar .ld-pmeter { display: inline-block; width: 54px; height: 5px; border-radius: 3px; background: var(--sx-bg2); overflow: hidden; }
#ld-bar .ld-pmeter i { display: block; height: 100%; background: var(--sx-ye); }
#ld-bar .ld-bgrow { flex: 1 1 0; min-width: 0; }
#ld-bar a.ld-runbtn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; box-sizing: border-box; flex: none; font-weight: 600; white-space: nowrap;
  color: var(--sx-hi); background: color-mix(in srgb, var(--sx-re) 20%, var(--sx-ui)); border: 1px solid color-mix(in srgb, var(--sx-re) 50%, transparent); }
#ld-bar a.ld-runbtn:hover { border-color: var(--sx-re); }
#ld-bar a.ld-runbtn .ld-lock { width: 15px; height: 15px; }
#ld-bar .ld-blinks { display: inline-flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
#ld-bar .ld-links .ld-blinks a { height: 26px; padding: 0 10px; background: none; border: 1px solid transparent; box-shadow: none; color: var(--sx-tx1b); border-radius: 7px; }
#ld-bar .ld-links .ld-blinks a:hover { color: var(--sx-hi); background: var(--sx-ui2); }
#ld-bar .ld-handbtn { height: 32px; padding: 0 10px; background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); }
#ld-bar .ld-handbtn.ld-hasready { border-color: color-mix(in srgb, var(--sx-ma) 50%, var(--sx-line)); }
#ld-bar .ld-handbtn.ld-open { color: var(--sx-hi); border-color: color-mix(in srgb, var(--sx-ma) 60%, transparent); background: color-mix(in srgb, var(--sx-ma) 22%, var(--sx-ui)); }
#ld-bar .ld-handn { position: absolute; top: -6px; right: -6px; min-width: 17px; height: 17px; padding: 0 4px; box-sizing: border-box; border-radius: 6px;
  background: var(--sx-ma); color: var(--sx-on); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
#ld-bar .ld-handn[hidden] { display: none; }
#ld-bar .ld-handbtn.ld-pulse .ld-handn { animation: ld-flashin .5s ease-out; }
/* the popover's rows */
#ld-bar .ld-pophead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
#ld-bar .ld-pophead b { color: var(--sx-hi); white-space: nowrap; flex: none; }
#ld-bar .ld-pophead .ld-hint { padding: 0; text-align: right; }
#ld-bar .ld-crows { display: flex; flex-direction: column; gap: 6px; }
#ld-bar .ld-crow { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; height: auto; padding: 9px 10px; margin: 0; box-sizing: border-box; overflow: hidden;
  border-radius: 10px; background: var(--sx-ui); border: 1px solid var(--sx-line); border-left: 3px solid var(--c); box-shadow: none;
  color: var(--sx-tx); font: inherit; text-align: left; white-space: normal; }
#ld-bar button.ld-crow { cursor: pointer; }
#ld-bar button.ld-crow:hover:not([disabled]) { background: var(--sx-ui2); border-top-color: var(--sx-line); }
#ld-bar .ld-crow[disabled] { cursor: default; }
#ld-bar .ld-crow.ld-wait { opacity: .6; }
#ld-bar .ld-cico { width: 30px; height: 30px; border-radius: 8px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  color: var(--c); background: color-mix(in srgb, var(--c) 18%, var(--sx-bg2)); }
#ld-bar .ld-cico .ld-ico { width: 16px; height: 16px; }
#ld-bar .ld-cthumb { position: relative; flex: none; width: 46px; height: 34px; border-radius: 6px; overflow: hidden; display: inline-flex; align-items: center; justify-content: center;
  color: var(--c); background: linear-gradient(135deg, color-mix(in srgb, var(--c) 34%, var(--sx-ui2)), var(--sx-bg2)); }
#ld-bar .ld-cthumb img { width: 100%; height: 100%; object-fit: cover; display: block; border: 0; border-radius: 0; }
#ld-bar .ld-cthumb .ld-gif { top: auto; left: auto; bottom: 2px; right: 2px; font-size: 8.5px; padding: 0 3px; }
#ld-bar .ld-ctxt { display: flex; flex-direction: column; min-width: 0; }
#ld-bar .ld-ctxt b { color: var(--sx-hi); font-size: 13.5px; font-weight: 600; }
#ld-bar .ld-ctxt small { color: var(--sx-tx2); font-size: 11.5px; }
#ld-bar .ld-go { margin-left: auto; padding: 3px 9px; border-radius: 6px; background: var(--c); color: var(--sx-on); font-weight: 700; font-size: 11.5px; flex: none; }
#ld-bar .ld-cbar { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--c); }
#ld-bar .ld-crow.ld-con { border-color: color-mix(in srgb, var(--c, var(--sx-cy)) 60%, var(--sx-line)); border-left-color: var(--c); }
#ld-bar .ld-handfoot { padding: 0; margin-top: 8px; }
@media (max-width: 1240px) { #ld-bar .ld-pace { display: none; } }
@media (max-width: 1080px) { #ld-bar .ld-who small { display: none; } #ld-bar .ld-pics span { display: none; } #ld-bar .ld-pics .ld-ico { margin-right: 0; } }
@media (max-width: 960px) { #ld-bar .ld-picn, #ld-bar a.ld-runbtn span { display: none; } }
@media (max-width: 760px) {
  #ld-bar { gap: 10px; }
  #ld-bar .ld-who, #ld-bar .ld-bdiv, #ld-bar .ld-skips, #ld-bar a.ld-runbtn, #ld-bar .ld-blinks { display: none; }
  #ld-bar .ld-pf-b, #ld-bar .ld-pf2-b > .ld-pf { height: min(38px, calc(var(--ld-barh, 56px) - 16px)); width: calc(min(38px, calc(var(--ld-barh, 56px) - 16px)) * 2 / 3); }
  #ld-bar .ld-prog { flex: 1 1 auto; }
  #ld-bar .ld-pgt b { font-size: 14px; }
  #ld-bar .ld-pgt .ld-pgof { display: none; }
  #ld-bar .ld-pgt .ld-pgshort { display: inline; }
  #ld-bar .ld-bgrow { display: none; }
}
/* while a hold runs: a chip on the player's top left, out of the
   timeline's way and of the pointer's; a fixed dark scrim on any video */
.ld-holdchip { position: absolute; top: 12px; left: 12px; z-index: 5; display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px;
  background: rgba(16,15,15,.82); border: 1px solid color-mix(in srgb, var(--sx-cy) 60%, transparent); color: var(--sx-paper); font-size: 12.5px;
  pointer-events: none; font-variant-numeric: tabular-nums; }
.ld-holdchip .ld-ico { width: 15px; height: 15px; color: var(--sx-cy); }
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
      } else if (kind === "bell") {
        // 2.16: a milestone, a hold passed: one soft struck note
        tone(c, 784, t, 1.4, 0.06); tone(c, 1568, t, 0.6, 0.015);
      } else if (kind === "thud") {
        // 2.16: a slip, a hold broken
        const a = tone(c, 150, t, 0.45, 0.16, "triangle");
        a.frequency.exponentialRampToValueAtTime(70, t + 0.4);
      } else if (kind === "best") {
        // 2.16: past your best
        tone(c, 659.25, t, 0.9, 0.09); tone(c, 987.77, t + 0.14, 1.3, 0.09); tone(c, 1318.5, t + 0.14, 0.6, 0.025);
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
    if ((L.tags && L.tags.length > 1) || duoOf(L)) return tagsListUrl(L, L.media === "images" ? "images" : "scenes");
    return `/${KINDS[L.kind].path}/${L.tid}/${L.media === "images" ? "images" : `scenes${L.rules && L.rules.fresh ? FRESH_Q : ""}`}`;
  }
  // Several tags have no page of their own: Stash's Scenes list, filtered to
  // them (and to unplayed scenes with "unwatched only"); 2.3: its Images and
  // Galleries lists the same way (forum: with OR, the other tags' images had
  // no list to be found in, only each tag's own page).
  // 2.14: a duo the same way, with a performers criterion (either of them).
  function tagsListUrl(L, page) {
    const duo = duoOf(L);
    const crit = [duo ? { type: "performers", modifier: "INCLUDES", value: { items: duo.map((p) => ({ id: String(p.id), label: p.name })), excluded: [] } }
      : { type: "tags", modifier: L.mode === "or" ? "INCLUDES" : "INCLUDES_ALL",
          value: { items: L.tags.map((t) => ({ id: String(t.id), label: t.name })), excluded: [], depth: -1 } }];
    if (page === "scenes" && L.rules && L.rules.fresh) crit.push({ type: "play_count", modifier: "EQUALS", value: { value: 0 } });
    return `/${page}?${crit.map((c) => `c=${encodeCriterion(c)}`).join("&")}`;
  }
  const scenesListUrl = (L) => tagsListUrl(L, "scenes");
  // 2.12.1: the Lockdown bar's links, in order: the run page, the target's
  // Scenes (Images for an image run; none under Roulette, where scenes come
  // at random), Galleries and Images (`more`: hidden first when space is
  // short), and Stash's Settings (user: "a Stash Settings icon on the header
  // during the lockdown for quick access"; open during a lock since 2.12).
  function barLinks(L, page) {
    const base = `/${KINDS[L.kind].path}/${L.tid}`;
    const out = [];
    if (page) out.push({ href: PAGE_PATH, label: tc("对局", "Run") });
    if (L.media === "images") out.push({ href: listUrl(L), label: tc("图片", "Images") });
    else if (!(L.rules && L.rules.random)) out.push({ href: listUrl(L), label: tc("场景", "Scenes") });
    // 2.16: Roulette's scene last shown, to get back to it from a gallery
    else if (lastShown(L)) out.push({ href: `/scenes/${lastShown(L)}`, label: tc("场景", "Scene") });
    out.push({ href: L.groups ? tagsListUrl(L, "galleries") : `${base}/galleries`, label: tc("画廊", "Galleries"), cls: "ld-more" });
    if (L.media !== "images") out.push({ href: L.groups ? tagsListUrl(L, "images") : `${base}/images`, label: tc("图片", "Images"), cls: "ld-more" });
    out.push({ href: "/settings", label: tc("Stash 设置", "Stash settings"), title: tc("Stash 设置", "Stash settings"), cls: "ld-gear", icon: "gear" });
    return out;
  }
  // Whether a Scenes list URL still has the lock's tags criterion (and the
  // unplayed one with "unwatched only"); other filters may narrow it.
  function keepsListFilter(search, L, page) {
    const cs = new URLSearchParams(search || "").getAll("c").map((c) => c.replace(/\(/g, "{").replace(/\)/g, "}"));
    const duo = duoOf(L);
    const mod = duo || L.mode === "or" ? '"INCLUDES"' : '"INCLUDES_ALL"';
    // a duo's criterion holds the two and nobody else (a third would widen it)
    const tags = cs.some((c) => c.includes(`"type":"${duo ? "performers" : "tags"}"`) && c.includes(`"modifier":${mod}`) &&
      (duo || L.tags || []).every((t) => c.includes(`"id":"${t.id}"`)) && (!duo || (c.match(/"id":"/g) || []).length === duo.length));
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
    back.innerHTML = `<div class="ld-modal" role="dialog" aria-modal="true">${html}</div>`;
    if (!sticky) back.addEventListener("pointerdown", (ev) => { if (ev.target === back) closeModal(); });
    // 2.16: over a fullscreen player a body child is not drawn (the result
    // card went unseen): the dialog leaves fullscreen first
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    document.body.appendChild(back);
    setTimeout(() => (back.querySelector(".ld-close") || back.querySelector(".ld-start, button"))?.focus({ preventScroll: true }), 0);
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
  // 2.12.1: the bar's Stash settings (a cog) and its "..." menu on a phone;
  // Give up's "(hold)" goes on a phone (the title still says to hold it)
  const GEAR_ICON = line('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/><circle cx="8" cy="8" r="4.3"/>');
  const MORE_ICON = '<svg class="ld-ico" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>';
  const GIVEUP_LABEL = tc(`放弃<span class="ld-gulong">（按住）</span>`, `Give up<span class="ld-gulong"> (hold)</span>`);
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
  // 2.17: the setup's tiles (user: "Performer", "Studio", "Tag", no "A "),
  // each with a small line, and a tick on the chosen one
  const kindTile = () => ({ performer: [tc("演员", "Performer"), tc("或两位演员", "or a duo of two")],
                            studio: [tc("工作室", "Studio"), tc("含其下级工作室", "with its sub-studios")],
                            tag: [tc("标签", "Tag"), tc("一个或几个", "one or several")] });
  const goalTile = () => ({ finish: tc("射出来就出局，一次或最多 5 次。", "Finish to get out, once or up to 5 times."),
                            timer: tc("等它走完：观看时长或锁定时间。", "Wait it out: watched or locked time."),
                            edge: tc("忍住不射出地看着设定时长；一次 O 即为失误。", "Watch for the time without finishing; an O is a slip.") });
  const TICK_SVG = line('<path d="M3.5 8.5l3 3 6-7"/>');
  const TICK_HTML = `<span class="ld-tick3">${TICK_SVG}</span>`;
  const X_SVG = line('<path d="M4 4l8 8M12 4l-8 8"/>');
  const PLUS_SVG = line('<path d="M8 3v10M3 8h10"/>');
  // 2.17: which tag pictures move (a GIF badge on their cards): asked once a
  // session a picture, by its type (and a WebP's header); `then` redraws
  // once it is known to move
  const picAnim = new Map();
  function animOf(url, then) {
    if (!url) return false;
    if (picAnim.has(url)) return picAnim.get(url) === true;
    if (picAnimated(url, "", null)) { picAnim.set(url, true); return true; }
    picAnim.set(url, null);
    fetchWithin((sig) => fetch(url, { credentials: "same-origin", signal: sig }), GQL_TIMEOUT_MS).then(async (r) => {
      const type = (r && r.headers && r.headers.get("content-type")) || "";
      let head = null;
      if (/webp/i.test(type)) head = new Uint8Array((await r.arrayBuffer()).slice(0, 32));
      else if (r && r.body && r.body.cancel) r.body.cancel().catch(() => {});
      const moves = picAnimated(url, type, head);
      picAnim.set(url, moves);
      if (moves && then) then();
    }).catch(() => picAnim.set(url, false));
    return false;
  }
  // A tag card's picture, with GIF on it when it moves
  const cardPicHtml = (url, name, then) => `<img src="${escapeHtml(url)}" alt="" loading="lazy" title="${escapeHtml(name || "")}">` +
    (animOf(url, then) ? `<span class="ld-gif">GIF</span>` : "");
  const HEART = line('<path d="M8 13.4S2.2 10 2.2 6.1A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5.8 1.5C13.8 10 8 13.4 8 13.4z"/>');
  const STAR = line('<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/>');
  const FUNNEL = line('<path d="M2.5 3h11l-4.2 5.2v4.6l-2.6 1.2V8.2z"/>');
  // The page's tab strip icons: 16-grid line icons at stroke 1.6, in the
  // tab's colour (the suite's tab strip).
  const tabIcon = (d) => `<svg class="ld-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const LOCK_LINE = tabIcon('<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>');
  const CROWN_LINE = tabIcon('<path d="M2.5 5.5l3 3L8 4l2.5 4.5 3-3-1.3 7H3.8z"/>');
  const BODY_LINE = tabIcon('<circle cx="8" cy="4.5" r="2"/><path d="M5 14V9.5L4 7h8l-1 2.5V14M8 9.5V14"/>');
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
    fresh: line('<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M11.8 4.2l-1.6 1.6M5.8 10.2l-1.6 1.6"/>'),
    slow: line('<path d="M4 2h8M4 14h8M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6"/>'),
    harsh: line('<path d="M6.5 2.5S3 6.5 3 9.2a3.5 3.5 0 0 0 7 0C10 6.5 6.5 2.5 6.5 2.5z"/><path d="M12.5 4v4M10.5 6h4"/>'),
    one: line('<path d="M13 6.5A5 5 0 0 0 4 4.5L2.5 6M3 9.5a5 5 0 0 0 9 2L13.5 10"/><path d="M2.5 3v3h3M13.5 13v-3h-3"/>'),
    // 2.12: a flag behind a veil (the target you can't see), a wave (Goon mode)
    hide: line('<path d="M4 14V2.5M4 3h7l-1.5 2.5L11 8H4"/><path d="M2 11.5h12" stroke-dasharray="1.5 1.5"/>'),
    toy: line('<path d="M1.5 8c1.2-3 2.4-3 3.6 0s2.4 3 3.6 0 2.4-3 3.6 0 1.4 2.2 2.2 1.2"/>'),
    // 2.13.0: an eye
    eyes: line('<path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  };
  // 2.19: a pin (Stay cards: stay put), a stopwatch (the Race)
  const CARD_ICON = {
    stay: line('<path d="M8 14.5V9"/><circle cx="8" cy="5.5" r="3.5"/><circle cx="8" cy="5.5" r=".8"/>'),
    race: line('<circle cx="8" cy="9.2" r="5"/><path d="M8 9.2V6.6M6.4 2h3.2M12.2 4.6l1-1"/>'),
  };
  const holdIcon = (k) => (HOLD_KINDS[k] && HOLD_KINDS[k].stay ? CARD_ICON.stay : COND_ICON.eyes);
  const heatPill = (h) => `<span class="ld-pill ld-heatpill" title="${tc("热度", "Heat")}">${FLAME} ${h}</span>`;

  // The suite's empty state: a raised card, one bold line, one muted line.
  const emptyHtml = (title, line) => `<div class="ld-emptycard"><b>${escapeHtml(title)}</b>${line ? `<span>${escapeHtml(line)}</span>` : ""}</div>`;
  // Loading: what is being read, over Insights' thin sliding bar.
  const loadingHtml = (text) => `<div class="ld-loading">${escapeHtml(text)}<div class="ld-lbar"><i></i></div></div>`;
  // A saved history or totals that do not parse are left alone (rule 5);
  // 2.2's review found that went unsaid (§6, open issue 6).
  const notReadHtml = (d) => (d && d.bad ? tc(`<div class="ld-notice">你保存的历史无法读取，锁局会保持原样、不往里添加任何内容。
    对局仍会锁定并结束；在历史恢复可读之前，它们不会被记录下来。</div>`, `<div class="ld-notice">Your saved history could not be read, so Lockdown leaves it as it is and adds nothing to it. ` +
    `Runs still lock and end; they are not recorded until the history is readable again.</div>`) : "");


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

  // 2.16: the History tab as a table, a row per run, a heading per month.
  // Rows keep `.ld-row` and its buttons (wireRows: Play again, remove).
  function histTableHtml(groups, now, shown) {
    let left = shown, rows = "";
    for (const g of groups) {
      if (left <= 0) break;
      rows += `<tr class="ld-hmonth"><th colspan="9"><span>${escapeHtml(g.label)}</span><span class="ld-mcount">${tc(`${g.done} 出局 · ${g.gaveUp} 放弃`, `${g.done} got out · ${g.gaveUp} gave up`)}</span></th></tr>`;
      const items = g.items.slice(0, left);
      rows += items.map((e) => histRowHtml(e, now)).join("");
      left -= items.length;
    }
    return rows ? `<table class="ld-htable"><thead><tr><th></th><th>${tc("锁给谁", "Locked to")}</th><th class="ld-hopt">${tc("怎么出去", "Way out")}</th><th>${tc("热度", "Heat")}</th><th class="ld-num">${tc("分数", "Score")}</th>` +
      `<th class="ld-num ld-hopt">${tc("观看", "Watched")}</th><th class="ld-num ld-hopt">${tc("锁定", "Locked")}</th><th>${tc("何时", "When")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : "";
  }
  function histRowHtml(e, now) {
    const kind = e.kind && e.kind !== "performer" && KINDS[e.kind] ? kl(e.kind) : "";
    const from = /^(random from |从收藏中随机|从推荐中随机|从\u201c)/.test(e.how || "") ? e.how : "";
    const note = [kind, from].filter(Boolean).join(" · ");
    const detail = entryDetail(e);
    return `<tr class="ld-row ld-hrow ${e.result}" data-key="${escapeHtml(entryKey(e))}"><td class="ld-hico">${icon(e)}</td>` +
      // one line each, the whole text on hover: a run's details made rows tall
      `<td><div class="ld-hwho">${pfHtml(e, e.name, e.image, "h")}<span class="ld-hname"><b>${escapeHtml(e.name || "?")}</b>` +
        `${note ? `<small>${escapeHtml(note)}</small>` : ""}${detail ? `<small class="ld-hdet" title="${escapeHtml(detail)}">${escapeHtml(detail)}</small>` : ""}` +
        `${e.pics > 0 ? `<small>${escapeHtml(picsText(e.pics))}</small>` : ""}${momentsHtml(e)}</span></div></td>` +
      `<td class="ld-hopt">${e.goal ? `<span class="ld-pill">${escapeHtml(goalLabel(e.goal))}</span>` : ""}</td>` +
      `<td>${typeof e.heat === "number" ? heatPill(e.heat) : e.difficulty && DIFF_LABEL[e.difficulty] ? `<span class="ld-pill ld-d-${e.difficulty}">${tc(DIFF_LABEL_ZH[e.difficulty], DIFF_LABEL[e.difficulty])}</span>` : ""}</td>` +
      `<td class="ld-num"><b class="ld-gold">${e.score ? Number(e.score).toLocaleString() : e.result === "done" ? "–" : ""}</b></td>` +
      `<td class="ld-num ld-hopt">${e.v >= 3 ? escapeHtml(fmtMinutes((e.watchedMs || 0) / 60000)) : ""}</td>` +
      `<td class="ld-num ld-hopt${e.result === "done" ? "" : " ld-hgave"}">${e.result === "done" ? "" : tc("放弃 ", "gave up ")}${escapeHtml(fmtDuration(e.ms))}</td>` +
      `<td class="ld-hwhen"${typeof e.at === "number" ? ` title="${tc("开始于 ", "Started ")}${escapeHtml(fmtStamp(e.at))}"` : ""}>${escapeHtml(typeof e.at === "number" ? fmtWhen(e.at, now) : "")}</td>` +
      `<td class="ld-hact"><button class="ld-rbtn ld-again" title="${tc("重新设置同样的锁定", "Set up the same lockdown again")}">${tc("再玩一次", "Play again")}</button>` +
      `<button class="ld-rbtn ld-del" title="${tc("从历史中移除", "Remove from history")}" aria-label="${tc("移除", "Remove")}">${TRASH}</button></td></tr>`;
  }

  function rowHtml(e, now) {
    const kind = e.kind && e.kind !== "performer" && KINDS[e.kind] ? kl(e.kind) : "";
    const from = /^(random from |从收藏中随机|从推荐中随机|从\u201c)/.test(e.how || "") ? e.how : "";
    const note = [kind, from].filter(Boolean).join(" · ");
    const pills = (e.goal ? `<span class="ld-pill">${escapeHtml(goalLabel(e.goal))}</span>` : "") +
      (typeof e.heat === "number" ? heatPill(e.heat)
        : e.difficulty && tc(DIFF_LABEL_ZH[e.difficulty], DIFF_LABEL[e.difficulty]) ? `<span class="ld-pill ld-d-${e.difficulty}">${tc(DIFF_LABEL_ZH[e.difficulty], DIFF_LABEL[e.difficulty])}</span>` : "");
    const detail = entryDetail(e);
    const scorePill = e.score ? `<span class="ld-pill ld-scorepill" title="${tc("分数", "Score")}">${Number(e.score).toLocaleString()}</span>` : "";
    const watched = e.v >= 3 ? tc(` · 观看 ${fmtMinutes((e.watchedMs || 0) / 60000)}`, ` · watched ${fmtMinutes((e.watchedMs || 0) / 60000)}`) : "";
    return `<div class="ld-row ${e.result}" data-key="${escapeHtml(entryKey(e))}">${icon(e)}` +
      `${pfHtml(e, e.name, e.image, "xs")}` +
      `<span class="ld-rmain"><span class="ld-rname">${escapeHtml(e.name || "?")}${note ? `<small>${escapeHtml(note)}</small>` : ""}</span>` +
        `<span class="ld-rsub">${scorePill}${pills}${detail ? `<em>${escapeHtml(detail)}</em>` : ""}</span>` +
        `${e.pics > 0 ? `<span class="ld-rpics">${escapeHtml(picsText(e.pics))}</span>` : ""}${momentsHtml(e)}</span>` +
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
                                     ...setOf(e) } });
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
        <li><b>锁给谁。</b> 一名演员、一对双人（两位演员，任一位的场景都算）、一个工作室（含其子工作室）或一个标签（含其子标签）。锁定期间，
          Stash 只打开他们的场景、图片和画廊，在你所有设备上都是如此。</li>
        <li><b>怎么出去。</b> <i>完成</i>：射出来就出局。<i>计时</i>：等它走完。<i>边缘</i>：在设定时间内忍住不射；
          每次 O 都算一次失误，会加时间。一旦达标你就出局、分数入账；你可以在那里射出来，也可以进入加时继续：
          每多看一分钟再加 10 分（乘以热度），最多再补一个目标时长。再往后不再加分，锁定会一直持续到一次 O 或按「停止加时」。</li>
        <li><b>热度。</b> 各种条件让这一盘更难。每一点热度给分数加 20%。没有必选的条件：
          热度 0 就是无负担的一盘。<i>禁止快进</i>把速度锁在 1 倍速，并隐藏时间轴的预览图。
          <i>盯着画面</i>：场景播放时，切换标签页、最小化浏览器或用别的应用超过 5 秒就算离开：
          这段时间不计入目标，并且每 2 秒扣 1 分（视频仍在播放）。</li>
        <li><b>分数。</b> 观看分钟数 × 10，每次跳过减 5（最多扣掉观看所得的一半），边缘模式每次 O 减 100，边缘加时每分钟加 10，每张新图片加 1（最多 100），每离开 2 秒减 1（盯着画面），出局再加 100，全部
          再乘以热度加成。只有成功出局的对局才计分。</li>
        <li><b>图片。</b> 这一盘里的图片，你看满 3 秒（在 Slideshow、图片页或 Stash 的查看器里）就算一分，
          一盘最多 100 张，且这张图没有被之前出局的对局计过分。</li>
        <li><b>时间轴。</b> 你看过的部分显示为蓝色。在那里拖动是免费的；其他地方会用掉一次跳过（见
          跳过配额）。</li>
        <li><b>瞬间。</b> 在一盘中给某个场景添加标记，且你已看过它 2 分钟，就算作你找到的一个瞬间：
          每个场景一个，每盘五个。有跳过配额时，它给该场景多一次跳过。这一盘会列出它们，并链接到对应位置。</li>
        <li><b>牌。</b> 每看满 10 分钟会来一张「坚持」牌：盯着画面 2 分钟（+30），或 Stay 5 / Stay 10——在同一个场景停留那么久
          （+40 / +100；中途打开别的场景会丢掉这张牌，场景放完则重播）。标签牌（你的收藏标签或你挑的标签）
          会打开一个带该标签的场景，10 分钟后回来。有跳过配额时，每 10 分钟来一张跳过牌（最多 3 张）：
          给跳过次数用尽的场景再补一次，或每张留到出局 +15。对局后段还会有「竞赛」：播放它，然后在
          3 分钟内射出来 +100，否则 −50。</li>
        <li><b>卡住了？</b> 在顶栏里长按 <i>放弃</i> 5 秒。会记为一次放弃；前 2 分钟内则算取消，什么都不记。</li></ol>
      <button class="ld-link" data-a="gotit">知道了</button></div>`, `<div class="ld-guide" data-a="guide">
      <b>How a run works</b>
      <ol>
        <li><b>Who.</b> A performer, a duo (two performers: a scene of either counts), a studio (with its sub-studios) or a
          tag (with its sub-tags). While you're locked, Stash only opens their scenes, images and galleries, on every device.</li>
        <li><b>Way out.</b> <i>Finish</i>: finish to get out. <i>Timer</i>: wait it out. <i>Edge</i>: watch for the set time
          without finishing; each O is a slip that adds time. Once you reach it you're out and the score is banked; you can
          finish there or keep going in overtime: each minute watched adds 10 more (times heat), up to the target's length
          again. Past that it scores nothing more, and the lock holds until an O or Stop overtime.</li>
        <li><b>Heat.</b> Conditions make the run harder. Each point of heat adds 20% to your score. None are required:
          heat 0 is a free run. <i>No fast-forward</i> holds the speed at 1x and hides the timeline's preview pictures.
          <i>Eyes on screen</i>: while a scene plays, switching tabs, minimising the browser or using another app for more
          than 5 seconds is away: that time doesn't count toward your target and costs a point every 2 seconds (the video
          keeps playing).</li>
        <li><b>Score.</b> Watched minutes × 10, minus 5 per skip (at most half of what watching earned), minus 100 per O in Edge, plus 10 per minute of Edge overtime, plus 1 per new picture viewed (up to 100), minus 1 per 2 seconds away (Eyes on screen), plus 100 for getting out, all
          times your heat bonus. Only runs you get out of are scored.</li>
        <li><b>Pictures.</b> Each of the run's pictures you look at for 3 seconds (in Slideshow, on its page or in Stash's viewer) is a point,
          up to 100 a run, if no run you got out of counted it before.</li>
        <li><b>The timeline.</b> What you've watched shows blue. Seeking there is free; anywhere else uses a skip (see
          Skip budget).</li>
        <li><b>Moments.</b> Add a marker to a scene during a run, once you've watched 2 minutes of it, and it counts as a
          moment you found: one per scene, five per run. With a Skip budget it gives that scene one more skip. The run
          lists them, linked to the spot.</li>
        <li><b>Cards.</b> A hold card comes every 10 minutes watched: eyes on the screen for 2 minutes of playing (+30), or Stay 5 / Stay 10,
          that long on one scene (+40 / +100; opening another scene loses the card, if the scene ends it plays again). Tag cards (your favourite tags, or the ones you pick)
          open a scene with that tag and come back after 10 minutes watched. With a Skip budget, a skip card comes every 10 minutes (3 at most):
          one more skip on a scene that is out of them, or +15 each kept to the end. Late in the run comes the Race: play it, then finish within
          3 minutes for +100, or lose 50.</li>
        <li><b>Stuck?</b> Hold <i>Give up</i> in the bar for 5 seconds. It counts as a give-up; in the first 2 minutes it is a cancel and counts for nothing.</li></ol>
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
    // 2.12.2: a preset, Play again or the last setup with Blind seeking loads
    // without it and says so, once: here, not on each re-render, and the
    // dialog's own setup is stored without it (render's setPref), so the
    // default does not say it again. A stored preset is left as it is.
    if (retiredIn(pf.setup || prefs().setup).length) ldToast(retiredNote(), "info");
    let target = pf.target ? { ...pf.target, id: String(pf.target.id) } : null;
    let src = pf.src || null;            // random pick: { type: "fav" } | { type: "filter", id, name }
    if (target) { S.kind = target.kind; S.pick = "choose"; }
    // Tags can be several (2.2, user feedback): `tagList`, joined by AND or OR;
    // `target` is then the combination (see tagTarget).
    let tagList = target && target.kind === "tag"
      ? (target.tags && target.tags.length ? target.tags.map((x) => ({ id: String(x.id), name: x.name })) : [{ ...target }]) : [];
    if (target && target.mode) S.tagMode = target.mode === "or" ? "or" : "and";
    let tagCount = null, countSeq = 0;
    // 2.14: a duo: `pairing` while the next pick becomes the second
    // performer; `duoCount` their scenes and images (null while counted)
    let pairing = false, duoCount = null;
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
      <section class="ld-card ld-stepc" data-step="1"><div class="ld-sh"><span class="ld-snum" data-a="num1">1</span><span class="ld-stitle">${tc("你被锁给了谁？", "Who are you locked to?")}</span>
          <span class="ld-ssum" data-a="sum1"></span></div>
        <div class="ld-choices ld-tiles3" data-a="kinds">${Object.keys(KINDS).map((k) =>
          `<button class="ld-choice ld-tile3" data-k="${k}"><b>${KIND_ICON[k]} <span>${kindTile()[k][0]}</span></b><small>${kindTile()[k][1]}</small>${TICK_HTML}</button>`).join("")}</div>
        <div class="ld-pickrow"><div class="ld-seg" data-a="pick"><button data-p="choose">${tc("我来挑", "I'll choose")}</button><button data-p="random">${tc("随机抽取", "Random pick")}</button></div>
          <div class="ld-search" data-a="choosebox">${SEARCH}<input data-a="q" autocomplete="off" spellcheck="false"></div></div>
        <div data-a="choose"><div class="ld-results" data-a="results"></div></div>
        <div data-a="random"><div class="ld-srcs" data-a="srcs"></div>
          <div class="ld-hint">${tc("按下开始后轮盘转动。", "The wheel spins when you press Start.")}</div></div>
        <div class="ld-recs" data-a="recs" hidden></div>
      </section>
      <section class="ld-card ld-stepc" data-step="2"><div class="ld-sh"><span class="ld-snum" data-a="num2">2</span><span class="ld-stitle">${tc("你怎么出去？", "How do you get out?")}</span>
          <span class="ld-ssum" data-a="sum2"></span></div>
        <div class="ld-choices ld-tiles3" data-a="goals">${Object.entries(goalInfo()).map(([k, [t, , ico]]) =>
          `<button class="ld-choice ld-tile3" data-g="${k}"><b>${ico} ${t}</b><small>${goalTile()[k]}</small>${TICK_HTML}</button>`).join("")}</div>
        <div class="ld-opts ld-optwell" data-a="goalopt"></div>
        <div class="ld-hint" data-a="goalhint"></div></section>
      <section class="ld-card ld-stepc" data-step="3"><div class="ld-sh"><span class="ld-snum" data-a="num3">3</span><span class="ld-stitle">${tc("热度", "Heat")}</span>
          <span class="ld-ssum"><span class="ld-heatsum" data-a="heatsum"></span><button class="ld-link ld-clearheat" data-a="clearheat">${tc("清除", "Clear")}</button></span></div>
        <div class="ld-heatbar" data-a="heatbar"></div>
        <div class="ld-hint">${tc("条件让对局更难；每点热度给分数加 20%。点一下条件升一档，或点某个点直接选那一档。", `Conditions make the run harder; each point of heat adds 20% to your score. Click a condition to
          raise it a rank, or a dot to pick its rank.`)}</div>
        <div class="ld-conds" data-a="conds"></div></section>
      <section class="ld-card ld-stepc" data-step="4"><div class="ld-sh"><span class="ld-snum" data-a="num4">4</span><span class="ld-stitle">${tc("你手里的牌", "Cards in your hand")}</span>
          <span class="ld-ssum" data-a="sum4">${tc("对局中想用时再打出", "play them when you like during the run")}</span></div>
        <div class="ld-pcards" data-a="cardtags"></div>
        <div class="ld-cardadd" data-a="cardaddbox" hidden><div class="ld-search">${SEARCH}<input data-a="cardq" placeholder="${tc("搜索要加为标签牌的标签", "Search a tag to add as a card")}" autocomplete="off" spellcheck="false" aria-label="${tc("搜索要加为标签牌的标签", "Search a tag to add as a card")}"></div>
          <div class="ld-results" data-a="cardres"></div></div>
        <div class="ld-cardfoot" data-a="cardfoot"></div></section>
      </div>
      <aside class="ld-runcard" aria-label="${tc("你的这一盘", "Your run")}">
        <div class="ld-cap">${tc("你的这一盘", "Your run")}</div>
        <div class="ld-rcwho ld-hero" data-a="rcwho"></div>
        <div class="ld-rcheat"><div class="ld-rct"><span class="ld-bigflame">${FLAME}</span><b data-a="heat">0</b><small>${tc("热度", "heat")}</small></div>
          <div class="ld-rct ld-rcx"><b data-a="mult">×1</b><small>${tc("分数", "score")}</small></div></div>
        <div class="ld-rcchips" data-a="rcchips"></div>
        <button class="ld-start" data-a="start">${LOCK_SVG} ${tc("开始这一盘", "Start run")}</button>
        <div class="ld-err" data-a="err"></div>
        <div class="ld-rcformula" data-a="formula"></div>
        <div class="ld-rcfoot"><div data-a="howscore"></div>
          <div class="ld-psave" data-a="psave"><button class="ld-link" data-a="savepreset">${tc("保存为预设", "Save as preset")}</button></div></div>
        <div class="ld-foot">${tc("锁定这台 Stash 上的所有设备 · 按住放弃 5 秒可退出 ·", "Locks every device on this Stash · hold Give up for 5 s to quit ·")}
          <button class="ld-link ld-soundbtn" data-a="sound"></button></div>
      </aside>
      </div>
      ${into ? "" : `<div class="ld-hist" data-a="hist"><div class="ld-empty">${tc("正在加载历史…", "Loading history…")}</div></div>
      <button class="ld-close" data-a="close">${tc("稍后再说", "Not now")}</button>`}`;
    const box = into ? into : modal(html);
    if (into) into.innerHTML = html;
    const $ = (a) => box.querySelector(`[data-a="${a}"]`);
    const err = (t) => { $("err").textContent = t || ""; };
    $("close")?.addEventListener("click", closeModal);
    let topRuns = [], bestHeat = 0, presets = [];
    // 2.9: Recommended: the lists (null while read), the chip, who ran lately
    let recs = recCached(), recErr = "", recRecent = new Set(), recLong = new Set();
    let recChip = recChipOk(src && src.type === "rec" ? src.chip : prefs().recChip);
    // 2.11: the shown-cards store, this dialog's draws (memoised per draw, so
    // re-renders never move the cards), and the history for the novelty bonus
    let recStore = recSeenLoad(), histList = null;
    const recMemo = new Map();
    // review L8: a quick Random pick waits for this read, or it could land on
    // someone run yesterday
    const cfgReady = readConfig().then((d) => {
      topRuns = (d.stats && d.stats.top) || [];
      bestHeat = (d.stats && d.stats.bestHeat) || 0;
      presets = d.presets || [];
      recRecent = recentPerformers(d.list, Date.now());
      recLong = recentPerformers(d.list, Date.now(), REC_LONG_MS);
      histList = d.failed ? null : d.list || [];
      if (box.isConnected) { render(); renderPresets(); renderRecs(); if (S.pick === "random") renderSources(); }
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
    // 2.16: tag cards: the favourite tags (read once) unless chosen by hand
    // 2.17: as playing cards: the hold card (it explains itself), then each
    // tag card with its picture and how many of the chosen target's scenes
    // have it (user: "so I know picking up that card would make sense"),
    // counted again when the target, the tags or Unwatched only change (one
    // aliased count query, countCardTags); a tag with none is greyed: the
    // run leaves it out (beginNow). An "Add a tag card" tile opens the search.
    let cardFavs = null, cardRes = [], cardTimer = null, cardSeq = 0, cardAdd = false;
    let cardCounts = { key: "", by: null, total: null }, cardCountSeq = 0;
    const cardList = () => (S.cards ? S.cards : (cardFavs || []).slice(0, CARD_TAGS_MAX));
    const cardTarget = () => (S.pick === "choose" && target && target.kind === S.kind ? target : null);
    const tKey = (t) => perfKey({ ...t, tid: String(t.id), pid: (t.kind || "performer") === "performer" ? String(t.id) : undefined });
    const tProbe = (t, fresh) => ({ kind: t.kind, tid: String(t.id), tags: t.tags, mode: t.mode, duo: t.duo, rules: { fresh: !!fresh } });
    const noTagCards = () => !!(S.conds && S.conds.one && S.goal === "timer");
    const recountCards = () => {
      const t = cardTarget(), list = cardList(), fresh = rulesOf(S).fresh;
      const key = t && list.length ? `${tKey(t)}|${fresh ? 1 : 0}|${list.map((x) => x.id).join(",")}` : "";
      if (key === cardCounts.key) return;
      cardCounts = { key, by: null, total: null };
      if (!key) return;
      const mine = ++cardCountSeq, probe = tProbe(t, fresh);
      Promise.all([countCardTags(probe, list, fresh), sceneCount(probe)])
        .then(([ns, total]) => {
          if (mine !== cardCountSeq || !box.isConnected) return;
          const by = {};
          list.forEach((x, i) => { by[x.id] = ns[i]; });
          cardCounts = { key, by, total };
          render();
        })
        .catch(() => { if (mine === cardCountSeq && box.isConnected) { cardCounts = { key, by: {}, total: null, failed: true }; render(); } });
    };
    // how many cards the run would hold: the hold card, the Race (2.19),
    // skip cards with a Skip budget (2.20) and the tag cards with scenes
    const cardsInHand = () => {
      if (pickedImageOnly()) return 0;
      const list = noTagCards() ? [] : cardList(), by = cardTarget() ? cardCounts.by : null;
      return 2 + (S.conds && S.conds.skip ? 1 : 0) + (by && !cardCounts.failed ? list.filter((x) => by[x.id] > 0).length : list.length);
    };
    // 2.19: when the Race comes, by way out
    const raceWhen = () => (S.goal === "timer" ? tc("过了大半时间", "past half the time") : S.goal === "edge" ? tc("加时开始时", "when overtime starts")
      : tc(`看满 ${RACE_FINISH_AFTER_MS / 60000} 分钟${S.conds && S.conds.slow ? "，O 已计入" : ""}`, `after ${RACE_FINISH_AFTER_MS / 60000} min watched${S.conds && S.conds.slow ? ", once O's count" : ""}`));
    const renderCards = () => {
      const el = $("cardtags");
      if (!el) return;
      recountCards();
      const list = cardList(), t = cardTarget(), by = cardCounts.by, io = pickedImageOnly(), none = noTagCards();
      const hold = HOLD_KINDS.eyes, s5 = HOLD_KINDS.stay5, s10 = HOLD_KINDS.stay10;
      const stays = !(S.conds && ((S.conds.one && S.goal === "timer") || S.conds.stay));
      // 2.19: the deal brings Eyes on screen or a Stay card
      let h = `<div class="ld-pcard ld-pchold${io ? " ld-off" : ""}" style="--c:var(--sx-cy)"><span class="ld-pkind">${tc("坚持牌", "Hold cards")}</span><span class="ld-pico">${COND_ICON.eyes}</span>` +
        `<span class="ld-pcname">${stays ? tc("盯着画面或 Stay", "Eyes on screen or Stay") : tc("盯着画面", escapeHtml(hold.name))}</span><span class="ld-pmeta">${io ? tc("图片对局没有牌", "No cards in a run of images")
          : stays ? tc(`盯着画面：${Math.round(hold.ms / 60000)} 分钟，+${hold.pts}。在同一个场景 Stay 5 / 10：停留则 +${s5.pts} / +${s10.pts}。` + `每看满 ${HOLD_EVERY_MS / 60000} 分钟来一张。`, `Eyes: ${Math.round(hold.ms / 60000)} min, +${hold.pts}. Stay 5 / 10 on one scene: +${s5.pts} / +${s10.pts} if you stay. ` + `One every ${HOLD_EVERY_MS / 60000} min watched.`)
          : tc(`播放 ${Math.round(hold.ms / 60000)} 分钟，+${hold.pts}。每看满 ${HOLD_EVERY_MS / 60000} 分钟来一张，保留 ${HOLD_LASTS_MS / 60000} 分钟。`, `${Math.round(hold.ms / 60000)} min of playing, +${hold.pts}. One every ${HOLD_EVERY_MS / 60000} min watched, kept ${HOLD_LASTS_MS / 60000} min.`)}</span></div>`;
      h += `<div class="ld-pcard ld-pchold${io ? " ld-off" : ""}" style="--c:var(--sx-or)"><span class="ld-pkind">${tc("竞赛牌", "Race card")}</span><span class="ld-pico">${CARD_ICON.race}</span>` +
        `<span class="ld-pcname">${tc("竞赛", "Race")}</span><span class="ld-pmeta">${io ? tc("图片对局没有牌", "No cards in a run of images")
          : tc(`每盘一次，${escapeHtml(raceWhen())}。播放它，然后在 ${RACE_MS / 60000} 分钟内射出来：+${RACE_WIN}，否则 −${RACE_LOSE}。`, `Once a run, ${escapeHtml(raceWhen())}. Play it, then finish within ${RACE_MS / 60000} min: +${RACE_WIN}, or −${RACE_LOSE}.`)}</span></div>`;
      // 2.20: skip cards, with a Skip budget
      if (S.conds && S.conds.skip) h += `<div class="ld-pcard ld-pchold${io ? " ld-off" : ""}" style="--c:var(--sx-or)"><span class="ld-pkind">${tc("跳过牌", "Skip cards")}</span><span class="ld-pico">${COND_ICON.skip}</span>` +
        `<span class="ld-pcname">${tc("跳过牌", "Skip card")}</span><span class="ld-pmeta">${io ? tc("图片对局没有牌", "No cards in a run of images")
          : tc(`每看满 ${SKIP_CARD_EVERY_MS / 60000} 分钟来一张，最多 ${SKIP_CARD_MAX} 张：给跳过次数用尽的场景再补一次，或每张留到出局 +${SKIP_CARD_PTS}。`, `One every ${SKIP_CARD_EVERY_MS / 60000} min watched, ${SKIP_CARD_MAX} at most: one more skip on a scene that is out of them, or +${SKIP_CARD_PTS} each kept to the end.`)}</span></div>`;
      h += list.map((x, i) => {
        const n = !t ? undefined : by && !cardCounts.failed ? (by[x.id] || 0) : by ? undefined : null;
        const off = n === 0 || none || io;
        const pic = tagPic(x.image_path);
        const meta = io ? tc("图片对局没有牌", "No cards in a run of images") : none ? tc("单一场景：这一盘没有标签牌", "One scene: no tag cards in this run")
          : n === undefined ? (t ? tc("没有统计：Stash 没有回应", "Not counted: Stash didn't answer") : tc("按你锁定的人来统计", "Counted for the one you're locked to")) : cardCountText(n, cardCounts.total, t);
        const pct = n && cardCounts.total ? Math.max(3, Math.min(100, Math.round((n / cardCounts.total) * 100))) : 0;
        const bold = n > 0 && meta.startsWith(`${n} `);
        return `<div class="ld-pcard ld-pctag${off ? " ld-off" : ""}" style="--c:var(--sx-ma)">` +
          `<button class="ld-px" data-uncard="${i}" aria-label="${tc("移除 ", "Remove ")}${escapeHtml(x.name)}" title="${tc("移除这张牌", "Remove this card")}">${X_SVG}</button>` +
          (pic ? `<span class="ld-pprev">${cardPicHtml(pic, x.name, renderCards)}</span><span class="ld-pkind">${tc("标签牌", "Tag card")}</span>`
            : `<span class="ld-pkind">${tc("标签牌", "Tag card")}</span><span class="ld-pico">${TAG_ICON}</span>`) +
          `<span class="ld-pcname">${escapeHtml(x.name)}</span>` +
          `<span class="ld-pmeta">${bold ? `<b>${n}</b>${escapeHtml(meta.slice(String(n).length))}` : escapeHtml(meta)}</span>` +
          (pct && !off ? `<span class="ld-pbar"><i style="width:${pct}%"></i></span>` : "") + `</div>`;
      }).join("");
      if (!list.length) h += `<div class="ld-pcard ld-pcnote"><span class="ld-pmeta">${cardFavs === null && !S.cards ? tc("正在读取你的收藏标签…", "Reading your favourite tags…")
        : tc("没有标签牌：加一张，或在 Stash 里把标签标为收藏。", "No tag cards: add one, or mark tags as favourites in Stash.")}</span></div>`;
      if (list.length < CARD_TAGS_MAX) h += `<button class="ld-pcard ld-padd" data-a="cardadd" aria-expanded="${cardAdd}">${PLUS_SVG}` +
        `<span class="ld-paddt">${tc("加一张标签牌", "Add a tag card")}</span><span class="ld-pmeta">${tc(`搜索任意标签；最多 ${CARD_TAGS_MAX} 张`, `search any tag; ${CARD_TAGS_MAX} at most`)}</span></button>`;
      el.innerHTML = h;
      $("cardaddbox").hidden = !cardAdd || list.length >= CARD_TAGS_MAX;
      $("cardres").innerHTML = cardRes.map((r, i) => `<div class="ld-res" data-cardadd="${i}">${pfHtml(null, r.name, r.image_path, "xs", "tag")}<span class="ld-rname">${escapeHtml(r.name)}</span>` +
        `<span class="ld-rmeta">${r.scene_count !== undefined ? plural(r.scene_count, "scene", "scenes") : ""}</span></div>`).join("");
      $("cardfoot").innerHTML = `<span class="ld-hint">${tc(`${S.cards ? "你的标签牌" : "来自你的收藏标签"}${t ? `，按 ${escapeHtml(t.name)} 统计` : ""}。`, `${S.cards ? "Your tag cards" : "From your favourite tags"}${t ? `, counted for ${escapeHtml(t.name)}` : ""}. `)}` +
        `${tc("对局场景都没有的标签会被略去。", "A tag none of the run's scenes have is left out.")}</span>` + (S.cards ? `<button class="ld-link" data-a="cardfav">${tc("用我的收藏标签", "Use my favourite tags")}</button>` : "");
      const n = cardsInHand();
      $("sum4").innerHTML = io ? tc("图片对局没有牌", "none in a run of images") : `<b>${plural(n, "card", "cards")}</b> · ${tc("对局中想用时再打出", "play them when you like during the run")}`;
    };
    listOf("tag", { favorite: true }, { per_page: -1 }).then((l) => { cardFavs = l.map((t) => ({ id: String(t.id), name: t.name, n: t.scene_count || 0, ...cardPic(t) }))
      .sort((a, b) => b.n - a.n); if (box.isConnected) render(); }).catch(() => { cardFavs = []; if (box.isConnected) render(); });
    box.addEventListener("click", (e) => {
      const un = e.target.closest && e.target.closest("[data-uncard]");
      const add = e.target.closest && e.target.closest("[data-cardadd]");
      const fav = e.target.closest && e.target.closest('[data-a="cardfav"]');
      const open = e.target.closest && e.target.closest('[data-a="cardadd"]');
      if (!un && !add && !fav && !open) return;
      e.stopPropagation();
      if (open) { cardAdd = !cardAdd; render(); if (cardAdd) setTimeout(() => $("cardq").focus(), 0); return; }
      if (un) { S.cards = cardList().filter((_, i) => i !== +un.dataset.uncard); }
      else if (add) {
        const t = cardRes[+add.dataset.cardadd], cur = cardList();
        if (t && !cur.some((x) => x.id === String(t.id))) S.cards = normaliseCardTags(cur.concat({ id: String(t.id), name: t.name, image_path: t.image_path }));
        $("cardq").value = ""; cardRes = [];
        if (cardList().length >= CARD_TAGS_MAX) cardAdd = false;
      } else S.cards = null;
      setPref("setup", S);
      render();
    });
    $("cardq").addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Escape") { $("cardq").value = ""; cardRes = []; cardAdd = false; render(); } });
    $("cardq").addEventListener("input", () => {
      clearTimeout(cardTimer);
      const term = $("cardq").value.trim();
      if (!term) { cardRes = []; renderCards(); return; }
      cardTimer = setTimeout(() => { const mine = ++cardSeq; searchTargets("tag", term).then((r) => { if (mine === cardSeq) { cardRes = r; renderCards(); } }).catch(() => {}); }, 180);
    });
    const soundLabel = () => { $("sound").textContent = prefs().sound === false ? tc("声音关闭", "Sounds off") : tc("声音开启", "Sounds on"); };
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
            `<span class="ld-tagchip">${pfHtml(null, x.name, x.image_path, "xxs", "tag")}${escapeHtml(x.name)}<button data-untag="${i}" aria-label="${tc("移除 ", "Remove ")}${escapeHtml(x.name)}">×</button></span>`).join("")}
            <span class="ld-tagmore">${tagList.length < 6 ? tc("搜索以再加一个", "search to add another") : ""}</span></div>
          ${two ? `<div class="ld-tagmode"><span class="ld-seg ld-mini"><button data-tm="and" class="${S.tagMode !== "or" ? "ld-on" : ""}">${tc("且", "AND")}</button>` +
            `<button data-tm="or" class="${S.tagMode === "or" ? "ld-on" : ""}">${tc("或", "OR")}</button></span>` +
            `<span class="ld-hint">${tagCount === null ? tc("统计中…", "Counting…") : !tagCount ? "" : !tagCount.s && !tagCount.i
              ? `<b class="ld-coral">${tc(`没有场景或图片带这些标签中的${S.tagMode === "or" ? "任一个" : "全部"}。`, `No scene or image has ${S.tagMode === "or" ? "any" : "all"} of these.`)}</b>`
              : `${tc(`${tagCount.s ? plural(tagCount.s, "scene", "scenes") : `${plural(tagCount.i, "image", "images")}（仅图片）`} ${S.tagMode === "or" ? "带其中任意一个" : "带全部"}。`, `${tagCount.s ? plural(tagCount.s, "scene", "scenes") : `${plural(tagCount.i, "image", "images")} (images only)`} ${S.tagMode === "or" ? "with any of these" : "with all of these"}.`)}`}</span></div>` : ""}`;
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
      // 2.14: a duo: the two, each with an x, and what they bring together
      // 2.17: as the chosen card, the two portraits overlapping
      if (!typed && S.kind === "performer" && duoOf(target)) {
        $("results").innerHTML = `<div class="ld-chosen ld-chduo">${pfHtml(target, target.name, target.image_path, "m")}<div class="ld-chmain">` +
          `<div class="ld-tagpick">${target.duo.map((x, i) => `${i ? `<span class="ld-tagjoin">&amp;</span>` : ""}` +
            `<span class="ld-tagchip">${escapeHtml(x.name)}` +
            `<button data-unduo="${i}" aria-label="${tc("移除 ", "Remove ")}${escapeHtml(x.name)}">×</button></span>`).join("")}</div>` +
          `<small>${duoCount === null ? tc("统计中…", "Counting…") : !duoCount ? ""
            : !duoCount.s && !duoCount.i ? `<b class="ld-coral">${tc("他们两位都没有场景或图片。", "Neither of them has a scene or image.")}</b>`
            : tc(`${duoCount.s ? plural(duoCount.s, "scene", "scenes") : `${plural(duoCount.i, "image", "images")}（仅图片）`} 任一人的都算。`, `${duoCount.s ? plural(duoCount.s, "scene", "scenes") : `${plural(duoCount.i, "image", "images")} (images only)`} with either of them.`)}` +
            `${duoCount && duoCount.s && whoN.u !== null && whoN.key === tKey(target) ? ` ${tc(`${whoN.u} 张未看过。`, `${whoN.u} unwatched.`)}` : ""}</small></div>` +
          `<button class="ld-xbtn" data-a="unpick" aria-label="${tc("清除双人", "Clear the duo")}" title="${tc("清除", "Clear")}">${X_SVG}</button></div>` +
          `<div class="ld-pairrow"><span class="ld-hint">${tc("双人：任一人的场景都算", "a duo: a scene of either of them counts")}</span></div>`;
        $("results").querySelectorAll("[data-unduo]").forEach((b) => b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const keep = target.duo[1 - +b.dataset.unduo];
          target = { kind: "performer", id: keep.id, name: keep.name, image_path: keep.image_path, scene_count: keep.scene_count, image_count: keep.image_count };
          duoChanged();
        }));
        wireUnpick();
        return;
      }
      // 2.17: the one chosen, as a card: their portrait, what they bring,
      // Pair with someone and x
      if (!typed && target && target.kind === S.kind && S.kind !== "tag") {
        $("results").innerHTML = `<div class="ld-chosen">${pfHtml(target, target.name, target.image_path, "m")}<div class="ld-chmain">` +
          `<b>${escapeHtml(target.name)}</b><small>${escapeHtml(chosenMeta(target))}</small></div>` +
          (S.kind === "performer" ? `<button class="ld-btn" data-a="pair">${PLUS_SVG} ${pairing ? tc("在上方搜索第二位演员", "Search above for the second performer") : tc("与某人配对", "Pair with someone")}</button>` : "") +
          `<button class="ld-xbtn" data-a="unpick" aria-label="${tc("清除 ", "Clear ")}${escapeHtml(target.name)}" title="${tc("清除", "Clear")}">${X_SVG}</button></div>`;
        wireUnpick();
        // 2.14: one performer chosen: pair them with someone, and who goes
        // well with them (from Neglected, Backlog and Discover)
        if (S.kind === "performer") {
          const mates = mateCards(recs, target.id, recLong, rulesOf(S).fresh).slice(0, REC_MATES_SHOW);
          $("results").insertAdjacentHTML("beforeend", `<div class="ld-pairrow"><span class="ld-hint">${tc("与某人配对成双人：任一人的场景都算", "Pair with someone for a duo: a scene of either of them counts")}</span></div>` +
            (mates.length ? `<div class="ld-matehead">${tc(`与 ${escapeHtml(target.name)} 很搭`, `Goes well with ${escapeHtml(target.name)}`)}</div><div class="ld-reclist ld-mates">${mates.map((x, i) =>
              `<button class="ld-reccard" data-mate="${i}" title="${escapeHtml(x.why)}">${pfHtml(null, x.name, x.image_path, "s", "performer")}` +
              `<span><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.why)}</small></span></button>`).join("")}</div>` : ""));
          $("results").querySelector('[data-a="pair"]').addEventListener("click", (ev) => {
            ev.stopPropagation();
            pairing = true;
            $("q").placeholder = tc("搜索第二位演员", "Search the second performer");
            renderResults();
            $("q").focus();
          });
          $("results").querySelectorAll("[data-mate]").forEach((b) => b.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const x = mates[+b.dataset.mate];
            if (!x) return;
            recStore = recSeenPick(recStore, x.id, Date.now());
            recSeenSave(recStore);
            target = duoTarget([target, x]);
            duoChanged();
          }));
        }
        return;
      }
      const list = typed ? results : [];
      if (!list.length) {
        $("results").innerHTML = typed ? `<div class="ld-hint">${tc(`没有带场景或图片的${label()}匹配“${escapeHtml(typed)}”。`, `No ${label()} with scenes or images matches “${escapeHtml(typed)}”.`)}</div>` : "";
        return;
      }
      hi = Math.min(hi, list.length - 1);
      $("results").innerHTML = list.map((p, i) =>
        `<div class="ld-res${i === hi && typed ? " ld-hi" : ""}${target && String(p.id) === target.id && target.kind === S.kind ? " ld-sel" : ""}" data-i="${i}">` +
        `${pfHtml(null, p.name, p.image_path, "xs", S.kind)}<span class="ld-rname">${escapeHtml(p.name)}</span>` +
        `<span class="ld-rmeta">${imageOnly(p) ? `${plural(p.image_count, "image", "images")} · <i>${tc("仅图片", "images only")}</i>`
          : p.scene_count !== undefined ? plural(p.scene_count, "scene", "scenes") : ""}</span><span class="ld-tick">✓</span></div>`).join("");
      $("results").querySelectorAll(".ld-res").forEach((el) => el.addEventListener("click", () => {
        pickTarget(list[+el.dataset.i]);
      }));
    };
    // 2.17: x on the chosen card clears the pick
    const wireUnpick = () => $("results").querySelector('[data-a="unpick"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      target = null; pairing = false; duoCount = null;
      err("");
      renderResults(); render(); renderRecs();
      $("q").focus();
    });
    // 2.17: what the chosen one brings: "46 scenes · 12 unwatched · last
    // locked to 41 days ago" (unwatched counted once a pick, whoN)
    let whoN = { key: "", u: null }, whoSeq = 0;
    const wantWho = (t) => {
      const key = t && !imageOnly(t) ? tKey(t) : "";
      if (key === whoN.key) return;
      whoN = { key, u: null };
      if (!key) return;
      const mine = ++whoSeq;
      sceneCount(tProbe(t, true)).then((u) => { if (mine === whoSeq && box.isConnected) { whoN = { key, u }; renderResults(); render(); } }).catch(() => {});
    };
    const lastLocked = (t) => {
      const k = tKey(t);
      const at = (histList || []).filter((e) => e && typeof e.at === "number" && perfKey(e) === k).reduce((a, e) => Math.max(a, e.at), 0);
      if (!histList) return "";
      if (!at) return tc("从未锁定过", "never locked to");
      const d = Math.floor((Date.now() - at) / DAY_MS);
      return tc(`上次锁定于 ${d < 1 ? "今天" : d === 1 ? "昨天" : `${d} 天前`}`, `last locked to ${d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`}`);
    };
    const sceneN = (t) => (t.tags && t.tags.length > 1 ? (tagCount && tagCount.s) : duoOf(t) ? (duoCount && duoCount.s) : t.scene_count);
    const chosenMeta = (t) => {
      if (imageOnly(t)) return `${plural(t.image_count, "image", "images")} · ${tc("仅图片", "images only")}`;
      const n = sceneN(t), u = whoN.key === tKey(t) ? whoN.u : null;
      return [typeof n === "number" ? plural(n, "scene", "scenes") : "", u !== null ? tc(`${u.toLocaleString()} 张未看过`, `${u.toLocaleString()} unwatched`) : "", lastLocked(t)].filter(Boolean).join(" · ");
    };
    // 2.14: the duo as one target: the first one's id and picture, both in `duo`
    const duoTarget = (two) => {
      const duo = duoMembers(two).map((p, i) => ({ ...p, scene_count: two[i].scene_count, image_count: two[i].image_count }));
      return { kind: "performer", id: duo[0].id, name: duoName(duo), image_path: duo[0].image_path, duo };
    };
    let duoSeq = 0;
    const duoChanged = () => {
      if (duoOf(target)) picked();
      pairing = false;
      duoCount = null;
      $("q").value = "";
      results = [];
      err("");
      renderResults();
      render();
      renderRecs();
      if (!duoOf(target)) return;
      const mine = ++duoSeq, probe = { kind: "performer", tid: target.id, duo: target.duo };
      Promise.all([sceneCount(probe), imageCount(probe)])
        .then(([n, ni]) => { if (mine === duoSeq) { duoCount = { s: n, i: ni }; renderResults(); render(); } })
        .catch(() => { if (mine === duoSeq) { duoCount = undefined; renderResults(); } });
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
      if (target) picked();
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
      const one = { kind: S.kind, id: String(p.id), name: p.name, image_path: p.image_path, scene_count: p.scene_count, image_count: p.image_count };
      // 2.14: after "Pair with someone", the pick is the second of a duo
      if (S.kind === "performer" && pairing && target && target.kind === "performer" && !duoOf(target) && target.id !== one.id) {
        target = duoTarget([target, one]);
        duoChanged();
        return;
      }
      pairing = false;
      target = one;
      picked();
      $("q").value = "";
      results = [];
      err("");
      renderResults();
      render();
      renderRecs();
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

    // 2.9: the Recommended block: four chips, each its own ranking; a card
    // picks that performer (as I'll choose does)
    // 2.15.1: Neglected and Backlog (and a Duos partner, who comes from them)
    // leave out 3 months of runs, the rest 7 days
    const recFor = (chip) => (recs && recs.lists ? recShown(recs.lists[recChipOk(chip)], REC_LONG_CHIPS.has(recChipOk(chip)) ? recLong : recRecent, rulesOf(S).fresh)
      .filter((x) => !(Array.isArray(x.duo) && x.duo[1] && recLong.has(String(x.duo[1].id)))) : []);
    // 2.11: the draw for a chip today: seeded by the day, the chip and the
    // Shuffle presses; kept for this dialog
    const recKey = (chip) => recDrawKey(dayKey(Date.now()), chip, (recStore.shuf.n || {})[recChipOk(chip)] || 0);
    const recOpts = (chip) => ({ now: Date.now(), seen: recStore, rest: REC_RESTS.has(recChipOk(chip)) });
    const recCards = (chip) => {
      const pool = recFor(chip);
      const key = recKey(chip);
      const memo = `${key}|${recs && recs.at}|${rulesOf(S).fresh ? 1 : 0}|${pool.map((x) => x.id).join(",")}`;
      if (!recMemo.has(memo)) recMemo.set(memo, recDraw(pool, { ...recOpts(chip), seed: hashStr(key), k: REC_SHOW, key }));
      return recMemo.get(memo);
    };
    const wantRecs = () => {
      if (S.kind !== "performer" || recs || recLoading) return;
      recErr = "";
      loadRecs(false).then((c) => { recs = c; }, (e) => { recErr = e.message || String(e); })
        .then(() => { if (box.isConnected) { renderRecs(); renderResults(); if (S.pick === "random") renderSources(); } });
    };
    // a card is the chosen one (a duo card: the same two)
    const recSel = (x) => !!target && target.kind === "performer" &&
      (duoOf(x) ? !!duoOf(target) && perfKey(target) === perfKey(x) : !duoOf(target) && target.id === String(x.id));
    const renderRecs = () => {
      const el = $("recs");
      if (!el) return;
      el.hidden = S.kind !== "performer";
      if (el.hidden) return;
      if (S.pick === "random") renderSources();   // its Recommended row follows the chip and the lists
      const chips = REC_CHIPS.map(([k]) => `<button class="ld-chip${k === recChip ? " ld-on" : ""}" data-rchip="${k}">${recChipLabel(k)}</button>`).join("");
      const list = recCards(recChip);
      const body = recErr ? `<div class="ld-hint">${tc("无法得出推荐：", "Couldn't work out recommendations:")} ${escapeHtml(recErr)} <button class="ld-link" data-a="recagain">${tc("重试", "Try again")}</button></div>`
        : !recs ? loadingHtml(tc("正在想该推荐谁…", "Working out who to suggest…"))
        : !list.length ? `<div class="ld-hint">${tc(`目前没有人符合「${escapeHtml(recChipLabel(recChip))}」${rulesOf(S).fresh ? "（带未看过场景）" : ""}。`, `Nobody fits ${escapeHtml(recChipLabel(recChip))} right now${rulesOf(S).fresh ? " with unwatched scenes" : ""}.`)}</div>`
        : `<div class="ld-reclist">${list.map((x, i) => `<button class="ld-reccard${recSel(x) ? " ld-sel" : ""}" data-rec="${i}" title="${escapeHtml(x.why)}">` +
            `${pfHtml(x, x.name, x.image_path, "h", "performer")}<span><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.why)}</small></span></button>`).join("")}</div>`;
      el.innerHTML = `<div class="ld-rechead"><span class="ld-plabel">${tc("推荐", "Recommended")}</span><span class="ld-filters">${chips}</span></div>${body}` +
        // 2.11: Shuffle draws again from the lists already worked out (no
        // query); Update reads Stash again (the old Refresh)
        (recs && !recErr ? `<div class="ld-hint ld-recfoot">${tc(`过去 7 天没锁过（久未光顾和待看积压为 3 个月），至少 3 个场景${recs.rt ? "；你的 Ratings Toolkit 分数也算" : ""}。`, `Not locked to in the last 7 days (3 months for Neglected and Backlog), 3 scenes or more${recs.rt ? "; your Ratings Toolkit scores count" : ""}. `)}` +
          `<button class="ld-link" data-a="recshuffle" title="${tc("从同样的名单里再抽几张牌", "Draw other cards from the same lists")}">${tc("换一批", "Shuffle")}</button> · ` +
          `<button class="ld-link" data-a="recagain" title="${tc("重新读取 Stash 并重算名单", "Read Stash again and work the lists out anew")}">${tc("更新", "Update")}</button>` +
          `<span class="ld-recago">${tc("算出于 ", "worked out ")}${escapeHtml(agoText(recs.at, Date.now()))}</span></div>` : "");
      // the cards shown count as shown once per draw (they weigh less for a few days unless picked)
      if (list.length) {
        const r = recSeenAdd(recStore, list.map((x) => x.id), recKey(recChip), Date.now());
        if (r.changed) { recStore = r.store; recSeenSave(recStore); }
      }
      el.querySelector('[data-a="recshuffle"]')?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        recStore = recShuffle(recStore, recChip, Date.now());
        recSeenSave(recStore);
        renderRecs();
      });
      el.querySelectorAll("[data-rchip]").forEach((b) => b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        recChip = b.dataset.rchip;
        setPref("recChip", recChip);
        if (src && src.type === "rec") src = { type: "rec", chip: recChip };
        renderRecs();
        if (S.pick === "random") { renderSources(); render(); }
      }));
      el.querySelectorAll("[data-rec]").forEach((b) => b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const x = list[+b.dataset.rec];
        if (!x) return;
        recStore = recSeenPick(recStore, x.id, Date.now());
        recSeenSave(recStore);
        S.pick = "choose";
        // 2.14: a Duos card picks both
        if (duoOf(x)) { target = duoTarget(x.duo); duoChanged(); return; }
        pickTarget({ id: x.id, name: x.name, image_path: x.image_path, scene_count: x.scene_count, image_count: x.image_count });
        renderRecs();
      }));
      el.querySelector('[data-a="recagain"]')?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        recs = null; recErr = "";
        renderRecs();
        loadRecs(true).then((c) => { recs = c; }, (e) => { recErr = e.message || String(e); })
          .then(() => { if (box.isConnected) { renderRecs(); if (S.pick === "random") renderSources(); } });
      });
    };

    const renderSources = () => {
      const k = S.kind;
      const row = (key, ico, name, meta, cls = "") =>
        `<div class="ld-res${src && srcKey(src) === key ? " ld-sel" : ""}${cls}" data-src="${escapeHtml(key)}">` +
        `<span class="ld-av">${ico}</span><span class="ld-rname">${escapeHtml(name)}</span>` +
        `<span class="ld-rmeta">${escapeHtml(meta)}</span><span class="ld-tick">✓</span></div>`;
      let html = row("fav", HEART, tc("收藏", "Favourites"), favN === null ? "…" : favN ? kp(k, favN) : `${tc("没有收藏的" + ((KIND_ZH[k] || {}).plural || k), `no favourite ${KINDS[k].plural}`)}`);
      // 2.9: the active Recommended chip's list, its best REC_SPIN, by score
      if (k === "performer") {
        const n = Math.min(REC_SPIN, recFor(recChip).length);
        html += recChip === "duos" ? row("rec", STAR, tc("推荐 · 双人", "Recommended · Duos"), tc("手动挑选", "picked by hand"), " ld-cant")
          : row("rec", STAR, tc(`推荐 · ${recChipLabel(recChip)}`, `Recommended · ${recChipLabel(recChip)}`), recErr ? tc("不可用", "can't use") : !recs ? "…" : n ? tc(`前 ${n} 位`, `top ${plural(n, "performer", "performers")}`) : tc("没有人符合", "nobody fits"), recErr ? " ld-cant" : "");
      }
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
        else if (key === "rec") {
          // 2.14: duos are suggested, never drawn
          if (recChip === "duos") { err(DUO_RANDOM); return; }
          src = { type: "rec", chip: recChip };
        }
        else { const f = saved.find((x) => `f:${x.id}` === key); if (f) src = { type: "filter", id: String(f.id), name: f.name }; }
        err("");
        renderSources();
        render();
      }));
    };
    const srcKey = (s) => (s.type === "fav" ? "fav" : s.type === "rec" ? "rec" : `f:${s.id}`);
    const loadSources = () => {
      const k = S.kind, mine = ++srcSeq;
      favN = null; saved = [];
      if (src && src.type === "rec" && k !== "performer") src = null;
      wantRecs();
      renderRecs();
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
      (target.tags ? !!tagCount && !tagCount.s && tagCount.i > 0 : duoOf(target) ? !!duoCount && !duoCount.s && duoCount.i > 0 : imageOnly(target));
    let lastImg = null, lastFresh = rulesOf(S).fresh;
    // 2.12: the conditions a run would start with: Toy in charge needs
    // Intiface Sync 1.49 (kept in the setup, so it comes back once it is there)
    const setupConds = () => {
      if (!S.conds.toy || goonApi()) return S.conds;
      const c = { ...S.conds };
      delete c.toy;
      return c;
    };
    // Goon mode's style, level and pace for Toy in charge, and whether
    // Intiface Sync can drive the toy now (the run can start either way)
    const toyOptsHtml = () => {
      const t = normaliseToy(S.toy), st = toyCtl.status();
      const sel = (k, opts, v) => `<select data-toy="${k}" aria-label="${tc(`Goon 模式 ${k}`, `Goon mode ${k}`)}">${opts.map(([o, l]) =>
        `<option value="${o}"${String(v) === String(o) ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>`;
      return `<div class="ld-toyopts" data-a="toyopts"><label>${tc("风格", "Style")} ${sel("style", TOY_STYLES, t.style)}</label>` +
        `<label>${tc("等级", "Level")} ${sel("level", Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)]), t.level)}</label>` +
        `<label>${tc("节奏", "Pace")} ${sel("pace", TOY_PACES, t.pace)}</label>` +
        `<span class="ld-hint ld-toyst${st.ok ? "" : " ld-toyno"}">${st.ok
          ? tc("Intiface Sync 已就绪。对局开始后，按 <b>启动玩具</b>（在顶栏或对局页）。", "Intiface Sync is ready. Once the run begins, press <b>Start the toy</b> (in the bar or on the run page).")
          : tc(`Intiface Sync 现在无法驱动玩具：${escapeHtml(st.why)}。对局仍可开始；玩具只能从「启动玩具」启动，且只有 Goon 模式运行达到观看时间的 ${Math.round(TOY_SHARE * 100)}% 时热度才计入。`, `Intiface Sync can't drive the toy now: ${escapeHtml(st.why)}. The run can still start; the toy starts only from Start the toy, and the heat counts only if Goon mode runs for ${Math.round(TOY_SHARE * 100)}% of your watched time.`)}</span></div>`;
    };

    // 2.17: the steps' badges: the step being set (the last one clicked or
    // typed in) red and outlined, the ones set a green tick, the ones not
    // reached yet grey. Opened with someone already chosen, all are set and
    // the cards are the step at hand; choosing someone moves on to the way out.
    let stepCur = target ? 4 : 1, stepReached = stepCur;
    const stepValid = () => [S.pick === "choose" ? !!(target && target.kind === S.kind) : !!src, true, true, true];
    const renderSteps = () => {
      const v = stepValid(), cur = v[0] || stepCur !== 1 ? stepCur : 1;
      stepStates(cur, stepReached, v).forEach((st, i) => {
        const n = $(`num${i + 1}`), sec = n && n.closest("[data-step]");
        if (!n) return;
        const cls = `ld-snum ld-${st}`;
        if (n.className !== cls) { n.className = cls; n.innerHTML = st === "done" ? TICK_SVG : String(i + 1); }
        if (sec) sec.classList.toggle("ld-cur", st === "now");
      });
    };
    const stepTo = (n) => { if (n !== stepCur) { stepCur = n; stepReached = Math.max(stepReached, n); renderSteps(); } };
    box.addEventListener("pointerdown", (ev) => { const sec = ev.target.closest && ev.target.closest("[data-step]"); if (sec) stepTo(+sec.dataset.step); });
    box.addEventListener("focusin", (ev) => { const sec = ev.target.closest && ev.target.closest("[data-step]"); if (sec) stepTo(+sec.dataset.step); });
    // a pick made: on to the way out
    const picked = () => { if (stepCur === 1) { stepCur = 2; stepReached = Math.max(stepReached, 2); } };

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
      $("choosebox").hidden = S.pick !== "choose";
      $("random").hidden = S.pick !== "random";
      $("q").placeholder = pairing && S.kind === "performer" ? tc("搜索第二位演员", "Search the second performer") : tc(`搜索${(KIND_ZH[S.kind] || {}).plural || KINDS[S.kind].plural}`, `Search ${KINDS[S.kind].plural}`);
      box.querySelectorAll("[data-g]").forEach((b) => b.classList.toggle("ld-on", b.dataset.g === S.goal));
      $("goalopt").innerHTML = S.goal === "finish" ? `<span>${tc("出局条件", "Get out after")}</span>${stepperHtml("os")}`
        : S.goal === "timer" ? `<span>${S.timerBy === "locked" ? tc("锁定", "Locked for") : tc("观看", "Watch for")}</span>${timeHtml("timerMin")}` +
            `<span class="ld-seg ld-mini"><button data-tb="watched" class="${S.timerBy !== "locked" ? "ld-on" : ""}">${tc("观看时间", "watched time")}</button>` +
            `<button data-tb="locked" class="${S.timerBy === "locked" ? "ld-on" : ""}">${tc("锁定时间", "locked time")}</button></span>`
        : `<span>${tc("观看", "Watch")}</span>${timeHtml("edgeMin")}<span>${tc("但不看完", "without finishing")}</span>`;
      const goal = goalOf(S);
      $("goalhint").textContent = S.goal === "finish"
        ? tc("像平时一样在 Stash 里按 O 键；锁局会在几秒内察觉，任何页面、任何设备都行。", "Press the O button in Stash as usual; Lockdown notices within seconds, from any page or device.")
        : S.goal === "timer"
        ? (S.timerBy === "locked" ? tc("计时在你锁定期间一直在走。", "The clock runs whenever you're locked.") : tc("只有场景真正播放的时间才算。", "Only time a scene is actually playing counts.")) + tc(" O 不会让它提前结束。", " An O doesn't end it early.")
        : tc(`只有场景播放的时间才算。每次 O 都是失误，扣 100 分；${slipText(goal)}。`, `Only time a scene plays counts. Every O is a slip that costs 100 points; ${slipText(goal)}.`) +
          (goal.hidden ? tc(` 隐藏目标：真值在 ${fmtMinutes(hiddenTarget(S.edgeMin, 0))} 到 ${fmtMinutes(hiddenTarget(S.edgeMin, 1))} 之间，结束时揭晓。`, ` Hidden target: the real one is between ${fmtMinutes(hiddenTarget(S.edgeMin, 0))} and ${fmtMinutes(hiddenTarget(S.edgeMin, 1))}, revealed at the end.`) : "");
      // the heat list: conditions for this way out (none for images only)
      // 2.12: Toy in charge without Intiface Sync 1.49 is shown off and adds nothing
      const C = setupConds();
      const heat = io ? 0 : heatOf(C, S.goal);
      const covered = (c) => c.k === "stay" && S.goal === "timer" && !!S.conds.one;   // One scene does it already
      const free = conditions().filter((c) => c.noHeat && condApplies(c, S.goal));
      $("conds").innerHTML = conditions().filter((c) => !c.noHeat && condApplies(c, S.goal)).map((c) => {
        const na = c.needs === "goon" && !goonApi();
        const r = na ? 0 : S.conds[c.k] || 0;
        return `<div class="ld-cond${r ? " ld-on" : ""}${na ? " ld-condna" : ""}" data-cond="${c.k}"${na ? ` aria-disabled="true" title="${TOY_NEEDS}"` : ""}>` +
          `<span class="ld-condico">${COND_ICON[c.k]}</span>` +
          `<span class="ld-condtxt"><b>${escapeHtml(c.name)}</b>${r ? `<em>${escapeHtml(c.ranks[r - 1])}</em>` : na ? `<em class="ld-na">${TOY_NEEDS}</em>` : ""}<small title="${escapeHtml(c.text)}">${escapeHtml(c.text)}</small></span>` +
          `<span class="ld-pips">${c.ranks.map((rk, i) => `<button class="ld-pip${i < r ? " ld-on" : ""}" data-pip="${i + 1}" ` +
            `title="${escapeHtml(rk)} · +${c.heat[i]} ${tc("热度", "heat")}" aria-label="${escapeHtml(c.name)}: ${escapeHtml(rk)}"${na ? " disabled" : ""}></button>`).join("")}</span>` +
          `<span class="ld-condheat"${covered(c) && r ? ` title="${tc("单一场景已经让你停在同一个场景上", "One scene already keeps you on one scene")}"` : ""}>${r ? (covered(c) ? "+0" : `+${c.heat[r - 1]}`) : "0"}</span></div>` +
          (c.k === "toy" && r ? toyOptsHtml() : "");
      }).join("") + (free.length ? `<div class="ld-noheat"><span>${tc("无热度", "No heat")}</span>${free.map((c) =>
          `<button class="ld-nhchip${S.conds[c.k] ? " ld-on" : ""}" data-cond="${c.k}" title="${escapeHtml(c.text)}"><i></i>${COND_ICON[c.k]} ${escapeHtml(c.name)}</button>`).join("")}
          <small>${tc("只是偏好，不是挑战", "a preference, not a challenge")}</small></div>` : "");
      $("conds").classList.toggle("ld-condsoff", io);
      if (io) $("conds").insertAdjacentHTML("afterbegin", `<div class="ld-hint ld-ionote">${tc(`${escapeHtml(target.name)} 只有图片、没有场景：`, `${escapeHtml(target.name)} has images only, no scenes: `)}` +
        `${imagesOk(S) ? tc("图片上的一次 O 也算。条件都是针对场景的，所以这一盘不启用。", "an O on one of the images counts. Conditions are about scenes, so they're off for this run.") : `<b class="ld-coral">${tc("请选完成，或按锁定时间的计时。", "pick Finish, or Timer by locked time.")}</b>`}</div>`);
      // 2.17: the header repeats the heat and what it multiplies; a
      // segmented meter of HEAT_MAX (halves) under it
      $("heatsum").innerHTML = heat ? `${FLAME}<b>${heat}</b> · ${tc("分数", "score")} ×${heatMult(heat)}` : tc("无热度 · 分数 ×1", "no heat · score ×1");
      $("clearheat").hidden = !heat;
      $("heatbar").innerHTML = meterHtml(heat);
      box.querySelectorAll(".ld-stepper").forEach((st) => {
        const shown = SHOW[st.dataset.s](S[st.dataset.s]);
        const b = st.querySelector("b"), inp = st.querySelector("input");
        if (b) b.textContent = shown;
        if (inp && document.activeElement !== inp) inp.value = shown;
      });
      const srcText = src ? (src.type === "fav" ? tc("你的收藏", "your favourites") : src.type === "rec" ? tc(`推荐（${escapeHtml(recChipLabel(src.chip))}）`, `Recommended (${escapeHtml(recChipLabel(src.chip))})`) : `“${escapeHtml(src.name)}”`) : "…";
      const who = S.pick === "choose"
        ? (target && target.kind === S.kind ? `<b>${escapeHtml(target.name)}</b>${S.kind === "performer" ? "" : ` (${label()})`}` : tc(`你挑的${label()}`, `the ${label()} you pick`))
        : tc(`从${srcText}随机抽取的${label()}`, `a random ${label()} from ${srcText}`);
      // the run card: who, the deal, heat, what it is worth
      const tgt = S.pick === "choose" && target && target.kind === S.kind ? target : null;
      if (tgt) wantWho(tgt);
      // 2.17: the steps' headers repeat the choice; their badges say where
      // the setup is (stepStates)
      const n1 = tgt ? sceneN(tgt) : null, u1 = tgt && whoN.key === tKey(tgt) ? whoN.u : null;
      $("sum1").innerHTML = S.pick === "random" ? `<b>${tc(`随机${label()}`, `Random ${label()}`)}</b> · ${tc("来自", "from")} ${srcText}`
        : tgt ? `<b>${escapeHtml(tgt.name)}</b>${imageOnly(tgt) ? tc(" · 仅图片", " · images only") : typeof n1 === "number" ? ` · ${plural(n1, "scene", "scenes")}${u1 !== null ? tc(`, ${u1.toLocaleString()} 张未看过`, `, ${u1.toLocaleString()} unwatched`) : ""}` : ""}`
        : `<span class="ld-muted">${tc(`挑一个${label()}`, `pick a ${label()}`)}</span>`;
      $("sum2").innerHTML = `<b>${escapeHtml(goalLabel(goal))}</b> · ${escapeHtml(goalInfo()[S.goal][1])}`;
      renderSteps();
      const dw = dealWords(goal, false);
      $("rcwho").innerHTML = (tgt ? pfHtml(tgt, tgt.name, tgt.image_path, "xl") : pfHtml(null, "", "", "xl", S.kind)) +
        `<div><b>${S.pick === "choose" ? (tgt ? escapeHtml(tgt.name) : tc(`挑一个${label()}`, `Pick a ${label()}`)) : who}</b>` +
        `<small>${escapeHtml(dw[0])}${dw[1] ? `<br>${escapeHtml(dw[1])}` : ""}</small></div>`;
      $("heat").textContent = String(heat);
      $("mult").textContent = `×${heatMult(heat)}`;
      renderCards();
      const nCards = cardsInHand();
      $("rcchips").innerHTML = `<span class="ld-pill">${goalInfo()[S.goal][2]} ${escapeHtml(goalLabel(goal))}</span>` +
        (io ? `<span class="ld-pill">${tc("仅图片", "images only")}</span>` : "") +
        conditions().filter((c) => !io && C[c.k] && condApplies(c, S.goal))
          .map((c) => `<span class="ld-pill ld-condpill">${COND_ICON[c.k]} ${escapeHtml(c.ranks[C[c.k] - 1])}</span>`).join("") +
        (nCards ? `<span class="ld-pill ld-cardpill">${CARDS_ICON} ${plural(nCards, "card", "cards")}</span>` : "");
      const runs = (histList || []).concat(topRuns).filter((x) => x && x.result !== "gaveup" && x.score > 0 && goalType(x) === S.goal);
      const best = runs.reduce((a, x) => Math.max(a, x.score || 0), 0);
      const onT = tgt ? runs.filter((x) => perfKey(x) === tKey(tgt)).reduce((a, x) => Math.max(a, x.score || 0), 0) : 0;
      // 2.11: the novelty bonus this setup would carry (conditions not used
      // in your last runs of this way out)
      const nv = io || !histList ? { nov: 0, ks: [] } : novelty(C, S.goal, histList);
      // 2.16 (user: "too dense and should be toggled on demand"): the
      // record line stays, how the score works folds away
      // 2.17: the records as three lines (to beat on them, the way out's
      // best, the highest heat got out of)
      const howOpen = !!$("howscore").querySelector("details[open]");
      const formulaText = tc(`分数：观看分钟数 × 10，每次跳过 −5（最多扣一半）`, `Score: watched minutes × 10, −5 per skip (at most half)`) +
        `${S.goal === "edge" ? tc("，每次 O −100，加时分钟 × 10", ", −100 per O, overtime minutes × 10") : ""}, ` +
        tc(`每张新图片 +1（最多 ${PICS_MAX}），每张坚持牌保留 +30（Stay +40 / +100），每张标签牌的标记 +${TAG_MATCH_PTS}，`, `+1 per new picture viewed (up to ${PICS_MAX}), +30 per hold card kept (Stay +40 / +100), +${TAG_MATCH_PTS} per tag card's marker, `) +
        tc(`竞赛 +${RACE_WIN} 或 −${RACE_LOSE}，`, `the Race +${RACE_WIN} or −${RACE_LOSE}, `) +
        `${C.skip ? tc(`每张保留的跳过牌 +${SKIP_CARD_PTS}，`, `+${SKIP_CARD_PTS} per skip card kept, `) : ""}${C.eyes ? tc("每离开 2 秒 −1，", "−1 per 2 s away, ") : ""}` +
        tc(`出局 +100，`, `+100 for getting out, `) +
        tc(`热度 ${heat} × ${heatMult(heat)}`, `× ${heatMult(heat)} for heat ${heat}`) +
        (nv.nov > 0 ? tc(`，新意 × ${Math.round((1 + nv.nov) * 100) / 100}。`, `, × ${Math.round((1 + nv.nov) * 100) / 100} for novelty.`) : tc("。这个出局方式最近 5 盘里没出现的条件每项加 3%（最多 15%）。", ". Each condition not in your last 5 runs of this way out adds 3% (up to 15%)."));
      const rcl = (l, v, cls) => `<div class="ld-rcline"><span>${l}</span><b class="${cls}">${v}</b></div>`;
      $("formula").innerHTML = (onT ? rcl(tc(`要在 ${escapeHtml(tgt.name)} 上超过`, `To beat on ${escapeHtml(tgt.name)}`), onT.toLocaleString(), "ld-gold") : "") +
        (best ? rcl(tc(`最佳${goalInfo()[S.goal][0]}`, `Best ${goalInfo()[S.goal][0]}`), best.toLocaleString(), "ld-hi") : "") +
        (bestHeat ? rcl(tc("出局时的最高热度", "Highest heat got out of"), String(bestHeat), "ld-orange") : "") +
        (nv.nov > 0 ? `<div class="ld-novline">${tc(`最近的新意：${escapeHtml(novNames(nv.ks).join(", "))}，+${Math.round(nv.nov * 100)}%`, `New lately: ${escapeHtml(novNames(nv.ks).join(", "))}, +${Math.round(nv.nov * 100)}%`)}</div>` : "");
      $("howscore").innerHTML = `<details class="ld-howscore"${howOpen ? " open" : ""}><summary>${tc("分数怎么算", "How the score works")}</summary><div>${formulaText}</div></details>`;
      setPref("setup", S);
      const fr = rulesOf(S).fresh;
      if (fr !== lastFresh) { lastFresh = fr; renderRecs(); if (S.pick === "random") renderSources(); }
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
        // 2.12: Toy in charge needs Intiface Sync 1.49 (one left on in a preset can still be turned off)
        if (c.needs === "goon" && !goonApi() && next > 0) { err(tc(`玩具主导需要 ${TOY_NEEDS} 或更新版本，已安装并开启。`, `Toy in charge ${TOY_NEEDS} or later, installed and on.`)); return; }
        S.conds = { ...S.conds, [c.k]: next };
        if (!next) delete S.conds[c.k];
        err("");
        render();
        return;
      }
      const el = ev.target.closest && ev.target.closest("button");
      if (!el || !box.contains(el)) return;
      if (el.dataset.k) {
        if (S.kind !== el.dataset.k) { tagList = []; tagCount = null; pairing = false; duoCount = null; }
        if (S.kind !== el.dataset.k) { S.kind = el.dataset.k; src = null; results = []; $("q").value = ""; loadSources(); renderResults(); }
      } else if (el.dataset.p) {
        S.pick = el.dataset.p;
        if (S.pick === "choose") setTimeout(() => $("q").focus(), 0);
        else renderSources();
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
      if (ev.target.dataset && ev.target.dataset.toy) { ev.stopPropagation(); return; }   // 2.12: the toy's pickers too
      if (!ev.target.dataset || !ev.target.dataset.time) return;
      ev.stopPropagation();                         // Stash's and QuickTools' keys stay out
      if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
    });
    box.addEventListener("change", (ev) => {
      const tk = ev.target.dataset && ev.target.dataset.toy;
      if (tk) { S.toy = normaliseToy({ ...S.toy, [tk]: tk === "level" ? Number(ev.target.value) : ev.target.value }); render(); return; }
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
        if (!target || target.kind !== S.kind) { err(tc(`请先挑一个${label()}：在上方搜索。`, `Pick a ${label()} first: search for one above.`)); $("q").focus(); return; }
        if (target.tags && tagCount && !tagCount.s && !tagCount.i) { err(tc(`没有场景或图片带这些标签中的${S.tagMode === "or" ? "任一个" : "全部"}。`, `No scene or image has ${S.tagMode === "or" ? "any" : "all"} of these tags.`)); return; }
        if (duoOf(target) && duoCount && !duoCount.s && !duoCount.i) { err(tc("他们两位都没有场景或图片。", "Neither of them has a scene or image.")); return; }
        const io = pickedImageOnly();
        if (io && !imagesOk(S)) { err(tc(`${target.name} 只有图片：请选完成，或按锁定时间的计时。`, `${target.name} has images only: pick Finish, or Timer by locked time.`)); return; }
        const run = io ? { ...S, conds: {} } : { ...S, conds: setupConds() };
        setPref("last", { setup: { ...S }, target });
        // 2.16: a few Stash reads come first; the button says so meanwhile
        const sb = $("start");
        sb.disabled = true; sb.innerHTML = `${LOCK_SVG} ${tc("锁定中…", "Locking…")}`;
        begin(target, "chosen", run).finally(() => { if (sb.isConnected) { sb.disabled = false; sb.innerHTML = `${LOCK_SVG} ${tc("开始这一盘", "Start run")}`; } });
        return;
      }
      if (!src) { err(tc("请选择随机抽取的来源。", "Pick where the random pick comes from.")); return; }
      const btn = $("start");
      btn.disabled = true;
      try {
        if (src.type === "rec") {
          if (S.kind !== "performer") { err(tc("推荐只适用于演员。", "Recommended is for performers.")); return; }
          if (src.chip === "duos") { err(DUO_RANDOM); return; }
          if (!recs) recs = await loadRecs(false);
          await cfgReady;
          // 2.11: the wheel weighs like the cards and skips its last 5 picks
          const list = recWheel(recFor(src.chip), recStore, { ...recOpts(src.chip), key: null });
          if (!list.length) { err(tc(`目前没有符合「${recChipLabel(src.chip)}」的人选。`, `Nobody fits ${recChipLabel(src.chip)} right now.`)); return; }
          setPref("last", { setup: { ...S }, src });
          spin(list.map((x) => ({ ...x, kind: "performer" })), tc(`从推荐中随机（${recChipLabel(src.chip)}）`, `random from recommended (${recChipLabel(src.chip)})`), { ...S, conds: setupConds() }, true,
               (p) => recSeenSave(recSpinAdd(recSeenLoad(), p.id, Date.now())));
          return;
        }
        const f = src.type === "filter" ? saved.find((x) => String(x.id) === src.id) : null;
        if (src.type === "filter" && !f) { err(tc("那个已保存的筛选器不见了。", "That saved filter is gone.")); return; }
        const list = src.type === "fav" ? await favouritesOf(S.kind, imagesOk(S)) : await targetsFor(S.kind, f, imagesOk(S));
        if (!list.length) { err(tc(`那里没有带${imagesOk(S) ? "场景或图片" : "场景"}的${kl(S.kind)}可供抽取。`, `No ${KINDS[S.kind].plural} with ${imagesOk(S) ? "scenes or images" : "scenes"} to pick from there.`)); return; }
        setPref("last", { setup: { ...S }, src });
        const how = src.type === "fav" ? tc("从收藏中随机", "random from favourites") : tc(`从“${src.name}”随机`, `random from “${src.name}”`);
        spin(list.map((x) => ({ ...x, kind: S.kind })), how, { ...S, conds: setupConds() });
      } catch (e) {
        err(`${tc("无法从中挑选：", "Can't pick from that:")} ${e.message}.`);
      } finally { if (btn.isConnected) btn.disabled = false; }
    };
    $("start").addEventListener("click", start);

    render();
    loadSources();
    renderResults();
    if (duoOf(target)) duoChanged();
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
      // 2.16 (user: "the history panel could be also like a table")
      let html = histTableHtml(groups, now, shown);
      if (!matching.length) html = list.length ? emptyHtml(tc("没有匹配项。", "Nothing matches."), tc("换个筛选条件或名称试试。", "Try another filter or name."))
        : emptyHtml(tc("还没有锁局。", "No lockdowns yet."), tc("在第一个标签页开一局；每次锁局都会出现在这里。", "Start a run on the first tab; every lockdown shows up here."));
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
    if (t && ["new", "board", "history", "body"].includes(t)) pageTab = t;
    renderPage();
  }

  function renderPage() {
    if (!pageEl || !pageEl.isConnected) return;
    // The suite's page frame (B1): icon, title and a muted line on the left,
    // the tab strip on the right, each tab with its icon and its colour.
    // 2.17: while locked to a performer (or a duo), Body stats: Performers
    // Toolkit's own Body section (bodyTabOk), never for a studio or tags
    const body = bodyTabOk(lock, window.PerformersToolkit);
    if (pageTab === "body" && !body) pageTab = "new";
    const tabs = [["new", lock ? tc("你的对局", "Your run") : tc("新对局", "New run"), LOCK_LINE, "var(--sx-re)"]]
      .concat(body ? [["body", tc("身体数据", "Body stats"), BODY_LINE, "var(--sx-bl)"]] : [])
      .concat([["board", tc("排行榜", "Leaderboard"), CROWN_LINE, "var(--sx-ye)"], ["history", tc("历史", "History"), HISTORY_LINE, "var(--sx-pu)"]]);
    const sub = lock ? tc(`锁定到 ${lock.name}`, `Locked to ${lock.name}`) : tc("锁定到一位演员、一对双人、一个工作室或标签，直到你出局", "Locked to one performer, a duo, a studio or tags until you get out");
    // 2.17: while locked the header says so, with the time (updateLive)
    pageEl.innerHTML = `<div class="ld-pagehead"><div class="ld-ptitle"><h2>${LOCK_SVG} ${tc("锁局", "Lockdown")}</h2>` +
      (lock ? `<span class="ld-lockpill" title="${escapeHtml(sub)}"><i></i><span data-a="lockpill">${tc("已锁定", "Locked")} · ${escapeHtml(fmtDuration(Date.now() - lock.startedAt))}</span></span>`
        : `<span class="ld-psub">${escapeHtml(sub)}</span>`) + `</div><div class="ld-tabs">` +
      tabs.map(([k, l, ico, c]) => `<button data-tab="${k}" class="${k === pageTab ? "ld-on" : ""}" style="--tc:${c}">${ico}<span>${l}</span></button>`).join("") +
      `</div></div><div class="ld-pagebody" data-a="pbody"></div>`;
    pageEl.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { pageTab = b.dataset.tab; renderPage(); }));
    const pb = pageEl.querySelector('[data-a="pbody"]');
    if (pageTab === "new") {
      if (lock) renderLive(pb);
      else { const pf = pagePrefill; pagePrefill = null; openStart(pf, pb); syncSoon(); }   // 2.11: idle tabs read every minute; look now
    } else if (pageTab === "body") {
      renderBody(pb);
    } else if (pageTab === "board") {
      pb.innerHTML = loadingHtml(tc("正在读取你的排行榜…", "Reading your leaderboard…"));
      readConfig().then((d) => { if (pb.isConnected) renderBoard(pb, d); });
    } else {
      pb.innerHTML = loadingHtml(tc("正在读取你的历史…", "Reading your history…"));
      readConfig().then((d) => { if (pb.isConnected) openHistory(d, pb); });
    }
  }

  // 2.10: the Hall of fame (boardHtml, with the pure parts above the test
  // hook). The way out, the period (All time first, the user's choice), Show
  // more and the opened run last while the tab is open. Pictures the runs on
  // screen lack (old runs, the most locked tile) are looked up in one query
  // for all of them, cached for the session, and the board drawn again.
  function renderBoard(box, data) {
    const s = { goal: "all", period: "all", more: false, open: null };
    const top = (data.stats && data.stats.top) || [], list = data.list || [];
    const byId = new Map(list.filter((e) => e && e.id).map((e) => [String(e.id), e]));
    const runs = boardRows(top, "all").map((x) => boardEntry(x, byId.get(String(x.id))));
    // the most locked target's picture, when a run or the history has it
    const most = mostLockedEntry(data.stats), mt = most ? keyTarget(most.key) : null;
    if (mt && mt.id && !lbPics.has(picKey(mt.kind, mt.id))) {
      const had = runs.concat(list).find((e) => e && e.image && (e.kind || "performer") === mt.kind && String(e.tid || e.pid) === mt.id);
      if (had) lbPics.set(picKey(mt.kind, mt.id), had.image);
    }
    let asking = false;
    const askPics = (v) => {
      if (asking) return;
      const items = v.ranked.map((r) => ({ kind: r.x.kind, id: r.x.tid, image: r.x.image }));
      if (mt && mt.id) items.push({ kind: mt.kind, id: mt.id, image: lbPics.get(picKey(mt.kind, mt.id)) });
      const need = portraitNeeds(items, lbPics), q = portraitQuery(need);
      if (!q) return;
      asking = true;
      gql(q.query, q.variables).then((d) => { portraitFill(lbPics, need, d); })
        .catch((e) => { log(`Leaderboard pictures not read: ${e.message}`, "error"); portraitFill(lbPics, need, null); })
        .then(() => { asking = false; if (box.isConnected) draw(); });
    };
    const draw = () => {
      const now = Date.now();
      box.innerHTML = boardHtml(top, list, data.stats, s, now, lbPics, notReadHtml(data));
      wireDots(box);
      askPics(boardView(top, { goal: s.goal, period: s.period, more: true, now, list }));
    };
    box.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (momentClick(ev)) return;
      const g = t.closest("[data-g]");
      if (g) { s.goal = g.dataset.g; s.open = null; s.more = false; draw(); return; }
      const p = t.closest("[data-p]");
      if (p) { s.period = p.dataset.p; s.open = null; s.more = false; draw(); return; }
      if (t.closest('[data-a="lbmore"]')) { s.more = true; draw(); return; }
      if (t.closest('[data-a="lbstart"]')) { pageTab = "new"; renderPage(); return; }
      const a = t.closest("a[data-lbopen]");
      if (a) {
        if (ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault(); navigate(a.getAttribute("href")); return;
      }
      // Same setup again: History's Play again, from the board's run
      const ag = t.closest("[data-again]");
      if (ag) {
        const x = runs.find((r) => String(r.id) === ag.dataset.again);
        if (x) openStart({ setup: setupFromEntry(x),
                           target: x.tid ? { kind: x.kind || "performer", id: String(x.tid), name: x.name, image_path: runPic(x),
                                             ...setOf(x) } : null });
        return;
      }
      const o = t.closest("[data-open]");
      if (o) { s.open = s.open === o.dataset.open ? null : o.dataset.open; draw(); }
    });
    // a podium card is a button for the keyboard too
    box.addEventListener("keydown", (ev) => {
      const o = ev.target && ev.target.matches && ev.target.matches("article[data-open]") ? ev.target : null;
      if (!o || (ev.key !== "Enter" && ev.key !== " ")) return;
      ev.preventDefault();
      s.open = s.open === o.dataset.open ? null : o.dataset.open;
      draw();
      const back = box.querySelector(`article[data-open="${CSS.escape(o.dataset.open)}"]`);
      if (back) back.focus();
    });
    draw();
  }
  // Phones: the podium is a swipe row; its dots follow the card in view.
  function wireDots(box) {
    const row = box.querySelector('[data-a="pod"]'), dots = box.querySelectorAll(".ld-lbdots i");
    if (!row || !dots.length) return;
    row.addEventListener("scroll", () => {
      const mid = row.scrollLeft + row.clientWidth / 2;
      const cards = [...row.children].sort((p, q) => p.offsetLeft - q.offsetLeft);
      let best = 0, d = Infinity;
      cards.forEach((c, i) => { const m = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (m < d) { d = m; best = i; } });
      dots.forEach((x, i) => x.classList.toggle("ld-on", i === best));
    }, { passive: true });
  }

  // The run in progress, on the page's first tab while locked.
  // 2.17: a hero band (the portrait, "Locked to", the deal, the pills) with
  // the way out big at its right (goalParts, pace under it); four numbers; a
  // card with Your hand | Moments; at the right the Scenes card (Back to your
  // scene, Deal another, Pictures, the Roulette round) and the toy. Phones:
  // one column.
  let liveTab = "hand";
  function renderLive(box) {
    const st = edgeState(lock) || "";
    const img = lock.media === "images";
    if (!lock.hand) liveTab = "moments";
    box.innerHTML = `<div class="ld-live" data-st="${st}">
      <section class="ld-lvhero">${pfHtml(lock, lock.name, lock.image, "l")}
        <div class="ld-lvwho"><span class="ld-cap ld-capre">${tc("锁定到", "Locked to")}</span><b class="ld-lvname">${escapeHtml(lock.name)}</b>
          <span class="ld-lvdeal" data-a="lvdeal"></span><div class="ld-rcchips" data-a="lvrules"></div></div>
        <div class="ld-lvprog" data-a="lvprog"></div></section>
      ${st ? overCardHtml(st, "lv") : ""}
      <div class="ld-lvgrid"><div class="ld-lvmain">
        <div class="ld-tiles ld-lvtiles">
          <div class="ld-tile"><b data-a="lvlocked"></b><span>${tc("已锁定", "locked")}</span></div>
          ${img ? `<div class="ld-tile"><b class="ld-blue" data-a="lvpicsn"></b><span>${tc("图片", "pictures")}</span></div>`
            : `<div class="ld-tile"><b class="ld-cyan" data-a="lvwatched"></b><span>${tc("已观看", "watched")}</span></div>
          <div class="ld-tile"><b data-a="lvskips"></b><span data-a="lvskipsl">${tc("已用跳过", "skips used")}</span></div>`}
          <div class="ld-tile"><b class="ld-gold" data-a="lvscore"></b><span>${st ? tc("分数已入账", "score banked") : tc("现在出局的分数", "score if you got out now")}</span></div>
        </div>
        <section class="ld-lvcard">
          <div class="ld-lvtabs"><div class="ld-tabs ld-subtabs" role="tablist" aria-label="${tc("你的对局分区", "Your run sections")}">
            ${lock.hand ? `<button data-lvtab="hand" role="tab" style="--tc:var(--sx-ma)">${CARDS_ICON}<span>${tc("你的手牌", "Your hand")}</span></button>` : ""}
            <button data-lvtab="moments" role="tab" style="--tc:var(--sx-pu)">${MOMENT_ICON}<span>${tc("瞬间", "Moments")}</span></button></div>
            <span class="ld-hint ld-lvtabnote" data-a="lvtabnote"></span></div>
          <div data-a="lvhand"></div>
          <div data-a="lvmoments"></div>
        </section>
        <div class="ld-lvpicn" data-a="lvpicn"></div>
      </div>
      <aside class="ld-lvside">
        <section class="ld-lvcard ld-lvscenes"><b class="ld-lvch">${img ? tc("图片", "Images") : tc("场景", "Scenes")}</b>
          <button class="ld-start ld-lvgo" data-a="lvgo">${img ? tc("回到图片", "Back to the images")
            : lock.rules && lock.rules.random ? (lastShown(lock) ? tc("回到你的场景", "Back to your scene") : tc("发一个场景", "Deal a scene")) : tc("回到场景", "Back to the scenes")}</button>
          <div class="ld-lvrow">${lock.rules && lock.rules.random && !img && !(lock.one && lock.one.id) && lastShown(lock) ? `<button class="ld-start ld-lvgo ld-lvalt" data-a="lvnext">${tc("再发一个", "Deal another")}</button>` : ""}
            <button class="ld-start ld-lvgo ld-lvpics" data-a="lvpics" hidden title="${tc("把本局的图片当作幻灯片播放", "Play the pictures of this run as a slideshow")}">${PICS_ICON} ${tc("图片", "Pictures")}</button></div>
          <div class="ld-lvround" data-a="lvround"></div>
        </section>
        <div data-a="lvtoy"></div>
        <div class="ld-foot">${st ? tc("你已出局：已入账的分数都不会丢失。", "You're out: nothing banked can be lost now.") : tc("在顶栏长按放弃 5 秒即可退出。", "Hold Give up in the bar for 5 seconds to quit.")}</div>
      </aside></div></div>`;
    // 2.16: under Roulette the target's list is closed (a reprimand and a
    // new scene): back to the scene last shown, or a new deal
    box.querySelector('[data-a="lvgo"]').addEventListener("click", () => {
      if (!lock) return;
      if (lock.rules && lock.rules.random && lock.media !== "images") { const id = lastShown(lock); if (id) navigate(`/scenes/${id}`); else goRandom(); return; }
      navigate(listUrl(lock));
    });
    box.querySelector('[data-a="lvnext"]')?.addEventListener("click", () => goRandom());
    box.querySelector('[data-a="lvhand"]').addEventListener("click", handClick);
    box.querySelector('[data-a="lvpics"]').addEventListener("click", playPictures);
    box.querySelectorAll("[data-lvtab]").forEach((b) => b.addEventListener("click", () => { liveTab = b.dataset.lvtab; updateLive(); }));
    wireOver(box);
    box.querySelector('[data-a="lvmoments"]').addEventListener("click", (ev) => momentClick(ev));
    updateLive();
  }

  // 2.17: Body stats: Performers Toolkit draws its own Body section for each
  // performer of the run (a duo: both, one after the other), each under a
  // heading with their name and a link to their page. Lockdown draws nothing
  // of it. Drawn when the tab is opened, not on each tick.
  async function renderBody(box) {
    const pt = window.PerformersToolkit;
    if (!lock || !bodyTabOk(lock, pt)) { box.innerHTML = emptyHtml(tc("没有身体数据", "No body stats"), tc("身体数据仅适用于锁定到演员的对局，且需安装 Performers Toolkit。", "Body stats are for a run locked to a performer, with Performers Toolkit installed.")); return; }
    const who = bodyIds(lock);
    box.innerHTML = `<div class="ld-body">${who.map((p, i) => `<section class="ld-bodysec">` +
      `<div class="ld-bodyhead${i ? " ld-bodynext" : ""}"><b>${escapeHtml(p.name)}</b><span class="ld-hint">${tc("来自 Performers Toolkit", "from Performers Toolkit")}</span>` +
      // under Roulette their page is closed (the lock bounces it): no link
      (lock.rules && lock.rules.random ? "" : `<a class="ld-link" href="/performers/${encodeURIComponent(p.id)}" data-a="bodyopen">${tc("打开 TA 的数据页", "Open their Stats tab")}</a>`) + `</div>` +
      `<div class="ld-bodyin" data-body="${escapeHtml(p.id)}"></div></section>`).join("")}</div>`;
    // Performers Toolkit's links (data-pgo: its page, "Everyone with these";
    // data-ptab: a tab of theirs) would leave the run for pages the lock
    // bounces: only the run's own performer pages it allows go through
    // (routeCheck); its buttons (units, cup, ticks, Show more) keep working
    const wrap = box.querySelector(".ld-body");
    const ids = who.map((p) => p.id);
    wrap.addEventListener("click", (ev) => {
      const t = ev.target.closest && ev.target.closest("[data-pgo], [data-ptab], a[href]");
      if (!t || !wrap.contains(t)) return;
      const sec = t.closest("[data-body]"), d = t.dataset || {};
      const href = d.pgo || (d.ptab && sec ? `/performers/${sec.dataset.body}/${d.ptab}` : t.getAttribute("href"));
      let path = "";
      try { path = new URL(href || "", location.origin).pathname; } catch (_) {}
      const r = path ? routeCheck(path, { kind: "performer", ids }, !!(lock && lock.rules && lock.rules.random)) : null;
      if (r && r.ok) return;
      ev.preventDefault(); ev.stopPropagation();
      ldToast(tc("锁局期间不行：等对局结束后再打开", "Not during a lockdown: open it after the run"), "info");
    }, true);
    box.querySelectorAll('[data-a="bodyopen"]').forEach((a) => a.addEventListener("click", (ev) => {
      if (ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault(); navigate(a.getAttribute("href"));
    }));
    for (const p of who) {
      const el = box.querySelector(`[data-body="${CSS.escape(p.id)}"]`);
      if (!el || !el.isConnected) return;
      try { if (!(await pt.bodyInto(el, p.id)) && el.isConnected && !el.innerHTML.trim()) el.innerHTML = emptyHtml(tc(`没有 ${p.name} 的身体数据`, `No body stats for ${p.name}`), ""); }
      catch (e) { log(`Body stats for ${p.id}: ${e.message}`, "error"); if (el.isConnected) el.innerHTML = emptyHtml(tc(`无法绘制 ${p.name} 的身体数据`, `Body stats for ${p.name} could not be drawn`), e.message); }
    }
  }
  // 2.6: the Edge target reached (Keep going or Finish), or overtime under
  // way (Stop). On the run page and, off it, under the bar (`#ld-over`).
  function overCardHtml(st, p) {
    const cap = otUpTo(lock);
    return st === "reached"
      ? `<div class="ld-otcard"><div class="ld-othead">${DROP}<b>${tc("已达边缘目标：你出局了", "Edge target reached: you're out")}</b></div>
          <div class="ld-otbank">${tc("分数已入账", "Score banked")} <b class="ld-gold" data-a="${p}bank"></b></div>
          <p>${tc(`继续观看可获得加时：每看一分钟多 10 分（乘以热度），最多 ${cap}。超过之后不再计分，锁局会一直保持，直到出现 O 或「停止加时」；已入账的分数不会丢失。`, `Keep going for overtime: every minute you watch adds 10 more (times heat), up to ${cap}. Past that it scores nothing more and the lock holds until an O or Stop overtime; nothing banked is lost.`)}</p>
          <div class="ld-otbtns"><button class="ld-start ld-otgo" data-a="otgo">${tc("继续（加时）", "Keep going (overtime)")}</button>
            <button class="ld-start ld-otfin" data-a="otfin">${tc("完成", "Finish")}</button></div></div>`
      : `<div class="ld-otcard ld-oton"><div class="ld-othead">${DROP}<b data-a="${p}ot"></b></div>
          <div class="ld-otmeter"><i data-a="${p}otbar"></i></div>
          <p>${tc(`最多计 ${cap}；之后锁局保持、不再计分，直到出现 O（自然结束）或「停止加时」。已入账的分数不会丢失。`, `It scores up to ${cap}; after that the lock holds, scoring nothing, until an O (the natural finish) or Stop overtime. Nothing banked is lost.`)}</p>
          <div class="ld-otbtns"><button class="ld-start ld-otfin" data-a="otstop">${tc("停止加时", "Stop overtime")}</button></div></div>`;
  }
  // "12:30 more", or for a hidden target "as long again as the target"
  // (2.12: it is revealed on the result card)
  const otUpTo = (L) => (L && L.goal && L.goal.hidden ? tc("与隐藏目标一样长", "as long again as the hidden target") : tc(`再多 ${fmtClock(overtimeCap(L))}`, `${fmtClock(overtimeCap(L))} more`));
  function wireOver(box) {
    box.querySelectorAll('[data-a="otgo"]').forEach((b) => b.addEventListener("click", keepGoing));
    box.querySelectorAll('[data-a="otfin"]').forEach((b) => b.addEventListener("click", () => end("done")));
    box.querySelectorAll('[data-a="otstop"]').forEach((b) => b.addEventListener("click", () => end("done", tc("加时已停止。", "Overtime stopped."))));
  }
  // The live numbers of the card: the banked score, overtime and its meter.
  function updateOver(box, p) {
    if (!box || !lock) return;
    const set = (a, t) => { const el = box.querySelector(`[data-a="${a}"]`); if (el && el.textContent !== t) el.textContent = t; };
    // 2.12.1: a hidden target's numbers wait for the result card
    const bar = box.querySelector(`[data-a="${p}otbar"]`);
    if (hiddenPast(lock)) {
      set(`${p}bank`, tc("结束时显示", "shown at the end"));
      set(`${p}ot`, tc("已超过目标 · 继续", "Past the target · keep going"));
      if (bar && bar.parentNode && !bar.parentNode.hidden) bar.parentNode.hidden = true;
      return;
    }
    const sc = scoreOf(entryFromLock(lock, "done", Date.now()));
    set(`${p}bank`, sc ? sc.total.toLocaleString() : "–");
    // 2.12: overtime past the cap holds the lock and scores no more
    const ot = overtimeMs(lock), pts = overtimePts(overtimeScored(lock));
    set(`${p}ot`, overtimeFull(lock) ? tc(`加时已满：+${pts} 已入账 · 继续`, `Overtime full: +${pts} banked · keep going`) : tc(`加时 ${fmtClock(ot)}（+${pts}）`, `Overtime ${fmtClock(ot)} (+${pts})`));
    const w = `${overtimeCap(lock) ? Math.min(100, Math.round((ot / overtimeCap(lock)) * 100)) : 0}%`;
    if (bar && bar.style.width !== w) bar.style.width = w;
  }
  function keepGoing() {
    if (edgeState(lock) !== "reached") return;
    lock = startOvertime(lock, Date.now());
    dirty = true;
    writeState(lock);
    saveProgress(true);
    ldToast(tc(`加时：最多计 ${otUpTo(lock)}；锁局会保持，直到出现 O 或「停止加时」。`, `Overtime: it scores up to ${otUpTo(lock)}; the lock holds until an O or Stop overtime.`), true);
    renderBar();
    updateLive();
  }

  // 2.17: goalParts drawn big (the run page's progress block)
  function progBlock(p, pace, up) {
    return `<span class="ld-cap">${escapeHtml(p.cap)}</span>` +
      `<div class="ld-pgt ld-g-${p.cls}"><b>${escapeHtml(p.big)}</b><span>${escapeHtml(p.of)}</span></div>` +
      (p.pct !== null ? `<span class="ld-track ld-g-${p.cls}"><i style="width:${p.pct}%"></i></span>` : "") +
      `<div class="ld-pgfoot"><span>${escapeHtml(p.left)}</span><span class="ld-pgpace${up ? " ld-up" : ""}">${escapeHtml(pace || "")}</span></div>`;
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
    const html = (el, h) => { if (el && el.dataset.k !== h) { el.dataset.k = h; el.innerHTML = h; } };
    const lp = pageEl.querySelector('[data-a="lockpill"]');
    if (lp) { const t = `${tc("已锁定", "Locked")} · ${fmtDuration(now - lock.startedAt)}`; if (lp.textContent !== t) lp.textContent = t; }
    // 2.17: Your hand | Moments, one shown
    if (!lock.hand) liveTab = "moments";
    b.querySelectorAll("[data-lvtab]").forEach((t) => { const on = t.dataset.lvtab === liveTab; if (t.classList.contains("ld-on") !== on) { t.classList.toggle("ld-on", on); t.setAttribute("aria-selected", on ? "true" : "false"); } });
    const ml = momentLinks(lock);
    const mh = ml.length ? momentsHtml(lock) : `<div class="ld-hint">${tc(`还没有瞬间：对局里的场景观看 ${MOMENT_WATCH_S / 60} 分钟后，在场景上添加标记（每个场景一个，每局 ${MOMENTS_MAX} 个）。`, `No moments yet: add a marker to a scene of the run once you've watched ${MOMENT_WATCH_S / 60} minutes of it (one a scene, ${MOMENTS_MAX} a run).`)}</div>`;
    const mb = b.querySelector('[data-a="lvmoments"]');
    html(mb, mh);
    if (mb && mb.hidden !== (liveTab !== "moments")) mb.hidden = liveTab !== "moments";
    const pb = b.querySelector('[data-a="lvpics"]');
    if (pb && pb.hidden !== !picsReady(lock)) pb.hidden = !picsReady(lock);
    // 2.12: a hidden target stays hidden here (dealWords for a run)
    const dw = dealWords(lock.goal, true), dot = (t) => t.replace(/\.$/, "");
    set("lvdeal", dot(dw[0]) + (dw[1] ? ` · ${dw[1].charAt(0).toLowerCase()}${dot(dw[1].slice(1))}` : "") +
      (typeof lock.heat === "number" ? "" : ` · ${tc(DIFF_LABEL_ZH[lock.difficulty] || "经典", DIFF_LABEL[lock.difficulty] || "Classic")}`));
    updateToyCard(b.querySelector('[data-a="lvtoy"]'));
    set("lvlocked", fmtDuration(now - lock.startedAt));
    // 2.16: the way out, big (phones hide the bar's meter), pace, the hand, the round
    // 2.17: the hero's progress block (goalParts, as the bar)
    const gp = goalParts(lock, now, eyesAt);
    html(b.querySelector('[data-a="lvprog"]'), progBlock(gp, paceShown(now), now >= flashUntil && paceUp));
    set("lvpicsn", String((lock.pics || []).length));
    const hb = b.querySelector('[data-a="lvhand"]'), hh = lock.hand ? handHtml(lock.hand, lock.watchedMs || 0, true, liveTab === "hand" ? cardStatsFor(lock) : null) : "";
    html(hb, hh);
    if (hb && hb.hidden !== (liveTab !== "hand")) hb.hidden = liveTab !== "hand";
    set("lvtabnote", liveTab === "hand" ? handNote(lock.hand, lock.watchedMs || 0) : tc(`已找到 ${ml.length} / ${MOMENTS_MAX}`, `${ml.length} of ${MOMENTS_MAX} found`));
    // 2.17: the Roulette round, with a meter
    const rd = dealInfo && dealInfo.id === lock.id && lock.rules && lock.rules.random ? dealInfo : null;
    html(b.querySelector('[data-a="lvround"]'), rd ? `<div class="ld-rcline"><span>${tc(`轮盘进度${duoOf(lock) && rd.side ? `（${escapeHtml((duoOf(lock).find((p) => String(p.id) === rd.side) || {}).name || "")}）` : ""}`, `Roulette round${duoOf(lock) && rd.side ? ` (${escapeHtml((duoOf(lock).find((p) => String(p.id) === rd.side) || {}).name || "")})` : ""}`)}</span>` +
      `<b>${tc(`第 ${rd.n} 个 / 共 ${rd.of} 个场景`, `${rd.n} of ${plural(rd.of, "scene", "scenes")}`)}</b></div><span class="ld-track"><i style="width:${rd.of ? Math.round((rd.n / rd.of) * 100) : 0}%"></i></span>` : "");
    set("lvwatched", hiddenPast(lock) ? tc("已超过目标", "past the target") : fmtDuration(lock.watchedMs || 0));
    set("lvskips", String(skipsUsed(lock)));
    set("lvskipsl", sc && sc.skips && !hiddenPast(lock) ? tc(`已用跳过 · ${sc.skips}`, `skips used · ${sc.skips}`) : tc("已用跳过", "skips used"));
    set("lvpicn", (lock.pics || []).length ? picsText(lock.pics.length) : "");
    set("lvscore", hiddenPast(lock) ? tc("结束时显示", "at the end") : sc ? sc.total.toLocaleString() : "–");
    const chips = lock.conds
      // 2.12.2: a run started before Blind seeking was retired keeps its
      // heat and shows it by name, with no icon (it no longer does anything)
      ? (typeof lock.heat === "number" ? `<span class="ld-pill ld-heatpill" title="${tc("热度", "Heat")}">${FLAME} ${tc("热度", "Heat")} ${lock.heat} · ×${heatMult(lock.heat)}</span>` : "") +
        anyCond().filter((c) => lock.conds[c.k] && condApplies(c, goalType(lock)))
          .map((c) => `<span class="ld-pill ld-condpill">${c.retired ? escapeHtml(c.name) : `${COND_ICON[c.k]} ${escapeHtml(c.ranks[lock.conds[c.k] - 1])}`}</span>`).join("")
      : rulesLabels(lock.rules, lock.goal).map((r) => `<span class="ld-pill">${escapeHtml(r)}</span>`).join("");
    const rl = b.querySelector('[data-a="lvrules"]');
    // 2.16: by a key: the browser writes the SVG back differently, so the
    // markup never matched and the chips were rebuilt every tick
    if (rl && rl.dataset.k !== chips) { rl.dataset.k = chips; rl.innerHTML = chips; }
  }

  // 2.12: Toy in charge on the run page: Goon mode's settings, whether it is
  // running here, the time under it against the watched time (the +2 heat
  // needs TOY_SHARE), its edges and cool-downs, and Start the toy (a click,
  // never by itself). The frame is redrawn only when its state changes, so
  // the button under the pointer is not replaced every tick.
  function updateToyCard(el) {
    if (!el) return;
    if (!lock || !lock.toy) { if (el.innerHTML) { el.innerHTML = ""; el.dataset.k = ""; } return; }
    const t = lock.toy, live = toyCtl.live(lock), av = live ? { ok: true } : toyCtl.status();
    const k = `${live}|${av.ok}|${av.why || ""}|${t.style}|${t.level}|${t.pace}`;
    if (el.dataset.k !== k) {
      el.dataset.k = k;
      const pace = (TOY_PACES.find(([p]) => p === t.pace) || [t.pace, t.pace])[1];
      el.innerHTML = `<div class="ld-toycard${live ? " ld-on" : ""}"><div class="ld-toyhead">${COND_ICON.toy}<b>${tc("玩具主导", "Toy in charge")}</b>` +
          `<span>${escapeHtml(toyStyleName(t.style))} · ${tc("等级", "level")} ${t.level} · ${escapeHtml(pace)}</span></div>` +
        `<p data-a="toyline"></p><p class="ld-toynums" data-a="toynums"></p>` +
        (live ? "" : `<div class="ld-toyact"><button class="ld-start ld-toygo" data-a="toygo">${COND_ICON.toy} ${tc("启动玩具", "Start the toy")}</button>` +
          (av.ok ? "" : `<span class="ld-hint ld-toyno">${escapeHtml(av.missing ? tc("玩具主导需要 Intiface Sync 1.49。", `Toy in charge ${TOY_NEEDS}.`) : tc(`Intiface Sync 现在无法驱动玩具：${av.why}。`, `Intiface Sync can't drive the toy now: ${av.why}.`))}</span>`) + `</div>`) +
        `</div>`;
      el.querySelector('[data-a="toygo"]')?.addEventListener("click", startToyClick);
    }
    const set = (a, x) => { const n = el.querySelector(`[data-a="${a}"]`); if (n && n.textContent !== x) n.textContent = x; };
    const s = live ? toyCtl.state() : null;
    set("toyline", live ? tc(`Goon 模式正在推进蓄力${s && s.stage ? ` · ${String(s.stage)}` : ""}${s && s.level ? ` · ${tc("等级", "level")} ${s.level}` : ""}。`, `Goon mode is driving the build-up${s && s.stage ? ` · ${String(s.stage)}` : ""}${s && s.level ? ` · level ${s.level}` : ""}.`)
      : t.starts ? tc("Goon 模式没有在这里运行：重新启动它，玩具才会继续主导。", "Goon mode isn't running here: start it again to keep the toy in charge.") : tc("还没开始：准备好后按「启动玩具」。", "Not started yet: press Start the toy when you're ready."));
    const ty = toyEarned(lock) || { share: 0, earned: false };
    set("toynums", tc(`玩具主导下已观看 ${fmtDuration(t.ms || 0)}，共观看 ${fmtDuration(lock.watchedMs || 0)}（${Math.round(ty.share * 100)}%；` +
      `+2 热度需要 ${Math.round(TOY_SHARE * 100)}%）${t.edges ? ` · ${t.edges} 次边缘` : ""}${t.cools ? ` · ${t.cools} 次冷却` : ""}`,
      `Under Goon ${fmtDuration(t.ms || 0)} of ${fmtDuration(lock.watchedMs || 0)} watched (${Math.round(ty.share * 100)}%; ` +
      `the +2 heat needs ${Math.round(TOY_SHARE * 100)}%)${t.edges ? ` · ${plural(t.edges, "edge", "edges")}` : ""}${t.cools ? ` · ${plural(t.cools, "cool-down", "cool-downs")}` : ""}`));
  }

  // What Goon mode tells Lockdown while it runs for this run.
  function toyCallbacks() {
    const bump = (k) => { if (!lock || !lock.toy) return; lock.toy = { ...lock.toy, [k]: (lock.toy[k] || 0) + 1 }; dirty = true; writeState(lock); updateLive(); };
    return {
      isCurrent: (id) => !!lock && lock.id === id,
      edge: () => bump("edges"),
      cool: () => bump("cools"),
      stage: () => updateLive(),
      ended: () => {
        if (!lock || !lock.toy) return;
        ldToast(tc("Goon 模式已结束：玩具只在它运行时才主导。请从顶栏或对局页重新启动玩具。", "Goon mode ended: the toy is in charge only while it runs. Start the toy again from the bar or the run page."));
        renderBar(); updateLive();
      },
    };
  }
  // Start the toy: only ever from this click (Goon mode needs the user's
  // gesture, and Lockdown never starts a device by itself). Called at once,
  // before anything is awaited.
  function startToyClick(ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (!lock || !lock.toy) return;
    const L = lock;
    toyCtl.start(L, toyCallbacks()).then((r) => {
      if (!r.ok) { ldToast(tc(`玩具没能启动：${r.why}`, `The toy didn't start: ${r.why}`), "error"); return; }
      if (r.already) return;
      if (lock && lock.id === L.id) { lock.toy = { ...lock.toy, starts: (lock.toy.starts || 0) + 1 }; dirty = true; writeState(lock); saveProgress(true); }
      ldToast(tc("玩具主导：Goon 模式正在推进蓄力", "Toy in charge: Goon mode drives the build-up"), true);
      renderBar(); updateLive();
    });
  }

  // ═══ Spin ══════════════════════════════════════════════════════════════════

  function spin(list, how, setup, weighted, onPick) {
    // decided now, shown last; Recommended weighs each by its score (2.9)
    const pick = weighted ? weightedPick(list, Math.random()) : list[Math.floor(Math.random() * list.length)];
    if (onPick) { try { onPick(pick); } catch (_) {} }
    const box = modal(`<div class="ld-spin"><img alt=""><div class="ld-name"></div><div class="ld-msg">${tc("正在转动…", "Spinning…")}</div></div>`, true);
    const img = box.querySelector("img"), name = box.querySelector(".ld-name");
    const delays = spinSchedule(Math.min(26, Math.max(8, list.length * 3)));
    let i = 0;
    // 2.16: no picture clears the last one (it stayed under the next name)
    const show = (p) => { name.textContent = p.name; if (p.image_path) img.src = p.image_path; else img.removeAttribute("src"); };
    const step = () => {
      if (i >= delays.length - 1) {
        show(pick);
        box.querySelector(".ld-spin").classList.add("ld-landed");
        box.querySelector(".ld-msg").textContent = tc("锁定中…", "Locking in…");
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
                    ...(multi ? { tags: t.tags, mode: t.mode } : {}), ...(duoOf(t) ? { duo: duoMembers(t.duo) } : {}) };
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
    // 2.11: the novelty bonus, from the history as it is now (none when it
    // cannot be read: nothing to compare with)
    let nv = { nov: 0, ks: [] };
    if (t.media !== "images") {
      try { const cfg = await readConfig(); if (!cfg.failed) nv = novelty(S.conds, S.goal, cfg.list); } catch (_) {}
    }
    // 2.16: the tag cards: chosen in the setup, else the favourite tags;
    // only those the target has scenes with, the most scenes first
    let cardTags = [];
    if (t.media !== "images" && !(S.conds && S.conds.one && S.goal === "timer")) {
      try {
        // 2.17: with each tag's picture (the card's preview)
        const pool = (S.cards || (await listOf("tag", { favorite: true }, { per_page: -1 })).map((x) => ({ id: String(x.id), name: x.name, image_path: x.image_path }))).slice(0, 20);
        if (pool.length) {
          const ns = await countCardTags({ ...probe, ...(groups ? { groups } : {}) }, pool, probe.rules && probe.rules.fresh);
          cardTags = pool.map((x, i) => ({ ...x, n: ns[i] })).filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n).slice(0, CARD_TAGS_MAX);
        }
      } catch (e) { log(`Tag cards not read: ${e.message}`, "error"); }
    }
    if (lock) { closeModal(); return; }  // another device's lock arrived meanwhile
    lock = newLock(t, under, S, how, baseO, Date.now(), undefined, groups);
    if (t.media !== "images") { lock.hand = newHand(cardTags); if (S.cards) lock.cardSet = S.cards; }
    if (nv.nov > 0) { lock.nov = nv.nov; lock.novK = nv.ks; }
    // a lock to a performer clears their shown-card count (a pick, not a pass)
    if (t.kind === "performer") {
      let st = recSeenLoad();
      for (const p of duoOf(t) || [t]) st = recSeenPick(st, String(p.id), Date.now());
      recSeenSave(st);
    }
    confirmedId = null;
    resetChecks();
    writeState(lock);
    closeModal();
    sound("start");
    enforce(true);
    pushLock();
    renderPage();
    // 2.12: the toy waits for its button (never started by itself)
    if (lock.toy) ldToast(tc("玩具主导：准备好后在顶栏按「启动玩具」", "Toy in charge: press Start the toy in the bar when you're ready"), true);
    if (lock.rules.random) await goRandom();
    else navigate(listUrl(lock));
  }

  // Ends this lock everywhere: history and totals, and the active lock
  // cleared, in one write. Another device that already recorded it (same
  // id) is not counted twice; a newer lock started elsewhere is left alone.
  const endedIds = new Set();      // runs ended on this device, never adopted again
  // 2.11: and the ones still waiting for their write, after a reload too
  for (const p of pendingRead()) endedIds.add(p.id);
  // `note`: a line for the result card (overtime full, stopped, an O).
  // 2.6: a run past its Edge target always ends got out (endResult), and
  // the counted moments are checked first: a marker deleted since is dropped
  // from the list (its extra skip stays given). If that check fails or is
  // slow, they are all kept (never drop what may still be there).
  function end(result, note) {
    if (!lock) return;
    if (eyesAt) eyesBack(Date.now(), true);   // 2.13.0: a look-away still going counts to here
    const done = lock;
    endedIds.add(done.id);
    lock = null;
    confirmedId = null;
    toyCtl.stop();                 // 2.12: any end ends Goon mode started for the run
    writeState(null);
    clearBar();
    resetChecks();
    const now = Date.now();
    // 2.16: the first 2 minutes, giving up is a cancel: nothing recorded
    const res = cancelResult(done, endResult(done, result), now);
    // the chime already played when the Edge target was reached
    if (res !== "cancelled" && !(res === "done" && done.over)) sound(res === "done" ? "out" : "giveup");
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

  // 2.11 (review M4): the finished run is kept in localStorage before the
  // write and dropped once it lands; a write that fails (Stash restarting,
  // offline, a timeout) is tried again by the next syncs until it lands,
  // never twice (endChange skips an id the history has). 2.10 cleared the
  // lock first and lost score, streak and board place on a failed write.
  function recordEnd(done, found, result, now, note) {
    const p = { id: done.id, done, found: found ? [...found.entries()] : null, result, now };
    pendingWrite(pendingAdd(pendingRead(), p));
    const placeEl = () => document.querySelector('.ld-modal [data-a="place"]');
    writeEnd(p).then((cfg) => {
      const i = boardRows((cfg.stats && cfg.stats.top) || []).findIndex((x) => x.id === done.id);
      const el = placeEl();
      if (el) el.textContent = i >= 0 ? tc(`你的排行榜第 ${i + 1} 名`, `#${i + 1} on your leaderboard`) : "";
      // 2.16: the records it set
      const rec = document.querySelector('.ld-modal [data-a="records"]');
      if (rec && result !== "cancelled") {
        const saved = (cfg.list || []).find((e) => e && e.id === done.id) || entryFromLock(done, result, now);
        const r = recordsOf(saved, cfg.list || [], cfg.stats || {});
        rec.innerHTML = r.map((x) => `<span class="ld-recchip">${escapeHtml(x)}</span>`).join("");
        if (r.some((x) => /^New best|^Best on|^Highest/.test(x))) sound("best");
      }
      if (pageTab !== "new") renderPage();
    }).catch((e) => {
      const el = placeEl();
      if (el) el.textContent = tc("尚未保存：锁局会先留着它，稍后再试", "Not saved yet: Lockdown keeps it and tries again");
      ldToast(tc(`这一盘暂时没能保存（${e.message}）；已先留着，等 Stash 恢复后会再保存`, `The run could not be saved yet (${e.message}); it is kept and saved when Stash answers`), "error");
      // A history that cannot be read must not keep every device locked.
      updateConfig(({ active }) => (active && active.id === done.id ? { active: null } : {})).catch(() => {});
    });
    showResult(entryFromLock(done, result, now), done, now, note);
    renderPage();
  }
  const endWriting = new Set();      // run ids whose end write is out now
  function writeEnd(p) {
    const found = Array.isArray(p.found) ? new Map(p.found) : null;
    endWriting.add(p.id);
    return updateConfig((cur) => endChange(cur, p.done, found, p.result, p.now), false, true)
      .then((cfg) => { pendingWrite(pendingDrop(pendingRead(), p.id)); return cfg; })
      .finally(() => endWriting.delete(p.id));
  }
  // From the sync: every run still waiting, one after another; after a
  // failure the next try waits longer (30 s, doubling, at most 10 min).
  let pendBusy = false, pendFails = 0, pendNext = 0;
  function retryPending() {
    if (pendBusy || Date.now() < pendNext) return;
    const list = pendingRead().filter((p) => !endWriting.has(p.id));
    if (!list.length) return;
    pendBusy = true;
    list.slice().reverse().reduce((ch, p) => ch.then(() => writeEnd(p)), Promise.resolve())
      .then(() => { pendFails = 0; pendNext = 0; ldToast(tc(`之前没保存成的 ${list.length} 盘已保存`, `Saved the finished ${list.length === 1 ? "run" : "runs"} that could not be saved before`), "done"); renderPage(); },
            (e) => { pendFails++; pendNext = Date.now() + backoffMs(pendFails, 30000, 600000); log(`${tc("已结束的对局仍未保存：", "Finished run still not saved:")} ${e.message}`, "error"); })
      .finally(() => { pendBusy = false; });
  }

  // The result card: how it ended, the score's breakdown, the moments.
  function showResult(entry, done, now, note) {
    const result = entry.result;
    const g = goalType(entry);
    const title = result === "cancelled" ? tc("已取消", "Cancelled") : result !== "done" ? tc("放弃锁局", "Lockdown given up")
      : g === "timer" ? tc("时间已满", "Time served") : g === "edge" ? tc("你坚持住了", "You held out") : tc("你出局了", "You got out");
    const sc = scoreOf(entry);
    // overtime has its own line below; 2.13.0: so has Eyes on screen when
    // there is a score to show it in
    const detail = entryDetail({ ...entry, overtimeMs: 0, ...(sc ? { away: undefined } : {}) });
    const gl = entry.goal || {};
    const edgeW = g === "edge" && gl.watchMs ? Math.min(entry.watchedMs || 0, gl.watchMs) : entry.watchedMs;
    const scoreHtml = sc ? `<div class="ld-score">
        <div><span>${tc(`${g === "edge" ? "目标" : "观看"} ${escapeHtml(fmtDuration(edgeW))} × 每分钟 10 分`, `${g === "edge" ? "Target" : "Watched"} ${escapeHtml(fmtDuration(edgeW))} × 10/min`)}</span><b class="ld-blue">${sc.watched}</b></div>
        ${sc.overtime ? `<div><span>${tc(`加时 ${escapeHtml(fmtDuration(Math.min(entry.overtimeMs, gl.watchMs || 0)))} × 每分钟 10 分`, `Overtime ${escapeHtml(fmtDuration(Math.min(entry.overtimeMs, gl.watchMs || 0)))} × 10/min`)}</span><b class="ld-blue">+${sc.overtime}</b></div>` : ""}
        <div><span>${tc(`跳过 ${entry.skipsUsed} × −5${entry.skipsUsed * 5 > -sc.skips ? "（最多扣一半）" : ""}`, `Skips ${entry.skipsUsed} × −5${entry.skipsUsed * 5 > -sc.skips ? " (capped at half)" : ""}`)}</span><b class="ld-coral">${sc.skips}</b></div>
        ${g === "edge" ? `<div><span>${tc(`失误 ${entry.slips || 0} × −100`, `Slips ${entry.slips || 0} × −100`)}</span><b class="ld-coral">${sc.slips}</b></div>` : ""}
        ${sc.pics ? `<div><span>${tc(`图片 ${sc.pics}`, `Pictures ${sc.pics}`)}</span><b class="ld-blue">+${sc.pics}</b></div>` : ""}
        ${sc.holds ? `<div><span>${tc(`坚持 ${sc.holds / HOLD_KINDS.eyes.pts} × +${HOLD_KINDS.eyes.pts}`, `Holds ${sc.holds / HOLD_KINDS.eyes.pts} × +${HOLD_KINDS.eyes.pts}`)}</span><b class="ld-blue">+${sc.holds}</b></div>` : ""}
        ${sc.tagm ? `<div><span>${tc(`标签牌标记 ${sc.tagm / TAG_MATCH_PTS} × +${TAG_MATCH_PTS}`, `Tag card markers ${sc.tagm / TAG_MATCH_PTS} × +${TAG_MATCH_PTS}`)}</span><b class="ld-blue">+${sc.tagm}</b></div>` : ""}
        ${entry.stays ? `<div><span>${tc(`停留牌 ${escapeHtml(staysText(entry.stays))}`, `Stay cards ${escapeHtml(staysText(entry.stays))}`)}</span><b class="${sc.stays < 0 ? "ld-coral" : "ld-blue"}">${sc.stays < 0 ? "−" + -sc.stays : "+" + sc.stays}</b></div>` : ""}
        ${sc.skipc ? `<div><span>${tc(`留存的跳过牌 ${entry.skipCards.kept} × ${SKIP_CARD_PTS}`, `Skip cards kept ${entry.skipCards.kept} × ${SKIP_CARD_PTS}`)}</span><b class="ld-blue">+${sc.skipc}</b></div>` : ""}
        ${entry.race ? `<div><span>${tc(`竞赛 ${escapeHtml(raceText(entry.race))}`, `Race ${escapeHtml(raceText(entry.race))}`)}</span><b class="${sc.race < 0 ? "ld-coral" : "ld-blue"}">${sc.race < 0 ? "−" + -sc.race : "+" + sc.race}</b></div>` : ""}
        ${entry.away ? (sc.away ? `<div><span>${tc(`离开 ${entry.away.n || 1}× · ${escapeHtml(fmtAway(awayMsOf(entry)))}`, `Away ${entry.away.n || 1}× · ${escapeHtml(fmtAway(awayMsOf(entry)))}`)}</span><b class="ld-coral">−${-sc.away}</b></div>`
          : `<div><span>${tc("盯着画面", "Eyes on screen")}</span><b><span class="ld-clean" title="${tc("从未移开视线", "Never looked away")}">${tc("干净", "clean")}</span></b></div>`) : ""}
        <div><span>${tc("出局", "Got out")}</span><b>+${sc.out}</b></div>
        <div class="ld-mline"><span>${FLAME} ${tc("热度", "Heat")} ${sc.heat}</span><b>× ${sc.mult}</b></div>
        ${sc.nov > 0 ? `<div class="ld-mline"><span>${tc(`新颖度：${escapeHtml(novNames(entry.novK).join(", ") || "新条件")}`, `Novelty: ${escapeHtml(novNames(entry.novK).join(", ") || "new conditions")}`)}</span><b>× ${Math.round((1 + sc.nov) * 100) / 100}</b></div>` : ""}
        <div class="ld-total"><span>${tc("分数", "Score")}</span><b class="ld-gold">${sc.total.toLocaleString()}</b></div>
        <div class="ld-place" data-a="place">${tc("保存中…", "Saving…")}</div></div>` : "";
    // 2.11 (review 3.5): one change for the next run, with a button that
    // opens New run set up with it (who is left to choose)
    const sug = result === "done" ? suggestNext(entry, [entry].concat(lastList.filter((e) => e && e.id !== entry.id))) : null;
    const sugHtml = sug ? `<div class="ld-suggest"><span>${tc(`${FLAME} 下一局：${escapeHtml(sug.text)} <small>(${escapeHtml(sug.mult)})</small>`, `${FLAME} Next: ${escapeHtml(sug.text)} <small>(${escapeHtml(sug.mult)})</small>`)}</span>` +
      `<button class="ld-link" data-a="sugnext">${tc("就这样设置", "Set it up")}</button></div>` : "";
    // 2.12: overtime past the cap says how much of it scored
    const otPast = entry.overtimeMs > (gl.watchMs || 0);
    const over = g === "edge" && entry.overtimeMs > 0
      ? `<div class="ld-msg ld-otline">${tc(`目标 ${escapeHtml(fmtClock(gl.watchMs || 0))} · 加时 ${escapeHtml(fmtClock(entry.overtimeMs))} ` +
        `（${otPast ? `${escapeHtml(fmtClock(gl.watchMs || 0))} 已计分，` : ""}+${overtimePts(Math.min(entry.overtimeMs, gl.watchMs || 0))}）`, `Target ${escapeHtml(fmtClock(gl.watchMs || 0))} &middot; Overtime ${escapeHtml(fmtClock(entry.overtimeMs))} ` +
        `(${otPast ? `${escapeHtml(fmtClock(gl.watchMs || 0))} scored, ` : ""}+${overtimePts(Math.min(entry.overtimeMs, gl.watchMs || 0))})`)}</div>` : "";
    // 2.12: Hidden target revealed: the real target, the time that was set,
    // and what the slips made of it
    const need = g === "edge" ? edgeNeedMs({ goal: gl, slips: entry.slips || 0, slipMs: entry.slipMs || 0 }) : 0;
    const reveal = g === "edge" && gl.hidden
      ? `<div class="ld-msg ld-otline ld-reveal">${tc(`隐藏目标是 <b>${escapeHtml(fmtClock(gl.watchMs || 0))}</b>`, `The hidden target was <b>${escapeHtml(fmtClock(gl.watchMs || 0))}</b>`)}` +
        `${gl.about ? tc(`（你设置的约为 ${escapeHtml(fmtMinutes(gl.about / 60000))}）`, ` (you set about ${escapeHtml(fmtMinutes(gl.about / 60000))})`) : ""}${need > (gl.watchMs || 0) ? tc(`；算上失误，${escapeHtml(fmtClock(need))}`, `; with the slips, ${escapeHtml(fmtClock(need))}`) : ""}.</div>` : "";
    const box = modal(`<div class="ld-spin ${result === "done" ? "ld-won" : ""}">
        <div class="ld-endico">${icon(entry)}</div>
        <div class="ld-name">${title}</div>
        <div class="ld-msg">${escapeHtml(done.name)} &middot; ${tc("锁定", "locked")} ${fmtDuration(now - done.startedAt)}${entry.v >= 3 ? ` &middot; ${tc("观看", "watched")} ${fmtDuration(entry.watchedMs)}` : ""}${detail ? ` &middot; ${escapeHtml(detail)}` : ""}</div>
        ${reveal}${over}${note ? `<div class="ld-msg ld-note">${escapeHtml(note)}</div>` : ""}
        ${result === "cancelled" ? `<div class="ld-msg ld-note">${tc("不满 2 分钟：不会记录任何内容，连胜保持不变。", "Under 2 minutes: nothing is recorded and your streak stays.")}</div>` : ""}
        <div class="ld-recchips" data-a="records"></div></div>
        ${momentsHtml(entry) ? `<div class="ld-resmoments">${momentsHtml(entry)}</div>` : ""}
        <div class="ld-storybox" data-a="story"></div>
        ${scoreHtml}
        ${sugHtml}
        <div class="ld-resbtns"><button class="ld-link" data-a="again">${tc("相同设置再来一局", "Same setup again")}</button><button class="ld-close">${tc("关闭", "Close")}</button></div>`);
    box.querySelector('[data-a="again"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeModal();
      if (lock) return;
      openStart({ setup: setupFromEntry(entry), target: { kind: entry.kind || "performer", id: String(entry.tid || entry.pid), name: entry.name,
                                                          image_path: entry.image, ...setOf(entry) } });
    });
    storyFill(box.querySelector('[data-a="story"]'), done);
    box.querySelector(".ld-close").addEventListener("click", closeModal);
    box.querySelector('[data-a="sugnext"]')?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeModal();
      if (lock) return;
      openStart({ setup: { ...setupFromEntry(entry), conds: sug.conds } });
    });
    box.addEventListener("click", (ev) => momentClick(ev, closeModal));
  }

  // 2.16: the run's story on the result card: the scenes in the order they
  // were opened, with the time watched in each, titles read in one query.
  function storyFill(el, done) {
    if (!el || !done || !done.scenes) return;
    const list = Object.entries(done.scenes).filter(([id]) => /^\d+$/.test(id))
      .map(([id, r]) => ({ id, t: (r && r.t0) || 0, sec: watchedSec(rangesOf(r || {})) }))
      .filter((x) => x.sec >= 5).sort((a, b) => a.t - b.t);
    if (!list.length) return;
    const shown = list.slice(0, 12);
    const draw = (titles) => {
      if (!el.isConnected) return;
      el.innerHTML = `<div class="ld-storyhead">${tc(`对局回顾 · 共 ${list.length} 个场景`, `The run · ${plural(list.length, "scene", "scenes")}`)}</div><ol class="ld-story">` +
        shown.map((x) => `<li><a class="ld-mlink" href="/scenes/${x.id}">${escapeHtml((titles && titles.get(x.id)) || tc(`场景 ${x.id}`, `Scene ${x.id}`))}</a>` +
          `<span>${escapeHtml(fmtClock(x.sec * 1000))}</span></li>`).join("") +
        (list.length > shown.length ? `<li class="ld-storymore">${tc(`另外还有 ${list.length - shown.length} 个`, `and ${list.length - shown.length} more`)}</li>` : "") + `</ol>`;
    };
    draw(null);
    gql(`query { ${shown.map((x, i) => `a${i}: findScene(id: "${x.id}") { title files { basename } }`).join(" ")} }`)
      .then((d) => draw(new Map(shown.map((x, i) => { const r = d && d[`a${i}`]; return [x.id, (r && (r.title || (r.files && r.files[0] && r.files[0].basename))) || ""]; }))))
      .catch(() => {});
  }

  // The lock was ended on another device (or its history entry is there):
  // `result` is that entry's, when known.
  function endedElsewhere(result) {
    const name = lock && lock.name;
    if (result) sound(result === "done" ? "out" : "giveup");
    lock = null;
    confirmedId = null;
    toyCtl.stop();                 // 2.12
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
    toyCtl.follow(lock);           // 2.12: a run that replaced ours ends the toy started for it
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
  // 2.8.2: the skip is taken only once another scene is found (a pick that
  // came back empty cost one for nothing), and saved like a seek's; a second
  // press while one is picking is ignored rather than charged twice.
  let picking = false;
  async function goRandom(next) {
    if (!lock) return;
    if (lock.one && lock.one.id) { navigate(`/scenes/${lock.one.id}`); return; }
    if (lock.current && stayBlocks("")) { ldToast(tc("坚持到底：先看完这个场景", "Stay to the end: finish this scene first")); navigate(`/scenes/${lock.current.id}`); return; }
    const cur = sceneHere();
    // 2.9.2 (user): Next scene is always free under Roulette, skips left or
    // not; Stay to the end (above) is the rule that holds a scene, the skip
    // budget is for seeking inside one
    const pay = false;
    if (pay && !nextSceneDecision(lock.scenes && lock.scenes[cur], skipBudget()).allow) { ldToast(nextSceneText("skips")); return; }
    if (picking) return;
    picking = true;
    const L = lock;
    let pick = null;
    try { pick = await randomScene(L, cur); }
    catch (e) { log(`Random scene failed: ${e.message}`, "error"); }
    finally { picking = false; }
    if (!lock || lock.id !== L.id) return;
    // 2.15: a side that dealt all its scenes starts a new round (kept with the lock)
    if (pick && pick.deck && JSON.stringify(pick.deck) !== JSON.stringify(lock.deck || {})) {
      lock.deck = { ...(lock.deck || {}), ...pick.deck };
      dirty = true; writeState(lock); saveProgress(true);
      if (Object.keys(lock.deck).length && pick.id) ldToast(duoOf(lock) ? tc(`已展示 ${duoOf(lock).find((p) => String(p.id) === pick.side)?.name || "TA"} 的所有场景：重新开始 TA 的场景`, `Every scene of ${duoOf(lock).find((p) => String(p.id) === pick.side)?.name || "them"} shown: starting their scenes again`)
        : tc("所有场景都展示过了：重新开始整副牌", "Every scene shown: starting the deck again"), "info");
    }
    if (pick && pick.round) dealInfo = { id: lock.id, ...pick.round, side: pick.side };
    if (pick && pick.dry && drySaid !== lock.id) { drySaid = lock.id; ldToast(tc("所有未看过的场景都看过了：改为从本局的场景中发牌", "Every unwatched scene has played: dealing from the scenes of this run"), "info"); }
    if (next === true && sceneHere() !== cur) return;          // they went somewhere else meanwhile
    if (pick && pick.id) {
      if (pay) {
        // decided again: a seek may have used the last skip while picking
        const d = nextSceneDecision(lock.scenes && lock.scenes[cur], skipBudget());
        if (!d.allow) { ldToast(nextSceneText("skips")); return; }
        if (d.skip) {
          lock.scenes = { ...(lock.scenes || {}), [cur]: d.rec };
          dirty = true;
          writeState(lock);
          saveProgress(true);
          ldToast(tc(`下一个场景：用掉了一次跳过${d.left === 0 ? "" : `（那个场景还剩 ${d.left} 次）`}`, `Next scene: used a skip${d.left === 0 ? "" : ` (${d.left} left on that scene)`}`));
        }
      }
      navigate(`/scenes/${pick.id}`);
      return;
    }
    // only the open scene is left: stay on it and say so
    if (pick && pick.only && cur) { ldToast(nextSceneText("none", lock.rules && lock.rules.fresh)); return; }
    if (!(pick && pick.only)) ldToast(lock.rules && lock.rules.fresh ? tc("没有未看过的场景可发：TA 的画廊和图片是开放的", "No unwatched scene left to deal: their galleries and images are open") : tc("没有场景可发：TA 的画廊和图片是开放的", "No scene to deal: their galleries and images are open"), "info");
    navigate(lock.groups ? tagsListUrl(lock, "galleries") : `/${KINDS[lock.kind].path}/${lock.tid}/galleries`, true);
  }
  let dealInfo = null, drySaid = null;

  // 2.12.1: runs one part of the page's work; an error is logged (once per
  // part and message) and the caller goes on. A promise's rejection too.
  const guardSaid = new Set();
  function guard(part, fn) {
    const said = (e) => {
      const k = `${part}|${e && e.message}`;
      if (!guardSaid.has(k)) { guardSaid.add(k); log(`${part} failed: ${(e && e.message) || e}`, "error"); }
    };
    try { const r = fn(); if (r && typeof r.catch === "function") r.catch(said); return r; }
    catch (e) { said(e); return undefined; }
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
    document.body.classList.toggle("ld-noff", noFfOn());   // 2.13.0: No fast-forward hides the previews
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ld-bar";
      // 2.16: a sticky bar is navigation (and stays solid with see-through panels)
      bar.setAttribute("role", "navigation");
      bar.setAttribute("aria-label", tc("锁局", "Lockdown"));
      veil = document.createElement("div");
      veil.id = "ld-veil";
      document.body.append(bar, veil);
    }
    if (!bar.isConnected) document.body.append(bar, veil);
    const h = navHeight();
    bar.style.height = h + "px";
    bar.style.setProperty("--ld-barh", h + "px");   // 2.18: the portrait leaves room above and below
    veil.style.top = h + "px";
    const pics = picsReady(lock);
    const st = edgeState(lock) || "";
    syncOverPrompt(st);
    // 2.12: Toy in charge's Start the toy, while Goon mode is not running here
    const toyBtn = !!lock.toy && !toyCtl.live(lock);
    const key = `${lock.id}|${lock.rules && lock.rules.random}|${pics}|${st}|${toyBtn}|${!!lock.hand}|${lastShown(lock) || ""}`;
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    // 2.12.1: the bar's links (barLinks), inline on a wide screen and in a
    // "..." menu on a phone, where Run, Scenes, Galleries, Images and the
    // Settings gear did not fit next to Start the toy and Give up (measured
    // at 375 px: Give up's right edge at 468)
    // 2.17: three groups: who (portrait, name, the way out and heat), how far
    // (the time, its meter, pace, the skips as tokens), then "Your run" on
    // its own (user: "this should be separate from these 3"), the links, the
    // icon buttons (Pictures, Start the toy, the cards, Stash settings) and
    // Give up last. The menu keeps every link.
    const links = barLinks(lock, hasPage);
    const run = links.find((l) => l.href === PAGE_PATH), gear = links.find((l) => l.icon);
    const plain = links.filter((l) => l !== run && l !== gear);
    const linkHtml = (l) => `<a href="${escapeHtml(l.href)}" data-a="link"${l.cls ? ` class="${l.cls}"` : ""}` +
      `${l.title ? ` title="${escapeHtml(l.title)}" aria-label="${escapeHtml(l.title)}"` : ""}>${l.icon ? GEAR_ICON : escapeHtml(l.label)}</a>`;
    const sub = `${liveGoalLabel(lock).replace(/ · .*$/, "")}${typeof lock.heat === "number" ? ` · ${tc("热度", "heat")} ${lock.heat} · ×${heatMult(lock.heat)}` : ""}` +
      `${lock.kind !== "performer" ? ` · ${KINDS[lock.kind].label}` : ""}`;
    bar.innerHTML =
      `<span class="ld-bwho">${pfHtml(lock, lock.name, lock.image, "b")}` +
      `<span class="ld-who"><b>${escapeHtml(lock.name)}</b><small>${escapeHtml(sub)}</small></span></span>` +
      `<span class="ld-bdiv" aria-hidden="true"></span>` +
      `<span class="ld-prog"></span><span class="ld-pace"></span>` +
      `<span class="ld-skips" hidden></span><span class="ld-picn"></span>` +
      `<span class="ld-bgrow"></span>` +
      (run ? `<a href="${escapeHtml(run.href)}" data-a="link" class="ld-runbtn" title="${tc("你的对局：对局页", "Your run: the run page")}">${LOCK_SVG}<span>${tc("你的对局", "Your run")}</span></a>` : "") +
      `<span class="ld-links">` +
        (plain.length ? `<span class="ld-blinks">${plain.map(linkHtml).join("")}</span>` : "") +
        (pics ? `<button data-a="pics" class="ld-pics" title="${tc("把本局的图片当作幻灯片播放", "Play the pictures of this run as a slideshow")}" aria-label="${tc("播放图片", "Play pictures")}">${PICS_ICON}<span>${tc("图片", "Pictures")}</span></button>` : "") +
        (toyBtn ? `<button data-a="toy" class="ld-toybtn" title="${tc("玩具主导：让 Intiface Sync 的 Goon 模式推进蓄力", "Toy in charge: let Intiface Sync's Goon mode drive the build-up")}">${COND_ICON.toy}<span>${tc("启动玩具", "Start the toy")}</span></button>` : "") +
        // 2.16: the hand of cards; 2.17: its popover opens right under it
        (lock.hand ? `<button data-a="hand" class="ld-handbtn" aria-haspopup="dialog" aria-expanded="false" title="${tc("你的牌", "Your cards")}" aria-label="${tc("你的牌", "Your cards")}">${CARDS_ICON}<b class="ld-handn" hidden></b></button>` : "") +
        (gear ? linkHtml(gear) : "") +
        `<button data-a="menu" class="ld-menubtn" title="${tc(`更多：${escapeHtml(links.map((l) => l.label).join(", "))}`, `More: ${escapeHtml(links.map((l) => l.label).join(", "))}`)}" aria-label="${tc("更多", "More")}" aria-haspopup="true" aria-expanded="false">${MORE_ICON}</button>` +
      `</span>` +
      // out of .ld-links (its buttons' rules), fixed under the cards button
      (lock.hand ? `<div class="ld-handpop" role="dialog" aria-label="${tc("你的牌", "Your cards")}" hidden></div>` : "") +
      `<div class="ld-barmenu" role="menu" hidden>${links.map((l) => `<a href="${escapeHtml(l.href)}" data-a="link" role="menuitem">` +
        `${l.icon ? GEAR_ICON : l.href === PAGE_PATH ? LOCK_SVG : ""}<span>${escapeHtml(l.href === PAGE_PATH ? tc("你的对局", "Your run") : l.label)}</span></a>`).join("")}</div>` +
      // 2.6: past the Edge target there is nothing to give up: the run's
      // own ways to end it take Give up's place
      (st === "reached"

        ? `<span class="ld-otbar"><button class="ld-otgo" data-a="otgo" title="${tc("继续观看：每分钟多 10 分，乘以热度", "Watch on: each minute adds 10 more, times heat")}">` +
            `<span class="ld-otlong">${tc("继续（加时）", "Keep going (overtime)")}</span><span class="ld-otshort">${tc("加时", "Overtime")}</span></button>` +
            `<button class="ld-otfin" data-a="otfin" title="${tc("以已入账的分数在这里结束对局", "End the run here with the score banked")}">${tc("完成", "Finish")}</button></span>`
        : st === "over"
        ? `<span class="ld-otbar"><button class="ld-otfin" data-a="otstop" title="${tc("以所有已入账内容在这里结束对局", "End the run here with everything banked")}">` +
            `<span class="ld-otlong">${tc("停止加时", "Stop overtime")}</span><span class="ld-otshort">${tc("停止", "Stop")}</span></button></span>`
        : `<button class="ld-giveup" title="${tc("长按 5 秒即可结束锁局但不算出局", "Hold for 5 seconds to end the lockdown without getting out")}">` +
            `<div class="ld-fill"></div><span>${tc(`放弃<span class="ld-gulong">（长按）</span>`, GIVEUP_LABEL)}</span></button>`);
    const menu = bar.querySelector(".ld-barmenu"), menuBtn = bar.querySelector('[data-a="menu"]');
    const showMenu = (on) => { if (!menu) return; menu.hidden = !on; menuBtn?.setAttribute("aria-expanded", on ? "true" : "false"); };
    bar.querySelectorAll('[data-a="link"]').forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault(); showMenu(false); navigate(a.getAttribute("href"));
    }));
    menuBtn?.addEventListener("click", (ev) => { ev.stopPropagation(); showMenu(menu.hidden); });
    bar.querySelector('[data-a="pics"]')?.addEventListener("click", playPictures);
    bar.querySelector('[data-a="toy"]')?.addEventListener("click", startToyClick);
    bar.querySelector('[data-a="hand"]')?.addEventListener("click", (ev) => { ev.stopPropagation(); showHand(bar.querySelector(".ld-handpop").hidden); });
    bar.querySelector(".ld-handpop")?.addEventListener("click", handClick);
    const gu = bar.querySelector(".ld-giveup");
    if (gu) wireGiveUp(gu);
    wireOver(bar);
    tick();
    showTip();
  }

  // 2.12.1: the bar's "..." menu closes on a click or tap anywhere else
  document.addEventListener("pointerdown", (ev) => {
    const hp = bar && bar.querySelector(".ld-handpop");
    if (hp && !hp.hidden && !(ev.target && ev.target.closest && ev.target.closest(".ld-handpop, .ld-handbtn"))) showHand(false);
    const m = bar && bar.querySelector(".ld-barmenu");
    if (!m || m.hidden || (ev.target && ev.target.closest && ev.target.closest(".ld-barmenu, .ld-menubtn"))) return;
    m.hidden = true;
    bar.querySelector(".ld-menubtn")?.setAttribute("aria-expanded", "false");
  }, true);

  // ── 2.16: the hand of cards ──
  const CARDS_ICON = line('<rect x="2.5" y="4.5" width="7" height="9" rx="1.2"/><path d="M6 2.5h6.3c.7 0 1.2.5 1.2 1.2V11"/>');
  const TAG_ICON = line('<path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6z"/><circle cx="5.3" cy="5.3" r=".8"/>');
  // The cards as buttons (the bar's popover and the run page's "Your cards").
  // 2.17: on the run page as playing cards (Cards.dc: a hold dealt, expiring
  // with its time yellow under 2 minutes, playing with a countdown ring, kept
  // green, broken; a tag card ready with its picture and counts, recharging
  // with a fill, its round done and still playable); in the popover as rows
  // with the tag's thumbnail. `st`: the tag cards' scenes (cardStatsFor).
  const HOLD_SHOW_MS = 20000, SOON_MS = 2 * 60000;
  let holdDone = null;                 // { t: "kept" | "broken", at, pts, k }: shown a little while
  let raceDone = null;                 // 2.19: { t: "won" | "lost", at }: the same for the Race
  const minTxt = (ms) => tc(`${Math.max(1, Math.ceil(ms / 60000))} 分钟`, `${Math.max(1, Math.ceil(ms / 60000))} min`);
  // the hold cards' names and tooltips (HOLD_KINDS, above) in the page's words
  const holdName = (k) => tc(k.stay ? k.name.replace("Stay ", "停留 ") : "盯着画面", k.name);
  const holdText = (k) => tc(k.stay ? `在本场景游玩 ${Math.round(k.ms / 60000)} 分钟；打开别的场景会失去它` : `游玩 ${Math.round(k.ms / 60000)} 分钟，期间不切换标签页或应用`, k.text);
  function handNote(hand, w) {
    if (!hand) return "";
    const n = handReady(hand, w);
    const next = hand.holds.length >= HOLD_HAND ? tc("手牌已满", "hand full") : tc(`再观看 ${fmtClock(HOLD_EVERY_MS - (Math.max(0, w) % HOLD_EVERY_MS))} 后发下一张坚持牌`, `next hold card in ${fmtClock(HOLD_EVERY_MS - (Math.max(0, w) % HOLD_EVERY_MS))} watched`);
    return `${hand.race && hand.race.st === "on" ? tc("竞赛中 · ", "racing · ") : ""}${hand.hold ? tc("进行中 · ", "holding · ") : ""}${tc(`${n} 张就绪 · ${next}`, `${n} ready · ${next}`)}`;
  }
  // a tag card's counts line: "14 scenes · 9 not shown yet"
  function tagLine(t, st, L) {
    const ids = st && st.ids ? st.ids[t.id] : null;
    if (!ids) return st && st.failed ? "" : tc("统计中…", "counting…");
    const c = tagCardStats(ids, L && L.scenes);
    if (!c.n) return tc("没有带此标签的场景了", "no scene left with it");
    return c.fresh ? tc(`${c.n} 个场景 · ${c.fresh} 个还没看过`, `${plural(c.n, "scene", "scenes")} · ${c.fresh} not shown yet`) : tc(`全部 ${c.n} 个场景都看过了：会再演一个`, `All ${plural(c.n, "scene", "scenes")} shown: plays one again`);
  }
  const tagRoundDone = (t, st, L) => { const ids = st && st.ids ? st.ids[t.id] : null; return !!ids && ids.length > 0 && !tagCardStats(ids, L && L.scenes).fresh; };
  const tagPicOf = (t, st) => tagPic(t.image_path) || (st && st.pics && st.pics[t.id]) || "";
  function ringHtml(frac, text) {
    const C = 169.65, off = Math.round(C * (1 - Math.max(0, Math.min(1, frac))) * 10) / 10;
    return `<span class="ld-ring"><svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true"><circle cx="32" cy="32" r="27" class="ld-ringbg"/>` +
      `<circle cx="32" cy="32" r="27" class="ld-ringfg" stroke-dasharray="${C}" stroke-dashoffset="${off}" transform="rotate(-90 32 32)"/></svg><b>${escapeHtml(text)}</b></span>`;
  }
  // 2.19: the Race in the hand: held (a card to play), on (its countdown),
  // or just won or lost (a little while, like a hold kept or broken)
  function raceRow(hand, now, page) {
    const r = hand && hand.race, rd = raceDone && now - raceDone.at < HOLD_SHOW_MS ? raceDone : null;
    if (!r) return "";
    if (r.st === "held") return page
      ? `<button class="ld-pcard" data-race="1" title="${tc(`游玩它，然后在 ${RACE_MS / 60000} 分钟内完成`, `Play it, then finish within ${RACE_MS / 60000} minutes`)}" style="--c:var(--sx-or)"><span class="ld-pkind">${tc("竞赛牌", "Race card")}</span>` +
        `<span class="ld-pico">${CARD_ICON.race}</span><span class="ld-pcname">${tc("竞赛", "Race")}</span><span class="ld-pmeta">${tc(`游玩后 ${RACE_MS / 60000} 分钟内完成；超时 −${RACE_LOSE}`, `Finish within ${RACE_MS / 60000} min of playing it; −${RACE_LOSE} if time runs out`)}</span>` +
        `<span class="ld-pfoot"><span>${tc("每局一次", "once a run")}</span><span class="ld-play">+${RACE_WIN} · ${tc("游玩", "Play")}</span></span></button>`
      : `<button class="ld-crow" data-race="1" title="${tc(`游玩它，然后在 ${RACE_MS / 60000} 分钟内完成`, `Play it, then finish within ${RACE_MS / 60000} minutes`)}" style="--c:var(--sx-or)"><span class="ld-cico">${CARD_ICON.race}</span>` +
        `<span class="ld-ctxt"><b>${tc(`竞赛 · ${RACE_MS / 60000} 分钟`, `Race · ${RACE_MS / 60000} min`)}</b><small>${tc(`及时完成，否则 −${RACE_LOSE}`, `finish in time, or −${RACE_LOSE}`)}</small></span><span class="ld-go">+${RACE_WIN}</span></button>`;
    if (r.st === "on") {
      const left = Math.max(0, r.until - now);
      return page
        ? `<div class="ld-pcard ld-plive" style="--c:var(--sx-or)"><span class="ld-pkind">${tc("竞赛", "Race")}</span>${ringHtml(left / RACE_MS, fmtClock(left))}` +
          `<span class="ld-pcname">${tc("现在完成", "Finish now")}</span><span class="ld-pmeta">${tc(`及时完成 +${RACE_WIN}，否则 −${RACE_LOSE}`, `+${RACE_WIN} in time, −${RACE_LOSE} if not`)}</span></div>`
        : `<div class="ld-crow ld-con" style="--c:var(--sx-or)"><span class="ld-cico">${CARD_ICON.race}</span><span class="ld-ctxt"><b>${tc("竞赛：现在完成", "Race: finish now")}</b>` +
          `<small>${tc(`还剩 ${escapeHtml(fmtClock(left))} · +${RACE_WIN}，否则 −${RACE_LOSE}`, `${escapeHtml(fmtClock(left))} left · +${RACE_WIN}, or −${RACE_LOSE}`)}</small></span><i class="ld-cbar" style="width:${Math.round((1 - left / RACE_MS) * 100)}%"></i></div>`;
    }
    if (!rd) return "";
    const won = r.st === "won";
    return page
      ? `<div class="ld-pcard ${won ? "ld-pwon" : "ld-plost"}" style="--c:var(--sx-${won ? "gr" : "re"})"><span class="ld-pbig">${won ? TICK_SVG : X_SVG}</span>` +
        `<span class="ld-pcname">${won ? tc("竞赛获胜", "Race won") : tc("竞赛失败", "Race lost")}</span><b class="ld-ppts">${won ? `+${RACE_WIN}` : `−${RACE_LOSE}`}</b>` +
        `<span class="ld-pmeta">${won ? tc(`用时 ${escapeHtml(fmtClock(r.ms || 0))}，热度前计入`, `in ${escapeHtml(fmtClock(r.ms || 0))}, before heat`) : tc("时间到了", "the time ran out")}</span></div>`
      : `<div class="ld-crow ld-c${won ? "kept" : "broken"}" style="--c:var(--sx-${won ? "gr" : "re"})"><span class="ld-cico">${won ? TICK_SVG : X_SVG}</span>` +
        `<span class="ld-ctxt"><b>${won ? tc(`竞赛获胜 · +${RACE_WIN}`, `Race won · +${RACE_WIN}`) : tc(`竞赛失败 · −${RACE_LOSE}`, `Race lost · −${RACE_LOSE}`)}</b><small>${won ? tc(`用时 ${escapeHtml(fmtClock(r.ms || 0))}，热度前计入`, `in ${escapeHtml(fmtClock(r.ms || 0))}, before heat`) : tc("时间到了", "the time ran out")}</small></span></div>`;
  }
  // 2.20: the skip cards in hand, one row (popover) or card (run page) for
  // all of them; usable on the scene on screen once it is out of skips
  const skipFoot = () => (skipBudget() !== null ? tc(`；每观看 ${SKIP_CARD_EVERY_MS / 60000} 分钟发一张跳过牌，最多 ${SKIP_CARD_MAX} 张`, `; a skip card every ${SKIP_CARD_EVERY_MS / 60000} min, ${SKIP_CARD_MAX} at most`) : "");
  function skipCardRow(hand, page) {
    const n = (hand && hand.sk) || 0;
    if (!n) return "";
    const id = sceneHere(), budget = skipBudget();
    const can = !!id && budget !== null && skipsLeft((lock && lock.scenes && lock.scenes[id]) || {}, budget) === 0;
    const tip = tc(`给跳过已用完的场景再补一次跳过；每张留到最后可得 +${SKIP_CARD_PTS}`, `One more skip on a scene that is out of them; each one kept to the end is +${SKIP_CARD_PTS}`);
    return page
      ? `<button class="ld-pcard" data-skipcard="1"${can ? "" : " disabled"} title="${escapeHtml(tip)}" style="--c:var(--sx-or)"><span class="ld-pkind">${n > 1 ? tc("跳过牌", "Skip cards") : tc("跳过牌", "Skip card")}</span>` +
        `<span class="ld-pico">${COND_ICON.skip}</span><span class="ld-pcname">${n > 1 ? tc(`${n} 张跳过牌`, `${n} skip cards`) : tc("跳过牌", "Skip card")}</span>` +
        `<span class="ld-pmeta">${tc(`场景的跳过用完后可再跳一次。留到最后：每张 +${SKIP_CARD_PTS}。`, `One more skip when a scene is out of them. Kept to the end: +${SKIP_CARD_PTS} each.`)}</span>` +
        `<span class="ld-pfoot"><span>${tc(`${n} / ${SKIP_CARD_MAX}`, `${n} of ${SKIP_CARD_MAX}`)}</span>${can ? `<span class="ld-play">${tc("使用", "Use")}</span>` : `<span>${tc("在播放器上", "on the player")}</span>`}</span></button>`
      : `<button class="ld-crow" data-skipcard="1"${can ? "" : " disabled"} title="${escapeHtml(tip)}" style="--c:var(--sx-or)"><span class="ld-cico">${COND_ICON.skip}</span>` +
        `<span class="ld-ctxt"><b>${n > 1 ? tc(`跳过牌 · ${n}`, `Skip cards · ${n}`) : tc("跳过牌", "Skip card")}</b><small>${can ? tc("本场景的跳过已用完：再补一次", "this scene is out of skips: one more") : tc("用于跳过已用完的场景", "for when a scene is out of skips")} · ${tc(`留到最后每张 +${SKIP_CARD_PTS}`, `+${SKIP_CARD_PTS} each if kept`)}</small></span>` +
        `<span class="ld-go">${can ? tc("使用", "Use") : `${n}/${SKIP_CARD_MAX}`}</span></button>`;
  }
  function handHtml(hand, w, page, st) {
    if (!hand) return "";
    const L = lock, now = Date.now();
    const done = holdDone && now - holdDone.at < HOLD_SHOW_MS ? holdDone : null;
    const noCards = tc(`还没有牌：每观看 ${HOLD_EVERY_MS / 60000} 分钟发一张坚持牌。`, `No cards yet: a hold card comes every ${HOLD_EVERY_MS / 60000} minutes watched.`);
    const foot = tc(`每观看 ${HOLD_EVERY_MS / 60000} 分钟发一张坚持牌，可保留 ${HOLD_LASTS_MS / 60000} 分钟；标签牌在游玩后 ${CARD_RECHARGE_MS / 60000} 分钟恢复${skipFoot()}。`, `A hold card every ${HOLD_EVERY_MS / 60000} min watched, kept ${HOLD_LASTS_MS / 60000} min; a tag card comes back ${CARD_RECHARGE_MS / 60000} min after you play it${skipFoot()}.`);
    if (!page) {
      let h = "";
      h += raceRow(hand, now, false);
      if (hand.hold && HOLD_KINDS[hand.hold.k]) {
        const k = HOLD_KINDS[hand.hold.k], d = Math.min(k.ms, Math.max(0, w - hand.hold.from));
        h += `<div class="ld-crow ld-con" style="--c:var(--sx-cy)"><span class="ld-cico">${holdIcon(hand.hold.k)}</span><span class="ld-ctxt"><b>${tc(`${escapeHtml(holdName(k))}：进行中`, `${escapeHtml(k.name)}: holding`)}</b>` +
          `<small>${tc(`还剩 ${escapeHtml(fmtClock(k.ms - d))} 游玩时间 · +${k.pts}${k.stay ? " · 本场景上" : ""}`, `${escapeHtml(fmtClock(k.ms - d))} of playing left · +${k.pts}${k.stay ? " · on this scene" : ""}`)}</small></span><i class="ld-cbar" style="width:${Math.round((d / k.ms) * 100)}%"></i></div>`;
      } else if (done) {
        h += `<div class="ld-crow ld-c${done.t}" style="--c:var(--sx-${done.t === "kept" ? "gr" : "re"})"><span class="ld-cico">${done.t === "kept" ? TICK_SVG : X_SVG}</span>` +
          `<span class="ld-ctxt"><b>${done.t === "kept" ? tc(`坚持成功 · +${done.pts}`, `Kept · +${done.pts}`) : done.k === "stay" ? tc("失去", "Lost") : tc("中断", "Broken")}</b><small>${done.t === "kept" ? tc("热度前计入分数", "before heat, in the score")
            : done.k === "stay" ? tc("打开了另一个场景；没有扣分", "another scene was opened; no points lost") : tc("你移开了视线；没有扣分", "you looked away; no points lost")}</small></span></div>`;
      }
      h += hand.holds.map((c, i) => { const k = HOLD_KINDS[c.k] || HOLD_KINDS.eyes, left = c.until - w;
        return `<button class="ld-crow" data-hold="${i}"${hand.hold ? " disabled" : ""} title="${escapeHtml(holdText(k))}" style="--c:var(--sx-cy)"><span class="ld-cico">${holdIcon(c.k)}</span>` +
          `<span class="ld-ctxt"><b>${escapeHtml(k.stay ? holdName(k) : tc(`${holdName(k)} · ${Math.round(k.ms / 60000)} 分钟`, `${k.name} · ${Math.round(k.ms / 60000)} min`))}</b><small${left < SOON_MS ? ' class="ld-soon"' : ""}>${k.stay ? tc("限一个场景 · ", "on one scene · ") : ""}${tc(`将在 ${minTxt(left)} 后过期`, `expires in ${minTxt(left)}`)}</small></span>` +
          `<span class="ld-go">+${k.pts}</span></button>`; }).join("");
      h += skipCardRow(hand, false);
      h += hand.tags.map((t) => { const left = tagReadyIn(t, w), pic = tagPicOf(t, st), line = tagLine(t, st, L);
        return `<button class="ld-crow ld-ctag${left ? " ld-wait" : ""}" data-ctag="${escapeHtml(t.id)}"${left ? " disabled" : ""} title="${tc(`打开一个带 ${escapeHtml(t.name)} 的场景`, `Open a scene with ${escapeHtml(t.name)}`)}" style="--c:var(--sx-ma)">` +
          `<span class="ld-cthumb">${pic ? cardPicHtml(pic, t.name) : TAG_ICON}</span><span class="ld-ctxt"><b>${escapeHtml(t.name)}</b>` +
          `<small>${left ? tc(`${minTxt(left)} 后恢复`, `back in ${minTxt(left)}`) : escapeHtml(line || tc("游玩：打开一个带此标签的场景", "play: a scene with this tag"))}</small></span>` +
          (left ? "" : `<span class="ld-go${tagRoundDone(t, st, L) ? " ld-gogrey" : ""}">${tc("游玩", "Play")}</span>`) + `</button>`; }).join("");
      if (!h) h = `<div class="ld-hint">${noCards}</div>`;
      return `<div class="ld-hand"><div class="ld-pophead"><b>${tc("你的手牌", "Your hand")}</b><span class="ld-hint">${escapeHtml(handNote(hand, w))}</span></div><div class="ld-crows">${h}</div>` +
        `<div class="ld-hint ld-handfoot">${foot}</div></div>`;
    }
    let h = raceRow(hand, now, true);
    if (hand.hold && HOLD_KINDS[hand.hold.k]) {
      const k = HOLD_KINDS[hand.hold.k], d = Math.min(k.ms, Math.max(0, w - hand.hold.from));
      h += `<div class="ld-pcard ld-plive" style="--c:var(--sx-cy)"><span class="ld-pkind">${tc("进行中", "Holding")}</span>${ringHtml(1 - d / k.ms, fmtClock(k.ms - d))}` +
        `<span class="ld-pcname">${escapeHtml(holdName(k))}</span><span class="ld-pmeta">${tc(`还剩 ${escapeHtml(fmtClock(k.ms - d))} 游玩时间 · +${k.pts}${k.stay ? " · 本场景上" : ""}`, `${escapeHtml(fmtClock(k.ms - d))} of playing left · +${k.pts}${k.stay ? ", on this scene" : ""}`)}</span></div>`;
    } else if (done) {
      h += done.t === "kept"
        ? `<div class="ld-pcard ld-pwon" style="--c:var(--sx-gr)"><span class="ld-pbig">${TICK_SVG}</span><span class="ld-pcname">${tc("坚持成功", "Kept")}</span><b class="ld-ppts">+${done.pts}</b>` +
          `<span class="ld-pmeta">${tc(`热度前计入${L && typeof L.heat === "number" ? ` · 分数 ×${heatMult(L.heat)}` : ""}`, `before heat${L && typeof L.heat === "number" ? ` · ×${heatMult(L.heat)} in the score` : ""}`)}</span></div>`
        : `<div class="ld-pcard ld-plost" style="--c:var(--sx-re)"><span class="ld-pbig">${X_SVG}</span><span class="ld-pcname">${done.k === "stay" ? tc("失去", "Lost") : tc("中断", "Broken")}</span>` +
          (done.k === "stay" ? `<span class="ld-pmeta">${tc("时间到前打开了另一个场景。没有扣分。", "Another scene was opened before the time was up. No points lost.")}</span></div>`
            : `<span class="ld-pmeta">${tc(`你移开视线超过 ${EYES_GRACE_MS / 1000} 秒。没有扣分。`, `You looked away for more than ${EYES_GRACE_MS / 1000} s. No points lost.`)}</span></div>`);
    }
    h += hand.holds.map((c, i) => { const k = HOLD_KINDS[c.k] || HOLD_KINDS.eyes, left = c.until - w, soon = left < SOON_MS;
      return `<button class="ld-pcard" data-hold="${i}"${hand.hold ? " disabled" : ""} title="${escapeHtml(holdText(k))}" style="--c:var(--sx-cy)">` +
        `<span class="ld-pkind">${tc("坚持牌", "Hold card")}</span><span class="ld-pico">${holdIcon(c.k)}</span><span class="ld-pcname">${escapeHtml(holdName(k))}</span>` +
        `<span class="ld-pmeta">${tc(k.stay ? `在本场景游玩 ${Math.round(k.ms / 60000)} 分钟；打开别的场景会失去它` : `盯着画面 ${Math.round(k.ms / 60000)} 分钟，期间不切换标签页或应用`, k.stay ? `Stay on one scene for ${Math.round(k.ms / 60000)} min of playing; leaving loses it` : `Keep your eyes here for ${Math.round(k.ms / 60000)} min of playing`)}</span>` +
        `<span class="ld-pfoot"><span${soon ? ' class="ld-soon"' : ""}>${tc(`将在 ${minTxt(left)} 后过期`, `expires in ${minTxt(left)}`)}</span><span class="ld-play">+${k.pts} · ${tc("游玩", "Play")}</span></span>` +
        `<span class="ld-pline${soon ? " ld-soon" : ""}"><i style="width:${Math.max(0, Math.min(100, Math.round((left / HOLD_LASTS_MS) * 100)))}%"></i></span></button>`; }).join("");
    h += skipCardRow(hand, true);
    h += hand.tags.map((t) => { const left = tagReadyIn(t, w), pic = tagPicOf(t, st), line = tagLine(t, st, L), again = tagRoundDone(t, st, L);
      return `<button class="ld-pcard ld-pctag${left ? " ld-pwait" : ""}" data-ctag="${escapeHtml(t.id)}"${left ? " disabled" : ""} title="${tc(`打开一个带 ${escapeHtml(t.name)} 的场景`, `Open a scene with ${escapeHtml(t.name)}`)}" style="--c:var(--sx-ma)">` +
        (pic ? `<span class="ld-pprev">${cardPicHtml(pic, t.name)}</span><span class="ld-pkind">${tc("标签牌", "Tag card")}</span>` : `<span class="ld-pkind">${tc("标签牌", "Tag card")}</span><span class="ld-pico">${TAG_ICON}</span>`) +
        `<span class="ld-pcname">${escapeHtml(t.name)}</span><span class="ld-pmeta">${escapeHtml(line)}</span>` +
        `<span class="ld-pfoot">${left ? `<span>${tc(`${minTxt(left)} 后恢复`, `back in ${minTxt(left)}`)}</span><span>${tc("恢复中", "recharging")}</span>` : `<span>${again ? tc("再演一个", "plays one again") : tc("现在打开一个", "opens one now")}</span><span class="ld-play${again ? " ld-gogrey" : ""}">${tc("游玩", "Play")}</span>`}</span>` +
        (left ? `<span class="ld-pline"><i style="width:${Math.round((1 - left / CARD_RECHARGE_MS) * 100)}%"></i></span>` : "") + `</button>`; }).join("");
    if (!h) h = `<div class="ld-hint">${noCards}</div>`;
    return `<div class="ld-hand ld-handpage"><div class="ld-pcards">${h}</div>` +
      `<div class="ld-hint ld-handfoot">${foot}</div></div>`;
  }
  // 2.17: the tag cards' scenes in this run (cardScenes), for their counts:
  // read when the popover or the run page draws them, again after a card is
  // played and every 5 minutes; never on each tick
  const CARD_STAT_MS = 5 * 60000;
  let cardStat = null, cardStatAsk = false;
  function cardStatsFor(L) {
    if (!L || !L.hand || !L.hand.tags.length) return null;
    const key = `${L.id}|${L.hand.tags.map((t) => t.id).join(",")}`;
    const mine = cardStat && cardStat.key === key ? cardStat : null;
    if ((!mine || mine.stale || Date.now() - mine.at > CARD_STAT_MS) && !cardStatAsk) {
      cardStatAsk = true;
      cardScenes(L, L.hand.tags).then((r) => { cardStat = { key, at: Date.now(), ...r }; },
        (e) => { log(`Tag cards not counted: ${e.message}`, "error"); cardStat = { key, at: Date.now(), ids: (mine && mine.ids) || null, pics: (mine && mine.pics) || {}, failed: true }; })
        .then(() => { cardStatAsk = false; drawHand(); if (pageEl) updateLive(); });
    }
    return mine;
  }
  // 2.17: the popover right under the cards button (popPlace), its notch
  // over the button; again when the window changes size
  function placeHand() {
    const pop = bar && bar.querySelector(".ld-handpop"), btn = bar && bar.querySelector('[data-a="hand"]');
    if (!pop || pop.hidden || !btn) return;
    const p = popPlace(btn.getBoundingClientRect(), window.innerWidth || document.documentElement.clientWidth, 340);
    pop.style.left = p.left + "px"; pop.style.top = p.top + "px"; pop.style.width = p.width + "px";
    pop.style.setProperty("--notch", p.notch + "px");
  }
  window.addEventListener("resize", () => placeHand());
  function showHand(on) {
    const pop = bar && bar.querySelector(".ld-handpop");
    if (!pop) return;
    pop.hidden = !on;
    bar.querySelector('[data-a="hand"]')?.setAttribute("aria-expanded", on ? "true" : "false");
    bar.querySelector('[data-a="hand"]')?.classList.toggle("ld-open", !!on);
    if (on) { pop.dataset.k = ""; drawHand(); placeHand(); }
  }
  function drawHand() {
    if (!bar || !lock || !lock.hand) return;
    const w = lock.watchedMs || 0, n = handReady(lock.hand, w);
    const b = bar.querySelector(".ld-handn");
    const racing = !!(lock.hand.race && lock.hand.race.st === "on");
    const t = lock.hand.hold || racing ? "•" : n ? String(n) : "";
    if (b && b.textContent !== t) { b.textContent = t; b.hidden = !t; }
    bar.querySelector('[data-a="hand"]')?.classList.toggle("ld-hasready", !!n || !!lock.hand.hold || racing);
    const pop = bar.querySelector(".ld-handpop");
    if (pop && !pop.hidden) { const hh = handHtml(lock.hand, w, false, cardStatsFor(lock)); if (pop.dataset.k !== hh) { pop.dataset.k = hh; pop.innerHTML = hh; } }
    holdChip();
  }
  // 2.17: while a hold runs, a small chip at the player's top left
  // ("Holding · 1:12 left · +30"), out of the timeline's way and of the
  // pointer's (pointer-events: none); in fullscreen it is in the player
  function holdChip() {
    const h = lock && lock.hand && lock.hand.hold && HOLD_KINDS[lock.hand.hold.k] ? lock.hand.hold : null;
    const race = lock && lock.hand && lock.hand.race && lock.hand.race.st === "on" ? lock.hand.race : null;
    const player = (h || race) && sceneHere() ? document.querySelector(".video-js") : null;
    let chip = document.getElementById("ld-holdchip");
    if (!player) { if (chip) chip.remove(); return; }
    if (!chip) { chip = document.createElement("div"); chip.id = "ld-holdchip"; chip.className = "ld-holdchip"; chip.setAttribute("role", "status"); }
    if (chip.parentNode !== player) player.appendChild(chip);
    let html = "";
    // 2.19: the Race first (it runs on the clock), then a hold
    if (race) html += `${CARD_ICON.race}<span>${escapeHtml(tc(`竞赛 · ${fmtClock(Math.max(0, race.until - Date.now()))} · +${RACE_WIN}`, `Race · ${fmtClock(Math.max(0, race.until - Date.now()))} · +${RACE_WIN}`))}</span>`;
    if (h) {
      const k = HOLD_KINDS[h.k], left = Math.max(0, k.ms - Math.max(0, (lock.watchedMs || 0) - h.from));
      html += `${holdIcon(h.k)}<span>${escapeHtml(tc(k.stay ? `${holdName(k)} · ${fmtClock(left)} 剩余 · +${k.pts}` : `进行中 · ${fmtClock(left)} 剩余 · +${k.pts}`, k.stay ? `${k.name} · ${fmtClock(left)} left · +${k.pts}` : `Holding · ${fmtClock(left)} left · +${k.pts}`))}</span>`;
    }
    if (chip.dataset.k !== html) { chip.dataset.k = html; chip.innerHTML = html; }
  }
  function handSet(hand, save) {
    if (!lock) return;
    lock = { ...lock, hand };
    dirty = true;
    writeState(lock);
    if (save) saveProgress(true);
    drawHand();
    if (pageEl) updateLive();
  }
  function handClick(ev) {
    const b = ev.target.closest && ev.target.closest("[data-hold], [data-ctag], [data-race], [data-skipcard]");
    if (!b || b.disabled || !lock || !lock.hand) return;
    ev.stopPropagation();
    if (b.dataset.skipcard !== undefined) {
      // 2.20
      if (useSkipCard(sceneHere())) ldToast(tc("用了跳过牌：本场景可以再跳一次", `Skip card used: one more skip in this scene`), "done");
      else ldToast(tc("跳过牌只用于跳过已用完的场景：先打开一个", "A skip card is for a scene that is out of skips: open one"), "info");
      showHand(false);
    } else if (b.dataset.race !== undefined) {
      const h = handPlayRace(lock.hand, Date.now());
      if (!h) return;
      handSet(h, true);
      sound("start");
      flash(tc(`竞赛：在 ${RACE_MS / 60000} 分钟内完成可得 +${RACE_WIN}`, `Race: finish within ${RACE_MS / 60000} minutes for +${RACE_WIN}`));
      showHand(false);
    } else if (b.dataset.hold !== undefined) {
      const c = lock.hand.holds[+b.dataset.hold], k = c && HOLD_KINDS[c.k];
      // 2.19: a Stay card is played on the scene on screen, else on the one
      // last shown (opened for it)
      const here = sceneHere(), scene = k && k.stay ? (here || lastShown(lock)) : null;
      if (k && k.stay && !scene) { ldToast(tc("先打开本局的一个场景，再打出这张牌", "Open a scene of the run, then play this card"), "info"); return; }
      const h = handPlayHold(lock.hand, +b.dataset.hold, lock.watchedMs || 0, scene);
      if (!h) return;
      holdAway = 0;
      handSet(h, true);
      const kk = HOLD_KINDS[h.hold.k];
      flash(kk.stay ? tc(`${holdName(kk)}：在本场景游玩 ${Math.round(kk.ms / 60000)} 分钟`, `${kk.name}: stay on this scene for ${Math.round(kk.ms / 60000)} minutes of playing`)
        : tc(`进行中：盯着画面 ${Math.round(kk.ms / 60000)} 分钟，期间不切换标签页或应用`, `Holding: ${kk.name.toLowerCase()} for ${Math.round(kk.ms / 60000)} minutes of playing`));
      showHand(false);
      if (kk.stay && scene !== here) navigate(`/scenes/${scene}`);
    } else playTag(b.dataset.ctag);
  }
  // A tag card: a scene of the run with that tag, one not shown yet if there is one.
  let tagBusy = false;
  async function playTag(id) {
    if (!lock || !lock.hand || tagBusy) return;
    const card = lock.hand.tags.find((t) => t.id === String(id));
    if (!card || tagReadyIn(card, lock.watchedMs || 0)) return;
    if (lock.one && lock.one.id) { ldToast(tc("单一场景：本局只留在它的场景里", "One scene: this run stays on its scene"), "info"); return; }
    if (lock.current && stayBlocks("")) { ldToast(tc("坚持到底：先完成这个场景", "Stay to the end: finish this scene first")); return; }
    tagBusy = true;
    const L = lock;
    try {
      const d = await gql(`query ($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: -1 }) { scenes { id } } }`,
                          { x: { ...sceneFilterFor(L, L.rules && L.rules.fresh), AND: { tags: { value: [card.id], modifier: "INCLUDES", depth: -1 } } } }, 60000);
      const all = (d?.findScenes?.scenes ?? []).map((x) => ({ id: String(x.id), who: [] }));
      const pick = deckPick(all, { scenes: L.scenes, deck: {} }, sceneHere(), Math.random(), Date.now());
      if (!lock || lock.id !== L.id) return;
      if (!pick.id) { ldToast(tc(`没有其他带 ${card.name} 的 ${L.name} 场景${L.rules && L.rules.fresh ? " 还没看过" : ""}`, `No other scene of ${L.name} with ${card.name}${L.rules && L.rules.fresh ? " left unwatched" : ""}`), "info"); return; }
      const h = handPlayTag(lock.hand, card.id, lock.watchedMs || 0, pick.id, Date.now());
      if (h) handSet(h, true);
      // 2.18: say what the card is worth now
      ldToast(tc(`${card.name}：在场景里用此标签标记一个瞬间，+${TAG_MATCH_PTS}`, `${card.name}: mark a moment with this tag in the scene for +${TAG_MATCH_PTS}`), "info");
      if (cardStat) cardStat.stale = true;   // 2.17: its counts again (one more shown)
      showHand(false);
      navigate(`/scenes/${pick.id}`);
    } catch (e) { ldToast(tc(`无法打出这张牌：${e.message}`, `The card could not be played: ${e.message}`), "error"); }
    finally { tagBusy = false; }
  }
  // Each tick: holds dealt, expired and passed; a hold being played breaks
  // on a look-away past the grace (on the tab that plays the run's scene).
  let holdAway = 0;
  // 2.20: the Stay card this tab has shown the scene of ("scene|from"). A
  // tab that never showed it (another window on another scene) does not
  // break it; this one does once it opens another scene.
  let staySeen = "";
  function handStep(now) {
    if (!lock || !lock.hand) return;
    let hand = lock.hand;
    const hk = hand.hold && HOLD_KINDS[hand.hold.k];
    if (hk && hk.stay) {
      // 2.19: a Stay card breaks when another scene is opened; 2.20: for
      // nothing (the card is lost), and the scene ending is not leaving it
      // (it plays again: the "ended" listener)
      holdAway = 0;
      const here = sceneHere(), key = `${hand.hold.scene}|${hand.hold.from}`;
      if (here === hand.hold.scene) staySeen = key;
      if (here && here !== hand.hold.scene && staySeen === key) {
        hand = handBreakHold(hand); holdDone = { t: "broken", at: now, k: "stay" };
        sound("thud"); flash(tc(`${holdName(hk)} 失去：打开了另一个场景`, `${hk.name} lost: another scene was opened`));
      }
    } else if (hand.hold) {
      if (awayHere() && sceneHere() && (holdAway || playingHere())) { if (!holdAway) holdAway = now; }
      else holdAway = 0;
      if (holdAway && now - holdAway > EYES_GRACE_MS) { holdAway = 0; hand = handBreakHold(hand); holdDone = { t: "broken", at: now }; sound("thud"); flash(tc("坚持中断：你移开了视线", "Hold broken: you looked away")); }
    } else holdAway = 0;
    const stays = !(lock.one && lock.one.id) && !(lock.rules && lock.rules.stay);
    const r = handTick(hand, lock.watchedMs || 0, { stays, race: raceDue(lock, now), now, skips: skipBudget() !== null && lock.media !== "images" });
    for (const ev of r.events) {
      if (ev.t === "passed") { holdDone = { t: "kept", at: now, pts: HOLD_KINDS[ev.k].pts, k: ev.k }; sound("bell"); flash(`${HOLD_KINDS[ev.k].stay ? tc(`${holdName(HOLD_KINDS[ev.k])} 坚持成功`, `${HOLD_KINDS[ev.k].name} kept`) : tc("坚持通过", "Hold passed")} · +${HOLD_KINDS[ev.k].pts}`); }
      else if (ev.t === "race-lost") { raceDone = { t: "lost", at: now }; sound("thud"); flash(tc(`竞赛失败：时间到了 · −${RACE_LOSE}`, `Race lost: time ran out · −${RACE_LOSE}`)); }
      else if (ev.t === "dealt") {
        flash(ev.k === "race" ? tc(`竞赛牌：打出它，然后在 ${RACE_MS / 60000} 分钟内完成可得 +${RACE_WIN}`, `The Race card: play it, then finish within ${RACE_MS / 60000} minutes for +${RACE_WIN}`)
          : ev.k === "skip" ? tc(`跳过牌：场景跳过用完后可再跳一次，留到最后每张 +${SKIP_CARD_PTS}`, `A skip card: one more skip when a scene is out of them, or +${SKIP_CARD_PTS} if you keep it`)
          : tc(`坚持牌${HOLD_KINDS[ev.k] && HOLD_KINDS[ev.k].stay ? `（${holdName(HOLD_KINDS[ev.k])}）` : ""}：想用时再打`, `A hold card${HOLD_KINDS[ev.k] && HOLD_KINDS[ev.k].stay ? `, ${HOLD_KINDS[ev.k].name}` : ""}: play it when you like`));
        // 2.17: the cards button's count pulses once
        const hb = bar && bar.querySelector('[data-a="hand"]');
        if (hb) { hb.classList.add("ld-pulse"); setTimeout(() => hb.classList.remove("ld-pulse"), 1200); }
      }
    }
    if (r.hand !== lock.hand) handSet(r.hand, r.events.some((e) => e.t === "passed" || e.t === "race-lost") || hand !== lock.hand);
    else drawHand();
  }

  // ── 2.16: pace against your best, and milestones ──
  let paceRef = null, paceAsk = null, paceAt = 0, paceText = "", paceUp = false, flashText = "", flashUntil = 0, paceHtml = "", paceTip = "";
  const SAID_KEY = "lockdownSaid";
  const saidMem = new Map();
  function msSaid(id) {
    if (!saidMem.has(id)) {
      let keys = [];
      try { const v = JSON.parse(localStorage.getItem(SAID_KEY) || "null"); if (v && v.id === id && Array.isArray(v.keys)) keys = v.keys; } catch (_) {}
      saidMem.set(id, new Set(keys));
    }
    return saidMem.get(id);
  }
  function msSave(id) { try { localStorage.setItem(SAID_KEY, JSON.stringify({ id, keys: [...msSaid(id)] })); } catch (_) {} }
  function flash(text) { flashText = text; flashUntil = Date.now() + 6000; paceDraw(); }
  const paceShown = (now) => (now < flashUntil ? flashText : paceText);
  // the bar's pace: "Score 237 [meter] best 1,545" or "Score 1,602 new best +57"
  function paceParts(v, b, up) {
    const n = (x) => escapeHtml(x.toLocaleString());
    if (!b) return `<span class="ld-psc">${tc("分数", "Score")} <b>${n(v)}</b></span>`;
    if (up) return `<span class="ld-psc">${tc("分数", "Score")} <b>${n(v)}</b></span><span class="ld-pbest ld-up">${tc(`新纪录 +${n(v - b.score)}`, `new best +${n(v - b.score)}`)}</span>`;
    return `<span class="ld-psc">${tc("分数", "Score")} <b>${n(v)}</b></span><span class="ld-pmeter"><i style="width:${Math.max(2, Math.min(100, Math.round((v / b.score) * 100)))}%"></i></span>` +
      `<span class="ld-pbest">${tc("最佳", "best")} <b>${n(b.score)}</b></span>`;
  }
  function paceDraw() {
    const el = bar && bar.querySelector(".ld-pace");
    if (!el) return;
    const now = Date.now(), fl = now < flashUntil;
    const h = fl ? escapeHtml(flashText) : paceHtml, cls = `ld-pace${fl ? " ld-flash" : paceUp ? " ld-up" : ""}`;
    if (el.dataset.k !== h) { el.dataset.k = h; el.innerHTML = h; }
    if (el.className !== cls) el.className = cls;
    const tip = fl ? "" : paceTip;
    if (el.title !== tip) el.title = tip;
  }

  function paceStep(now) {
    if (!lock) return;
    const L = lock;
    if ((!paceRef || paceRef.id !== L.id) && paceAsk !== L.id) {
      paceAsk = L.id;
      readConfig().then((d) => { paceRef = { id: L.id, best: d.failed ? null : paceBest(d.list, d.stats && d.stats.top, L) }; },
                        () => { paceRef = { id: L.id, best: null }; });
    }
    if (now - paceAt < 1000) { paceDraw(); return; }
    paceAt = now;
    const said = msSaid(L.id);
    const due = milestonesDue(L, now, said);
    if (due.length) { for (const m of due) said.add(m.k); msSave(L.id); sound("bell"); flash(due[0].text); }
    const b = paceRef && paceRef.id === L.id ? paceRef.best : null;
    paceText = ""; paceUp = false; paceHtml = ""; paceTip = "";
    // 2.18 (user: "1,308 to your best ... hard to know what it means cuz I
    // cant see my current score"): the score if you got out now, beside the
    // best to beat, with a meter between them
    if (!hiddenPast(L) && L.media !== "images") {
      const sc = scoreOf(entryFromLock(L, "done", now)), v = sc ? sc.total : 0;
      const n = (x) => x.toLocaleString();
      paceTip = tc(`现在出局的分数：${n(v)}${b ? ` · 你的最佳 ${b.who}：${n(b.score)}` : ""}`, `Score if you got out now: ${n(v)}${b ? ` · your best ${b.who}: ${n(b.score)}` : ""}`);
      if (!b) { paceText = tc(`分数 ${n(v)}`, `Score ${n(v)}`); paceHtml = paceParts(v, null); }
      else if (v >= b.score) {
        paceUp = true;
        paceText = tc(`分数 ${n(v)} · 新纪录 ${b.who}（+${n(v - b.score)}）`, `Score ${n(v)} · new best ${b.who} (+${n(v - b.score)})`);
        paceHtml = paceParts(v, b, true);
        if (!said.has("best")) {
          said.add("best"); msSave(L.id); sound("best");
          ldToast(L.over ? tc(`新纪录 ${b.who}：已入账`, `New best ${b.who}: banked`) : tc(`超过了你的最佳 ${b.who}（${n(b.score)}）：出局即可入账`, `Past your best ${b.who} (${n(b.score)}): get out to bank it`), "done");
        }
      } else { paceText = tc(`分数 ${n(v)}，你的最佳 ${n(b.score)} ${b.who}`, `Score ${n(v)} of your best ${n(b.score)} ${b.who}`); paceHtml = paceParts(v, b, false); }
    }
    paceDraw();
  }

  // 2.6: the Edge target reached: a card under the bar says so, with the
  // banked score and the two choices, until one is made (it never times
  // out into a loss). Not on the run page, which has the same card.
  function syncOverPrompt(st) {
    let p = document.getElementById("ld-over");
    const want = st === "reached" && location.pathname !== PAGE_PATH && overLater !== (lock && lock.id);
    if (!want) { if (p) p.remove(); return; }
    if (!p) {
      p = document.createElement("div");
      p.id = "ld-over";
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-label", tc("已达边缘目标", "Edge target reached"));
      p.innerHTML = overCardHtml("reached", "pr");
      // 2.16: on a phone it covered the video: Later folds it into the bar
      p.querySelector(".ld-otbtns")?.insertAdjacentHTML("beforeend", `<button class="ld-link ld-otlater" data-a="otlater">${tc("稍后", "Later")}</button>`);
      p.querySelector('[data-a="otlater"]')?.addEventListener("click", () => { overLater = lock && lock.id; p.remove(); });
      wireOver(p);
      document.body.appendChild(p);
    }
    p.style.top = navHeight() + 8 + "px";
    updateOver(p, "pr");
  }

  let overLater = null;
  function wireGiveUp(btn) {
    const fill = btn.querySelector(".ld-fill");
    // A timer rather than requestAnimationFrame, which stalls in a hidden tab.
    let started = 0, iv = null;
    const stop = () => {
      started = 0;
      btn.classList.remove("ld-holding");
      clearInterval(iv);
      fill.style.transition = "width .2s"; fill.style.width = "0";
      btn.querySelector("span").innerHTML = tc(`放弃<span class="ld-gulong">（长按）</span>`, GIVEUP_LABEL);
    };
    const frame = () => {
      if (!started) return;
      const t = (Date.now() - started) / HOLD_MS;
      fill.style.width = Math.min(100, t * 100) + "%";
      btn.querySelector("span").textContent = t < 1 ? tc(`继续按住… ${Math.ceil((1 - t) * HOLD_MS / 1000)}`, `Keep holding… ${Math.ceil((1 - t) * HOLD_MS / 1000)}`) : btn.dataset.cancel ? tc("已取消", "Cancelled") : tc("已放弃", "Given up");
      if (t >= 1) { started = 0; clearInterval(iv); end("gaveup"); }
    };
    const go = () => {
      started = Date.now();
      btn.classList.add("ld-holding");
      fill.style.transition = "none";
      clearInterval(iv);
      iv = setInterval(frame, 50);
    };
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      btn.setPointerCapture?.(ev.pointerId);
      go();
    });
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(t, () => { if (started) stop(); });
    // 2.16: held Space or Enter does the same (the keyboard had no way to quit)
    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault(); ev.stopPropagation();
      if (!started && !ev.repeat) go();
    });
    btn.addEventListener("keyup", (ev) => { if ((ev.key === " " || ev.key === "Enter") && started) stop(); });
    btn.addEventListener("blur", () => { if (started) stop(); });
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
  // 2.16 (user: something floating over the timeline got in the way of
  // seeking): the toast sits at the top, under the bar (in fullscreen at the
  // player's top), away from the control bar and its preview; it stays
  // 50 ms a character longer (up to 9 s), and a "done" one is not wiped by
  // the next for 1.5 s (it waits its turn).
  let toastTimer = null, toastHold = 0, toastNext = null;
  // 2.20 `act` { label, fn }: one button in the toast (it then takes clicks)
  function ldToast(text, kind, act) {
    injectStyles();
    let t = document.getElementById("ld-toast");
    if (!t) { t = document.createElement("div"); t.id = "ld-toast"; t.setAttribute("role", "status"); }
    const host = toastHost(document);
    if (t.parentNode !== host) host.appendChild(t);
    const k = toastKind(kind), now = Date.now();
    if (now < toastHold && k !== "error") { toastNext = [text, kind, act]; setTimeout(() => { if (toastNext) { const n = toastNext; toastNext = null; ldToast(n[0], n[1], n[2]); } }, toastHold - now + 20); return; }
    toastHold = k === "done" ? now + 1500 : 0;
    t.style.top = (document.fullscreenElement ? 16 : navHeight() + 10) + "px";
    t.className = `ld-t-${k} ld-show${act ? " ld-act" : ""}`;
    t.textContent = text;
    if (act) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ld-tact"; b.textContent = act.label;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); t.classList.remove("ld-show", "ld-act"); try { act.fn(); } catch (e) { log(`Toast action failed: ${e.message}`, "error"); } });
      t.appendChild(b);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("ld-show", "ld-act"), toastMs(k, text) + (act ? 3000 : 0));
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
    const prog = bar.querySelector(".ld-prog"), sk = bar.querySelector(".ld-skips");
    // 2.17: the time big, "of 30:00 watched", the meter (goalParts, as the
    // run page); on a phone "of 30:00" (.ld-pgof / .ld-pgshort)
    const gp = goalParts(lock, now, eyesAt);
    const html = `<span class="ld-pgt ld-g-${gp.cls}"><b>${escapeHtml(gp.big)}</b><span class="ld-pgof">${escapeHtml(gp.of)}</span>` +
      `<span class="ld-pgshort">${escapeHtml(gp.short)}</span></span>` +
      (gp.pct !== null ? `<span class="ld-meter ld-g-${gp.cls}"><i style="width:${gp.pct}%"></i></span>` : gp.left ? `<small>${escapeHtml(gp.left)}</small>` : "");
    if (prog && prog.dataset.k !== html) { prog.dataset.k = html; prog.innerHTML = html; prog.title = [gp.cap, gp.left].filter(Boolean).join(": "); }
    // 2.16: the first 2 minutes, Give up is Cancel (nothing recorded)
    const gu = bar.querySelector(".ld-giveup");
    if (gu && !gu.classList.contains("ld-holding")) {
      const c = cancelResult(lock, "gaveup", now) === "cancelled";
      if (gu.dataset.cancel !== (c ? "1" : "")) {
        gu.dataset.cancel = c ? "1" : "";
        gu.querySelector("span").innerHTML = c ? tc(`取消<span class="ld-gulong">（长按）</span>`, `Cancel<span class="ld-gulong"> (hold)</span>`) : tc(`放弃<span class="ld-gulong">（长按）</span>`, GIVEUP_LABEL);
        gu.title = c ? tc("按住 5 秒取消：前 2 分钟内不会记录任何内容", "Hold for 5 seconds to cancel: in the first 2 minutes nothing is recorded") : tc("按住 5 秒直接结束锁局，不算出局", "Hold for 5 seconds to end the lockdown without getting out");
      }
    }
    guard("hand", () => handStep(now));
    guard("pace", () => paceStep(now));
    // 2.9: new pictures viewed this run
    const pn = bar.querySelector(".ld-picn"), np = (lock.pics || []).length;
    if (pn && pn.textContent !== (np ? `${tc("图片 " + np, "Pictures " + np)}` : "")) { pn.textContent = np ? tc(`图片 ${np}`, `Pictures ${np}`) : ""; pn.title = np ? tc(`本次新看了 ${np} 张图片：热度前 +${np}`, `${np} new pictures viewed: +${np} before heat`) : ""; }
    if (pageEl) updateLive();
    const pr = document.getElementById("ld-over");
    if (pr) updateOver(pr, "pr");
    // 2.17 (user: "can skips show more visually? like a resource"): the
    // scene's skips as tokens in a small well, filled orange for the ones
    // left, dashed for the spent ones, a bonus one (a moment) marked
    if (sk) {
      const budget = lock.rules ? lock.rules.skips : null, id = sceneHere();
      const tk = id ? skipTokens((lock.scenes || {})[id] || {}, budget) : null;
      const html = !tk ? "" : tk.none ? `<span class="ld-skcap">${tc("不能跳过", "No skipping")}</span>`
        : `<span class="ld-skcap">${tc("跳过", "Skips")}</span><span class="ld-sktoks">${tk.list.map((x) =>
            `<i class="ld-sktok${x.on ? " ld-on" : ""}${x.bonus ? " ld-bonus" : ""}${x.card ? " ld-xs" : ""}">${COND_ICON.skip}</i>`).join("")}</span>`;
      if (sk.dataset.k !== html) {
        sk.dataset.k = html; sk.innerHTML = html; sk.hidden = !html;
        const t = !tk ? "" : tk.none ? tc("本局不能跳过", "No skipping in this run") : tc(`本场景剩余跳过：${tk.left} / ${tk.total}${tk.bonus ? `（${tk.bonus} 来自发现的瞬间）` : ""}${tk.xs ? `（${tk.xs} 来自跳过牌）` : ""}`, `Skips left in this scene: ${tk.left} of ${tk.total}${tk.bonus ? ` (${tk.bonus} for a moment found)` : ""}${tk.xs ? ` (${tk.xs} from skip cards)` : ""}`);
        sk.title = t; if (t) sk.setAttribute("aria-label", t); else sk.removeAttribute("aria-label");
        sk.classList.toggle("ld-zero", !!tk && !tk.left);
      }
    }
    // 2.6: Edge waits at its target for Keep going or Finish. 2.12 (user): a
    // full overtime no longer ends the run: it scores nothing more and the
    // lock holds until an O or Stop overtime
    if (goalType(lock) === "edge") {
      if (!lock.over && goalReached(lock, now)) edgeReached(now);
      else if (overtimeFull(lock) && otFullSaid !== lock.id && !hiddenPast(lock)) {
        otFullSaid = lock.id;
        ldToast(tc(`加时已满：+${overtimePts(overtimeScored(lock))} 已入账。继续观看不再计分；锁局保持，直到出局或停止加时。`, `Overtime full: +${overtimePts(overtimeScored(lock))} banked. Watching on scores nothing more; the lock holds until an O or Stop overtime.`), "done");
      }
    } else if (goalReached(awayNowLock(lock, eyesAt, now), now)) end("done");
  }
  let otFullSaid = null;

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
    document.body.classList.remove("ld-on", "ld-checking", "ld-noff");
    previewGuard(false);
    document.getElementById("ld-tip")?.remove();
    document.getElementById("ld-over")?.remove();
    document.getElementById("ld-holdchip")?.remove();
    bar?.remove(); veil?.remove();
    bar = null; veil = null;
  }

  // The way out as it stands (the bar's goal and, 2.16, the run page's big
  // one): O's, time left, the Edge meter or a hidden target's hint, overtime.
  function goalHtml(lock, now, eyesAt) {
    const g = lock.goal || { type: "finish", os: 1 };
    const hintTc = (f) => { const e = edgeHint(f); return tc(e === "early" ? "偏早" : e === "about halfway" ? "大约一半" : "快到了", e); };
    let out = "";
    if (g.type === "finish") {
      const need = g.os || 1;
      out = need === 1 ? tc("一个 O 即可出局", "one O to get out") : tc(`${lock.os || 0} / ${need} 个 O`, `${lock.os || 0} of ${need} O's`);
      const minMs = (lock.rules && lock.rules.minMs) || 0;
      const wait = lock.slowBy === "watched" ? minMs - ((lock.watchedMs || 0) - (lock.slowFrom || 0)) : lock.startedAt + minMs - now;
      if (wait > 0) out += ` <small>${lock.slowBy === "watched" ? tc(`再看 ${fmtClock(wait)} 后开始计数`, `count after ${fmtClock(wait)} more watching`) : tc(`${fmtClock(wait)} 后开始计数`, `count in ${fmtClock(wait)}`)}</small>`;
    } else if (g.type === "timer") {
      // 2.13.0: time away (Eyes on screen) is added back to a locked-time Timer
      out = g.by === "watched" ? tc(`${fmtClock(g.ms - (lock.watchedMs || 0))} 观看剩余`, `${fmtClock(g.ms - (lock.watchedMs || 0))} of watching left`)
        : tc(`剩余 ${fmtClock(lock.startedAt + g.ms + awayMsOf(awayNowLock(lock, eyesAt, now)) - now)}`, `${fmtClock(lock.startedAt + g.ms + awayMsOf(awayNowLock(lock, eyesAt, now)) - now)} left`);
    } else if (edgeState(lock) === "reached") {
      out = `<span class="ld-reachedtxt">${tc("已到目标", "target reached")} <small>${tc("分数已入账", "score banked")}</small></span>`;
    } else if (edgeState(lock) === "over") {
      // 2.12: past the cap the lock holds; the score part is full
      const ot = overtimeMs(lock), cap = overtimeCap(lock), pts = overtimePts(overtimeScored(lock));
      out = hiddenPast(lock) ? `<span class="ld-otfull">${tc("超过目标", "past the target")}<small>${tc(" · 继续", " · keep going")}</small></span>`
        : overtimeFull(lock)
        ? `<span class="ld-otfull">${tc(`加时已满：+${pts} 已入账`, `Overtime full: +${pts} banked`)}<small>${tc(" · 继续", " · keep going")}</small></span><span class="ld-meter ld-otm"><i style="width:100%"></i></span>`
        : tc(`加时 ${fmtClock(ot)}（+${pts}）`, `Overtime ${fmtClock(ot)} (+${pts})`) + `<span class="ld-meter ld-otm"><i style="width:${cap ? Math.round((ot / cap) * 100) : 0}%"></i></span>`;
    } else if (lock.goal && lock.goal.hidden) {
      // 2.12: Hidden target: a rough hint and the watched time, never the target
      const need = edgeNeedMs(lock), w = lock.watchedMs || 0;
      out = `<span class="ld-wlabel">${tc("已观看 ", "watched ")}</span>${fmtClock(w)} <small class="ld-hint3">${hintTc(need ? w / need : 0)}</small>`;
    } else {
      const need = edgeNeedMs(lock), w = Math.min(need, lock.watchedMs || 0);
      out = `<span class="ld-wlabel">${tc("已观看 ", "watched ")}</span>${fmtClock(w)}${tc(" / ", " of ")}${fmtClock(need)}<span class="ld-meter"><i style="width:${need ? Math.round((w / need) * 100) : 0}%"></i></span>`;
    }
    return out;
  }

  // ── Enforcement ────────────────────────────────────────────────────────────

  const allowedCache = new Map();    // "lockid:scene:12" -> true/false
  let checkSeq = 0, checkFails = 0;
  let lastPath = null;

  async function enforce(force) {
    if (!lock) return;
    // 2.12.1: a bar that fails to draw must not stop the route check below:
    // without it a scene is never known to belong, so its watching never
    // counts and its seeks are never judged (free skips)
    guard("bar", renderBar);
    const path = location.pathname;
    // The query counts too: a filter added on their Scenes tab changes only
    // the query, and it is exactly what can widen the list.
    const here = path + location.search;
    if (!force && here === lastPath) return;
    lastPath = here;
    const r = routeCheck(path, lock, lock.rules && lock.rules.random);
    // 2.12 (user): Settings open during a lock; each visit is noted
    if (r.settings) { noteSettings(); document.body.classList.remove("ld-checking"); return; }
    inSettings = false;
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
      if (allowedCache.get(key)) { document.body.classList.remove("ld-checking"); if (r.check === "scene") sceneShown(r.id); }
      else bounce();
      return;
    }
    // Hide the page until we know, so a forbidden scene is never seen.
    document.body.classList.add("ld-checking");
    const seq = ++checkSeq, L = lock;
    let ok = false, failed = false;
    try { ok = (await itemsMatch([{ kind: r.check, id: r.id }], L))[0]; }
    catch (e) { failed = true; log(`${tc("检查失败（", "Check failed (")}${e.message}${tc("），稍后重试", "), trying again")}`, "error"); }
    if (seq !== checkSeq || location.pathname + location.search !== here) return;
    // `lock` is a new object after every sync, O poll and save: the same run
    // is the same id. A different run: check again, or the veil stays up
    // and nothing counts (review, 2.2).
    if (!lock || lock.id !== L.id) { lastPath = null; return; }
    // 2.11 (review M2): could not check is not "no": the veil stays, nothing
    // is cached or let go, and the check runs again (1, 2, 4, 8, 10 s)
    const verdict = belongVerdict(ok, failed);
    if (verdict.retry) {
      checkFails++;
      if (checkFails === 3) ldToast(tc("Stash 没有响应，正在重新检查", "Stash isn't answering; checking again"), "warn");
      setTimeout(() => {
        if (lock && lock.id === L.id && location.pathname + location.search === here) { lastPath = null; enforce(true); }
      }, backoffMs(checkFails, 1000, 10000));
      return;
    }
    checkFails = 0;
    allowedCache.set(key, ok);
    // the one scene was deleted or no longer belongs: pick another rather
    // than be sent back to it for ever (a definite "no" only)
    if (verdict.release && r.check === "scene" && lock.current && lock.current.id === String(r.id) && !lock.current.done) {
      lock.current = { ...lock.current, done: true };
      dirty = true; writeState(lock); saveProgress(true);
    }
    if (verdict.release && r.check === "scene" && lock.one && lock.one.id === String(r.id)) {
      lock.one = dropOne(lock.one);
      dirty = true; writeState(lock); saveProgress(true);
      ldToast(tc("本盘的场景没了：你接着播放的那个就是", "The run's scene is gone: the next one you play is the one"));
    }
    if (ok) {
      document.body.classList.remove("ld-checking");
      if (r.check === "scene") sceneShown(r.id);
    } else bounce();
  }

  // 2.12: a visit to Stash's Settings during the run (any tab, counted once
  // per visit) goes into the run's history: "visited Settings".
  let inSettings = false;
  function noteSettings() {
    if (inSettings || !lock) return;
    inSettings = true;
    lock = { ...lock, settings: (lock.settings || 0) + 1 };
    dirty = true;
    writeState(lock);
    saveProgress(true);
    ldToast(tc("锁局期间设置保持打开；这次访问会记进对局历史。在那里关掉 Lockdown 会结束锁局。", "Settings stay open during a lockdown; this visit goes into the run's history. Turning Lockdown off there ends the lock."), true);
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

  // 2.11 (review L2): after a failed batch the next try waits (250 ms,
  // doubling, at most 10 s) instead of going out again every tick and DOM change
  let cardFails = 0, cardWait = 0;
  async function scanCards() {
    if (!lock || cardBusy || Date.now() < cardWait) return;
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
      cardFails = 0; cardWait = 0;
    } catch (e) {
      cardFails++;
      cardWait = Date.now() + backoffMs(cardFails, 250, 10000);
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
    // 2.13.0: Slideshow showing counts as playing for Eyes on screen; time
    // announced while away past the grace does not count
    lastShowAt = Date.now();
    if (eyesOn() && eyesAway(Date.now())) return;
    lock.watchedMs = (lock.watchedMs || 0) + ms;
    if (lock.toy && toyCtl.live(lock)) lock.toy = { ...lock.toy, ms: (lock.toy.ms || 0) + ms };   // 2.12
    dirty = true;
    writeState(lock);
    // 2.9: and the picture it was, toward the pictures' points
    if (ev.detail.imageId) notePic(ev.detail.imageId, ms);
  });

  // ── 2.9: points for pictures ──────────────────────────────────────────────
  // Time on each picture (Slideshow's announcements above; Stash's image page
  // and lightbox, timed here while the tab is on screen) adds up per image in
  // `picAcc` for this page; at PIC_MS a picture of the target that no earlier
  // run counted joins `lock.pics` (merged across devices like the rest).
  // Whether it belongs is the route check's or the cards' answer when they
  // have one, else one batched itemsMatch.
  let picAcc = {}, picRunId = null, picBusy = false, lastPicTrack = 0;
  const picPending = new Set();
  function picBelongs(id) {
    const k = `${lock.id}:image:${id}`;
    if (allowedCache.has(k)) return allowedCache.get(k);
    if (itemCache.has(k)) return itemCache.get(k);
    picPending.add(String(id));
    checkPics();
    return undefined;
  }
  async function checkPics() {
    if (picBusy || !lock || !picPending.size) return;
    picBusy = true;
    const L = lock, ids = [...picPending].slice(0, 40);
    ids.forEach((id) => picPending.delete(id));
    try {
      const res = await itemsMatch(ids.map((id) => ({ kind: "image", id })), L);
      if (lock && lock.id === L.id) ids.forEach((id, i) => { itemCache.set(`${L.id}:image:${id}`, !!res[i]); notePic(id, 0); });
    } catch (e) { log(`Picture check failed: ${e.message}`); }
    finally { picBusy = false; if (picPending.size) setTimeout(checkPics, 1000); }
  }
  function notePic(id, ms) {
    if (!lock) return;
    if (picRunId !== lock.id) { picRunId = lock.id; picAcc = {}; }
    const st = { acc: picAcc, run: lock.pics || [], earlier: picEarlier };
    let r = picTime(st, id, ms, undefined);
    if (r.why === "wait") r = picTime({ ...st, acc: r.acc }, id, 0, picBelongs(String(id)));
    picAcc = r.acc;
    if (r.why !== "counted") return;
    lock.pics = r.run;
    dirty = true;
    writeState(lock);
    if (lock.pics.length === PICS_MAX) ldToast(tc(`${PICS_MAX} 张图片：这是一盘能计入的上限`, `${PICS_MAX} pictures: the most a run counts`), true);
  }
  function trackPictures() {
    const now = Date.now();
    const dt = lastPicTrack ? Math.min(1000, now - lastPicTrack) : 0;
    lastPicTrack = now;
    if (!lock || document.visibilityState !== "visible" || document.body.classList.contains("ld-checking")) return;
    // Slideshow open: it announces its own pictures
    const ss = window.Slideshow;
    if (ss && typeof ss.isOpen === "function" && ss.isOpen()) return;
    const a = document.querySelector(".Lightbox .Lightbox-footer a.image-link");
    const id = pictureHere(location.pathname, a ? a.getAttribute("href") : "", !!document.querySelector(".Lightbox"));
    if (id && dt) notePic(id, dt);
  }

  // The scene's record in this lock (furthest point watched, skips used).
  // Made the first time an allowed scene opens; "unwatched only" lets a
  // scene with a record through even after Stash has counted its play.
  function sceneRec(id) {
    if (!lock) return null;
    if (!lock.scenes) lock.scenes = {};
    if (!lock.scenes[id]) { lock.scenes[id] = { ranges: [], skips: 0, t0: Date.now() }; dirty = true; writeState(lock); }
    return lock.scenes[id];
  }

  // 2.15: a scene opened (by any path) is shown in Roulette's round: `at`
  // is when, at most once a minute (a re-check of the same page is not news)
  function sceneShown(id) {
    const rec = sceneRec(id);
    if (!rec) return;
    const now = Date.now();
    if (!rec.at || now - rec.at > 60000) { rec.at = now; dirty = true; writeState(lock); }
  }

  const sceneHere = () => (/^\/scenes\/(\d+)/.exec(location.pathname) || [])[1] || null;
  // The scene player's own video, not a card's hover preview.
  const isPlayer = (v) => v instanceof HTMLVideoElement && !!v.closest(".video-js") && !!sceneHere();
  const playerVideo = () => (sceneHere() ? document.querySelector(".video-js video") : null);
  // The player's media is the open scene's, not the last one's still playing
  // while Stash loads this one (mediaOwner, 2.8.2). Playback, seeks and
  // "ended" count only then.
  let media = null, reloadAt = null, mediaAt = 0;
  const RELOAD_MS = 20000;   // 2.12.1: how long a transcoded stream may take to come back from a seek
  function noteMedia(v) {
    if (v) {
      const next = mediaOwner(media, v.currentSrc || v.src || "", sceneHere());
      // the same scene's source again, right after a click or key: a seek
      // on a live-transcoded file (the stream reloaded from that point)
      // 2.13.0: through byUser (gateUser), so the click that opened the
      // scene no longer carries to a second source Stash tries as it loads
      if (media && next !== media && next.id && next.id === media.id && byUser()) reloadAt = { id: next.id, at: Date.now() };
      if (next !== media) mediaAt = Date.now();
      media = next;
    }
    return media;
  }
  const mediaHere = (v) => { const id = sceneHere(), m = noteMedia(v); return !!id && (!m || m.id === id); };

  // The sum of O counts over the target's scenes, polled: faster on a scene
  // page, where the O button is. An O pressed anywhere counts.
  // 2.11 (review M5c): on a scene page the open scene's own count is read
  // every 2.5 s (one small query) and every O of the target only every 15 s,
  // or at once when that count moved; elsewhere every 10 s; and only the
  // polling tab reads them all (oCheckPlan).
  let oBusy = false, lastOCheck = 0, lastOScene = 0;
  async function checkO() {
    if (!lock || oBusy || document.visibilityState !== "visible") return;
    const sid = lock.media === "images" ? null : sceneHere();
    const plan = oCheckPlan({ now: Date.now(), lastFull: lastOCheck, lastScene: lastOScene, own: pollOwnerNow(), onScene: !!sid,
                              hasBase: !!lock.oBase, allowed: !!sid && allowedCache.get(`${lock.id}:scene:${sid}`) === true });
    if (!plan) return;
    if (plan === "scene") {
      oBusy = true;
      lastOScene = Date.now();
      let moved = false;
      try {
        const d = await gql(`query ($id: ID!) { findScene(id: $id) { id o_counter } }`, { id: sid });
        moved = !!lock && !!d && !!d.findScene && oSceneMoved(lock.oBase, sid, d.findScene.o_counter || 0);
      } catch (e) { log(`O check (scene) failed: ${e.message}`); }
      finally { oBusy = false; }
      if (!moved) return;
    }
    oBusy = true;
    lastOCheck = Date.now();
    const L = lock;
    try {
      const rows = await oRows(L);
      if (!lock || lock.id !== L.id) return;
      const r = applyO(lock, lock.oBase ? rows : rows.reduce((a, x) => a + x.o, 0), Date.now());
      const before = lock;
      lock = r.lock;
      // 2.19: an O that counts (Finish and Timer: one more O; Edge: the
      // natural finish past the target) wins a Race that is on
      if (lock.hand && lock.hand.race && lock.hand.race.st === "on" &&
          ((lock.os || 0) > (before.os || 0) || (r.end === "done" && (before.goal || {}).type === "edge"))) {
        const h = raceWon(lock.hand, Date.now());
        if (h !== lock.hand) {
          lock = { ...lock, hand: h };
          raceDone = { t: "won", at: Date.now() };
          dirty = true;
          writeState(lock);
          if (!r.end) saveProgress(true);
          sound("best");
          ldToast(tc(`竞赛胜出：${fmtClock(h.race.ms || 0)} · +${RACE_WIN}`, `Race won in ${fmtClock(h.race.ms || 0)} · +${RACE_WIN}`), "info");
          drawHand();
        }
      }
      if (lock.baseO !== before.baseO) writeState(lock);
      if (lock.os !== before.os || lock.slips !== before.slips || lock.early !== before.early) {
        dirty = true;
        saveProgress(true);
        const g = lock.goal || {};
        if (lock.slips > (before.slips || 0)) sound("thud");
        if (lock.slips > (before.slips || 0)) ldToast(g.slip === "reset" ? tc("一次 O：整个目标重新来过", "An O: the whole target again")
          : g.hidden ? tc("一次 O：还要看更多（多少保持隐藏）", "An O: more to watch (how much stays hidden)")
          : tc(`一次 O：还要再看 ${fmtMinutes(Math.round((edgeNeedMs(lock) - edgeNeedMs(before)) / 60000))}`, `An O: ${fmtMinutes(Math.round((edgeNeedMs(lock) - edgeNeedMs(before)) / 60000))} more to watch`));
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
      const d = await gql(`query ($id: ID!) { findScene(id: $id) { id scene_markers { id title seconds created_at primary_tag { id name } tags { id } } } }`, { id });
      const list = d && d.findScene && d.findScene.scene_markers;
      if (!Array.isArray(list) || !lock || lock.id !== runId) return;
      const r = markersSeen(lock, id, list, Date.now());
      if (r.lock === lock) return;
      lock = r.lock;
      // 2.18: a new marker with a played tag card's tag in its scene
      const fresh = list.filter((m) => r.results.some((x) => x.marker === String(m.id)));
      if (fresh.length && lock.hand) {
        const tm = tagMatches(lock.hand, id, fresh, MARK_SKEW_MS);
        if (tm.got.length) {
          lock = { ...lock, hand: tm.hand };
          saveProgress(true);
          sound("best");
          ldToast(tc(`${tm.got.join(", ")} 已标记：标签牌 +${TAG_MATCH_PTS * tm.got.length}`, `${tm.got.join(", ")} marked: +${TAG_MATCH_PTS * tm.got.length} for the tag card`), "done");
        }
      }
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
    if (!v || document.body.classList.contains("ld-checking") || allowedCache.get(`${lock.id}:scene:${id}`) !== true || !mediaHere(v)) return;
    observe(v, id);
    paintWatched(v, id);
    // 2.13.0: and, under Eyes on screen, not while away past the grace
    if (!v.paused && !v.ended && v.readyState >= 3 && document.visibilityState === "visible" && !(eyesOn() && eyesAway(now))) {
      lock.watchedMs = (lock.watchedMs || 0) + dt;
      // 2.12: and the part of it Goon mode drove, for Toy in charge's heat
      if (lock.toy && toyCtl.live(lock)) lock.toy = { ...lock.toy, ms: (lock.toy.ms || 0) + dt };
      dirty = true;
    }
    if (dirty && now - lastCache > 5000) { lastCache = now; writeState(lock); }
  }

  // ── 2.13.0: Eyes on screen ──
  // Counted by the tab where the run plays: a scene of the run playing in
  // it (or Slideshow showing the run's pictures in the last 10 s) when the
  // tab is hidden (another tab, the browser minimised) or the window loses
  // focus (another app). `eyesAt` is when that began. The video plays on;
  // past EYES_GRACE_MS the watching stops counting (trackPlayback, Slideshow
  // time, a locked-time Timer through awayNowLock), and when the eyes come
  // back the stretch past the grace is added to `lock.away` with a toast.
  // Not away: fullscreen (the document keeps focus), Lockdown's and Stash's
  // own dialogs, Intiface Sync's pad (all in the page). Picture-in-picture
  // is away once the Stash window is left (decided: the condition is about
  // Stash in front of you; a toast says so when it opens). A tab that is not
  // playing never counts, so a second Stash tab of the run does not; the
  // playing tab hidden behind it does. A reload is not away: the page
  // unloading ends a stretch at once (pagehide), and the new page starts
  // with none.
  let eyesAt = 0, lastShowAt = 0;
  function eyesOn() { return !!(lock && lock.rules && lock.rules.eyes && lock.media !== "images"); }
  function awayHere() {
    try { return document.visibilityState === "hidden" || (typeof document.hasFocus === "function" && !document.hasFocus()); }
    catch (_) { return false; }
  }
  function playingHere() {
    const id = sceneHere(), v = id && playerVideo();
    if (v && !v.paused && !v.ended && allowedCache.get(`${lock.id}:scene:${id}`) === true && mediaHere(v)) return true;
    return Date.now() - lastShowAt < 10000;
  }
  const eyesAway = (now) => !!eyesAt && now - eyesAt > EYES_GRACE_MS;
  function eyesCheck() {
    if (!eyesOn()) { eyesAt = 0; return; }
    if (awayHere()) { if (!eyesAt && playingHere()) eyesAt = Date.now(); return; }
    if (eyesAt) eyesBack(Date.now(), false);
  }
  // The eyes are back (or the run or the page ends: `quiet`).
  function eyesBack(now, quiet) {
    const since = eyesAt;
    eyesAt = 0;
    if (!since || !lock) return;
    const before = { n: (lock.away && lock.away.n) || 0, ms: awayMsOf(lock) };
    const a = awayAdd(before, now - since);
    if (a.n === before.n && a.ms === before.ms) return;
    lock.away = a;
    dirty = true;
    writeState(lock);
    saveProgress(true);
    const pts = awayPts(a.ms) - awayPts(before.ms);
    if (!quiet) ldToast(tc(`离开 ${fmtAway(a.ms - before.ms)}：−${pts} 点`, `Away ${fmtAway(a.ms - before.ms)}: −${pts} ${pts === 1 ? "point" : "points"}`));
  }
  window.addEventListener("blur", () => guard("eyes", eyesCheck));
  window.addEventListener("focus", () => guard("eyes", eyesCheck));
  document.addEventListener("enterpictureinpicture", (ev) => {
    if (eyesOn() && isPlayer(ev.target)) ldToast(tc("盯着画面：离开 Stash 窗口后，画中画仍算离开", "Eyes on screen: picture-in-picture still counts as away once you leave the Stash window"));
  }, true);

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
  // 2.12.1: `seen`, the last position of the open scene before its check
  // came back; `held`, a user's jump made then ({ id, from }).
  let cur = null, snap = null, drag = null, seen = null, held = null;
  // 2.13.0: inputs and the player's loads (gateUser above); `gate` replaces
  // 2.1-2.12's bare `lastInput`
  let gate = gate0();
  const PLAY_SEL = ".vjs-play-control, .vjs-big-play-button, .vjs-big-play-pause-button, .vjs-menu-button, .vjs-menu, " +
    ".vjs-volume-panel, .vjs-mute-control, .vjs-fullscreen-control, .vjs-picture-in-picture-control, .vjs-playback-rate";
  function inputOn(t) {
    if (!t || !t.closest) return "page";
    // not the bar (2.8.2): Next scene is a click, and the next scene's
    // player placing itself right after it is not the user seeking
    if (t.closest("#ld-bar, " + NEXT_SEL)) return "bar";
    if (!t.closest(".video-js")) return "page";
    if (t.closest(PLAY_SEL)) return "play";
    if (t.closest("video, .vjs-tech, .vjs-poster, .vjs-text-track-display")) return "video";
    return "player";
  }
  for (const t of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(t, (ev) => {
      const tg = ev.target;
      const field = !!tg && (tg.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || "") && tg.type !== "range"));
      gate = gateInput(gate, Date.now(), inputKind({ type: t, key: ev.key, on: inputOn(tg), field,
                                                      touch: t === "touchstart" || ev.pointerType === "touch" }));
    }, { capture: true, passive: true });
  }
  const byUser = () => gateUser(gate, Date.now());
  // The player starting a new source: a load settles (no seek is the user's
  // without a player input after it), unless the user's own seek reloaded
  // the open scene's stream (a transcode), which stays theirs
  document.addEventListener("loadstart", (ev) => {
    const v = ev.target;
    if (!isPlayer(v)) return;
    if (!loadIsSeek(gate, Date.now(), !!media && media.id === sceneHere(), mediaAt)) gate = gateLoad(gate, Date.now(), "start");
  }, true);
  for (const t of ["loadedmetadata", "canplay"]) {
    document.addEventListener(t, (ev) => { if (isPlayer(ev.target)) gate = gateLoad(gate, Date.now(), "meta"); }, true);
  }
  const scrubbing = (v) => { const p = v.closest(".video-js"); return !!(p && p.classList.contains("vjs-scrubbing")); };
  // A function declaration, not a const: the bar (renderBar) reads it, and a
  // run already active when the page loads draws the bar before this line
  // has run (2.5.1's Next scene button threw there and got no click handler).
  function skipBudget() { return lock && lock.rules && lock.rules.skips !== undefined ? lock.rules.skips : null; }
  const isSnap = (t) => !!(snap && Date.now() - snap.at < 3000 && Math.abs(t - snap.t) < 1);

  function sendBack(v, t, msg, good) {
    snap = { t, at: Date.now() };
    seekTo(v, t);
    if (msg) ldToast(msg, good);
  }

  // 2.12.1 (§6, 2.2.0's open item 1): the scene's time is video.js's, not
  // the <video>'s. A file Stash transcodes live is reloaded from the new
  // point on each seek, so the element's own clock starts again near 0 while
  // the player's adds the offset: read raw, every jump on such a file looked
  // like a jump to the start (always free) and its watched parts landed at
  // the wrong place. Stash's player keeps the real time; a plain file reads
  // the same either way. Setting goes through the player too, so a refused
  // jump reloads the stream at the right point.
  function playerOf(v) {
    const p = document.getElementById("VideoJsPlayer")?.player;
    try { return p && typeof p.currentTime === "function" && typeof p.el === "function" && p.el() && p.el().contains(v) ? p : null; }
    catch (_) { return null; }
  }
  function timeOf(v) {
    const p = playerOf(v);
    if (p) { try { const t = p.currentTime(); if (typeof t === "number" && isFinite(t)) return t; } catch (_) {} }
    return v.currentTime;
  }
  function seekTo(v, t) {
    const p = playerOf(v);
    if (p) { try { p.currentTime(t); return; } catch (_) {} }
    v.currentTime = t;
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
        ldToast(d.left ? tc(`用掉一次跳过：本场景还剩 ${d.left} 次跳过`, `Skip used: ${plural(d.left, "skip", "skips")} left in this scene`) : tc("本场景最后一次跳过已用掉", "Last skip in this scene used"));
      }
    } else {
      cur = { id, t: from };
      const msg = budget === 0 && !rec.bonus && !rec.xs ? tc("禁止跳过：只能看已经看过的部分", "No skipping: only the parts you've watched") : tc("还没看过，本场景也没有跳过配额了", "Not watched yet, and no skips left in this scene");
      // 2.20: a skip card in hand is offered; used, the jump goes through
      // as a skip (decided again: the scene may have moved on meanwhile)
      if (lock.hand && lock.hand.sk > 0) {
        sendBack(v, from, "");
        ldToast(msg, "warn", { label: tc(`用一张跳过牌（${lock.hand.sk}）`, `Use a skip card (${lock.hand.sk})`), fn: () => {
          if (!lock || sceneHere() !== id || !useSkipCard(id)) return;
          const d2 = seekDecision(sceneRec(id), to, skipBudget());
          if (!d2.allow) return;
          lock.scenes[id] = d2.rec; cur = { id, t: to };
          dirty = true; writeState(lock); saveProgress(true);
          const pv = playerVideo();
          if (pv) sendBack(pv, to, tc(`用了跳过牌：本场景还剩 ${d2.left || 0} 次跳过`, `Skip card used: ${plural(d2.left || 0, "skip", "skips")} left in this scene`), true);
        } });
      } else sendBack(v, from, msg);
    }
  }
  // 2.20: a skip card played on the scene on screen, which must be out of
  // skips: one more skip there. False when it can't be.
  function useSkipCard(id) {
    const budget = skipBudget();
    if (!lock || !lock.hand || budget === null || !id) return false;
    const rec = sceneRec(id);
    if (skipsLeft(rec, budget) > 0) return false;
    const h = handPlaySkip(lock.hand);
    if (!h) return false;
    lock.scenes = { ...(lock.scenes || {}), [id]: { ...rec, xs: (rec.xs || 0) + 1 } };
    handSet(h, true);
    return true;
  }

  // 2.12.1: a drag still marked scrubbing waits (the 250 ms loop calls this
  // again once it ends): 2.0-2.12 dropped it here unjudged, and the jump then
  // went free unless a click came less than a second before it ended. A drag
  // on a scene not yet known to belong is held (heldSeek) and judged once it is.
  function endDrag() {
    if (!lock || !drag) { drag = null; return; }
    const v = playerVideo(), dr = drag;
    const step = dragStep(dr, sceneHere(), { video: !!v, scrubbing: !!v && scrubbing(v), media: !!v && mediaHere(v),
                                             allowed: allowedCache.get(`${lock.id}:scene:${dr.id}`) === true,
                                             snap: !!v && isSnap(timeOf(v)) });
    if (step === "wait") return;
    drag = null;
    if (step === "hold") held = holdSeek(held, dr.id, dr.from);
    else if (step === "judge") judge(v, dr.id, dr.from, timeOf(v));
  }

  // Playing on adds to the watched parts; a jump nobody reported is judged.
  function observe(v, id) {
    const t = timeOf(v);
    if (!isFinite(t) || v.seeking || scrubbing(v) || drag) return;
    if (!cur || cur.id !== id) {                               // where a scene opens is fine
      cur = { id, t };
      // 2.12.1: unless the user jumped while the scene was being checked
      // (the veil is not drawn over a fullscreen player): judged now, from
      // where it was before the jump
      const h = heldSeek(held, id, t);
      held = h.held;
      if (h.judge) { cur = { id, t: h.from }; judge(v, id, h.from, t); }
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
    // 2.12.1: a live-transcoded file seeks by reloading its stream, which
    // can take longer than INPUT_MS; a reload that came right after a click
    // or key (noteMedia) carries it to the jump it makes
    const carried = !!(reloadAt && reloadAt.id === id && Date.now() - reloadAt.at < RELOAD_MS);
    reloadAt = null;
    if (!byUser() && !carried) { cur.t = t; return; }           // the player was placed, not sought
    judge(v, id, cur.t, t);
  }

  for (const t of ["pointerup", "pointercancel", "mouseup", "touchend"]) {
    document.addEventListener(t, () => { if (drag) setTimeout(endDrag, 80); }, true);
  }

  document.addEventListener("seeking", (ev) => {
    const v = ev.target;
    if (!lock || !isPlayer(v)) return;
    const id = sceneHere();
    if (!id || !mediaHere(v)) return;
    const to = timeOf(v), now = Date.now();
    if (isSnap(to)) { snap = null; cur = { id, t: to }; return; }
    const known = allowedCache.get(`${lock.id}:scene:${id}`) === true;
    const from = cur && cur.id === id ? cur.t : !known && seen && seen.id === id ? seen.t : null;
    if (scrubbing(v)) { if (!drag || drag.id !== id) drag = { id, from: from === null ? to : from }; return; }
    // not known to belong yet: a record now would let a played scene through
    // "unwatched only" (review, 2.2). 2.12.1: a user's jump is held and judged
    // once it is known (observe); the player placing itself is not one
    if (!known) {
      if (from !== null && byUser()) held = holdSeek(held, id, from);
      else seen = { id, t: to };
      return;
    }
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
    if (!id || !mediaHere(v)) return;
    if (allowedCache.get(`${lock.id}:scene:${id}`) !== true) {
      // 2.12.1: where it plays while it is checked (the "from" of a held jump)
      const t = timeOf(v);
      if (!v.seeking && isFinite(t) && !(held && held.id === id)) seen = { id, t };
      return;
    }
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

  // 2.13.0: No fast-forward hides the timeline's preview (previewGuardIn)
  function noFfOn() { return !!(lock && lock.rules && lock.rules.speed && lock.media !== "images"); }
  function previewGuard(on) { previewGuardIn(document, on); }

  // "Stay to the end": the scene being watched (`lock.current`) must play to
  // its end before another opens. It becomes current once it plays, and is
  // done at its last seconds or its "ended".
  const stayOn = () => !!(lock && lock.rules && lock.rules.stay);
  // 2.11 (review M3): done at the end only with the scene really watched
  // (stayCovered); one drag to the last seconds no longer does it. Short
  // of it, a toast says how much is left (seeking back to the start is
  // always free, so it can be watched through).
  let stayTold = 0;
  function stayShort(c) {
    if (Date.now() - stayTold < 15000) return;
    stayTold = Date.now();
    ldToast(tc(`坚持到底：这个场景还有 ${fmtMinutes(Math.max(1, Math.ceil(c.left / 60)))} 没看`, `Stay to the end: ${fmtMinutes(Math.max(1, Math.ceil(c.left / 60)))} of this scene not watched yet`));
  }
  function trackStay(v, id, t) {
    if (!stayOn()) return;
    const c = lock.current;
    if (!c || c.done) { if (!c || c.id !== id || !c.done) { lock.current = { id, done: false }; dirty = true; } }
    const dur = durationOf(v);
    if (lock.current && lock.current.id === id && !lock.current.done && isFinite(dur) && dur > 0 && t >= dur - 3) {
      const cov = stayCovered(rangesOf((lock.scenes || {})[id]), dur);
      if (cov.done) finishCurrent(); else stayShort(cov);
    }
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
    if (!lock || !(ev.target instanceof HTMLMediaElement) || !isPlayer(ev.target) || !mediaHere(ev.target)) return;
    const id = sceneHere();
    if (!id) return;
    if (lock.current && lock.current.id === id && !lock.current.done) finishCurrent();
    if (lock.one && lock.one.id === id) { lock.one = dropOne(lock.one); dirty = true; writeState(lock); saveProgress(true); }
  }, true);

  // Random scenes: when a scene ends, the next one is random too.
  document.addEventListener("ended", (ev) => {
    // the last scene's video ending while this one loads is not this one ending
    // 2.9: stopped here (document capture runs before the player's own
    // listeners), or Stash's continue-playlist would open the queue's next
    // scene while the loop or the random pick happens
    if (!lock || !isPlayer(ev.target) || !mediaHere(ev.target)) return;
    if (oneOn() && lock.one.id && lock.one.id === sceneHere()) { ev.stopImmediatePropagation(); loopOne(ev.target, lock.one.id); return; }
    // 2.20 (user: "the stay card was interrupted even though I didnt touch
    // anything": the scene ended and Roulette dealt the next): a Stay card
    // on this scene plays it again from the start (free: the start is
    // always), no Roulette next, no playlist next, until it is kept
    const sh = lock.hand && lock.hand.hold, shk = sh && HOLD_KINDS[sh.k];
    if (shk && shk.stay && sh.scene === sceneHere()) {
      ev.stopImmediatePropagation();
      cur = { id: sh.scene, t: 0 };
      sendBack(ev.target, 0, tc(`${shk.name}：场景会重新播放，直到保留这张牌`, `${shk.name}: the scene plays again until the card is kept`), true);
      try { const pp = ev.target.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (_) {}
      return;
    }
    if (lock.current && lock.current.id === sceneHere() && !lock.current.done && stayOn()) {
      // 2.11: ended without enough of it watched: it stays the scene (no
      // random next, no playlist next) until it has been
      const dur = durationOf(ev.target);
      const cov = isFinite(dur) && dur > 0 ? stayCovered(rangesOf((lock.scenes || {})[sceneHere()]), dur) : { done: true };
      if (!cov.done) { ev.stopImmediatePropagation(); stayTold = 0; stayShort(cov); return; }
    }
    if (lock.current && lock.current.id === sceneHere()) finishCurrent();
    if (lock.rules && lock.rules.random) { ev.stopImmediatePropagation(); goRandom(); }
  }, true);

  // ── 2.9: the player's own next controls under Roulette ─────────────────────
  // (user: "skip to next video from the player doesn't work"). Stash's skip
  // buttons (video.js, with a queue), the queue panel's buttons and
  // Lockdown's own control-bar button all do Next scene (goRandom(true): the
  // same skip rules as the bar's). Capture phase on the document, because
  // video.js acts on its buttons itself; touchend is only stopped (video.js
  // "tap"), the click that follows does the work.
  function nextControl(ev) {
    if (!lock || !lock.rules || !lock.rules.random || !sceneHere()) return;
    const el = ev.target && ev.target.closest && ev.target.closest(NEXT_SEL);
    if (!el) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    if (ev.type === "click") goRandom(true);
  }
  document.addEventListener("click", nextControl, true);
  document.addEventListener("touchend", (ev) => {
    if (lock && lock.rules && lock.rules.random && sceneHere() && ev.target && ev.target.closest && ev.target.closest(NEXT_SEL)) ev.stopImmediatePropagation();
  }, true);
  // Without a queue Stash shows no next button: Lockdown adds one to the
  // control bar under Roulette (not with One scene's scene chosen).
  const NEXT_ICON = '<svg viewBox="0 0 16 16" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 3.5v9L10 8z"/><path d="M12.5 3.5v9"/></svg>';
  function ensureVjsNext() {
    const have = document.querySelector(".ld-vjsnext");
    const player = sceneHere() ? document.querySelector(".video-js") : null;
    const cbar = player && player.querySelector(".vjs-control-bar");
    const want = !!(lock && lock.rules && lock.rules.random && cbar && !(lock.one && lock.one.id) && !player.classList.contains("vjs-skip-buttons-next"));
    if (!want) { if (have) have.remove(); return; }
    if (have && cbar.contains(have)) return;
    if (have) have.remove();
    const b = document.createElement("button");
    b.type = "button";
    b.className = "vjs-control vjs-button ld-vjsnext";
    b.title = tc("下一个场景", "Next scene");               // 2.12.1: free under Roulette since 2.9.2 (it said "uses a skip")
    b.innerHTML = `${NEXT_ICON}<span class="vjs-control-text">${tc("下一个场景", "Next scene")}</span>`;
    const play = cbar.querySelector(".vjs-play-control");
    if (play) play.after(b); else cbar.prepend(b);
  }

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
  // 2.11 (review M5d): which tab of this browser polls while locked
  // (pollOwner). Without localStorage every tab polls, as before.
  const TAB_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function pollOwnerNow() {
    try {
      const r = pollOwner(JSON.parse(localStorage.getItem(OWNER_KEY) || "null"), TAB_ID, document.visibilityState === "visible", Date.now());
      if (r.write) localStorage.setItem(OWNER_KEY, JSON.stringify(r.write));
      return r.own;
    } catch (_) { return true; }
  }

  // What Stash holds against what this page has: a lock started elsewhere
  // is adopted, one ended elsewhere ends here, the same lock is merged
  // (syncDecision). 2.11: with Suite Data the read is `active` alone unless
  // the history is needed (syncPlan); a finished run still waiting for its
  // write is tried again here.
  let lastSync = 0, syncing = false, lastFull = 0;
  async function sync(force) {
    if (syncing) return;
    const iv = pollIntervals(!!lock, lock ? pollOwnerNow() : true, !!sceneHere());
    if (!force && (document.visibilityState !== "visible" || Date.now() - lastSync < iv.sync)) return;
    syncing = true;
    lastSync = Date.now();
    try {
      retryPending();
      let remote, list = null;
      const light = Date.now() - lastFull < SYNC_FULL_MS ? await readActive() : null;
      if (light && syncPlan(lock && lock.id, light.active, endedIds, Date.now() - lastFull) === "light") remote = light.active;
      else {
        const cfg = await readConfig();
        if (cfg.failed) return;
        lastFull = Date.now();
        remote = cfg.active;
        list = cfg.list;
      }
      const d = syncDecision(lock, remote, list, endedIds, confirmedId);
      // A run that already ended (in the history, or ended here moments ago
      // while this read was out) is not taken up again: a write that raced
      // the end could leave it in `active` (review, 2.2). Clear it instead,
      // unless its own end write is still to land (that write clears it).
      const ghost = d.clear;
      if (ghost && !pendingRead().some((p) => p.id === ghost)) updateConfig(({ active }) => (active && active.id === ghost ? { active: null } : {})).catch(() => {});
      if (d.act === "adopt") adopt(d.remote);
      else if (d.act === "ended") endedElsewhere(d.entry && d.entry.result);
      else if (d.act === "push") pushLock();
      else if (d.act === "merge") {
        confirmedId = lock.id;
        lock = mergeLock(d.remote, lock);
        writeState(lock);
      }
    } finally { syncing = false; }
  }
  // at once, but not twice within a few seconds (focus and visibility come together)
  function syncSoon() { if (Date.now() - lastSync > 3000) sync(true); }

  // ── Nav button ─────────────────────────────────────────────────────────────

  // Stash's own nav icon classes, sized 1em by the stylesheet like its Font
  // Awesome icons (2.3 drew it 18 px inline). fx-keep-color: Flexoki paints
  // nav icons currentColor except these, and the lock stays red (§4.15).
  const ICON = `<svg class="nav-menu-icon fx-keep-color d-block d-xl-inline mb-2 mb-xl-0" viewBox="0 0 16 16" width="1em" height="1em" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;

  function ensureNav() {
    const nav = document.querySelector(".top-nav .navbar-collapse .navbar-nav");
    if (!nav) return;
    // The entry is written once, but the locale can arrive after it exists:
    // refresh the label instead of leaving an English one behind.
    const label = nav.querySelector(".ld-nav a > span");
    if (label) { label.textContent = tc("锁局", "Lockdown"); return; }
    injectStyles();
    const item = document.createElement("div");
    item.className = "nav-link ld-nav col-4 col-sm-3 col-md-2 col-lg-auto";
    const a = document.createElement("a");
    a.href = "#";
    a.className = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column " +
                  "justify-content-between align-items-center btn btn-primary";
    a.innerHTML = ICON + "<span>" + tc("锁局", "Lockdown") + "</span>";
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
  // 2.9: no dialog, under Roulette on a scene: Stash's queue keys ("p n",
  // "p p", "p r") do Next scene instead; the second key is stopped here,
  // before Stash's own shortcut handler sees it.
  let lastKey = null;
  window.addEventListener("keydown", (ev) => {
    const back = document.querySelector(".ld-modal-back");
    const t = ev.target;
    const typing = !!t && (t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") && t.type !== "checkbox"));
    if (!back) {
      // 2.16: Escape closes the bar's "..." menu and the hand
      if (ev.key === "Escape" && bar) {
        const m = bar.querySelector(".ld-barmenu"), hp = bar.querySelector(".ld-handpop");
        if ((m && !m.hidden) || (hp && !hp.hidden)) {
          ev.stopImmediatePropagation(); ev.preventDefault();
          if (m) { m.hidden = true; bar.querySelector(".ld-menubtn")?.setAttribute("aria-expanded", "false"); }
          showHand(false);
          return;
        }
      }
      if (ev.defaultPrevented || typing || ev.ctrlKey || ev.metaKey || ev.altKey || !lock || !lock.rules || !lock.rules.random || !sceneHere()) return;
      const now = Date.now();
      if (queueKey(lastKey, ev.key, now)) { lastKey = null; ev.stopImmediatePropagation(); ev.preventDefault(); goRandom(true); return; }
      lastKey = { key: ev.key, at: now };
      return;
    }
    if (ev.defaultPrevented) return;
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
    toyCtl.follow(lock);            // 2.12: ended or replaced in another tab: so is the toy started here
    if (changed) { resetChecks(); confirmedId = null; pagePrefill = null; renderPage(); }
    if (lock) enforce(true); else clearBar();
  });

  // Check a route the moment the app changes it, before it renders, rather
  // than up to 250 ms later: a forbidden page should never flash up.
  for (const fn of ["pushState", "replaceState"]) {
    const orig = history[fn].bind(history);
    // the player's source is noted against the scene being left first
    // (mediaOwner): the router changes the URL before the player changes
    history[fn] = (...a) => { noteMedia(playerVideo()); const r = orig(...a); if (lock) enforce(false); return r; };
  }
  window.addEventListener("popstate", () => { if (lock) enforce(false); });

  document.addEventListener("visibilitychange", () => {
    guard("eyes", eyesCheck);      // 2.13.0: Eyes on screen, before the hidden tab saves
    if (document.visibilityState === "visible") { lastMark = 0; lastOScene = 0; syncSoon(); }
    else { pollOwnerNow(); if (lock) { writeState(lock); saveProgress(true); } }   // a hidden tab lets the polling go
  });
  window.addEventListener("focus", syncSoon);
  window.addEventListener("pagehide", () => {
    try { const c = JSON.parse(localStorage.getItem(OWNER_KEY) || "null"); if (c && c.tab === TAB_ID) localStorage.removeItem(OWNER_KEY); } catch (_) {}
    if (eyesAt) eyesBack(Date.now(), true);   // 2.13.0: a reload is not away; a stretch ends here
    if (lock) { writeState(lock); saveProgress(true); }
  });

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // A timer, not requestAnimationFrame: rAF never fires in a hidden tab.
    setTimeout(() => { queued = false; guard("nav", ensureNav); if (lock) { guard("bar", renderBar); guard("cards", scanCards); } }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  // 2.12.1: each part on its own (guard): one that throws (the bar, the
  // toy, pictures) no longer stops the watching, the O's or the saves after it
  setInterval(() => {
    guard("nav", ensureNav);
    guard("sync", () => sync(false));
    guard("toy", () => toyCtl.follow(lock));   // 2.12: Goon mode never outlives the run it was started for
    guard("previews", () => previewGuard(noFfOn()));   // 2.13.0: and put back once no such run is on
    guard("eyes", eyesCheck);                  // 2.13.0: Eyes on screen
    if (!lock) return;
    guard("enforce", () => enforce(false));
    guard("watch", trackPlayback);
    guard("pictures", trackPictures);
    guard("next", ensureVjsNext);
    guard("tick", tick);
    guard("o", checkO);
    guard("markers", checkMarkers);
    guard("cards", scanCards);
    guard("save", () => saveProgress(false));
  }, 250);

  ensureNav();
  if (lock) enforce(true);
  sync(true);
})();
