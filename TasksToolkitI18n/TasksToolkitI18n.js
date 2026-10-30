/**
 * Tasks Toolkit - Stash UI plugin
 *
 * One place for Stash's own jobs (scan, generate, identify, auto tag,
 * backups) and the toolkits' read-only scans (MAINTENANCE §4.28):
 * - Overview (/taskstoolkit): what the library needs, from cheap count
 *   queries, grouped Safe / Too long for now / Needs a look, with "Do the
 *   safe ones" queuing the safe ones in a fixed order.
 * - The runner holds the steps itself and sends one at a time to Stash,
 *   within the guards (jobs in Stash's queue, one heavy job, heavy work only
 *   at night, held while a scene plays in this browser). One tab per browser
 *   runs it (a localStorage lock); its state lives in Suite Data, so another
 *   tab or device sees it, and two devices cannot send the same step (the
 *   store refuses a write based on an old revision).
 * - Routines: steps from the safe catalogue only, on a timer from this
 *   browser or in Stash by themselves (0.4.0: Tasks' scheduler, a daemon its
 *   server part starts in the Stash container; every page load asks it to
 *   run, so nothing has to be set up).
 * - Task viewer: the running job with Stop, Stash's queue, what waits here,
 *   History (the last 200 jobs, whoever started them).
 *
 * Nothing in the catalogue changes what the user made: no Clean, no saving
 * a toolkit's matches, no merges or deletes, and Identify only in the safe
 * shape (stash-box fingerprints, empty fields only, nothing created, no
 * cover). A test checks every mutation it can send.
 */
(function () {
  "use strict";
  if (window.__TasksToolkitI18nLoaded) return;
  window.__TasksToolkitI18nLoaded = true;

  // ==================== i18n ====================
  var PLUGIN_VERSION = '0.6.4-1';
  var _intlLocale = '';
  var _afterLocale = [];        // locale 到达后要重绘的东西（导航入口、面板）
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
        React.useEffect(function () {
          var next = (intl && intl.locale) || '';
          if (next && next !== _intlLocale) {
            _intlLocale = next;
            for (var i = 0; i < _afterLocale.length; i++) { try { _afterLocale[i](); } catch (_) {} }
          }
        });
        return null;
      }
      api.patch.before('App', function (props) {
        return [{ children: React.createElement(React.Fragment, null, React.createElement(IntlBridge), props.children) }];
      });
    } catch (e) {
      console.warn('[TasksToolkitI18n] i18n bridge failed:', e);
    }
  })();
  console.log('[TasksToolkitI18n] Tasks Toolkit I18n v' + PLUGIN_VERSION + ' loaded');

  const PLUGIN_ID = "TasksToolkitI18n";
  const PAGE_PATH = "/taskstoolkit";
  const DATA_KEYS = ["routines", "history", "runner", "guards"];   // kept in Suite Data's store when it is installed
  const HIST_MAX = 200;
  const ARM_MS = 6000;                       // "Click again to ..." (suite standard)
  const GRACE_MS = 15 * 60000;               // a routine this late still runs by itself; later it asks
  const LONG_MS = 60 * 60000;                // over an hour: "too long for now"
  const LOCK_KEY = "TasksToolkitI18nLock";       // the one tab of this browser that runs the queue
  const LOCK_STALE_MS = 12000;
  const PLAY_KEY = "TasksToolkitI18nPlaying";    // a scene playing in any tab of this browser
  const VIEW_KEY = "TasksToolkitI18nView";       // what the running tab shows the others (nav indicator)
  const PREFS_KEY = "TasksToolkitI18nPrefs";     // UI only: last tab, unticked rows
  const DEBUG = false;
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  // ═══ Pure helpers (tested) ═════════════════════════════════════════════════

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => (n ?? 0).toLocaleString(isZh() ? "zh-CN" : "en-US");
  // 中文量词：键与英文单数词一致；缺省时退回英文词本身
  const UNIT_ZH = {
    scene: "个场景", gallery: "个图库", performer: "名演员", studio: "个工作室", tag: "个标签",
    folder: "个文件夹", item: "项", "organized item": "个已整理项", job: "个任务", task: "个任务",
    toolkit: "个工具包", "stash-box": "个 stash-box", thing: "件事", routine: "个例程", step: "步",
    "step(s)": "步",
  };
  const plural = (n, w, ws = `${w}s`) => {
    if (isZh()) return `${fmtN(n)} ${UNIT_ZH[w] || w}`;
    return `${fmtN(n)} ${n === 1 ? w : ws}`;
  };
  const pad2 = (n) => String(n).padStart(2, "0");
  function fmtAgo(at, now) {
    const m = Math.floor((now - at) / 60000);
    if (isZh()) {
      if (m < 1) return "刚刚";
      if (m < 60) return `${m} 分钟前`;
      if (m < 48 * 60) return m < 24 * 60 ? `${Math.round(m / 60)} 小时前` : "昨天";
      return `${Math.round(m / 1440)} 天前`;
    }
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    if (m < 48 * 60) return m < 24 * 60 ? `${Math.round(m / 60)} h ago` : "yesterday";
    return `${Math.round(m / 1440)} days ago`;
  }
  function fmtDur(ms) {
    if (!(ms > 0)) return isZh() ? "0 秒" : "0 s";
    const s = Math.round(ms / 1000);
    if (isZh()) {
      if (s < 60) return `${s} 秒`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m} 分钟`;
      const h = Math.floor(m / 60), r = m % 60;
      return r && h < 10 ? `${h} 小时 ${r} 分` : `${Math.round(m / 60)} 小时`;
    }
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r && h < 10 ? `${h} h ${r} min` : `${Math.round(m / 60)} h`;
  }
  const fmtEst = (ms) => (ms > 0 ? `~${fmtDur(ms)}` : "");
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const DAY_SHORT_ZH = ["日", "一", "二", "三", "四", "五", "六"];
  const dayName = (i) => tc(DAYS_ZH[i] || "", DAYS[i] || "");
  // "Today 02:00", "yesterday 02:00", "Sunday 03:00", "4 Oct 05:30"
  function fmtWhen(at, now) {
    const d = new Date(at), n = new Date(now);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(n)) / 86400000);
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (isZh()) {
      if (diff === 0) return `今天 ${hm}`;
      if (diff === -1) return `昨天 ${hm}`;
      if (diff === 1) return `明天 ${hm}`;
      if (diff > -7 && diff < 7) return `${DAYS_ZH[d.getDay()]} ${hm}`;
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
    }
    if (diff === 0) return `today ${hm}`;
    if (diff === -1) return `yesterday ${hm}`;
    if (diff === 1) return `tomorrow ${hm}`;
    if (diff > -7 && diff < 7) return `${DAYS[d.getDay()]} ${hm}`;
    return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${hm}`;
  }
  const median = (xs) => { const a = xs.filter((x) => x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };

  // ── The toolkits whose read-only scans Tasks can start ───────────────────
  // [id, name, icon, task, min]: 0.2.0 (user: "toolkit scans should be able
  // to run by server"): from version `min` each toolkit has a Stash task,
  // `task` with { mode: "scan" }, whose Python part plans the same scan its
  // page's Scan sheet would (the options last kept there) and runs it. So
  // the browser runner and the server script start it the same way, with no
  // page. An older toolkit: its connector's scan() (window.StashSuite
  // .toolkits, v1; §4.14d), from a browser only. Tasks never calls run(key),
  // the quick actions that save.
  const KITS = [
    ["PerformersToolkit", "Performers Toolkit", "person", "Scan performers", "0.18.0"],
    ["SceneToolkit", "Scenes Toolkit", "film", "Scan scenes", "0.10.0"],
    ["StudiosToolkit", "Studios Toolkit", "studio", "Scan studios", "0.4.0"],
    ["TagAtlas", "Tags Toolkit", "tag", "Scan tags", "1.7.0"],
    ["GalleriesToolkit", "Galleries Toolkit", "pics", "Scan galleries", "0.6.0"],
    ["Movies", "Movies Toolkit", "reel", "Scan for movies", "1.6.0"],
    // 0.4.1: Markers Toolkit's scan reads ThePornDB's markers and the files' chapters
    ["MarkersToolkit", "Markers Toolkit", "marker", "Scan markers", "0.1.0"],
    // 0.4.2: Archive Toolkit's scan reads which organized scenes are final (it never
    // moves: archiving is its page's, or its own task, never a safe step)
    ["ArchiveToolkit", "Archive Toolkit", "db", "Scan archive", "0.1.0"],
  ];
  // 0.5.0: a toolkit's second read-only step, apart from its scan:
  // [key, plugin, name, icon, task, args, min, sub, run kind]. Planned on the
  // server only: the connector's scan() is the scan, so there is no browser
  // fallback (an older toolkit leaves the step out, saying why). Scenes
  // Toolkit 0.14.0's "Find updated scenes" (a forum request) only reads:
  // applying what it finds writes, so that stays on its Update tab.
  const KIT_STEPS = [
    ["SceneToolkitUpdates", "SceneToolkit", "Scenes Toolkit: find updated scenes", "film", "Find updated scenes", { mode: "update" }, "0.14.0",
      "Reads only: asks the stash-boxes which linked scenes' records changed since Stash took them; what differs waits on its Update tab", "updplan"],
  ];
  // 0.6.0: Autopilot's own steps, not in the safe catalogue: they write, so
  // no routine and no "Do the safe ones" offers them (routineSteps leaves
  // them out). [key, plugin, name, icon, task, args, min, sub], as the
  // server part's AP_STEPS. Archive Toolkit 0.2.3's select "auto": the clean
  // Ready rows, copies to another mount allowed (hashed before and after).
  const AP_STEPS = [
    ["archive", "ArchiveToolkit", "Archive Toolkit: archive Ready scenes", "db", "Archive ready scenes", { mode: "archive", select: "auto" }, "0.2.3",
      "Moves the clean Ready scenes of its last scan into the library, within its caps, each logged with Undo; stops between scenes when you switch Autopilot off"],
  ];
  const kitName = (id) => {
    const k = KITS.find((x) => x[0] === id);
    if (k) return k[1];
    const s = KIT_STEPS.find((x) => x[0] === id);
    return s ? kitName(s[1]) : id;
  };
  // Scenes Toolkit from this version has "Fill performers from stash-box" (its Fill tab)
  const FILL_MIN = "0.11.0";
  function verAtLeast(v, min) {
    const a = String(v || "").split(/[.-]/).map((x) => parseInt(x, 10) || 0), b = String(min).split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
  }
  // The installed toolkit can plan its scan on the server (its version from
  // Stash's plugin list; unknown counts as not)
  const kitServer = (id, ver) => { const k = KITS.find((x) => x[0] === id); return !!(k && ver && verAtLeast(ver, k[4])); };
  // A toolkit step can be planned on the server by the installed version (0.5.0: a second step has its own minimum)
  const stepServer = (c, ver) => (c && c.only ? !!(ver && verAtLeast(ver, c.min)) : !!(c && kitServer(c.kit, ver)));

  // ── The safe catalogue: everything a routine or "Do the safe ones" may run.
  // Each adds or reads only: new files scanned in, generated files made for
  // scenes missing them, empty fields filled, names in paths added, backups
  // written. `heavy`: Stash is slow while it runs (one at a time, the night
  // guard). `long`: hours, never in the one-click set. `browser`: needs a
  // page (a toolkit picks what to scan), so a server script leaves it out.
  const Q = {
    scan: "mutation ($i: ScanMetadataInput!) { metadataScan(input: $i) }",
    generate: "mutation ($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }",
    identify: "mutation ($i: IdentifyMetadataInput!) { metadataIdentify(input: $i) }",
    autotag: "mutation ($i: AutoTagMetadataInput!) { metadataAutoTag(input: $i) }",
    cleangen: "mutation ($i: CleanGeneratedInput!) { metadataCleanGenerated(input: $i) }",
    optimise: "mutation { optimiseDatabase }",
    backupdb: "mutation ($i: BackupDatabaseInput!) { backupDatabase(input: $i) }",
    task: "mutation ($p: ID!, $t: String!) { runPluginTask(plugin_id: $p, task_name: $t) }",
    kitscan: "mutation ($p: ID!, $t: String!, $a: Map) { runPluginTask(plugin_id: $p, task_name: $t, args_map: $a) }",
    // 0.2.0: Auto tag on what is new goes through Tasks' own server part
    // (autotag_run reads the new scenes' folders and starts metadataAutoTag)
    op: "mutation ($a: Map) { runPluginOperation(plugin_id: \"TasksToolkitI18n\", args: $a) }",
  };
  const CAT = {
    scan: { name: "Scan new files", sub: "New and changed files only, with covers and phashes for them", src: "Stash", heavy: true, icon: "scan", c: "bl",
      q: Q.scan, input: () => ({ rescan: false, scanGenerateCovers: true, scanGeneratePhashes: true }) },
    genfast: { name: "Generate covers and phashes", sub: "Only scenes missing them; previews off", src: "Stash", heavy: true, icon: "gen", c: "bl",
      q: Q.generate, input: () => ({ covers: true, phashes: true, overwrite: false }) },
    identify: { name: "Identify, empty fields only", sub: "Stash-box fingerprints; scenes with a phash and no stash-box link", src: "Stash", heavy: true, icon: "find", c: "bl",
      q: Q.identify, special: "identify" },
    // 0.2.0: only the folders of what was added since the last Auto tag
    // (special "autotag": Tasks' server part). 0.3.0: only the names found
    // in those paths, and no whole-library input at all: when the server
    // part does not answer the step is skipped (a 9-hour run is worse)
    autotag: { name: "Auto tag", sub: "Performer, studio and tag names found in the paths of what was added since the last Auto tag; adds only", src: "Stash", heavy: false, icon: "tag", c: "bl",
      q: Q.autotag, special: "autotag" },
    previews: { name: "Generate previews and sprites", sub: "Only scenes missing them; takes hours", src: "Stash", heavy: true, long: true, icon: "gen", c: "bl",
      q: Q.generate, input: () => ({ previews: true, sprites: true, overwrite: false }) },
    cleangen: { name: "Clean generated files", sub: "Generated files nothing uses any more", src: "Stash", heavy: false, icon: "clean", c: "bl",
      q: Q.cleangen, input: () => ({ blobFiles: true, sprites: true, screenshots: true, transcodes: true, markers: true, imageThumbnails: true, dryRun: false }) },
    optimise: { name: "Optimise database", sub: "Stash answers slowly while it runs", src: "Stash", heavy: true, locks: true, icon: "bolt", c: "bl", q: Q.optimise },
    backupdb: { name: "Back up Stash's database", sub: "Into Stash's backup folder", src: "Stash", heavy: false, sync: true, icon: "db", c: "bl",
      q: Q.backupdb, input: () => ({ download: false }) },
    sdbackup: { name: "Suite Data backup", sub: "Every plugin's data in one file; the newest 10 are kept", src: "Suite Data", heavy: false, icon: "db", c: "gr",
      q: Q.task, plugin: "SuiteData", task: "Backup now" },
  };
  // 冻结表：CAT 保持英文原表（name 还用于历史条目和服务器 notes 的匹配），
  // 中文另存一表，渲染时由 stepName() 按 isZh() 取
  const CAT_ZH = {
    scan: ["扫描新文件", "只扫新增和有改动的文件，并为它们生成封面和 phash"],
    genfast: ["生成封面和 phash", "只处理缺少它们的场景；不生成预览"],
    identify: ["识别（只填空字段）", "按 stash-box 指纹匹配；有 phash 且未关联 stash-box 的场景"],
    autotag: ["自动打标签", "扫描自上次以来新增文件的路径里的演员、工作室和标签名；只新增"],
    previews: ["生成预览和雪碧图", "只处理缺少它们的场景；要花几小时"],
    cleangen: ["清理生成的文件", "已经没人用的生成文件"],
    optimise: ["优化数据库", "运行期间 Stash 响应会变慢"],
    backupdb: ["备份 Stash 数据库", "备份到 Stash 的备份文件夹"],
    sdbackup: ["Suite Data 备份", "所有插件的数据存进一个文件；保留最新 10 份"],
  };
  // "Do the safe ones" runs in this order: new files first, then what they
  // need (covers and phashes, which Identify matches on), then what reads
  // the result, then the backups of it all.
  const ORDER = ["scan", "genfast", "identify", "autotag"].concat(KITS.map((k) => "kit:" + k[0]), KIT_STEPS.map((k) => "kit:" + k[0]), ["sdbackup", "backupdb", "previews", "cleangen", "optimise"]);
  function catOf(k) {
    if (CAT[k]) return CAT[k];
    const ap = /^ap:(\w+)$/.exec(String(k || "")), a = ap && AP_STEPS.find((x) => x[0] === ap[1]);
    if (a) return { name: a[2], sub: a[7], src: kitName(a[1]), heavy: false, icon: a[3], c: "or", kit: a[1], q: Q.kitscan, plugin: a[1], task: a[4], args: a[5], min: a[6], only: true, ap: true, writes: true };
    if (ap) return null;
    const m = /^kit:(\w+)$/.exec(String(k || ""));
    const kit = m && KITS.find((x) => x[0] === m[1]);
    // 0.5.0: a toolkit's second step (kit is the plugin; only: no browser fallback)
    const ks = m && !kit && KIT_STEPS.find((x) => x[0] === m[1]);
    if (ks) return { name: ks[2], sub: ks[7], src: kitName(ks[1]), heavy: false, icon: ks[3], c: "or", kit: ks[1], q: Q.kitscan, plugin: ks[1], task: ks[4], args: ks[5], min: ks[6], only: true, runKind: ks[8] };
    if (!kit) return null;
    return { name: `${kit[1]} scan`, sub: "Reads only, planned on the server; what it finds waits on its page", src: kit[1], heavy: false, icon: kit[2], c: "or", kit: kit[0],
      q: Q.kitscan, plugin: kit[0], task: kit[3], args: { mode: "scan" }, min: kit[4] };
  }
  // 目录键的中文名；没有中文条目（或非目录键）返回 null
  function catZh(k) {
    const key = String(k || "");
    if (CAT_ZH[key]) return { name: CAT_ZH[key][0], sub: CAT_ZH[key][1] };
    const ap = /^ap:(\w+)$/.exec(key);
    const a = ap && AP_STEPS.find((x) => x[0] === ap[1]);
    if (a && AP_STEP_ZH[a[0]]) return { name: AP_STEP_ZH[a[0]][0], sub: AP_STEP_ZH[a[0]][1] };
    const m = /^kit:(\w+)$/.exec(key);
    const ks = m && KIT_STEPS.find((x) => x[0] === m[1]);
    if (ks && KIT_STEP_ZH[ks[0]]) return { name: KIT_STEP_ZH[ks[0]][0], sub: KIT_STEP_ZH[ks[0]][1] };
    const kit = m && KITS.find((x) => x[0] === m[1]);
    if (kit) return { name: `${kit[1]} 扫描`, sub: "只读取，在服务器上规划；结果等你在它的页面上查看" };
    return null;
  }
  // 工具包的第二类步骤与 Autopilot 的步骤（品牌名与 task 名保持英文）
  const KIT_STEP_ZH = {
    SceneToolkitUpdates: ["Scenes Toolkit：查找已更新的场景",
      "只读取：向 stash-box 询问已关联场景的记录自 Stash 收录以来有哪些变化；有差异的内容等你在它的 Update 标签页查看"],
  };
  const AP_STEP_ZH = {
    archive: ["Archive Toolkit：归档 Ready 场景",
      "把它上次扫描到的干净 Ready 场景移入媒体库（受它的上限约束），每个都记录可撤销；你关掉 Autopilot 时会在场景之间停下"],
  };
  // 英文名：历史条目匹配服务器 notes（notes 里存的是英文步骤名），脚本也用它
  const stepNameEn = (k) => (catOf(k) || { name: String(k) }).name;
  const stepName = (k) => { const z = isZh() && catZh(k); return z ? z.name : stepNameEn(k); };
  // 目录说明的中文（供 catOf 的 sub 显示）
  const catSub = (k) => { const z = isZh() && catZh(k); return z ? z.sub : (catOf(k) || {}).sub || ""; };
  const safeOrder = (ks) => ks.slice().sort((a, b) => (ORDER.indexOf(a) < 0 ? 99 : ORDER.indexOf(a)) - (ORDER.indexOf(b) < 0 ? 99 : ORDER.indexOf(b)));

  // ── Identify, the safe shape (user: "Identify is safe if it detects scenes
  // that are linked with phash on stash-box"). Stash-box sources only, which
  // match by fingerprint; one match or nothing (skipMultipleMatches); every
  // field MERGE, which fills an empty single value and adds to lists, never
  // OVERWRITE; nothing created (createMissing false); no cover, organized
  // left alone, no tag added to skipped scenes. The scenes: those with a
  // phash and no stash-box link, read when the step starts.
  const ID_FIELDS = ["title", "code", "details", "director", "urls", "date", "studio", "performers", "tags", "stash_ids"];
  const ID_FILTER = { is_missing: "stash_id", NOT: { is_missing: "phash" } };
  function safeIdentifyInput(endpoints, ids, defaults) {
    const o = (defaults && defaults.options) || {};
    return {
      sources: (endpoints || []).map((e) => ({ source: { stash_box_endpoint: e } })),
      options: {
        fieldOptions: ID_FIELDS.map((f) => ({ field: f, strategy: "MERGE", createMissing: false })),
        setCoverImage: false, setOrganized: false, skipMultipleMatches: true, skipSingleNamePerformers: true,
        includeMalePerformers: o.includeMalePerformers === false ? false : true,
      },
      sceneIDs: (ids || []).map(String),
    };
  }
  // The stash-boxes the user's own Identify uses, in its order; scrapers and
  // Auto Tag left out. None chosen there: every stash-box set up.
  function idEndpoints(defaults, boxes) {
    const known = (boxes || []).map((b) => b && b.endpoint).filter(Boolean);
    const mine = ((defaults && defaults.sources) || []).map((s) => s && s.source && s.source.stash_box_endpoint).filter((e) => e && known.indexOf(e) >= 0);
    return mine.length ? mine.filter((e, i) => mine.indexOf(e) === i) : known;
  }
  // What the user's own Identify settings would change beyond the safe
  // shape, in words; empty when they already are that.
  function identifyRisks(defaults) {
    if (!defaults) return [];
    const o = defaults.options || {}, out = [];
    const over = (o.fieldOptions || []).filter((f) => f && f.strategy === "OVERWRITE").map((f) => f.field);
    if (over.length) out.push(tc(`覆盖 ${over.join("、")}`, `overwrites ${over.join(", ")}`));
    if (o.setCoverImage) out.push(tc("替换封面", "replaces covers"));
    if (o.setOrganized) out.push(tc("把场景标记为已整理", "marks scenes organized"));
    const make = (o.fieldOptions || []).filter((f) => f && f.createMissing).map((f) => f.field);
    if (make.length) out.push(tc(`创建缺少的 ${make.join("、")}`, `creates missing ${make.join(" and ")}`));
    if ((defaults.sources || []).some((s) => s && s.source && s.source.scraper_id)) out.push(tc("使用按名称匹配的抓取器", "uses scrapers that match by name"));
    return out;
  }

  // ── Guards ───────────────────────────────────────────────────────────────
  const GUARDS = { maxQueue: 3, oneHeavy: true, holdPlay: true, night: false, from: 1, to: 8 };
  // A job in Stash's queue that makes Stash slow, from its description
  const heavyJob = (desc) => /scan|generat|identif|clean|optimi|auto ?tag|transcod/i.test(String(desc || ""));
  // Which catalogue step a job someone else started was, for History and
  // "last scan" (Stash's own descriptions; a toolkit runs as a plugin task)
  function classifyDesc(desc) {
    const d = String(desc || "");
    if (/^scanning|\bscan\b/i.test(d) && !/plugin/i.test(d)) return "scan";
    if (/clean/i.test(d)) return /generated/i.test(d) ? "cleangen" : "clean";
    if (/generat/i.test(d)) return "generate";
    if (/identif/i.test(d)) return "identify";
    if (/auto ?tag/i.test(d)) return "autotag";
    if (/optimi/i.test(d)) return "optimise";
    if (/backup/i.test(d)) return "backupdb";
    if (/plugin/i.test(d)) return "plugin";
    return "";
  }
  const inNight = (h, from, to) => (from <= to ? h >= from && h < to : h >= from || h < to);
  const live = (q) => (q || []).filter((j) => j && j.status !== "FINISHED" && j.status !== "FAILED" && j.status !== "CANCELLED");
  // Why an item may not be sent now ("" = it may). ctx: { queue (Stash's
  // jobQueue), guards, playing (a scene plays in this browser), now, hour, force }
  function gate(item, ctx) {
    const g = { ...GUARDS, ...((ctx && ctx.guards) || {}) }, q = live(ctx.queue);
    const c = catOf(item.k);
    if (!c) return tc("不是 Tasks 认识的任务", "Not a step Tasks knows");
    if (item.held) return tc("被你暂停了", "Held by you");
    if (item.after && item.after > ctx.now) return tc(`等到 ${fmtWhen(item.after, ctx.now)} 再运行`, `Waits until ${fmtWhen(item.after, ctx.now)}`);
    if (q.length >= g.maxQueue) return tc(`Stash 队列里已有 ${q.length} 项（最多 ${g.maxQueue} 项）`, `Stash's queue has ${q.length} of at most ${g.maxQueue}`);
    if (item.idle && q.length) return tc("等 Stash 空闲", "Waits for Stash to be idle");
    const heavy = c.heavy || c.locks;
    if (heavy && g.oneHeavy) { const h = q.find((j) => heavyJob(j.description)); if (h) return tc(`重任务：等 "${String(h.description || "a job").slice(0, 40)}" 结束`, `Heavy: waits for "${String(h.description || "a job").slice(0, 40)}"`); }
    if (heavy && g.night && !inNight(ctx.hour, g.from, g.to)) return tc(`重任务：等到 ${pad2(g.from)}:00`, `Heavy: waits for ${pad2(g.from)}:00`);
    if (g.holdPlay && ctx.playing && item.src && item.src.t !== "you" && ctx.force !== item.id) return tc("已暂停：有场景正在播放", "Held: a scene is playing");
    return "";
  }
  // The first item that may go now, and why each one before it waits.
  // Items wait in order: one held back by a guard holds the rest, since a
  // routine's steps depend on the ones before them.
  function firstReady(wait, ctx) {
    const why = {};
    for (const it of wait || []) {
      const w = gate(it, ctx);
      if (!w) return { item: it, why };
      why[it.id] = w;
      if (!it.held && !(it.after && it.after > ctx.now)) {
        // the rest wait behind it
        for (const r of wait) if (r !== it && !why[r.id] && r.id !== it.id) why[r.id] = why[r.id] || tc("等上面那一项先跑", "Waits for the one above");
        return { item: null, why };
      }
    }
    return { item: null, why };
  }

  // ── Schedules (local time) ──────────────────────────────────────────────
  // sched: { freq: daily | weekly | monthly | hand, time: "HH:MM", dow: 0-6 }
  // Monthly is the first <dow> of the month, as Stash users plan maintenance.
  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return { h: +m[1], m: +m[2] };
  }
  function dayMatch(s, d) {
    if (s.freq === "daily") return true;
    if (s.freq === "weekly") return d.getDay() === (+s.dow || 0);
    if (s.freq === "monthly") return d.getDay() === (+s.dow || 0) && d.getDate() <= 7;
    return false;
  }
  function nextRun(s, from) {
    const t = s && parseHM(s.time);
    if (!t || !["daily", "weekly", "monthly"].includes(s.freq)) return 0;
    const b = new Date(from);
    for (let i = 0; i <= 40; i++) {
      const c = new Date(b.getFullYear(), b.getMonth(), b.getDate() + i, t.h, t.m, 0, 0);
      if (c.getTime() > from && dayMatch(s, c)) return c.getTime();
    }
    return 0;
  }
  function lastDue(s, now) {
    const t = s && parseHM(s.time);
    if (!t || !["daily", "weekly", "monthly"].includes(s.freq)) return 0;
    const b = new Date(now);
    for (let i = 0; i <= 40; i++) {
      const c = new Date(b.getFullYear(), b.getMonth(), b.getDate() - i, t.h, t.m, 0, 0);
      if (c.getTime() <= now && dayMatch(s, c)) return c.getTime();
    }
    return 0;
  }
  // A browser routine's timer: "due" (run it now), "missed" (no Stash tab was
  // open when it was due: ask), or "". Taken or skipped dues, and dues from
  // before the routine was made or last changed, do not count.
  function dueState(r, now) {
    if (!r || !r.on || r.where !== "browser" || !r.sched || r.sched.freq === "hand") return "";
    const d = lastDue(r.sched, now);
    if (!d) return "";
    if (d <= Math.max(r.created || 0, r.edited || 0, r.takenDue || 0, r.skipDue || 0)) return "";
    return now - d <= GRACE_MS ? "due" : "missed";
  }
  function schedWords(s) {
    if (!s || s.freq === "hand") return tc("手动", "By hand");
    const t = parseHM(s.time), at = t ? `${pad2(t.h)}:${pad2(t.m)}` : "?";
    if (s.freq === "daily") return tc(`每天 ${at}`, `Every day at ${at}`);
    if (s.freq === "weekly") return `${dayName(+s.dow || 0)} ${at}`;
    if (s.freq === "monthly") return tc(`每月第一个${dayName(+s.dow || 0)} ${at}`, `First ${DAYS[+s.dow || 0]} of the month at ${at}`);
    return tc("手动", "By hand");
  }
  // cron's fields; "first Sunday" is days 1-7 here and a weekday check in the
  // script (cron ORs day-of-month and day-of-week when both are set)
  function cronLine(s) {
    const t = parseHM(s && s.time);
    if (!t) return "";
    if (s.freq === "daily") return `${t.m} ${t.h} * * *`;
    if (s.freq === "weekly") return `${t.m} ${t.h} * * ${+s.dow || 0}`;
    if (s.freq === "monthly") return `${t.m} ${t.h} 1-7 * *`;
    return "";
  }

  // ── Stored data. Each key holds JSON text; one that does not parse is
  // refused, never replaced (rule 5) ────────────────────────────────────────
  function readJson(map, key, dflt, ok) {
    const raw = map && map[key];
    if (raw === undefined || raw === null || raw === "") return dflt;
    let v;
    try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { v = undefined; }
    if (v === undefined || !ok(v)) throw new Error(tc(`Tasks Toolkit 的数据「${key}」无法读取；没有写入任何内容`, `Tasks Toolkit's ${key} could not be read; nothing was written`));
    return v;
  }
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function readData(map) {
    const runner = readJson(map, "runner", { wait: [], cur: null, hold: false }, isObj);
    return {
      routines: readJson(map, "routines", [], Array.isArray).filter(isObj).map(normRoutine),
      history: readJson(map, "history", [], Array.isArray).filter(isObj),
      runner: { ...runner, wait: Array.isArray(runner.wait) ? runner.wait.filter(isObj) : [], cur: isObj(runner.cur) ? runner.cur : null, hold: !!runner.hold },
      guards: { ...GUARDS, ...readJson(map, "guards", {}, isObj) },
    };
  }
  // The whole new map: every key written back as JSON text, unknown keys and
  // unknown fields riding through untouched
  function writeData(mine, d) {
    return { ...mine, routines: JSON.stringify(d.routines), history: JSON.stringify(d.history), runner: JSON.stringify(d.runner), guards: JSON.stringify(d.guards) };
  }
  let idN = 0;
  const newId = (p, now) => `${p}${(now || Date.now()).toString(36)}${(++idN).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  // A routine with its defaults filled in; fields this version does not
  // know ride through (rule 5)
  function normRoutine(r) {
    const s = isObj(r.sched) ? r.sched : {};
    return {
      ...r,
      id: String(r.id || ""), name: String(r.name || "Routine"),
      steps: Array.isArray(r.steps) ? r.steps.map(String) : [],
      sched: { ...s, freq: ["daily", "weekly", "monthly", "hand"].includes(s.freq) ? s.freq : "hand", time: parseHM(s.time) ? s.time : "02:00", dow: Math.max(0, Math.min(6, +s.dow || 0)) },
      where: r.where === "server" ? "server" : "browser",
      on: r.on !== false, idle: r.idle !== false, holdPlay: r.holdPlay !== false, onFail: r.onFail === "continue" ? "continue" : "stop",
    };
  }
  // Steps a routine may hold: the safe catalogue, nothing else
  const routineSteps = (ks) => (ks || []).filter((k) => { const c = catOf(k); return !!c && !c.ap; });

  // ── The queue ─────────────────────────────────────────────────────────────
  // items: { id, k, src: { t: safe | you | routine | tonight, name, rid, run, idx, of }, at, held, after, idle, hold }
  function enqueue(d, ks, src, now, more) {
    const items = routineSteps(ks).map((k, i) => ({ id: newId("w", now), k, src: { ...src, idx: i + 1, of: ks.length }, at: now, ...(more || {}) }));
    d.runner.wait = d.runner.wait.concat(items);
    return items;
  }
  function enqueueRoutine(d, r, now, due) {
    const run = newId("r", now);
    const items = enqueue(d, r.steps, { t: "routine", name: r.name, rid: r.id, run }, now, { idle: !!r.idle, hold: r.holdPlay !== false });
    const i = d.routines.findIndex((x) => x.id === r.id);
    if (i >= 0) d.routines[i] = { ...d.routines[i], takenDue: due || d.routines[i].takenDue || 0, cur: { run, at: now, ok: 0, failed: 0, of: items.length } };
    return items;
  }
  function moveItem(wait, id, dir) {
    const i = wait.findIndex((x) => x.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= wait.length) return wait;
    const out = wait.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }
  function pushHist(list, e) {
    const out = [e].concat(list || []);
    return out.slice(0, HIST_MAX);
  }
  // The running step ended: its History entry, and its routine's tally; a
  // failed step with "stop the routine" takes that run's other steps out
  // (they go to History as skipped, so nothing disappears unsaid)
  // "Auto tag skipped: ..." already names the step and how it ended
  const endWords = (k, result, note) => {
    if (note && (note.startsWith(`${stepNameEn(k)} ${result}`) || note.startsWith(`${stepName(k)} ${result}`))) return note;
    if (isZh()) return `${stepName(k)}${resultZh(result)}${note ? `：${note}` : ""}`;
    return `${stepName(k)} ${result}${note ? `: ${note}` : ""}`;
  };
  function finishCur(d, result, note, now) {
    const c = d.runner.cur;
    if (!c) return d;
    const start = c.startedAt || c.sentAt || now;
    d.history = pushHist(d.history, { id: c.id, k: c.k, label: stepName(c.k), src: c.src || { t: "you" }, start, end: now, result, note: note || "", job: c.job || "" });
    d.runner.cur = null;
    const s = c.src || {};
    if (s.t !== "routine") return d;
    const ri = d.routines.findIndex((x) => x.id === s.rid);
    const r = ri >= 0 ? d.routines[ri] : null;
    const tally = r && r.cur && r.cur.run === s.run ? { ...r.cur } : { run: s.run, at: start, ok: 0, failed: 0, of: s.of || 1 };
    if (result === "ok") tally.ok += 1; else tally.failed += 1;
    let notes = result === "ok" ? "" : endWords(c.k, result, note);
    // 0.3.0: a skipped step (Auto tag without its server part) does not stop the routine
    if (result !== "ok" && result !== "skipped" && r && r.onFail === "stop") {
      const left = d.runner.wait.filter((w) => w.src && w.src.run === s.run);
      d.runner.wait = d.runner.wait.filter((w) => !(w.src && w.src.run === s.run));
      for (const w of left) d.history = pushHist(d.history, { id: w.id, k: w.k, label: stepName(w.k), src: w.src, start: now, end: now, result: "skipped", note: `${stepName(c.k)} ${result}, so the routine stopped`, job: "" });
    }
    const more = d.runner.wait.some((w) => w.src && w.src.run === s.run);
    if (r) {
      if (more) d.routines[ri] = { ...r, cur: tally };
      else {
        const { cur, ...rest } = r;
        d.routines[ri] = { ...rest, last: { at: tally.at, end: now, ok: tally.ok, failed: tally.failed, of: tally.of, took: now - tally.at, note: notes || (r.last && r.cur && r.cur.note) || "" } };
      }
    }
    return d;
  }

  // ── History views ─────────────────────────────────────────────────────────
  const KIND_GROUP = (e) => (/^kit:/.test(e.k) ? "kits" : e.k === "sdbackup" ? "sd" : "stash");
  const HIST_FILTERS = {
    all: () => true, stash: (e) => KIND_GROUP(e) === "stash", kits: (e) => KIND_GROUP(e) === "kits", sd: (e) => KIND_GROUP(e) === "sd",
    routine: (e) => e.src && (e.src.t === "routine" || e.src.t === "server"), you: (e) => e.src && ["you", "safe", "tonight"].includes(e.src.t),
    failed: (e) => e.result === "failed", stopped: (e) => e.result === "stopped" || e.result === "skipped",
  };
  const histFilter = (list, f) => (list || []).filter(HIST_FILTERS[f] || HIST_FILTERS.all);
  function histCounts(list) {
    const out = {};
    Object.keys(HIST_FILTERS).forEach((f) => { out[f] = histFilter(list, f).length; });
    return out;
  }
  // Time spent per plugin over the last `days`, biggest first
  function timePerPlugin(list, now, days = 30) {
    const by = {};
    for (const e of list || []) {
      if (!(e.end > now - days * 86400000) || !(e.end >= e.start)) continue;
      const who = /^kit:/.test(e.k) ? kitName(e.k.slice(4)) : e.k === "sdbackup" ? "Suite Data" : "Stash";
      by[who] = (by[who] || 0) + (e.end - e.start);
    }
    return Object.keys(by).map((name) => ({ name, ms: by[name] })).sort((a, b) => b.ms - a.ms);
  }
  // When a step last ended well, from History (Tasks' own runs and the jobs
  // it saw others start)
  function lastOk(list, k) {
    const want = k === "genfast" || k === "previews" ? ["genfast", "previews", "generate"] : [k];
    let at = 0;
    for (const e of list || []) if (want.includes(e.k) && e.result === "ok" && e.end > at) at = e.end;
    return at;
  }

  // ── Estimates: the median of the last five good runs of that step, else a
  // guess from the library's size (L.scenes, counts) ─────────────────────────
  function estimate(k, L, list) {
    const runs = (list || []).filter((e) => e.k === k && e.result === "ok" && e.end > e.start).slice(0, 5).map((e) => e.end - e.start);
    // Auto tag's runs went through more or fewer folders each time: the
    // guess from what is new now, not the median
    if (runs.length && !(k === "autotag" && L && L.autotag)) return median(runs);
    const n = (L && L.scenes) || 0, min = 60000;
    switch (k) {
      case "scan": return Math.max(2 * min, n * 40);
      case "genfast": return min / 2 + ((L && (L.nophash || 0) + (L.nocover || 0)) || 0) * 3000;
      case "identify": return min + ((L && L.idable) || 0) * 1200;
      case "autotag": {
        // 0.3.0: Stash goes name by name over the folders: about a second a
        // name for each run, plus a little per name and item
        const a = L && L.autotag;
        if (a) {
          const names = (a.performers || 0) + (a.studios || 0) + (a.tags || 0), items = (a.scenes || 0) + (a.galleries || 0);
          return names ? Math.max(min / 2, names * 1000 * Math.max(1, a.parts || 1) + names * items * 0.5) : min / 2;
        }
        return Math.max(3 * min, n * 15);
      }
      case "previews": return Math.max(60 * min, n * 400);
      case "optimise": return Math.max(5 * min, n * 40);
      case "backupdb": return Math.max(min, n * 5);
      case "cleangen": return Math.max(2 * min, n * 10);
      case "sdbackup": return min;
      default: return 10 * min;   // a toolkit's scan
    }
  }

  // "Auto tag: 1,258 scenes added in the last 7 days · 37 performers, 4 studios, 12 tags to look for"
  const atNames = (a) => (a.performers || 0) + (a.studios || 0) + (a.tags || 0);
  function autotagTitle(a, now) {
    const what = [a.scenes ? plural(a.scenes, "scene") : "", a.galleries ? plural(a.galleries, "gallery", "galleries") : ""].filter(Boolean).join(tc(" 和 ", " and "));
    if (!what) return tc("自动打标签：上次之后没有新增内容", "Auto tag: nothing added since the last one");
    const d = new Date(a.since || 0);
    const when = a.first ? tc("最近 7 天内", "in the last 7 days")
      : tc(`${d.getMonth() + 1} 月 ${d.getDate()} 日以来${new Date(now).getFullYear() !== d.getFullYear() ? `（${d.getFullYear()} 年）` : ""}`,
        `since ${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}${new Date(now).getFullYear() !== d.getFullYear() ? ` ${d.getFullYear()}` : ""}`);
    const head = tc(`自动打标签：${when}新增 ${what}`, `Auto tag: ${what} added ${when}`);
    if (a.error) return `${head}${tc(" · 无法规划", " · cannot plan it")}`;
    if (!a.folders) return `${head}${tc(" · 没有可以单独下发的文件夹", " · none in a folder it can be given on its own")}`;
    if (!atNames(a)) return `${head}${tc(" · 这些路径里没有演员、工作室或标签名", " · no performer, studio or tag names in their paths")}`;
    return `${head}${tc(` · 待查找：${plural(a.performers || 0, "performer")}、${plural(a.studios || 0, "studio")}、${plural(a.tags || 0, "tag")}`,
      ` · ${plural(a.performers || 0, "performer")}, ${plural(a.studios || 0, "studio")}, ${plural(a.tags || 0, "tag")} to look for`)}`;
  }

  // A safe row's tick: the user's choice (prefs ticks: false or true) over
  // the row's own default (on, except a fresh scan)
  const SCAN_STALE_MS = 6 * 3600000;
  const tickOn = (row, ticks) => (ticks && typeof ticks[row.k] === "boolean" ? ticks[row.k] : row.dflt !== false);
  // The Tick: the opposite of what shows; back to the default drops the choice
  function nextTicks(ticks, row) {
    const out = { ...(ticks || {}) }, want = !tickOn(row, ticks);
    if (want === (row.dflt !== false)) delete out[row.k]; else out[row.k] = want;
    return out;
  }
  // 0.4.0: the scheduler's (and the old script's) steps as History entries,
  // so "last scan" and the estimates count what ran with no tab open. The
  // scheduler's notes carry the step's key; the old script's only its name.
  function serverHist(notes) {
    const byName = {};
    for (const k of ORDER) byName[shSafe(stepNameEn(k))] = k;
    const out = [];
    for (const name of Object.keys((notes && notes.runs) || {})) {
      const r = notes.runs[name];
      for (const run of [r, r && r.prev]) {
        if (!run || !Array.isArray(run.steps)) continue;
        let prev = run.startedAt || 0;
        for (const st of run.steps) {
          out.push({ id: `sv${name}${st.at}`, k: st.k || byName[st.name] || "", label: st.name || "Step", src: { t: "server", name }, start: prev, end: st.at,
            result: st.result === "skipped" ? "skipped" : st.result || "ok", note: st.text || "", job: st.job || "" });
          prev = st.at;
        }
      }
    }
    return out;
  }

  // ── The Overview: rows from the library's counts (pure) ─────────────────
  // L: { scenes, nophash, nocover, idable, unorg, recent, boxes, idDefaults,
  //      kits: [{ id, present, lastScan, items }], sd: { on, lastBackup }, hist }
  function overview(L, now, ticks) {
    const H = (L && L.hist) || [];
    const est = (k) => estimate(k, L, H);
    const ago = (at) => (at ? fmtAgo(at, now) : "");
    const rows = { safe: [], long: [], look: [], fine: [] };
    const add = (row) => {
      const c = catOf(row.k) || {};
      row = { heavy: !!(c.heavy || c.locks), icon: c.icon, c: c.c, src: c.src, ...row };
      if (row.est === undefined) row.est = est(row.k);
      if (!row.need) { rows.fine.push(row); return; }
      if (row.longOnly || c.long || (row.est > LONG_MS && !row.keepSafe)) rows.long.push(row);
      else rows.safe.push({ ...row, on: tickOn(row, ticks) });
    };
    // 0.4.0 (user: a "Scan library for new files" row always there): always
    // under Safe with its own Run. Ticked, and so the first step of Do the
    // safe ones, when the last scan is over SCAN_STALE_MS old or unknown;
    // fresher, it stays listed but unticked and is not counted as to do.
    const lastScan = lastOk(H, "scan"), scanStale = !lastScan || now - lastScan > SCAN_STALE_MS;
    add({ k: "scan", need: true, keepSafe: true, dflt: scanStale, quiet: !scanStale,
      title: lastScan ? tc(`扫描新文件 · 上次扫描 ${ago(lastScan)}`, `Scan library for new files · last scan ${ago(lastScan)}`) : tc("扫描新文件", "Scan library for new files"),
      sub: tc(`只扫新增和有改动的文件，并为它们生成封面和 phash。${lastScan ? "" : " Tasks 还没见过一次扫描。"}${scanStale ? "" : " 最近扫过，可以跳过；勾选即可纳入。"}`,
        `New and changed files, with their covers and phashes.${lastScan ? "" : " Tasks has not seen a scan yet."}${scanStale ? "" : " Recent enough to skip; tick it to include it."}`) });
    const np = L.nophash || 0, nc = L.nocover || 0;
    add({ k: "genfast", need: np + nc > 0,
      title: np && nc ? tc(`${plural(np, "scene")}没有 phash，${fmtN(nc)} 个没有封面`, `${plural(np, "scene")} without a phash, ${fmtN(nc)} without a cover`)
        : np ? tc(`${plural(np, "scene")}没有 phash`, `${plural(np, "scene")} without a phash`)
          : tc(`${plural(nc, "scene")}没有封面`, `${plural(nc, "scene")} without a cover`),
      sub: tc("只处理缺少它们的场景。", "Only for scenes missing them."), fine: tc("每个场景都有 phash 和封面", "every scene has a phash and a cover") });
    const ends = idEndpoints(L.idDefaults, L.boxes);
    if (ends.length) {
      add({ k: "identify", need: (L.idable || 0) > 0,
        title: tc(`按指纹识别 ${plural(L.idable || 0, "scene")}`, `Identify ${plural(L.idable || 0, "scene")} by fingerprint`),
        sub: tc(`在 ${(L.boxes || []).filter((b) => ends.includes(b.endpoint)).map((b) => b.name || b.endpoint).join("、") || "你的 stash-box"} 上按指纹匹配。只填空字段；不覆盖、不创建。`,
          `Matched by fingerprint on ${(L.boxes || []).filter((b) => ends.includes(b.endpoint)).map((b) => b.name || b.endpoint).join(", ") || "your stash-box"}. Fills empty fields only; overwrites and creates nothing.`),
        fine: tc("每个有 phash 的场景都已关联 stash-box", "every scene with a phash has a stash-box link") });
    }
    const at = L.autotag;
    if (at) {
      // 0.3.0: something to do only when a name was found in the new paths
      const atWhere = tc(`${plural(at.folders || 0, "folder")}${(at.parts || 0) > 1 ? `，分 ${at.parts} 批依次运行` : ""}`,
        `${plural(at.folders || 0, "folder")}${(at.parts || 0) > 1 ? ` in ${at.parts} runs one after another` : ""}`);
      const atMore = [at.loose ? tc(`${plural(at.loose, "item")}直接放在媒体库文件夹里的已排除（只有整库扫描才够得到它们）。`,
          `${plural(at.loose, "item")} straight in a library folder left out (only the whole library reaches them).`) : "",
        at.organized ? tc(`${plural(at.organized, "organized item")}保持原样，与 Stash 的做法一致。`,
          `${plural(at.organized, "organized item")} left alone, as Stash does.`) : ""].filter(Boolean).join(" ");
      add({ k: "autotag", need: !at.error && (at.scenes || 0) + (at.galleries || 0) > 0 && atNames(at) > 0 && (at.folders || 0) > 0, title: autotagTitle(at, now),
        sub: at.error ? tc(`没有规划：${at.error}。不会发送任何任务。`, `Not planned: ${at.error}. Nothing is sent.`)
          : tc(`只用这些名字，且只用在这些 ${atWhere}。仅新增。${at.first ? " 首次运行：最近 7 天。" : ""}${atMore ? ` ${atMore}` : ""}`,
            `Only those names, only in their ${atWhere}. Adds only.${at.first ? " First run: the last 7 days." : ""}${atMore ? ` ${atMore}` : ""}`),
        fine: (at.scenes || 0) + (at.galleries || 0) > 0 ? autotagTitle(at, now).replace(/^Auto tag: /, "").replace(/^自动打标签：/, "") : tc("上次自动打标签之后没有新增内容", "nothing added since the last Auto tag") });
    } else add({ k: "autotag", need: false, title: tc("自动打标签", "Auto tag"),
      sub: tc("Tasks 的服务器部分没有响应，所以跳过它，而不是对整库运行。", "Tasks' server part did not answer, so it is skipped rather than run over the whole library."),
      fine: tc("服务器部分没有响应，因此跳过", "the server part did not answer, so it is skipped") });
    for (const kit of L.kits || []) {
      if (!kit.present) continue;
      const at2 = kit.lastScan || lastOk(H, `kit:${kit.id}`), srv = kitServer(kit.id, kit.version), c = catOf(`kit:${kit.id}`);
      add({ k: `kit:${kit.id}`, need: !at2 || now - at2 > 7 * 86400000,
        title: at2 ? tc(`${kitName(kit.id)}：上次扫描 ${ago(at2)}`, `${kitName(kit.id)}: last scan ${ago(at2)}`) : tc(`${kitName(kit.id)}：还没扫描过`, `${kitName(kit.id)}: not scanned yet`),
        sub: srv ? tc("只读取，在服务器上规划；结果等你在它的页面上查看。", "Reads only, planned on the server; results wait on its page.")
          : tc(`只读取；结果等你在它的页面上查看。升级到 ${c.min} 后也能从 Stash 里运行。`, `Reads only; results wait on its page. Update it to ${c.min} to run it from Stash too.`),
        fine: at2 ? `${kitName(kit.id)} ${ago(at2)}` : "" });
      // 0.5.0: its second read-only step, when the installed version has it
      for (const ks of KIT_STEPS.filter((x) => x[1] === kit.id)) {
        const k = `kit:${ks[0]}`, cs = catOf(k);
        if (!stepServer(cs, kit.version)) continue;
        const at3 = Math.max((kit.lastRuns || {})[ks[8]] || 0, lastOk(H, k));
        add({ k, need: !at3 || now - at3 > 7 * 86400000,
          title: at3 ? tc(`${stepName(k)}：上次 ${ago(at3)}`, `${cs.name}: last ${ago(at3)}`) : tc(`${stepName(k)}：还没运行过`, `${cs.name}: not run yet`),
          sub: `${catSub(k) || cs.sub}.`,
          fine: at3 ? `${cs.name.replace(/^[^:]+: /, "")} ${ago(at3)}` : "" });
      }
    }
    if (L.sd && L.sd.on) {
      const at = L.sd.lastBackup || 0;
      add({ k: "sdbackup", need: !at || now - at > 24 * 3600000,
        title: at ? tc(`Suite Data 备份已是 ${fmtAgo(at, now)}`, `Suite Data backup is ${fmtAgo(at, now).replace(/ ago$/, " old").replace(/^yesterday$/, "a day old")}`)
          : tc("还没有 Suite Data 备份", "No Suite Data backup yet"),
        sub: tc("所有插件的数据存进一个文件；保留最新 10 份。", "All plugin data in one file; the newest 10 are kept."),
        fine: at ? tc(`Suite Data 备份 ${ago(at)}`, `Suite Data backup ${ago(at)}`) : "" });
    }
    const bk = lastOk(H, "backupdb");
    add({ k: "backupdb", need: !bk || now - bk > 7 * 86400000,
      title: bk ? tc(`Stash 数据库备份：上次 ${ago(bk)}`, `Stash's database backup: last ${ago(bk)}`) : tc("备份 Stash 数据库", "Back up Stash's database"),
      sub: bk ? tc("在 Stash 的备份文件夹里留一份副本。", "A copy in Stash's backup folder.") : tc("在 Stash 的备份文件夹里留一份副本。还没见过任何备份。", "A copy in Stash's backup folder. None seen yet."),
      fine: bk ? tc(`数据库备份 ${ago(bk)}`, `database backup ${ago(bk)}`) : "" });
    // safe but long: offered for tonight or a routine, never in the one-click set
    if ((L.scenes || 0) > 0) add({ k: "previews", need: true, longOnly: true, title: tc("为缺少预览的场景生成预览和雪碧图", "Previews and sprites for scenes missing them"),
      sub: tc("只处理缺少的。媒体库很大时要花几小时。", "Only where missing. Takes hours on a big library.") });
    const op = lastOk(H, "optimise");
    add({ k: "optimise", need: !op || now - op > 30 * 86400000, longOnly: true,
      title: op ? tc(`优化数据库：上次运行 ${ago(op)}`, `Optimise database: last run ${ago(op)}`) : tc("优化数据库", "Optimise database"),
      sub: tc("运行期间 Stash 会变慢；每月一次就足够。", "Stash is slow while it runs; once a month is plenty."),
      fine: op ? tc(`已优化 ${ago(op)}`, `optimised ${ago(op)}`) : "" });
    // needs a look: these write, merge or delete, so they never run by themselves
    const risks = identifyRisks(L.idDefaults);
    if (risks.length) rows.look.push({ k: "idplain", icon: "find", c: "bl", src: "Stash",
      title: tc("用你自己的设置识别", "Identify with your own settings"),
      sub: tc(`你的识别设置会${risks.join("、")}。Tasks 只运行上面那个安全版本；这个由你自己启动。`,
        `Your Identify settings ${risks.join(", ")}. Tasks only runs the safe one above; this one is yours to start.`),
      what: "Writes", pc: "ye", go: "/settings?tab=tasks", goLabel: tc("识别设置", "Identify settings") });
    if ((L.unorg || 0) > 0) rows.look.push({ k: "unorg", icon: "check", c: "cy", src: "Stash",
      title: tc(`${plural(L.unorg, "scene")}未标记为已整理`, `${plural(L.unorg, "scene")} not marked organized`),
      sub: tc("有空时看一眼。", "Have a look when you have time."), what: "Info", pc: "", go: "/scenes?c=" + encodeCriterion({ type: "organized", value: "false" }), goLabel: tc("查看它们", "See them") });
    // 0.2.1: Scenes Toolkit 0.11.0's "Fill performers from stash-box" (user:
    // "scan all scenes in the library to add missing performers again").
    // Its plan only reads but its save writes (and can make performers), so
    // it is listed here with a link, never in the safe set or a routine.
    // Once a plan found scenes, the toolkit's own "fill" item below says how
    // many; until then this standing row, which does not count as to do.
    const st = (L.kits || []).find((k) => k.id === "SceneToolkit" && k.present);
    if (st && verAtLeast(st.version, FILL_MIN) && !(st.items || []).some((it) => it && it.key === "fill" && it.count > 0))
      rows.look.push({ k: "look:SceneToolkit:fillperf", icon: "film", c: "or", src: "Scenes Toolkit",
        title: tc("为已关联的场景补上缺少的演员", "Add missing performers to linked scenes"),
        sub: tc("找出你已关联的场景在 stash-box 上缺少的演员。在 Scenes Toolkit 的 Fill 标签页里核对并保存，可撤销。",
          "Finds performers your linked scenes are missing on the stash-box. Review and save on Scenes Toolkit's Fill tab, with Undo."),
        what: "Writes", pc: "ye", go: "/scenetoolkit?tab=fill", goLabel: tc("打开", "Open"), opt: true });
    for (const kit of L.kits || []) {
      for (const it of kit.items || []) {
        if (!it || !(it.count > 0) || (it.tone !== "ready" && it.tone !== "look")) continue;
        rows.look.push({ k: `look:${kit.id}:${it.key}`, icon: (KITS.find((x) => x[0] === kit.id) || [])[2] || "list", c: "or", src: kitName(kit.id),
          title: `${fmtN(it.count)} ${it.label}`,
          sub: it.tone === "ready" ? tc("这是它上次扫描找到的。保存可以撤销。", "Found by its last scan. Saving has Undo.") : tc("这是它上次扫描找到的；每一项都需要你决定。", "Found by its last scan; each needs your choice."),
          what: it.tone === "ready" ? "Saves" : "Needs you", pc: "ye", go: it.url || (it.action && it.action.url) || kit.page || "/", goLabel: tc("查看", "Review") });
      }
    }
    const onRows = rows.safe.filter((r) => r.on);
    return { ...rows, total: rows.safe.filter((r) => !r.quiet).length + rows.long.length + rows.look.filter((r) => r.what !== "Info" && !r.opt).length,
      picked: safeOrder(onRows.map((r) => r.k)), pickedMs: onRows.reduce((a, r) => a + (r.est || 0), 0) };
  }
  // Stash's list URL criterion, as Insights writes it
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

  // ── Recommended routines, from what is installed and how the library grows
  // L: { kits: [ids present], sd, boxes (count), scenes, recent }
  function recommend(L) {
    const kits = (L.kits || []).filter((id) => KITS.some((k) => k[0] === id));
    const out = [
      // 0.4.0: Stash runs it by itself (the scheduler), no tab needed
      { name: "Nightly", where: "server", sched: { freq: "daily", time: "02:00", dow: 0 }, steps: ["scan", "genfast", "autotag"], idle: true, holdPlay: true, onFail: "stop", on: true },
      // 0.2.0: a server routine again; the toolkits plan their own scans there
      { name: "Weekly", where: "server", sched: { freq: "weekly", time: "03:00", dow: 0 },
        steps: kits.map((id) => `kit:${id}`).concat(L.boxes ? ["identify"] : [], L.sd ? ["sdbackup"] : [], ["backupdb"]), idle: true, holdPlay: true, onFail: "continue", on: true },
      { name: "Monthly", where: "server", sched: { freq: "monthly", time: "05:00", dow: 0 }, steps: ["previews", "cleangen", "optimise", "backupdb"], idle: true, holdPlay: true, onFail: "continue", on: true },
      { name: "After adding files", where: "browser", sched: { freq: "hand", time: "02:00", dow: 0 },
        steps: ["scan", "genfast", "autotag"].concat(kits.includes("SceneToolkit") ? ["kit:SceneToolkit"] : []), idle: true, holdPlay: true, onFail: "stop", on: true },
    ];
    return out.map(normRoutine);
  }
  // 0.6.2 (user: "add the routines you added for me as defaults for users ...
  // they can of course remove or edit it ... and should be off by default"):
  // a new install starts with the user's own three, off, built for what is
  // installed. Written once, only while there is no routines key at all
  // (seedRoutines), so a list someone emptied stays empty.
  function starterRoutines(L, now) {
    const kits = (L.kits || []).filter((id) => KITS.some((k) => k[0] === id));
    const base = { where: "server", idle: true, holdPlay: true, onFail: "continue", on: false, starter: true };
    return [
      { ...base, name: "Overnight", sched: { freq: "daily", time: "02:00", dow: 0 },
        steps: ["scan", "genfast", "autotag"].concat(kits.includes("SceneToolkit") ? ["kit:SceneToolkit"] : [], ["previews"], L.sd ? ["sdbackup"] : []) },
      { ...base, name: "Weekly catalogue check", sched: { freq: "weekly", time: "03:00", dow: 0 },
        steps: (L.boxes ? ["identify"] : []).concat(kits.filter((id) => id !== "SceneToolkit").map((id) => `kit:${id}`), ["backupdb"]) },
      { ...base, name: "Monthly tidy-up", sched: { freq: "monthly", time: "05:00", dow: 0 }, steps: ["cleangen", "optimise", "backupdb"] },
    ].map((r) => normRoutine({ ...r, id: newId("t", now), created: now }));
  }
  // "Use recommended": a routine of the same name takes the recommended
  // steps and timer and keeps its id and record; every other routine stays
  function applyRecommended(list, rec, now) {
    const out = (list || []).slice();
    for (const r of rec) {
      const i = out.findIndex((x) => String(x.name).toLowerCase() === r.name.toLowerCase());
      if (i >= 0) out[i] = normRoutine({ ...out[i], steps: r.steps, sched: r.sched, where: r.where, idle: r.idle, holdPlay: r.holdPlay, onFail: r.onFail, edited: now });
      else out.push(normRoutine({ ...r, id: newId("t", now), created: now }));
    }
    return out;
  }

  // ── The server script ─────────────────────────────────────────────────────
  // POSIX sh with curl only: waits for an empty queue before each step,
  // starts it, waits again, reads how it ended (findJob); stops when Stash
  // does not answer; reports to this plugin's `note` operation.
  const shSafe = (s, n) => String(s || "").replace(/[^A-Za-z0-9 ._()+,-]/g, "").trim().slice(0, n || 60);
  const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const slugOf = (s) => String(s || "routine").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "routine";
  function stepBody(k, o) {
    const c = catOf(k);
    if (!c || c.browser) return null;
    if (c.kit) return JSON.stringify({ query: c.q, variables: { p: c.plugin, t: c.task, a: c.args } });
    if (c.plugin) return JSON.stringify({ query: c.q, variables: { p: c.plugin, t: c.task } });
    if (c.special === "autotag") return JSON.stringify({ query: Q.op, variables: { a: { mode: "autotag_run" } } });
    if (c.special === "identify") return JSON.stringify({ query: c.q, variables: { i: safeIdentifyInput(o.endpoints, ["@@IDS@@"], o.idDefaults) } });
    return JSON.stringify(c.input ? { query: c.q, variables: { i: c.input() } } : { query: c.q });
  }
  function serverScript(r, o) {
    o = o || {};
    const name = shSafe(r.name) || "Routine", slug = slugOf(name), cron = cronLine(r.sched);
    const skipped = [], lines = [];
    let total = 0;
    for (const k of routineSteps(r.steps)) {
      const c = catOf(k), label = shSafe(c.name);
      if (c.kit && o.kitVers && !stepServer(c, o.kitVers[c.kit])) {
        skipped.push(c.name);
        lines.push(`# left out: ${label} (${o.kitVers[c.kit] ? `version ${shSafe(o.kitVers[c.kit], 12)} ${c.only ? "does not have this step" : "plans its scan on its page only"}; update it to ${c.min}` : "not installed in Stash"}, then copy this script again)`);
        continue;
      }
      if (c.special === "identify" && !(o.endpoints || []).length) { skipped.push(c.name); lines.push(`# left out: ${label} (no stash-box is set up in Stash)`); continue; }
      total += 1;
      if (c.special === "identify") {
        const parts = stepBody(k, o).split('"@@IDS@@"');
        lines.push(`# ${label}: the scenes with a phash and no stash-box link, read when this step starts`,
          `ID_HEAD=${shq(parts[0])}`, `ID_TAIL=${shq(parts[1])}`,
          `IDS=$(gql '{"query":"{ findScenes(filter: {per_page: -1}, scene_filter: {is_missing: \\"stash_id\\", NOT: {is_missing: \\"phash\\"}}) { scenes { id } } }"}' | grep -o '"id":"[0-9]*"' | cut -d '"' -f 4 | sed 's/.*/"&"/' | paste -sd, -)`,
          `if [ -n "$IDS" ]; then go "${label}" "$ID_HEAD$IDS$ID_TAIL"; else note step "${label}" skipped "nothing to identify"; fi`);
      } else if (c.special === "autotag") {
        // 0.3.0: a split Auto tag answers "more": the step again starts the next part
        // once this one ended well (the note confirmed it); at most 50 parts
        lines.push(`# ${label}: only the folders of what was added since the last Auto tag, and only the`,
          "# names found in their paths (Tasks Toolkit's server part reads them and starts it; the",
          "# step's note confirms it ended well; a big one comes in parts, one after another)",
          "AT_N=0; MORE=1",
          'while [ -n "$MORE" ] && [ "$AT_N" -lt 50 ]; do',
          "  AT_N=$((AT_N + 1))",
          `  go "${label}" ${shq(stepBody(k, o))}`,
          "done");
      } else if (c.kit) {
        lines.push(c.only ? `# ${label}: its Stash task, planned there with the options last kept on its page; it only reads`
          : `# ${label}: its Stash task plans the scan with the options last kept on its page; it only reads`,
          `go "${label}" ${shq(stepBody(k, o))}`);
      } else lines.push(`go "${label}" ${shq(stepBody(k, o))}`);
    }
    const stash = /^https?:\/\/[A-Za-z0-9.:[\]_-]+$/.test(String(o.stash || "")) ? o.stash : "http://localhost:9999";
    const head = [
      "#!/bin/sh",
      `# Tasks Toolkit routine "${name}", written by the Tasks page on ${o.date || ""}.`,
      "# Copy it again after you change the routine on the page.",
      cron ? `# Schedule: ${cron}  (${schedWords(r.sched)})` : "# No timer: run it by hand.",
      "",
      `STASH=${shq(stash)}   # Stash's address as seen from this server`,
      "# Stash: Settings > Security > API Key. Anyone holding the key can do",
      "# everything in Stash: keep it in this file on the server only. Leave it",
      "# empty if your Stash has no login.",
      'STASH_API_KEY=""',
      `ROUTINE="${name}"`,
      `ON_FAIL="${r.onFail === "continue" ? "continue" : "stop"}"   # stop | continue: what a failed step does`,
      `LOCK="/tmp/stash-tasks-${slug}.lock"`,
      "POLL=30                         # seconds between looks at Stash's queue",
      "",
    ];
    if (r.sched && r.sched.freq === "monthly") head.push(`# cron starts this on days 1-7; it runs on the ${DAYS[+r.sched.dow || 0]} among them`,
      `[ "$(date +%u)" = "${(+r.sched.dow || 0) === 0 ? 7 : +r.sched.dow}" ] || exit 0`, "");
    const body = [
      'mkdir "$LOCK" 2>/dev/null || { echo "$ROUTINE is already running"; exit 0; }',
      "trap 'rmdir \"$LOCK\" 2>/dev/null' EXIT INT TERM",
      "",
      "gql() {",
      '  if [ -n "$STASH_API_KEY" ]; then',
      "    printf '%s' \"$1\" | curl -sf -m 60 -H \"Content-Type: application/json\" -H \"ApiKey: $STASH_API_KEY\" --data-binary @- \"$STASH/graphql\"",
      "  else",
      "    printf '%s' \"$1\" | curl -sf -m 60 -H \"Content-Type: application/json\" --data-binary @- \"$STASH/graphql\"",
      "  fi",
      "}",
      "",
      "# a line for the Tasks page (\"last heard from the server\"); never stops the run",
      "note() {",
      '  gql "{\\"query\\":\\"mutation (\\$a: Map) { runPluginOperation(plugin_id: \\\\\\"TasksToolkitI18n\\\\\\", args: \\$a) }\\",\\"variables\\":{\\"a\\":{\\"mode\\":\\"note\\",\\"routine\\":\\"$ROUTINE\\",\\"event\\":\\"$1\\",\\"step\\":\\"$2\\",\\"result\\":\\"$3\\",\\"text\\":\\"$4\\",\\"job\\":\\"$5\\"}}}" >/dev/null 2>&1 || true',
      "}",
      "",
      "# wait until Stash's queue is empty: every $POLL s, up to 1440 looks (12 h); three",
      "# unanswered asks in a row stop the routine",
      'STOP=""',
      "wait_idle() {",
      "  i=0; miss=0",
      '  while [ "$i" -lt 1440 ]; do',
      "    r=$(gql '{\"query\":\"{ jobQueue { id } }\"}')",
      '    if [ -z "$r" ]; then',
      "      miss=$((miss + 1))",
      '      [ "$miss" -ge 3 ] && { STOP="Stash did not answer"; return 1; }',
      "    else",
      "      miss=0",
      "      case \"$r\" in *'\"jobQueue\":[]'*|*'\"jobQueue\":null'*) return 0 ;; esac",
      "    fi",
      '    sleep "$POLL"',
      "    i=$((i + 1))",
      "  done",
      '  STOP="Stash stayed busy for 12 h"',
      "  return 1",
      "}",
      "",
      "# one step: wait for an empty queue, start it, wait for it to end, ask how it ended",
      "OK=0; FAILED=0",
      "MORE=\"\"",
      "step() {",
      '  MORE=""',
      "  wait_idle || return 1",
      '  r=$(gql "$2")',
      '  if [ -z "$r" ]; then STOP="Stash did not answer"; return 1; fi',
      "  case \"$r\" in *'\"errors\"'*) note step \"$1\" failed \"Stash refused it\"; FAILED=$((FAILED + 1)); return 2 ;; esac",
      "  job=$(printf '%s' \"$r\" | grep -o '\":\"[0-9][0-9]*\"' | head -n 1 | tr -dc '0-9')",
      "  more=\"\"; case \"$r\" in *'\"more\":true'*) more=1 ;; esac",
      "  wait_idle || return 1",
      '  st=""',
      '  [ -n "$job" ] && st=$(gql "{\\"query\\":\\"{ findJob(input: {id: \\\\\\"$job\\\\\\"}) { status } }\\"}" | grep -o \'"status":"[A-Z]*"\' | cut -d \'"\' -f 4)',
      '  case "$st" in',
      '    FAILED|CANCELLED) note step "$1" failed "Stash reports $st" "$job"; FAILED=$((FAILED + 1)); return 2 ;;',
      "  esac",
      '  note step "$1" ok "" "$job"; OK=$((OK + 1)); MORE="$more"; return 0',
      "}",
      "",
      "finish() {",
      '  if [ -n "$STOP" ]; then note failed "" "" "$STOP; $OK of $TOTAL steps ok"; echo "$ROUTINE stopped: $STOP"; exit 1; fi',
      '  if [ "$FAILED" -gt 0 ]; then note failed "" "" "$OK of $TOTAL steps ok"; echo "$ROUTINE: $FAILED step(s) failed"; exit 1; fi',
      '  note done "" "" "$OK of $TOTAL steps ok"; exit 0',
      "}",
      "go() {",
      '  step "$1" "$2"; rc=$?',
      '  [ "$rc" -eq 1 ] && finish',
      '  [ "$rc" -eq 2 ] && [ "$ON_FAIL" = "stop" ] && finish',
      "  return 0",
      "}",
      "",
      `TOTAL=${total}`,
      'note start "" "" ""',
    ];
    const text = head.concat(body, lines, ["wait_idle", "finish", ""]).join("\n");
    return { text, skipped, total, file: `stash-tasks-${slug}.sh`, cron, slug };
  }

  // ── Stash's scheduler (0.4.0) ────────────────────────────────────────────
  // The user's server routines never ran: the script above needed a User
  // Scripts entry that was never set up. Tasks' server part now runs them
  // itself, as a daemon in the Stash container (TasksToolkitI18n.py "Scheduler").
  // Every page load asks it to run (`scheduler`: it answers at once when it
  // does), so after a container restart the first Stash page opened starts
  // it; Stash has no start-up hook. An hourly knock from cron is the
  // optional fallback (keepAliveScript); nothing else has to be set up.
  //
  // "tonight 02:00" for a time in the coming night, else fmtWhen's words
  function fmtNext(at, now) {
    const h = new Date(at).getHours();
    if (at > now && at - now < 24 * 3600000 && h < 6) return tc(`今晚 ${pad2(h)}:${pad2(new Date(at).getMinutes())}`, `tonight ${pad2(h)}:${pad2(new Date(at).getMinutes())}`);
    return fmtWhen(at, now);
  }
  // The scheduler's state in words: { ok, text, start (offer Start), warn }
  function schedLine(st, now, err) {
    if (!st) return { ok: false, text: err ? tc(`调度器没有响应（${err}）。`, `Stash's scheduler did not answer (${err}).`) : tc("正在询问调度器…", "Asking Stash's scheduler…"), start: !!err };
    if (st.supported === false) return { ok: false, text: tc(`调度器无法在这里运行：${st.error || "需要 Linux 上的 Stash（如 Docker）"}。安排在 Stash 里运行的例程会等待。`, `Stash's scheduler cannot run here: ${st.error || "it needs Stash on Linux (as in Docker)"}. Routines set to run in Stash wait.`), start: false };
    if (!st.running) return { ok: false, text: tc(`调度器没有运行${st.stopWhy ? `（${st.stopWhy}）` : ""}，安排在 Stash 里运行的例程会等待。`, `Stash's scheduler is not running${st.stopWhy ? ` (${st.stopWhy})` : ""}, so routines set to run in Stash wait.`), start: true };
    const parts = [tc(`调度器自 ${fmtWhen(st.started || now, now)} 起运行`, `Scheduler running since ${fmtWhen(st.started || now, now)}`)];
    if (st.busy && st.busy.name) parts.push(tc(`正在运行 ${st.busy.name}${st.busy.step ? `：${st.busy.step}` : ""}`, `running ${st.busy.name} now${st.busy.step ? `: ${st.busy.step}` : ""}`));
    else if (st.next && st.next.at) parts.push(tc(`下一项：${st.next.name} ${fmtNext(st.next.at, now)}`, `next: ${st.next.name} ${fmtNext(st.next.at, now)}`));
    else parts.push(tc("没有定时在 Stash 里运行的例程", "no routine set to run in Stash on a timer"));
    let warn = "";
    if (st.stale) warn = tc(`它是版本 ${st.version}；会在例程之间更新到 ${st.pluginVersion}。`, `It is version ${st.version}; it changes to ${st.pluginVersion} between routines.`);
    else if (st.lastError) warn = st.lastError;
    return { ok: true, text: parts.join(" · "), start: false, warn };
  }
  // The optional fallback: a cron line that knocks once an hour, so a Stash
  // restarted while nobody opens it still has its scheduler (the call
  // returns at once when it runs). POSIX sh with curl, as the routine script.
  function keepAliveScript(o) {
    o = o || {};
    const stash = /^https?:\/\/[A-Za-z0-9.:[\]_-]+$/.test(String(o.stash || "")) ? o.stash : "http://localhost:9999";
    const body = JSON.stringify({ query: Q.op, variables: { a: { mode: "scheduler" } } });
    const text = [
      "#!/bin/sh",
      `# Tasks Toolkit: keep Stash's scheduler running (optional), written by the Tasks page on ${o.date || ""}.`,
      "# Stash starts it whenever a Stash page is opened; this starts it after a restart",
      "# nobody opened Stash for. It answers at once when the scheduler already runs.",
      "# Schedule: 0 * * * *  (every hour)",
      "",
      `STASH=${shq(stash)}   # Stash's address as seen from this server`,
      "# Stash: Settings > Security > API Key. Anyone holding the key can do",
      "# everything in Stash: keep it in this file on the server only. Leave it",
      "# empty if your Stash has no login.",
      'STASH_API_KEY=""',
      `BODY=${shq(body)}`,
      'if [ -n "$STASH_API_KEY" ]; then',
      `  printf '%s' "$BODY" | curl -sf -m 60 -H "Content-Type: application/json" -H "ApiKey: $STASH_API_KEY" --data-binary @- "$STASH/graphql" >/dev/null || echo "Stash did not answer"`,
      "else",
      `  printf '%s' "$BODY" | curl -sf -m 60 -H "Content-Type: application/json" --data-binary @- "$STASH/graphql" >/dev/null || echo "Stash did not answer"`,
      "fi",
      "",
    ].join("\n");
    return { text, file: "stash-tasks-scheduler.sh", cron: "0 * * * *", slug: "scheduler" };
  }

  // 0.6.1: a running job's time left at its rate so far (ms; 0 = unknown):
  // its progress and when it started, both from Stash's jobQueue
  function jobLeft(j, now) {
    const p = j && j.progress > 0 ? j.progress : 0, st = j && j.startTime ? Date.parse(j.startTime) : NaN;
    return p > 0.02 && p < 1 && st > 0 && now > st ? ((now - st) * (1 - p)) / p : 0;
  }
  // A job's name as people read it: "Archive ready scenes", "Generating"
  const jobName = (d) => String(d || "A job").replace(/^Running plugin task:\s*/i, "").replace(/\s*(\.\.\.|…)$/, "");
  // "about 12 min left, done around 14:20"
  function leftWords(ms, now) {
    if (!(ms > 0)) return "";
    const at = new Date(now + ms);
    return tc(`约剩 ${fmtDur(ms)}，预计 ${ms > 20 * 3600000 ? fmtWhen(now + ms, now) : `${pad2(at.getHours())}:${pad2(at.getMinutes())}`} 完成`,
      `about ${fmtDur(ms)} left, done around ${ms > 20 * 3600000 ? fmtWhen(now + ms, now) : `${pad2(at.getHours())}:${pad2(at.getMinutes())}`}`);
  }
  // The top bar's Tasks button: { text (on the button), kind, title (hover) }, pure
  function navInfo(queue, wait, missed, now) {
    const run = live(queue).find((j) => j.status === "RUNNING");
    if (run) {
      const pct = run.progress > 0 ? `${Math.round(run.progress * 100)}%` : "";
      const left = leftWords(jobLeft(run, now), now);
      return { text: pct, kind: "run", title: [`${jobName(run.description)}${pct ? ` ${pct}` : ""}`, left, wait ? tc(`${wait} 项等待`, `${wait} waiting`) : ""].filter(Boolean).join(" · ") };
    }
    if (missed) return { text: "!", kind: "miss", title: tc("任务：有一个例程被错过", "Tasks: a routine was missed") };
    return { text: "", kind: "", title: wait ? tc(`任务：${wait} 项等待`, `Tasks: ${wait} waiting`) : tc("任务：没有正在运行的任务", "Tasks: nothing running") };
  }

  // ── Autopilot (0.6.0) ────────────────────────────────────────────────────
  // User: "when toggled on it will continue with its task tree ... when I
  // toggle it off it will pause the current task and let me operate stash
  // the way I want and clears Stash's own task scheduler for my operations".
  // The switch is the server part's (_server/autopilot.json: one for every
  // device), Stash's scheduler does the work, step by step through its tree
  // (AP_TREE in the .py); the page shows it and flips it.
  // How often a step of the tree comes due, in words
  function apEvery(ms, after) {
    const h = Math.round((ms || 0) / 3600000);
    const w = h < 24 ? tc(`每 ${h} 小时`, `every ${h} h`) : h === 24 ? tc("每天", "daily") : h === 168 ? tc("每周", "weekly") : h >= 720 ? tc("每月", "monthly") : tc(`每 ${Math.round(h / 24)} 天`, `every ${Math.round(h / 24)} days`);
    return after && after.length ? tc(`${w}，且在每次${after.map((k) => stepName(k).replace(/^Scan new files$/, "scan") || "").join("、")}之后`, `${w}, and after each ${after.map((k) => stepNameEn(k).replace(/^Scan new files$/, "scan")).join(", ")}`) : w;
  }
  // The next step of the tree that can run: { k, due } or null
  function apNext(ap) {
    const out = (ap && ap.skip) || [];
    const rows = ((ap && ap.view) || []).filter((r) => r && !r.why && !out.includes(r.k));
    return rows.length ? rows.slice().sort((a, b) => (a.due || 0) - (b.due || 0))[0] : null;
  }
  // The switch's state, pure: { k: none | off | on | run | nosched, title (the
  // top bar's tooltip), line (the card's sentence) }
  function apState(ap, queue, now) {
    if (!ap) return { k: "none", title: "Autopilot", line: tc("正在询问 Stash 的调度器…", "Asking Stash's scheduler…") };
    // the progress of Autopilot's own job only (another job may be the one running)
    const run = ap.cur && ap.cur.job ? live(queue).find((j) => String(j.id) === String(ap.cur.job)) : null;
    const pct = run && run.progress > 0 ? ` ${Math.round(run.progress * 100)}%` : "";
    const back = ap.backAt ? tc(`${fmtNext(ap.backAt, now)} 自动恢复开启`, `back on by itself ${fmtNext(ap.backAt, now)}`) : tc("保持关闭，直到你重新打开", "stays off until you switch it on");
    if (!ap.on && !ap.at) return { k: "none", title: tc("Autopilot 已关闭 · 打开它，Stash 就会自己维护自己", "Autopilot is off · turn it on and Stash looks after itself"),
      line: tc("打开后 Stash 会自己维护自己：新文件、封面、识别、自动打标签、工具包扫描、归档和备份，一次只做一项。想让 Stash 完全归你用时，随时关掉。",
        "Turn it on and Stash looks after itself: new files, covers, Identify, Auto tag, toolkit scans, archiving and backups, one at a time. Turn it off whenever you want Stash to yourself.") };
    if (!ap.on) return { k: "off", title: tc(`Autopilot 已关闭 · ${back} · 点击继续`, `Autopilot off · ${back} · click to carry on`),
      line: tc(`自 ${fmtWhen(ap.at, now)} 起关闭。Stash 归你了；${back}。`, `Off since ${fmtWhen(ap.at, now)}. Stash is yours; ${back}.`) };
    if (ap.sched && ap.sched.supported === false) return { k: "nosched", title: tc("Autopilot 需要 Stash 的调度器，而它只能在 Linux 上的 Stash（例如 Docker）里运行", "Autopilot needs Stash's scheduler, which runs only on a Linux Stash (as in Docker)"),
      line: tc("已打开，但它需要 Linux 上的 Stash（例如 Docker），所以这里什么也不会发生。", "On, but it needs Stash on Linux (as in Docker), so nothing happens here.") };
    if (ap.sched && ap.sched.running === false) return { k: "nosched", title: tc("Autopilot 已打开，但 Stash 的调度器没在运行 · 打开 Tasks 启动它", "Autopilot on, but Stash's scheduler is not running · open Tasks to start it"),
      line: tc("已打开，但 Stash 的调度器还没运行。", "On, but Stash's scheduler is not running yet.") };
    const left = leftWords(jobLeft(run, now), now);
    if (ap.cur) return { k: "run", title: tc(`Autopilot · ${stepName(ap.cur.k)}${pct}${left ? ` · ${left}` : ""} · 点击暂停并清空 Stash 的队列`,
        `Autopilot · ${stepName(ap.cur.k)}${pct}${left ? ` · ${left}` : ""} · click to pause and clear Stash's queue`),
      line: ap.cur.job ? tc(`正在处理 ${stepName(ap.cur.k)}${pct}${left ? `，${left}` : ""}。`, `Working on ${stepName(ap.cur.k)}${pct}${left ? `, ${left}` : ""}.`)
        : tc(`下一步：${stepName(ap.cur.k)}，等 Stash 队列空了就开始。`, `Next: ${stepName(ap.cur.k)}, once Stash's queue is empty.`) };
    const nx = apNext(ap), when = nx ? (nx.due <= now ? tc("现在", "now") : fmtWhen(nx.due, now)) : "";
    const wait = ap.wait ? tc(`（${ap.wait}）`, ` (${ap.wait})`) : "";
    return { k: "on", title: tc(`Autopilot · ${nx ? `下一项：${stepName(nx.k)} ${when}` : "没有要做的"}${wait} · 点击暂停`,
        `Autopilot · ${nx ? `next: ${stepName(nx.k)} ${when}` : "nothing to do"}${wait} · click to pause`),
      line: nx ? (nx.due <= now ? tc(`下一项：${stepName(nx.k)}，Stash 一空闲就开始${wait}。`, `Next: ${stepName(nx.k)}, as soon as Stash is free${wait}.`)
        : tc(`目前都做完了。下一项：${stepName(nx.k)} ${when}。`, `All done for now. Next: ${stepName(nx.k)} ${when}.`))
        : (ap.view && ap.view.length ? tc("这里没有它能运行的任务。", "Nothing it can run here.") : tc("30 秒内启动。", "Starting within 30 s.")) };
  }
  // What the switch going off did, in words
  function apOffWords(r) {
    const st = (r && r.stopped) || [], left = (r && r.left) || [];
    const parts = [st.length ? tc(`已停止 ${st.slice(0, 3).join("、")}${st.length > 3 ? ` 等 ${st.length} 项` : ""}`, `Stopped ${st.slice(0, 3).join(", ")}${st.length > 3 ? ` and ${st.length - 3} more` : ""}`) : tc("当时没有任务在运行", "Nothing was running")];
    if (left.length) parts.push(tc(`先做完：${left.slice(0, 2).map((x) => `${x.d}（${/^it writes your data/i.test(x.why) ? "保存中" : x.why}）`).join("、")}${left.length > 2 ? ` 等 ${left.length} 项` : ""}`,
      `finishing first: ${left.slice(0, 2).map((x) => `${x.d} (${x.why.replace(/^it writes your data, so it is left to finish$/, "saving")})`).join(", ")}${left.length > 2 ? ` and ${left.length - 2} more` : ""}`));
    return tc(`Autopilot 已关闭。${parts.join("；")}。${r && r.backAt ? ` 将在 ${fmtNext(r.backAt, Date.now())} 自动恢复开启。` : ""}`,
      `Autopilot off. ${parts.join("; ")}.${r && r.backAt ? ` Back on by itself ${fmtNext(r.backAt, Date.now())}.` : ""}`);
  }

  if (window.__TasksToolkitI18nTest) {
    window.__TasksToolkitI18nTestHooks = { PLUGIN_VERSION, DATA_KEYS, CAT, Q, KITS, KIT_STEPS, stepServer, ORDER, catOf, stepName, safeOrder, safeIdentifyInput, idEndpoints, identifyRisks, ID_FIELDS, ID_FILTER,
      GUARDS, heavyJob, classifyDesc, inNight, gate, firstReady, parseHM, nextRun, lastDue, dueState, schedWords, cronLine, readData, writeData, normRoutine,
      routineSteps, enqueue, enqueueRoutine, moveItem, pushHist, finishCur, histFilter, histCounts, timePerPlugin, lastOk, estimate, overview, recommend,
      applyRecommended, serverScript, stepBody, shSafe, kitServer, verAtLeast, autotagTitle, navPlan, shq, slugOf, fmtDur, fmtAgo, fmtWhen, HIST_MAX, GRACE_MS, LONG_MS, suiteData, lockFree,
      tickOn, nextTicks, serverHist, SCAN_STALE_MS, fmtNext, schedLine, keepAliveScript, AP_STEPS, apEvery, apNext, apState, apOffWords, jobLeft, leftWords, navInfo, jobName, starterRoutines };
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
    catch { throw new Error(tc(`Stash 返回 ${res.status}${res.status === 401 ? "：已退出登录？" : ""}`, `Stash returned ${res.status}${res.status === 401 ? ": logged out?" : ""}`)); }
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    return json?.data ?? null;
  }
  function navigate(url) {
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }
  async function readConfig() {
    const d = await gql(`query { configuration { plugins } }`);
    const plugins = d?.configuration?.plugins;
    if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
    return plugins[PLUGIN_ID] || {};
  }
  async function writeConfig(next) {
    await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`, { id: PLUGIN_ID, input: next });
  }
  // the server part (TasksToolkitI18n.py): the server script's notes
  async function serverOp(mode, args) {
    const d = await gql(`mutation ($a: Map) { runPluginOperation(plugin_id: "${PLUGIN_ID}", args: $a) }`, { a: { mode, ...(args || {}) } });
    const r = d && d.runPluginOperation;
    if (!r || typeof r !== "object") throw new Error("Tasks Toolkit's server part did not answer");
    return r;
  }
  // Suite Data's own operations, read only (its listing: the last backup)
  async function sdOp(mode, args) {
    const d = await gql(`mutation ($a: Map) { runPluginOperation(plugin_id: "SuiteData", args: $a) }`, { a: { mode, by: "Tasks Toolkit", ...(args || {}) } });
    const r = d && d.runPluginOperation;
    if (!r || typeof r !== "object") throw new Error(tc("Suite Data 没有响应", "Suite Data did not answer"));
    return r;
  }
  const JOB_FIELDS = "id status description progress startTime endTime addTime error subTasks";
  async function readQueue() {
    const d = await gql(`{ jobQueue { ${JOB_FIELDS} } }`);
    return (d && d.jobQueue) || [];
  }
  async function findJob(id) {
    try { const d = await gql(`query ($id: ID!) { findJob(input: { id: $id }) { ${JOB_FIELDS} } }`, { id: String(id) }); return d && d.findJob; }
    catch (_) { return null; }
  }
  const tms = (t) => { const x = t ? Date.parse(t) : NaN; return isNaN(x) ? 0 : x; };
  const conns = () => (window.StashSuite && window.StashSuite.toolkits) || {};

  // ═══ Data: Suite Data's client ═════════════════════════════════════════════
  let sdNote = "";
  const SD = suiteData({ id: PLUGIN_ID, keys: DATA_KEYS, gql, label: "Tasks Toolkit", readConfig, writeConfig,
                         notify: (t) => { sdNote = t; toast(t, "warn"); } });
  // The one writer: fn(data) changes the parsed data and returns it (null:
  // nothing to write); the whole map goes back with unknown keys untouched
  function save(fn) {
    return SD.update((mine) => {
      const d = readData(mine);
      const r = fn(d);
      return r ? writeData(mine, r) : null;
    }).then((m) => { if (m) { S.data = readData(m); S.dataAt = Date.now(); } return m; });
  }
  async function loadData() {
    const mine = await SD.read();
    S.data = readData(mine);
    S.dataAt = Date.now();
    S.dataErr = "";
    return S.data;
  }

  // ═══ State ═════════════════════════════════════════════════════════════════

  const ME = newId("tab", Date.now());
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch (_) { prefs = {}; }
  const setPref = (k, v) => { prefs[k] = v; try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {} };
  const S = {
    tab: ["overview", "routines", "viewer"].includes(prefs.tab) ? prefs.tab : "overview",
    data: null, dataAt: 0, dataErr: "", lib: null, libAt: 0, libErr: "", loading: false,
    queue: [], queueAt: 0, queueErr: "", why: {}, kits: {}, kitVer: {}, notes: null, notesErr: "", server: "", sched: null, schedErr: "",
    hf: "all", hmore: 25, fold: {}, sheet: null, armed: null, armTimer: 0, force: "", missed: [], msg: "",
    ap: null, apErr: "",
  };
  let pageEl = null, sheetEl = null;

  // ═══ Feedback: the suite's toast and click-again ═══════════════════════════

  let toastEl = null, toastTimer = 0;
  function toast(text, kind, act) {
    injectStyles();
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.id = "tt-toast"; toastEl.setAttribute("role", "status"); }
    const host = document.fullscreenElement || document.body;
    if (toastEl.parentNode !== host) host.appendChild(toastEl);
    const k = ["info", "done", "warn", "error"].includes(kind) ? kind : "info";
    toastEl.className = `tt-t-${k}`;
    toastEl.innerHTML = `<span>${esc(text)}</span>${act ? `<button class="tt-link" type="button">${esc(act.label)}</button>` : ""}`;
    if (act) toastEl.querySelector("button").addEventListener("click", () => { toastEl.hidden = true; act.fn(); });
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, k === "error" || k === "warn" || act ? 8000 : 3000);
  }
  function armed(id) {
    if (S.armed === id) { S.armed = null; clearTimeout(S.armTimer); return true; }
    S.armed = id;
    clearTimeout(S.armTimer);
    S.armTimer = setTimeout(() => { S.armed = null; render(); renderSheet(); }, ARM_MS);
    render(); renderSheet();
    return false;
  }

  // ═══ Reading the library (cheap counts) ════════════════════════════════════

  // 0.1.1: created_at takes a String, not a Timestamp (user saw "Variable $since of type Timestamp used in position expecting String!")
  const COUNTS_Q = `query ($since: String!) {
    all: findScenes(filter: { per_page: 0 }) { count }
    nophash: findScenes(filter: { per_page: 0 }, scene_filter: { is_missing: "phash" }) { count }
    nocover: findScenes(filter: { per_page: 0 }, scene_filter: { is_missing: "cover" }) { count }
    idable: findScenes(filter: { per_page: 0 }, scene_filter: { is_missing: "stash_id", NOT: { is_missing: "phash" } }) { count }
    unorg: findScenes(filter: { per_page: 0 }, scene_filter: { organized: false }) { count }
    recent: findScenes(filter: { per_page: 0 }, scene_filter: { created_at: { value: $since, modifier: GREATER_THAN } }) { count }
    configuration { general { stashBoxes { endpoint name } } plugins }
    plugins { id name enabled version }
  }`;
  const ID_DEFAULTS_Q = `{ configuration { defaults { identify { sources { source { stash_box_endpoint scraper_id } }
    options { setCoverImage setOrganized includeMalePerformers skipMultipleMatches fieldOptions { field strategy createMissing } } } } } }`;
  // A toolkit's last background job (its `run` key): from Suite Data's store
  // when it is installed, asking for that one key (SD.overlay would read
  // every key, logs of a megabyte and more), else from its config
  async function kitRun(id, cfg, sdOn) {
    let raw = (cfg && cfg[id] && cfg[id].run) || "";
    if (sdOn) {
      try { const r = await sdOp("get", { plugin: id, keys: JSON.stringify(["run"]) }); if (r.items && r.items.run) raw = r.items.run.value || ""; } catch (_) {}
    }
    try { const v = typeof raw === "string" ? JSON.parse(raw || "null") : raw; return isObj(v) ? v : null; } catch (_) { return null; }
  }
  async function loadLib(force) {
    if (S.loading || (!force && S.lib && Date.now() - S.libAt < 5 * 60000)) return;
    S.loading = true; S.libErr = ""; render();
    try {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const d = await gql(COUNTS_Q, { since });
      const cfg = (d.configuration && d.configuration.plugins) || {};
      const on = (id) => ((d.plugins || []).find((p) => p && p.id === id) || { enabled: false }).enabled !== false && (d.plugins || []).some((p) => p && p.id === id);
      const sdOn = on("SuiteData");
      let idDefaults = null;
      try { const x = await gql(ID_DEFAULTS_Q); idDefaults = x && x.configuration && x.configuration.defaults && x.configuration.defaults.identify; } catch (_) {}
      const C = conns();
      const kits = await Promise.all(KITS.map(async ([id]) => {
        const present = on(id) && !!C[id];
        const run = present ? await kitRun(id, cfg, sdOn) : null;
        // (0.5.0: a scan's end only; a toolkit's other runs, as Scenes Toolkit's update check, count for their own step)
        const lastScan = run && !["save", "fill", "fillplan", "update", "updplan"].includes(run.kind) && (run.finishedAt || 0) && !run.lost ? run.finishedAt : 0;
        const lastRuns = run && run.kind && run.finishedAt && !run.lost ? { [run.kind]: run.finishedAt } : {};
        const ver = ((d.plugins || []).find((p) => p && p.id === id) || {}).version || "";
        return { id, present, installed: on(id), version: ver, lastScan, lastRuns, page: C[id] && C[id].page, items: (S.kits[id] && S.kits[id].items) || [] };
      }));
      let lastBackup = 0;
      if (sdOn) { try { const l = await sdOp("list"); lastBackup = ((l.snapshots || [])[0] || {}).at || 0; } catch (_) {} }
      if (!S.data) await loadData();
      // 0.2.0: which toolkits plan their scan on the server, and what Auto tag would go through
      S.kitVer = {};
      for (const p of d.plugins || []) if (p && p.id) S.kitVer[p.id] = p.version || "";
      let autotag = null;
      // 0.3.0: once per library read (page open, then at most every 5 min);
      // the server keeps the plan 30 min unless something new came in, and
      // plans again on Refresh (force)
      try { autotag = await serverOp("autotag_paths", force ? { refresh: "1" } : {}); } catch (e) { log(`autotag_paths: ${e.message}`); }
      S.lib = { scenes: d.all.count, nophash: d.nophash.count, nocover: d.nocover.count, idable: d.idable.count, unorg: d.unorg.count, recent: d.recent.count,
        boxes: (d.configuration.general && d.configuration.general.stashBoxes) || [], idDefaults, kits, sd: { on: sdOn, lastBackup }, autotag };
      S.libAt = Date.now();
      loadKitPiles(kits);
      seedRoutines();
    } catch (e) { S.libErr = e.message; }
    S.loading = false;
    render();
  }
  // 0.6.2: the starter routines, once, only when no routines were ever stored
  async function seedRoutines() {
    if (S.seeded) return;
    S.seeded = true;
    try {
      const m = await SD.update((mine) => {
        if (mine.routines !== undefined && mine.routines !== null && mine.routines !== "") return null;
        const d = readData(mine);
        d.routines = starterRoutines(recInput(), Date.now());
        return writeData(mine, d);
      });
      if (m) { S.data = readData(m); S.dataAt = Date.now(); render(); }
    } catch (e) { log(`starter routines: ${e.message}`); }
  }
  // What each toolkit's last scan left to do (its connector's summary, the
  // hub's contract): read after the counts, each on its own, so a slow one
  // does not hold the page
  function loadKitPiles(kits) {
    const C = conns();
    for (const k of kits) {
      if (!k.present || !C[k.id] || typeof C[k.id].summary !== "function") continue;
      const prev = S.kits[k.id];
      if (prev && Date.now() - prev.at < 10 * 60000) continue;
      S.kits[k.id] = { at: Date.now(), items: (prev && prev.items) || [] };
      Promise.race([C[k.id].summary({}), new Promise((_, no) => setTimeout(() => no(new Error("no answer")), 30000))])
        .then((s) => {
          S.kits[k.id] = { at: Date.now(), items: (s && Array.isArray(s.items) ? s.items : []) };
          const lk = S.lib && S.lib.kits.find((x) => x.id === k.id);
          if (lk) { lk.items = S.kits[k.id].items; if (s && s.scannedAt && !lk.lastScan) lk.lastScan = s.scannedAt; }
          render();
        })
        .catch((e) => log(`${k.id}: ${e.message}`));
    }
  }
  async function loadNotes() {
    try { S.notes = await serverOp("notes"); S.notesErr = ""; S.server = S.notes.version || ""; }
    catch (e) { S.notes = null; S.notesErr = e.message; }
    await loadSched();
    render(); renderSheet();
  }
  // 0.4.0: Stash's scheduler. `scheduler` starts it unless it runs (then it
  // only answers its state); `scheduler_status` only reads.
  const tzNow = () => { let name = ""; try { name = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {} return { name, offset: -new Date().getTimezoneOffset() }; };
  async function loadSched(start) {
    try { S.sched = await serverOp(start ? "scheduler" : "scheduler_status", start ? { tz: tzNow() } : {}); S.schedErr = ""; }
    catch (e) { S.schedErr = e.message; }
    return S.sched;
  }
  // Once per page load, on any Stash page: after a container restart the
  // first page opened starts the scheduler again (Stash has no start-up hook
  // for plugins). Cheap: it answers at once when the scheduler runs. Its own
  // window flag, so the SPA's navigation never asks twice.
  function ensureScheduler() {
    if (window.__TasksToolkitI18nSchedAsked) return;
    window.__TasksToolkitI18nSchedAsked = true;
    loadSched(true).then((st) => { if (st && st.startedNow) log("scheduler started"); if (pageEl) render(); }, () => {});
  }

  // ═══ Autopilot's switch (0.6.0) ════════════════════════════════════════════
  // Read every 30 s by this browser's runner tab (or the page) while it is
  // visible, a Python call each time, and shared with the other tabs through
  // localStorage; a click reads it at once. The browser's own queue follows
  // the switch: held while it is off (marked apHold, so only that hold is
  // let go when it is back on).
  const AP_KEY = "TasksToolkitI18nAp";
  const AP_POLL_MS = 30000;
  let apAt = 0, apBusy = false;
  function apShared() {
    try { const v = JSON.parse(localStorage.getItem(AP_KEY) || "null"); return v && Date.now() - (v.seen || 0) < 120000 ? v : null; } catch (_) { return null; }
  }
  const apNow = () => { const sh = apShared(); return sh && (!S.ap || sh.seen > apAt) ? sh : S.ap; };
  function apKeep(r) {
    S.ap = r; S.apErr = ""; apAt = Date.now();
    try { localStorage.setItem(AP_KEY, JSON.stringify({ ...r, seen: apAt })); } catch (_) {}
  }
  async function loadAp(force) {
    if (apBusy || (!force && Date.now() - apAt < AP_POLL_MS)) return S.ap;
    apBusy = true;
    apAt = Date.now();
    try { apKeep(await serverOp("autopilot_status")); }
    catch (e) { S.apErr = e.message; }
    apBusy = false;
    return S.ap;
  }
  function apSyncHold(ap) {
    if (!ap || !S.data) return Promise.resolve();
    const R = S.data.runner;
    if (!(ap.held && !R.hold) && !(ap.on && R.apHold)) return Promise.resolve();
    return save((d) => {
      if (ap.held && !d.runner.hold) { d.runner.hold = true; d.runner.apHold = true; return d; }
      if (ap.on && d.runner.apHold) { d.runner.hold = false; delete d.runner.apHold; return d; }
      return null;
    }).catch((e) => log(e.message, "error"));
  }
  // The first switch-on: timed routines off (kept; their steps are in the tree)
  async function apTakeRoutines() {
    let names = [];
    await save((d) => {
      names = [];
      const now = Date.now();
      for (const r of d.routines) if (r.on && r.sched.freq !== "hand") { r.on = false; r.apOff = now; r.edited = now; names.push(r.name); }
      return names.length ? d : null;
    });
    apKeep(await serverOp("autopilot_set", { taken: String(Date.now()) }));
    return names;
  }
  async function apSwitch(on) {
    const was = apNow();
    S.ap = { ...(was || {}), on, held: !on, cur: on ? (was && was.cur) || null : null, at: Date.now() };
    apAt = Date.now();
    renderNav(); render();
    let r;
    try { r = await serverOp("autopilot", { on: on ? "1" : "0" }); }
    catch (e) { S.ap = was; renderNav(); render(); toast(tc(`Autopilot 未切换：${e.message}`, `Autopilot not switched: ${e.message}`), "error"); return; }
    apKeep(r);
    if (!S.data) { try { await loadData(); } catch (_) {} }
    await apSyncHold(r);
    let took = [];
    if (on && !r.taken) { try { took = await apTakeRoutines(); } catch (e) { toast(tc(`你的例程没有被关闭：${e.message}`, `Your routines were not turned off: ${e.message}`), "error"); } }
    if (on && r.sched && r.sched.running === false && r.sched.supported !== false) await loadSched(true);
    renderNav(); render();
    if (!on) toast(apOffWords(r), (r.left || []).length || r.error ? "warn" : "done");
    else {
      const stl = apState(apNow(), S.queue, Date.now()).line, tail = isZh() ? stl : stl.replace(/^On[^.]*\. /, "");
      toast(tc(`Autopilot 已开启：${tail}${took.length ? ` ${took.join("、")} 现已关闭（保留着）：Autopilot 会跑它们的步骤。` : ""}`,
        `Autopilot on: ${tail}${took.length ? ` ${took.join(", ")} ${took.length === 1 ? "is" : "are"} off now (kept): Autopilot runs their steps.` : ""}`), "done");
    }
  }
  async function apSet(args) {
    try { apKeep(await serverOp("autopilot_set", args)); render(); }
    catch (e) { toast(e.message, "error"); }
  }

  // ═══ The runner ════════════════════════════════════════════════════════════
  // One tab per browser holds the lock and does the work; any tab can change
  // the queue (through the store, so nothing is lost between them).
  function lockFree(rec, me, now) {
    return !rec || rec.id === me || !(now - (rec.at || 0) < LOCK_STALE_MS);
  }
  function holdLock() {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (_) {}
    if (!lockFree(rec, ME, Date.now())) return false;
    try { localStorage.setItem(LOCK_KEY, JSON.stringify({ id: ME, at: Date.now() })); } catch (_) { return true; }
    return true;
  }
  function dropLock() {
    try { const rec = JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); if (rec && rec.id === ME) localStorage.removeItem(LOCK_KEY); } catch (_) {}
  }
  // A scene playing in any tab of this browser holds routines
  function notePlaying() {
    const v = document.querySelector("video");
    if (v && !v.paused && !v.ended && v.readyState > 2) { try { localStorage.setItem(PLAY_KEY, String(Date.now())); } catch (_) {} return true; }
    return false;
  }
  function playing() {
    let at = 0;
    try { at = +localStorage.getItem(PLAY_KEY) || 0; } catch (_) {}
    return Date.now() - at < 10000;
  }

  // Start one step; { job } for a Stash job, { done, note } when it ended at once
  async function startStep(it) {
    const c = catOf(it.k);
    if (!c) throw new Error(tc("不是 Tasks 认识的步骤", "not a step Tasks knows"));
    if (c.kit && !(c.kit in S.kitVer)) {
      // a runner tab that never drew the page: which version is installed
      try { const d = await gql("{ plugins { id version } }"); for (const p of (d && d.plugins) || []) if (p && p.id) S.kitVer[p.id] = p.version || ""; } catch (_) {}
    }
    // 0.5.0: a toolkit's second step is planned on the server or not run at all
    if (c.only) {
      if (!stepServer(c, S.kitVer[c.kit])) throw new Error(tc(`${kitName(c.kit)} ${c.min} 或更新版本才有这一步（你的是：${S.kitVer[c.kit] || "未安装"}）`, `${kitName(c.kit)} ${c.min} or newer has this step (yours: ${S.kitVer[c.kit] || "not installed"})`));
      const r = await gql(c.q, { p: c.plugin, t: c.task, a: c.args });
      return { job: String((r && r.runPluginTask) || ""), kit: c.kit, note: "planned on the server" };
    }
    if (c.kit && kitServer(c.kit, S.kitVer[c.kit])) {
      // 0.2.0: the toolkit plans it on the server; its job id comes back
      const r = await gql(c.q, { p: c.plugin, t: c.task, a: c.args });
      return { job: String((r && r.runPluginTask) || ""), kit: c.kit, note: "planned on the server" };
    }
    if (c.kit) {
      const conn = conns()[c.kit];
      if (!conn || typeof conn.scan !== "function") throw new Error(tc(`${kitName(c.kit)} 未安装或已关闭`, `${kitName(c.kit)} is not installed or is off`));
      const before = new Set((await readQueue()).map((j) => String(j.id)));
      const msg = String((await conn.scan()) || "");
      const after = await readQueue();
      const fresh = after.filter((j) => !before.has(String(j.id)));
      const job = fresh.length ? String(fresh[fresh.length - 1].id) : "";
      if (!job && /^nothing/i.test(msg)) return { done: true, note: msg };
      return { job, note: msg, kit: c.kit };
    }
    if (c.special === "autotag") {
      let r = null, why = "";
      try { r = await serverOp("autotag_run"); } catch (e) { why = e.message; }
      if (r) {
        if (r.nothing || !r.job) return { done: true, note: String(r.label || "Nothing added since the last Auto tag") };
        return { job: String(r.job), note: String(r.label || ""), atJob: String(r.job), atMore: !!r.more };
      }
      // the server part refused the plan (a library folder in it, too much new): a failure in its words
      if (/^Auto tag:/.test(why)) throw new Error(why.replace(/^Auto tag:\s*/, ""));
      // 0.3.0: no answer is no longer the whole library (9 hours on the user's): skipped, said in History
      return { done: true, result: "skipped", note: `Auto tag skipped: the server part did not answer${why ? ` (${why})` : ""}` };
    }
    if (c.special === "identify") {
      const d = await gql(`query { configuration { general { stashBoxes { endpoint } } } }`);
      let defaults = null;
      try { const x = await gql(ID_DEFAULTS_Q); defaults = x.configuration.defaults.identify; } catch (_) {}
      const ends = idEndpoints(defaults, d.configuration.general.stashBoxes);
      if (!ends.length) throw new Error(tc("没有设置 stash-box（设置 > 元数据提供方）", "No stash-box is set up (Settings > Metadata Providers)"));
      const s = await gql(`query ($f: SceneFilterType) { findScenes(filter: { per_page: -1 }, scene_filter: $f) { scenes { id } } }`, { f: ID_FILTER });
      const ids = ((s && s.findScenes && s.findScenes.scenes) || []).map((x) => x.id);
      if (!ids.length) return { done: true, note: "Nothing to identify" };
      const r = await gql(c.q, { i: safeIdentifyInput(ends, ids, defaults) });
      return { job: String(r.metadataIdentify || ""), note: plural(ids.length, "scene") };
    }
    if (c.plugin) {
      const r = await gql(c.q, { p: c.plugin, t: c.task });
      return { job: String(r.runPluginTask || "") };
    }
    const r = await gql(c.q, c.input ? { i: c.input() } : undefined);
    const v = r && Object.values(r)[0];
    if (c.sync) return { done: true, note: "" };
    return { job: v == null ? "" : String(v) };
  }

  let ticking = false, lastRead = 0, lastQ = 0;
  const seen = new Map();     // Stash jobs this tab saw in the queue: id -> job (for History)
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      notePlaying();
      const visible = document.visibilityState !== "hidden";
      const mine = holdLock();
      const busy = !!(S.data && (S.data.runner.cur || S.data.runner.wait.length));
      const now = Date.now();
      // Stash's queue: every tick for the tab that runs things or shows the page; else every 10 s while visible
      if (mine || pageEl || (visible && now - lastQ > 10000)) {
        try { S.queue = await readQueue(); S.queueErr = ""; } catch (e) { S.queueErr = e.message; }
        S.queueAt = lastQ = Date.now();
      }
      if (mine) {
        const every = pageEl ? 10000 : busy ? 15000 : 5 * 60000;
        if (!S.data || now - lastRead > every) { lastRead = now; try { await loadData(); } catch (e) { S.dataErr = e.message; } }
        if (S.data && !S.dataErr) {
          await watchElsewhere();
          await watchCur();
          await timers();
          await sendNext();
        }
        shareView();
      }
      // 0.6.0: Autopilot's switch, every 30 s by the tab that runs things or shows the page
      if ((mine || pageEl) && visible) {
        await loadAp(false);
        if (mine && S.data && !S.dataErr) await apSyncHold(S.ap);
      }
      if (pageEl) render(true);
      renderNav();
    } catch (e) { log(e.message, "error"); }
    ticking = false;
  }
  // Jobs others started (Stash's own Tasks page, a toolkit's page): into
  // History when they leave the queue, so "last scan" and the history count
  // everything that ran
  async function watchElsewhere() {
    const cur = S.data.runner.cur;
    const ids = new Set(S.queue.map((j) => String(j.id)));
    for (const j of S.queue) seen.set(String(j.id), j);
    for (const [id, j] of Array.from(seen)) {
      if (ids.has(id)) continue;
      seen.delete(id);
      if (cur && String(cur.job) === id) continue;
      const f = (await findJob(id)) || j;
      const result = f.status === "FAILED" ? "failed" : f.status === "CANCELLED" ? "stopped" : "ok";
      const start = tms(f.startTime) || tms(f.addTime), end = tms(f.endTime) || Date.now();
      await save((d) => {
        if (d.history.some((e) => e.job === id && Math.abs((e.start || 0) - start) < 120000)) return null;
        d.history = pushHist(d.history, { id: newId("h"), k: classifyDesc(f.description) || "other", label: String(f.description || "Stash job").slice(0, 80),
          src: { t: "elsewhere", name: "Stash" }, start, end, result, note: f.error ? String(f.error).slice(0, 200) : "", job: id });
        return d;
      }).catch(() => {});
    }
  }
  async function watchCur() {
    const c = S.data.runner.cur;
    if (!c) return;
    const now = Date.now();
    if (!c.job) {
      // a toolkit's scan without a job id: its connector says when it ends
      if (c.kit && conns()[c.kit] && c.startedAt) {
        let j = null;
        try { j = await conns()[c.kit].status(); } catch (_) {}
        if (j && j.finished) return end(c, j.lost ? "failed" : "ok", j.lost ? "the job went missing" : "");
        if (now - c.startedAt < 6 * 3600000) return;
        return end(c, "failed", "no word from the toolkit for 6 h");
      }
      // sent but never started: the tab that sent it went away
      if (now - (c.sentAt || 0) > 5 * 60000) return end(c, "failed", "it did not start (the tab that sent it closed)");
      return;
    }
    const q = S.queue.find((j) => String(j.id) === String(c.job));
    if (q) { S.curJob = q; return; }
    const f = await findJob(c.job);
    S.curJob = f;
    if (f && (f.status === "RUNNING" || f.status === "READY" || f.status === "STOPPING")) return;
    if (f && f.status === "FAILED") return end(c, "failed", f.error || "Stash reports it failed");
    if (f && f.status === "CANCELLED") return end(c, "stopped", c.stopAsked ? "Stopped by you" : "Stopped in Stash");
    if (c.atJob && c.atMore && await nextAutotagPart(c)) return;
    if (!f) return end(c, "ok", "Stash no longer lists the job");
    return end(c, "ok", "");
  }
  // 0.3.0: a split Auto tag: this part ended well, so the server part marks
  // it and starts the next one; the step goes on with that job. False when
  // there is no next part to wait for (then the step ends as usual).
  async function nextAutotagPart(c) {
    let r = null;
    try {
      const d = await serverOp("autotag_done", { job: c.atJob });
      if (!d.ok || !d.more) return false;
      r = await serverOp("autotag_run");
    } catch (e) { log(e.message); return false; }
    if (!r || r.nothing || !r.job) return false;
    await save((d) => {
      if (!d.runner.cur || d.runner.cur.id !== c.id) return null;
      d.runner.cur = { ...d.runner.cur, job: String(r.job), atJob: String(r.job), atMore: !!r.more, note: String(r.label || "") };
      return d;
    }).catch((e) => log(e.message, "error"));
    return true;
  }
  function end(c, result, note) {
    // 0.2.0: Auto tag on the new folders ended well: the server part moves its
    // mark (only for that job), so the next one starts from here
    if (result === "ok" && c.atJob) serverOp("autotag_done", { job: c.atJob }).catch((e) => log(e.message));
    return save((d) => (d.runner.cur && d.runner.cur.id === c.id ? finishCur(d, result, note, Date.now()) : null)).then(() => {
      if (result !== "ok") toast(`${endWords(c.k, result, note)}${tc("。", ".")}`, result === "failed" ? "error" : "warn");
    }).catch((e) => log(e.message, "error"));
  }
  // Browser routines whose time came: run them; a missed one asks
  async function timers() {
    const now = Date.now();
    S.missed = [];
    for (const r of S.data.routines) {
      const st = dueState(r, now);
      if (st === "missed") S.missed.push({ id: r.id, name: r.name, due: lastDue(r.sched, now) });
      if (st !== "due") continue;
      const due = lastDue(r.sched, now);
      await save((d) => {
        const x = d.routines.find((y) => y.id === r.id);
        if (!x || dueState(x, now) !== "due") return null;
        enqueueRoutine(d, x, now, due);
        return d;
      }).catch((e) => log(e.message, "error"));
    }
    if (S.missed.length && !S.toldMissed) {
      S.toldMissed = true;
      const m = S.missed[0];
      toast(tc(`${m.name} 应于 ${fmtWhen(m.due, now)} 运行，但当时没有打开 Stash 标签页。`, `${m.name} was due ${fmtWhen(m.due, now)} but no Stash tab was open.`), "warn", { label: tc("打开任务", "Open Tasks"), fn: () => navigate(PAGE_PATH) });
    }
  }
  async function sendNext() {
    const R = S.data.runner;
    const ctx = { queue: S.queue, guards: S.data.guards, playing: playing(), now: Date.now(), hour: new Date().getHours(), force: S.force };
    const pick = R.hold ? { item: null, why: {} } : firstReady(R.wait, ctx);
    // one step at a time: while one runs, the next waits for it whatever the guards say
    if (R.cur && R.wait.length) pick.why = { ...pick.why, [R.wait[0].id]: R.wait[0].held ? tc("被你暂停了", "Held by you") : tc("等正在跑的这一项结束", "Waits for the one running now") };
    S.why = pick.why;
    if (R.cur || !pick.item) return;
    let claimed = null;
    await save((d) => {
      if (d.runner.cur || d.runner.hold) return null;
      const i = d.runner.wait.findIndex((x) => x.id === pick.item.id);
      if (i < 0) return null;
      const it = d.runner.wait.splice(i, 1)[0];
      d.runner.cur = { ...it, sentAt: Date.now(), by: ME };
      claimed = d.runner.cur;
      return d;
    }).catch((e) => log(e.message, "error"));
    if (!claimed) return;
    if (S.force === claimed.id) S.force = "";
    let res;
    try { res = await startStep(claimed); }
    catch (e) { await end(claimed, "failed", e.message); return; }
    if (res.done) { await end(claimed, res.result || "ok", res.note || ""); return; }
    await save((d) => {
      if (!d.runner.cur || d.runner.cur.id !== claimed.id) return null;
      d.runner.cur = { ...d.runner.cur, job: res.job || "", kit: res.kit || "", note: res.note || "", atJob: res.atJob || "", atMore: !!res.atMore, startedAt: Date.now() };
      return d;
    }).catch((e) => log(e.message, "error"));
  }
  // What the running tab tells the others (the nav indicator)
  function shareView() {
    const R = S.data && S.data.runner;
    const v = { at: Date.now(), wait: R ? R.wait.length : 0, cur: R && R.cur ? stepName(R.cur.k) : "", missed: S.missed.length };
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch (_) {}
  }
  function readView() {
    try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); return v && Date.now() - v.at < 60000 ? v : null; } catch (_) { return null; }
  }

  // ── What the buttons do ──────────────────────────────────────────────────
  async function queueSteps(ks, src, more) {
    if (!ks.length) return;
    try {
      await save((d) => { enqueue(d, ks, src, Date.now(), more); return d; });
      toast(ks.length === 1 ? tc(`${stepName(ks[0])}：已加入这里的队列，限制允许时就会开始。`, `${stepName(ks[0])}: sent to the queue here; it starts when the guards allow.`) : tc(`${plural(ks.length, "task")}已加入队列；会逐个发送给 Stash。`, `${plural(ks.length, "task")} queued here; they go to Stash one at a time.`), "done");
      tick();
    } catch (e) { toast(tc(`未加入队列：${e.message}`, `Not queued: ${e.message}`), "error"); }
  }
  // the next night window's start (the guard's hours)
  function tonight(now) {
    const g = (S.data && S.data.guards) || GUARDS, d = new Date(now);
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), g.from, 0, 0, 0).getTime();
    return inNight(d.getHours(), g.from, g.to) ? now : c > now ? c : c + 86400000;
  }
  async function runRoutine(id, due) {
    try {
      await save((d) => { const r = d.routines.find((x) => x.id === id); if (!r) return null; enqueueRoutine(d, r, Date.now(), due || 0); return d; });
      toast(tc("已加入队列；它的步骤会逐个发送给 Stash。", "Queued here; its steps go to Stash one at a time."), "done");
      tick();
    } catch (e) { toast(tc(`未加入队列：${e.message}`, `Not queued: ${e.message}`), "error"); }
  }
  async function skipDue(id, due) {
    try { await save((d) => { const r = d.routines.find((x) => x.id === id); if (!r) return null; r.skipDue = due; return d; }); S.missed = S.missed.filter((m) => m.id !== id); render(); }
    catch (e) { toast(e.message, "error"); }
  }
  async function stopCur() {
    const c = S.data && S.data.runner.cur;
    if (!c) return;
    try {
      await save((d) => { if (!d.runner.cur || d.runner.cur.id !== c.id) return null; d.runner.cur.stopAsked = true; return d; });
      if (c.job) await gql(`mutation ($id: ID!) { stopJob(job_id: $id) }`, { id: String(c.job) });
      toast(tc("已请求 Stash 停止它。", "Asked Stash to stop it."), "info");
    } catch (e) { toast(tc(`无法停止：${e.message}`, `Could not stop it: ${e.message}`), "error"); }
  }
  async function stopStash(id) {
    try { await gql(`mutation ($id: ID!) { stopJob(job_id: $id) }`, { id: String(id) }); toast(tc("已请求 Stash 停止它。", "Asked Stash to stop it."), "info"); tick(); }
    catch (e) { toast(tc(`无法停止：${e.message}`, `Could not stop it: ${e.message}`), "error"); }
  }
  const editWait = (fn) => save((d) => { const w = fn(d.runner.wait.slice(), d); if (!w) return null; d.runner.wait = w; return d; }).then(() => render()).catch((e) => toast(e.message, "error"));

  // ═══ Icons ═════════════════════════════════════════════════════════════════

  const ICON = {
    tasks: '<path d="M2.5 4l1.2 1.2L6 3M8 4.5h5.5M2.5 8.5l1.2 1.2L6 7.5M8 9h5.5M8 12.5h5.5"/>',
    shield: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
    routine: '<path d="M13 3.5v3h-3M12.6 6.5A5 5 0 1 0 13 9.5"/>',
    clock: '<path d="M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3.2l2.2 1.4"/>',
    eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4"/>',
    play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    check: '<path d="M3 8.5l3 3 7-7"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    stop: '<path d="M4.5 4.5h7v7h-7z"/>',
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    arrow: '<path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"/>',
    up: '<path d="M8 13V3M4.5 6.5L8 3l3.5 3.5"/>',
    down: '<path d="M8 3v10M4.5 9.5L8 13l3.5-3.5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    chev: '<path d="M4 6l4 4 4-4"/>',
    server: '<path d="M2.5 3h11v4h-11zM2.5 9h11v4h-11zM5 5h.01M5 11h.01"/>',
    browser: '<path d="M2 3.5h12v9H2zM2 6h12"/>',
    hand: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    cal: '<path d="M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
    gauge: '<path d="M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3"/>',
    hist: '<path d="M5 4.5L2.5 7 5 9.5M2.5 7h7a3.5 3.5 0 0 1 0 7H8"/>',
    bars: '<path d="M2.5 13.5h11M4.5 11V8M7.5 11V4.5M10.5 11V6.5"/>',
    warn: '<path d="M8 2.5l6 11H2zM8 7v3M8 12h.01"/>',
    info: '<path d="M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 7.5v3.5M8 5h.01"/>',
    copy: '<path d="M5.5 5.5h7v8h-7zM3.5 10.5v-8h7"/>',
    dl: '<path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10"/>',
    grip: '<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5"/>',
    scan: '<path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/>',
    gen: '<path d="M2.5 3h11v10h-11zM3 12l3.5-3.5 2.5 2.5 1.5-1.5L13 12"/>',
    tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6zM5.5 5.5h.01"/>',
    person: '<path d="M8 7.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5M3 13.5c.5-2.8 2.5-4 5-4s4.5 1.2 5 4"/>',
    film: '<path d="M2.5 3h11v10h-11zM5 3v10M11 3v10"/>',
    studio: '<path d="M3 13.5V4l5-2v11.5M8 6h5v7.5M2 13.5h12"/>',
    pics: '<path d="M3 2.5h8v9H3zM5 13.5h8v-9"/>',
    reel: '<path d="M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3"/>',
    db: '<path d="M3 4c0-1 2.2-1.5 5-1.5s5 .5 5 1.5v8c0 1-2.2 1.5-5 1.5S3 13 3 12zM3 4c0 1 2.2 1.5 5 1.5S13 5 13 4M3 8c0 1 2.2 1.5 5 1.5S13 9 13 8"/>',
    find: '<path d="M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M10.5 10.5l3 3"/>',
    clean: '<path d="M10 2.5L6.5 8M4 8.5h5l1 5H3z"/>',
    bolt: '<path d="M9 2L4 9h4l-1 5 5-7H8z"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
    marker: '<path d="M4 2.5h8v11l-4-3-4 3z"/>',
  };
  const ic = (n, st) => `<svg class="tt-ic" viewBox="0 0 16 16" aria-hidden="true"${st ? ` style="${st}"` : ""}>${ICON[n] || ICON.list}</svg>`;
  const tok = (c) => (c ? `var(--sx-${c})` : "var(--sx-tx1b)");
  const RESULT_ZH = { ok: "成功", failed: "失败", skipped: "跳过", running: "运行中", missed: "错过" };
  const resultZh = (r) => tc(RESULT_ZH[r] || r, r);
  // 需要你查看的行，其 what 值是逻辑标记（Writes/Info/Saves/Needs you），只在显示时翻译
  const WHAT_ZH = { Writes: "写入", Info: "信息", Saves: "保存", "Needs you": "需要你处理" };
  const whatZh = (w) => tc(WHAT_ZH[w] || w, w);
  // 服务器给的「不能运行」原因，显示时翻译；未收录的保持原文
  const whyZh = (w) => {
    const s = String(w || "");
    if (!s) return s;
    if (s === "not installed") return tc("未安装", s);
    if (/^needs /.test(s)) return tc(`需要${s.slice(6)}`, s);
    return s;
  };
  const SRC_LOOK = {
    safe: ["shield", "gr", "Run the safe ones"], you: ["person", "tx2", "You"], tonight: ["clock", "bl", "Tonight"],
    routine: ["routine", "bl", ""], elsewhere: ["server", "tx2", "Stash"], server: ["server", "gr", ""],
  };
  // SRC_LOOK 是冻结表：英文标签另配中文，显示时按来源类型取
  const SRC_NAME_ZH = { safe: "运行安全项", you: "你", tonight: "今晚", elsewhere: "Stash" };
  function srcTag(s) {
    const L = SRC_LOOK[(s && s.t) || "you"] || SRC_LOOK.you;
    const name = s && s.t === "routine"
      ? tc(`${s.name || "例程"}${s.of > 1 ? `，第 ${s.idx}/${s.of} 步` : ""}`, `${s.name || "Routine"}${s.of > 1 ? `, step ${s.idx} of ${s.of}` : ""}`)
      : s && s.t === "server" ? (s.name === "Autopilot" ? "Autopilot" : tc(`${s.name || "例程"}（在 Stash 里）`, `${s.name || "Routine"}, in Stash`))
        : L[2] ? tc(SRC_NAME_ZH[s.t] || L[2], L[2]) : "";
    return `<span class="tt-src" style="--c:${tok(L[1])}">${ic(L[0])}${esc(name)}</span>`;
  }

  // ═══ The page ══════════════════════════════════════════════════════════════

  const TABS = [["overview", "Overview", "shield", "gr", "1"], ["routines", "Routines", "routine", "bl", "2"], ["viewer", "Running", "tasks", "cy", "3"]];
  // 冻结表：TABS 仍是位置数组（id / 图标 / 主色 / 快捷键不动），只把标签按 key 取中文
  const TABS_ZH = { overview: "总览", routines: "例程", viewer: "运行中" };
  const tabLabel = (k, l) => tc(TABS_ZH[k] || l, l);
  let lastHtml = "";
  function render(soft) {
    if (!pageEl || !pageEl.isConnected) return;
    // a soft redraw (every tick) waits while the user is in a field or has
    // a menu open, and is skipped when nothing changed
    if (soft && (pageEl.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))) return;
    const now = Date.now();
    let body;
    if (S.dataErr && !S.data) body = `<div class="tt-card tt-empty"><b>${tc("Tasks Toolkit 读不到自己的数据", "Tasks Toolkit could not read its data")}</b><span>${esc(S.dataErr)}</span>
      <button class="tt-btn" data-a="reload">${ic("refresh")}${tc("重试", "Try again")}</button></div>`;
    else if (!S.data) body = `<div class="tt-load">${tc("正在读取你的任务…", "Reading your tasks…")}<div class="tt-lbar"><i></i></div></div>`;
    else body = S.tab === "routines" ? routinesHtml(now) : S.tab === "viewer" ? viewerHtml(now) : overviewHtml(now);
    const html = `<div class="tt" data-tab="${S.tab}">
      <div class="tt-head"><h1 class="tt-title">${ic("tasks")}${tc("任务", "Tasks")}</h1><span class="tt-read">${readLine(now)}</span>
        <div class="tt-tabs" role="tablist" aria-label="${tc("任务", "Tasks")}">${TABS.map(([k, l, i, c, key]) => `<button class="tt-tab${S.tab === k ? " on" : ""}" role="tab" aria-selected="${S.tab === k}" style="--tc:var(--sx-${c})" data-tab="${k}" title="${tabLabel(k, l)} (${key})">${ic(i)}${tabLabel(k, l)}</button>`).join("")}</div></div>
      ${missedHtml(now)}${S.msg ? `<div class="tt-banner">${ic("info")}<span class="tt-grow">${esc(S.msg)}</span></div>` : ""}
      ${body}</div>`;
    if (soft && html === lastHtml) return;
    lastHtml = html;
    pageEl.innerHTML = html;
  }
  function readLine(now) {
    const R = S.data && S.data.runner, q = live(S.queue);
    if (R && (R.cur || R.wait.length || q.length)) {
      const parts = [];
      if (q.some((j) => j.status === "RUNNING") || (R && R.cur)) parts.push(tc("1 项运行中", "1 running"));
      const inQ = q.filter((j) => j.status !== "RUNNING").length;
      if (inQ) parts.push(tc(`${fmtN(inQ)} 项排队`, `${fmtN(inQ)} queued`));
      if (R && R.wait.length) parts.push(tc(`${fmtN(R.wait.length)} 项在此等待`, `${fmtN(R.wait.length)} waiting here`));
      return `<span class="tt-spin"></span>${esc(parts.join(" · "))}`;
    }
    return `${ic("clock")}${tc("Stash 空闲", "Stash is idle")}`;
  }
  function missedHtml(now) {
    if (!S.missed.length || !S.data) return "";
    return S.missed.map((m) => `<div class="tt-banner">${ic("warn")}<span class="tt-grow"><b>${esc(m.name)}</b>${tc(` 应于 ${esc(fmtWhen(m.due, now))} 运行，但当时没有打开 Stash 标签页。`, ` was due ${esc(fmtWhen(m.due, now))}, but no Stash tab was open.`)}</span>
      <button class="tt-btn tt-sm tt-go" data-a="runmissed" data-id="${esc(m.id)}" data-due="${m.due}">${ic("play")}${tc("立即运行", "Run it now")}</button>
      <button class="tt-btn tt-sm" data-a="skipmissed" data-id="${esc(m.id)}" data-due="${m.due}">${tc("跳过这一项", "Skip this one")}</button></div>`).join("");
  }

  // ── Overview ─────────────────────────────────────────────────────────────
  function overviewHtml(now) {
    if (S.libErr && !S.lib) return `<div class="tt-card tt-empty"><b>${tc("读不到你的媒体库", "Could not read your library")}</b><span>${esc(S.libErr)}</span><button class="tt-btn" data-a="relib">${ic("refresh")}${tc("重试", "Try again")}</button></div>`;
    if (!S.lib) return `<div class="tt-load">${tc("正在读取你的媒体库…", "Reading your library…")}<div class="tt-lbar"><i></i></div></div>`;
    const O = overview({ ...S.lib, hist: histAll() }, now, prefs.ticks);
    const allSafe = O.safe.filter((r) => !r.quiet).length;
    const hero = `<div class="tt-card tt-hero">
      <div class="tt-grow"><h2>${O.total ? tc(`待处理 ${plural(O.total, "thing")} · ${fmtN(allSafe)} 项可立即运行`, `${plural(O.total, "thing")} to do · ${fmtN(allSafe)} can run now`) : tc("全部都是最新的。", "All up to date.")}</h2>
        ${O.total ? `<p>${[O.look.filter((r) => r.what !== "Info" && !r.opt).length ? tc(`${fmtN(O.look.filter((r) => r.what !== "Info" && !r.opt).length)} 项需要你查看`, `${fmtN(O.look.filter((r) => r.what !== "Info" && !r.opt).length)} need${O.look.filter((r) => r.what !== "Info" && !r.opt).length === 1 ? "s" : ""} your review`) : "", O.long.length ? tc(`${fmtN(O.long.length)} 项留到今晚更好`, `${fmtN(O.long.length)} best left for tonight`) : ""].filter(Boolean).join(tc("、", ", "))}</p>` : ""}</div>
      <button class="tt-btn tt-go tt-big" data-a="dosafe" ${O.picked.length ? "" : "disabled"}>${ic("play")}${tc("运行安全项", "Run the safe ones")} <small>${plural(O.picked.length, "task")}${O.pickedMs ? tc(` · 约 ${esc(fmtDur(O.pickedMs))}`, ` · about ${esc(fmtDur(O.pickedMs))}`) : ""}</small></button>
      ${O.picked.length ? `<div class="tt-flow" aria-label="${tc("安全任务的运行顺序", "Order the safe tasks run in")}"><span>${tc("按此顺序：", "In this order:")}</span>${O.picked.map((k, i) => `${i ? ic("arrow") : ""}<span class="tt-fs"><b>${i + 1}</b>${esc(stepName(k).replace(/^Generate covers and phashes$/, "Generate").replace(/ scan$/, " scan"))}</span>`).join("")}
        <span class="tt-grow"></span><span>${tc("有场景播放时暂停。", "Pauses while a scene plays.")}</span></div>` : ""}</div>`;
    const safe = `<section><div class="tt-sh" style="--c:var(--sx-gr)"><h3>${ic("shield")}${tc("可安全运行", "Safe to run")}</h3><span class="tt-muted">${tc("只新增或只读取", "only adds or reads")}</span>
        <span class="tt-shw">${O.safe.length ? tc(`已选 ${fmtN(O.safe.filter((r) => r.on).length)} / 共 ${fmtN(O.safe.length)}`, `${fmtN(O.safe.filter((r) => r.on).length)} of ${fmtN(O.safe.length)}`) : ""}</span>
        <button class="tt-btn tt-sm" data-a="relib" title="${tc("重新统计数量并重新规划自动打标签", "Read the counts again and plan Auto tag afresh")}">${ic("refresh")}${tc("刷新", "Refresh")}</button></div>
      <div class="tt-list">${O.safe.length ? O.safe.map((r) => safeRow(r)).join("") : `<div class="tt-none">${ic("check")}${tc("没有要运行的任务。", "Nothing to run.")}</div>`}</div></section>`;
    const long = O.long.length ? `<button class="tt-fold${S.fold.long ? " open" : ""}" style="--c:var(--sx-bl)" data-a="fold" data-k="long">${ic("clock")}<span><b>${tc("今晚最合适", "Best tonight")}</b> · ${fmtN(O.long.length)}</span>${ic("chev")}</button>
      <section class="tt-sec${S.fold.long ? " open" : ""}"><div class="tt-sh" style="--c:var(--sx-bl)"><h3>${ic("clock")}${tc("今晚最合适", "Best tonight")}</h3><span class="tt-muted">${tc("安全，但很慢", "safe, but slow")}</span></div>
      <div class="tt-list">${O.long.map((r) => longRow(r)).join("")}</div></section>` : "";
    const look = O.look.length ? `<button class="tt-fold${S.fold.look ? " open" : ""}" style="--c:var(--sx-ye)" data-a="fold" data-k="look">${ic("eye")}<span><b>${tc("需要你查看", "Your review")}</b> · ${fmtN(O.look.length)}</span>${ic("chev")}</button>
      <section class="tt-sec${S.fold.look ? " open" : ""}"><div class="tt-sh" style="--c:var(--sx-ye)"><h3>${ic("eye")}${tc("需要你查看", "Your review")}</h3><span class="tt-muted">${tc("这些会改动数据，所以从不自动运行", "these change things, so they never run by themselves")}</span></div>
      <div class="tt-list">${O.look.map((r) => lookRow(r)).join("")}</div></section>` : "";
    const fine = O.fine.filter((r) => r.fine).map((r) => r.fine);
    const done = fine.length ? `<div class="tt-done">${ic("check")}<b>${tc("已是最新：", "Up to date:")}</b> ${esc(fine.join(" · "))}</div>` : "";
    const piles = S.lib.kits.some((k) => k.present && !(S.kits[k.id] && S.kits[k.id].items)) ? `<div class="tt-muted">${tc("正在读取工具包的结果…", "Reading the toolkits' results…")}</div>` : "";
    return `<div class="tt-split"><div class="tt-main">${apCard(now)}${hero}${safe}${long}${look}${piles}${done}</div>${sideHtml(now, "overview")}</div>`;
  }
  // 0.6.0: Autopilot's card: the switch, what it does now, its tree
  function apCard(now) {
    const ap = apNow(), st = apState(ap, S.queue, now), on = !!(ap && ap.on);
    const view = (ap && ap.view) || [];
    const rows = view.filter((r) => r.why !== "not installed" && !/^needs /.test(r.why || ""));
    const absent = view.filter((r) => !rows.includes(r));
    const lastW = (r) => (r.last && r.last.at ? `${r.last.result === "ok" ? "" : `${resultZh(r.last.result)} · `}${fmtAgo(r.last.at, now)}` : tc("还没运行过", "not run yet"));
    const nextW = (r) => tc((((ap && ap.skip) || []).includes(r.k) ? "已排除" : r.why ? whyZh(r.why) : ap && ap.cur && ap.cur.k === r.k ? "正在运行" : !r.due || r.due <= now ? "现在就该运行" : fmtWhen(r.due, now)),
      (((ap && ap.skip) || []).includes(r.k) ? "left out" : r.why ? r.why : ap && ap.cur && ap.cur.k === r.k ? "running now" : !r.due || r.due <= now ? "due now" : fmtWhen(r.due, now)));
    const tree = rows.length ? `<div class="tt-aptree">${rows.map((r) => { const c = catOf(r.k) || {}, out = ((ap && ap.skip) || []).includes(r.k);
      return `<div class="tt-apr${out ? " off" : ""}${ap && ap.cur && ap.cur.k === r.k ? " cur" : ""}" style="--c:${tok(c.c)}">
        <button class="tt-box${out ? "" : " on"}" aria-pressed="${!out}" aria-label="${out ? tc("放回", "Put back") : tc("排除", "Leave out")} ${esc(stepName(r.k))}" title="${out ? tc("把它放回", "Put it back") : tc("把它排除", "Leave it out")}" data-a="apskip" data-k="${esc(r.k)}">${out ? "" : ic("check")}</button>
        ${ic(c.icon)}<b>${esc(stepName(r.k))}</b>${c.writes ? `<span class="tt-pill tt-ye">${tc("写入", "Writes")}</span>` : r.heavy ? `<span class="tt-pill tt-or">${tc("重", "Heavy")}</span>` : ""}
        <span class="tt-muted">${esc(apEvery(r.every, r.after))}</span><span class="tt-grow"></span>
        <span class="tt-apt"><span class="tt-apw" title="${esc((r.last && r.last.text) || "")}">${esc(lastW(r))}</span><span class="tt-apn">${esc(nextW(r))}</span></span></div>`; }).join("")}</div>
      ${absent.length ? `<p class="tt-note">${tc("未安装：", "Not installed: ")}${esc(absent.map((r) => `${stepName(r.k)}${/^needs /.test(r.why) ? `（${whyZh(r.why)}）` : ""}`).join(tc("、", ", ")))}.</p>` : ""}` : `<p class="tt-note">${tc("Stash 的调度器检查过后（30 秒内）就会显示列表。", "The list shows once Stash's scheduler has looked (within 30 s).")}</p>`;
    const sched = ap && ap.sched && ap.sched.running === false && ap.sched.supported !== false && on ? `<button class="tt-btn tt-sm tt-go" data-a="schedstart">${ic("play", "width:12px;height:12px")}${tc("启动调度器", "Start the scheduler")}</button>` : "";
    return `<div class="tt-card tt-ap" data-k="${st.k}">
      <div class="tt-aph"><button class="tt-tog tt-apbig${on ? " on" : ""}" role="switch" aria-checked="${on}" data-a="apsw">${ic("bolt")}<i></i>Autopilot ${on ? tc("已开启", "on") : tc("已关闭", "off")}</button>
        <span class="tt-grow tt-apline">${esc(st.line)}</span>${sched}
        <button class="tt-link" data-a="fold" data-k="ap" aria-expanded="${!!S.fold.ap}">${S.fold.ap ? tc("隐藏", "Hide") : tc("显示", "Show")}${tc("它的任务", " its tasks")}</button></div>
      ${S.fold.ap ? `<div class="tt-apbody">${tree}
        <div class="tt-apset">${tog2("apauto", !!(ap && ap.autoOn === true), tc("忘了的话，01:00 自动帮我打开", "Back on by itself at 01:00 if I forget"))}</div>
        <p class="tt-note">${tc("一次一项，从上往下，只要 Stash 空闲就做。关闭会停掉扫描和生成（之后会接着做，跳过已完成的部分）；正在保存你数据的任务会先做完。", "One task at a time, top first, whenever Stash is free. Off stops scans and generating (they pick up later, skipping what is done); anything saving your data finishes first.")}</p></div>` : ""}</div>`;
  }
  const tog2 = (a, on, label) => `<button class="tt-tog${on ? " on" : ""}" aria-pressed="${!!on}" data-a="${a}"><i></i>${esc(label)}</button>`;
  function pills(r) {
    return `<span class="tt-pill">${esc(r.src || "Stash")}</span>${r.heavy ? `<span class="tt-pill tt-or">${(catOf(r.k) || {}).locks ? tc("占用 Stash", "Locks Stash") : tc("重", "Heavy")}</span>` : ""}`;
  }
  function safeRow(r) {
    return `<div class="tt-row${r.on ? "" : " off"}" style="--c:${tok(r.c)}">
      <button class="tt-box${r.on ? " on" : ""}" aria-pressed="${r.on}" aria-label="${tc("纳入", "Include")} ${esc(r.title)}" data-a="tick" data-k="${esc(r.k)}">${r.on ? ic("check") : ""}</button>
      ${ic(r.icon)}<div class="tt-what"><b>${esc(r.title)}</b><span>${esc(r.sub)}</span><div class="tt-pm">${pills(r)}<span class="tt-grow"></span><span class="tt-est">${esc(fmtEst(r.est))}</span></div></div>
      <div class="tt-pills">${pills(r)}</div><span class="tt-est">${esc(fmtEst(r.est))}</span>
      <button class="tt-ib" data-a="runone" data-k="${esc(r.k)}" aria-label="${tc("只运行", "Run only")} ${esc(r.title)}" title="${tc("只运行这一项", "Run only this")}">${ic("play")}</button></div>`;
  }
  function longRow(r) {
    const monthly = r.k === "optimise" && S.data.routines.find((x) => /^monthly$/i.test(x.name));
    return `<div class="tt-row long" style="--c:${tok("bl")}">${ic(r.icon)}<div class="tt-what"><b>${esc(r.title)}</b><span>${esc(r.sub)}</span>
      <div class="tt-pm">${pills(r)}<span class="tt-grow"></span><span class="tt-est">${esc(fmtEst(r.est) || tc("数小时", "hours"))}</span></div></div>
      <div class="tt-pills">${pills(r)}</div><span class="tt-est">${esc(fmtEst(r.est) || tc("数小时", "hours"))}</span>
      ${monthly ? `<button class="tt-btn tt-sm" data-a="tomonthly" data-k="${esc(r.k)}" data-id="${esc(monthly.id)}">${tc(`加入 ${monthly.name}`, `Add to ${monthly.name}`)}</button>` : `<button class="tt-btn tt-sm" data-a="tonight" data-k="${esc(r.k)}">${tc("加入今晚", "Add to tonight")}</button>`}</div>`;
  }
  function lookRow(r) {
    return `<div class="tt-row look" style="--c:${tok(r.c)}">${ic(r.icon)}<div class="tt-what"><b>${esc(r.title)}</b><span>${esc(r.sub)}</span>
      <div class="tt-pm"><span class="tt-pill">${esc(r.src)}</span><span class="tt-pill${r.pc ? ` tt-${r.pc}` : ""}">${esc(whatZh(r.what))}</span></div></div>
      <div class="tt-pills"><span class="tt-pill">${esc(r.src)}</span><span class="tt-pill${r.pc ? ` tt-${r.pc}` : ""}">${esc(whatZh(r.what))}</span></div>
      <a class="tt-btn tt-sm" href="${esc(r.go)}" data-go="${esc(r.go)}">${esc(r.goLabel || tc("查看", "Review"))}${ic("arrow", "width:12px;height:12px")}</a></div>`;
  }
  function sideHtml(now, where) {
    const R = S.data.runner, q = live(S.queue), G = S.data.guards;
    const running = q.find((j) => j.status === "RUNNING");
    const lastH = S.data.history[0];
    const stashNow = `<div class="tt-card tt-sc"><h4 style="--c:var(--sx-cy)">${ic("server")}${tc("Stash 当前状态", "Stash now")}</h4><div class="tt-kv">
      <span>${tc("运行中", "Running")}</span><b>${running ? esc(jobName(running.description).slice(0, 40)) + (running.progress > 0 ? ` ${Math.round(running.progress * 100)}%` : "") : tc("无", "nothing")}</b>
      <span>${tc("Stash 排队", "Queued in Stash")}</span><b>${fmtN(q.filter((j) => j.status !== "RUNNING").length)}</b>
      <span>${tc("此处排队", "Queued here")}</span><b>${fmtN(R.wait.length)}${R.hold ? tc("（已暂停）", " (held)") : ""}</b>
      ${lastH ? `<span>${tc("上次任务", "Last job")}</span><b>${esc(jobName(lastH.label))} · ${esc(fmtAgo(lastH.end || lastH.start, now))} · ${esc(resultZh(lastH.result))}</b>` : ""}</div>
      ${where !== "viewer" ? `<button class="tt-link" data-tab="viewer">${tc("查看正在运行的任务", "See what is running")}</button>` : ""}</div>`;
    const next = S.data.routines.filter((r) => r.sched.freq !== "hand" && r.on)
      .map((r) => ({ r, at: nextRun(r.sched, now) })).filter((x) => x.at).sort((a, b) => a.at - b.at).slice(0, 3);
    const nextCard = `<div class="tt-card tt-sc"><h4 style="--c:var(--sx-bl)">${ic("routine")}${tc("接下来的例程", "Next routines")}</h4>${schedHtml(now, true)}
      ${next.length ? next.map(({ r, at }) => `<div class="tt-nr"><b>${esc(r.name)} · ${esc(fmtNext(at, now))}</b>${whereTag(r)}<span>${esc(r.where === "server" ? serverHeard(r.name, now) : tc("到点需要打开 Stash 标签页。", "Needs a Stash tab open then."))}</span></div>`).join("")
        : `<div class="tt-muted">${(apNow() || {}).on ? tc("没有启用的例程：Autopilot 会跑它们的步骤。", "None on: Autopilot runs their steps.") : tc("没有定时例程。", "None on a timer.")}</div><button class="tt-link" data-tab="routines">${tc("例程", "Routines")}</button>`}</div>`;
    const guards = `<div class="tt-card tt-sc"><h4 style="--c:var(--sx-or)">${ic("gauge")}${tc("对 Stash 温柔一点", "Go easy on Stash")}</h4><div class="tt-guards">
      ${tog("oneHeavy", G.oneHeavy, tc("一次只跑一个重任务", "One heavy task at a time"))}
      ${tog("holdPlay", G.holdPlay, tc("有场景播放时暂停", "Pause while a scene plays"))}
      <div class="tt-tog on tt-num-g"><i></i>${tc("Stash 排队任务上限", "Jobs queued in Stash, at most")}<span class="tt-grow"></span>
        <button class="tt-ib" data-a="maxq" data-d="-1" aria-label="${tc("减少", "Fewer")}">${ic("down")}</button><span class="tt-gnum">${fmtN(G.maxQueue)}</span><button class="tt-ib" data-a="maxq" data-d="1" aria-label="${tc("增加", "More")}">${ic("up")}</button></div>
      ${tog("night", G.night, tc(`仅在 ${pad2(G.from)}:00 到 ${pad2(G.to)}:00 之间跑重任务`, `Heavy work only between ${pad2(G.from)}:00 and ${pad2(G.to)}:00`))}</div>
      <p class="tt-note">${tc("重任务：扫描、生成、识别、优化。场景播放只在本浏览器内可见。", "Heavy: scan, generate, identify, optimise. A scene playing is seen in this browser only.")}</p></div>`;
    return `<aside class="tt-side" aria-label="${tc("Stash 当前状态、接下来的例程、限制", "Stash now, next routines, guards")}">${stashNow}${nextCard}${guards}</aside>`;
  }
  const tog = (k, on, label) => `<button class="tt-tog${on ? " on" : ""}" aria-pressed="${!!on}" data-a="guard" data-k="${k}"><i></i>${esc(label)}</button>`;
  // 0.4.0: "Stash" (runs by itself, the scheduler) or "This browser"; the
  // stored value stays "server" (rule 5: routines from 0.3 keep meaning
  // "runs on the Stash side")
  function whereTag(r) {
    const w = r.sched.freq === "hand" ? ["hand", "hand", tc("手动", "By hand")] : r.where === "server" ? ["sv", "server", "Stash"] : ["br", "browser", tc("本浏览器", "This browser")];
    return `<span class="tt-where ${w[0]}">${ic(w[1])}${w[2]}</span>`;
  }
  function serverHeard(name, now) {
    const run = S.notes && S.notes.runs && S.notes.runs[shSafe(name) || "Routine"];
    if (!run) return S.notesErr ? tc("服务端部分没有响应。", "The server part did not answer.") : tc("还没有在 Stash 里运行过。", "Not run in Stash yet.");
    if (run.result === "running") return tc(`正在 Stash 里运行，始于 ${fmtWhen(run.startedAt, now)}。`, `Running in Stash since ${fmtWhen(run.startedAt, now)}.`);
    if (run.result === "missed") return tc(`错过 ${fmtWhen(run.endedAt || run.startedAt, now)}${run.text ? `：${run.text}` : ""}。`, `Missed ${fmtWhen(run.endedAt || run.startedAt, now)}${run.text ? `: ${run.text}` : ""}.`);
    return tc(`上次在 Stash 里运行 ${fmtWhen(run.endedAt || run.startedAt, now)}，${run.result === "ok" ? "成功" : "失败"}${run.text ? `：${run.text}` : ""}。`, `Last run in Stash ${fmtWhen(run.endedAt || run.startedAt, now)}, ${run.result === "ok" ? "ok" : "failed"}${run.text ? `: ${run.text}` : ""}.`);
  }
  // The scheduler's line with Start (or Stop) and the optional keep-alive
  function schedHtml(now, compact) {
    const L = schedLine(S.sched, now, S.schedErr), armStop = S.armed === "schedstop";
    return `<div class="tt-sched${L.ok ? " ok" : " bad"}">${ic(L.ok ? "check" : "warn")}<span class="tt-grow">${esc(L.text)}${L.warn ? `<em>${esc(L.warn)}</em>` : ""}</span>
      ${L.start ? `<button class="tt-btn tt-sm tt-go" data-a="schedstart">${ic("play", "width:12px;height:12px")}${tc("启动", "Start")}</button>` : ""}
      ${!compact && L.ok ? `<button class="tt-btn tt-sm tt-dangerl${armStop ? " armed" : ""}" data-a="schedstop">${armStop ? tc("再点一次停止", "Click again to stop") : tc("停止", "Stop")}</button>` : ""}
      ${!compact ? `<button class="tt-link" data-a="keep">${tc("重启后保持运行（可选）", "Keep it running after restarts (optional)")}</button>` : ""}</div>`;
  }

  // ── Routines ─────────────────────────────────────────────────────────────
  function routinesHtml(now) {
    const list = S.data.routines;
    const rec = recommend(recInput());
    const intro = `<div class="tt-banner tt-info">${ic("info", "color:var(--sx-bl)")}<span class="tt-grow">${tc("例程可以", "Routines run")} <b style="color:var(--sx-gr-tx)">${tc("在 Stash 里", "in Stash")}</b> ${tc("自己运行，也可以打开 Stash 标签页时", "by themselves, or in")} <b style="color:var(--sx-bl-tx)">${tc("在本浏览器里", "this browser")}</b> ${tc("运行。", "while a Stash tab is open.")}</span>
      <button class="tt-btn tt-sm" data-a="newr">${ic("plus")}${tc("新建例程", "New routine")}</button></div>${schedHtml(now, false)}${apRoutinesNote()}`;
    const armRec = S.armed === "userec";
    const recCard = `<div class="tt-card tt-recc"><div class="tt-rech"><div class="tt-grow"><h3>${tc("为你的媒体库推荐的例程", "Recommended for your library")}</h3>
      <p>${esc(recWhy())} ${tc("重任务放在夜里。", "Heavy work at night.")}</p></div>
      <button class="tt-btn tt-pri${armRec ? " armed" : ""}" data-a="userec">${ic("check")}${armRec ? tc("再点一次即采用", "Click again to use them") : tc("采用推荐", "Use recommended")}</button></div>
      ${weekHtml(rec)}
      <div class="tt-recl">${rec.map((r) => `<div class="tt-recr"><b>${esc(r.name)}</b>${whereTag(r)}<span class="tt-muted">${esc(schedWords(r.sched))}</span><span class="tt-chain">${r.steps.map((k, i) => `${i ? ic("arrow") : ""}<span class="tt-chip" style="--c:${tok((catOf(k) || {}).c)}">${ic((catOf(k) || {}).icon)}${esc(stepName(k))}</span>`).join("")}</span></div>`).join("")}</div>
      <p class="tt-note">${tc("会替换同名例程；你自己的例程保留。", "Replaces routines with the same names; your own stay.")}</p></div>`;
    const cards = list.length ? `<div class="tt-rgrid">${list.map((r) => routineCard(r, now)).join("")}</div>`
      : `<div class="tt-card tt-empty"><b>${tc("还没有例程", "No routines yet")}</b><span>${tc("可以从上面的推荐开始，也可以自己创建。", "Start from the recommended ones above, or make your own.")}</span><button class="tt-btn" data-a="newr">${ic("plus")}${tc("新建例程", "New routine")}</button></div>`;
    // 0.2.3 (user: "I don't see the daily one"): with routines of their own the
    // suggestion folds away under them, so its Nightly is not taken for theirs
    if (list.length) return `<div class="tt-col">${intro}<h3 class="tt-yourh">${tc("你的例程", "Your routines")}</h3>${cards}
      <details class="tt-recfold"><summary>${tc("建议的例程", "Suggested routines")}</summary>${recCard}</details></div>`;
    return `<div class="tt-col">${intro}${recCard}${cards}</div>`;
  }
  // 0.6.0: while Autopilot runs their steps, the routines it turned off say so
  function apRoutinesNote() {
    const ap = apNow();
    const starters = S.data.routines.filter((r) => r.starter && !r.on && !r.edited);
    if ((!ap || !ap.at) && starters.length) return `<div class="tt-banner">${ic("info", "color:var(--sx-bl)")}<span class="tt-grow">${tc("初始例程，全部关闭。打开其中一个、编辑或删除它，或者直接让 Autopilot 全包。", "Starter routines, all off. Turn one on, edit or delete it, or let Autopilot run everything.")}</span></div>`;
    if (!ap || !ap.at) return "";
    const off = S.data.routines.filter((r) => r.apOff && !r.on).map((r) => r.name);
    return `<div class="tt-banner">${ic("bolt", "color:var(--sx-or)")}<span class="tt-grow">${tc(`Autopilot 会替你跑这些步骤${off.length ? `，所以 ${esc(off.join("、"))} 已关闭（保留着）` : ""}。打开其中一个，它也会在自己的时间运行。`,
      `Autopilot runs these steps for you${off.length ? `, so ${esc(off.join(", "))} ${off.length === 1 ? "is" : "are"} off (kept)` : ""}. Turn one on and it runs at its time too.`)}</span></div>`;
  }
  function recInput() {
    const L = S.lib || {};
    return { kits: (L.kits || []).filter((k) => k.present).map((k) => k.id), sd: !!(L.sd && L.sd.on), boxes: (L.boxes || []).length, scenes: L.scenes || 0, recent: L.recent || 0 };
  }
  function recWhy() {
    const I = recInput();
    return tc([I.recent ? `本周新增约 ${fmtN(I.recent)} 个场景` : "", I.kits.length ? `已装 ${plural(I.kits.length, "toolkit")}` : "没有装工具包",
      I.sd ? "Suite Data 已启用" : "", I.boxes ? `${plural(I.boxes, "stash-box")}` : "没有 stash-box"].filter(Boolean).join("、") + "。",
    [I.recent ? `About ${fmtN(I.recent)} scenes added this week` : "", I.kits.length ? `${plural(I.kits.length, "toolkit")} installed` : "no toolkits installed",
      I.sd ? "Suite Data on" : "", I.boxes ? plural(I.boxes, "stash-box", "stash-boxes") : "no stash-box"].filter(Boolean).join(", ") + ".");
  }
  function weekHtml(list) {
    const blocks = (r, day) => {
      const s = r.sched, t = parseHM(s.time);
      if (!t || s.freq === "hand") return "";
      if ((s.freq === "weekly" || s.freq === "monthly") && day !== (+s.dow || 0)) return "";
      const ms = r.steps.reduce((a, k) => a + estimate(k, S.lib, S.data.history), 0);
      const l = ((t.h * 60 + t.m) / 1440) * 100, w = Math.max(1.2, Math.min(100 - l, (ms / 86400000) * 100));
      const k = s.freq === "daily" ? "n" : s.freq === "weekly" ? "w" : "m";
      return `<i class="tt-blk ${k}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%" title="${esc(tc(`${r.name}：${schedWords(s)}，约 ${fmtDur(ms)}`, `${r.name}: ${schedWords(s)}, about ${fmtDur(ms)}`))}"></i>`;
    };
    const order = [1, 2, 3, 4, 5, 6, 0];
    // the rarer ones underneath, so a daily block on a first Sunday still shows
    const rank = { monthly: 0, weekly: 1, daily: 2 };
    const byRare = list.slice().sort((a, b) => (rank[a.sched.freq] || 0) - (rank[b.sched.freq] || 0));
    return `<div class="tt-week" aria-label="${tc("一周概览", "Week at a glance")}"><span></span><div class="tt-hours">${["00", "03", "06", "09", "12", "15", "18", "21", "24"].map((h) => `<span>${h}</span>`).join("")}</div>
      ${order.map((d) => `<span>${isZh() ? DAY_SHORT_ZH[d] : DAYS[d].slice(0, 3)}</span><div class="tt-day">${byRare.map((r) => blocks(r, d)).join("")}</div>`).join("")}</div>
      <div class="tt-legend"><span><i style="background:var(--sx-bl)"></i>${tc("每天", "Daily")}</span><span><i style="background:var(--sx-gr)"></i>${tc("每周", "Weekly")}</span><span><i style="background:var(--sx-or)"></i>${tc("每月（当月第一个该日）", "Monthly (the first of that day)")}</span></div>`;
  }
  function routineCard(r, now) {
    const last = r.last, cur = r.cur, next = r.sched.freq === "hand" ? 0 : nextRun(r.sched, now);
    const server = r.where === "server";
    const lastTxt = cur ? tc(`运行中：已完成 ${cur.ok + cur.failed}/${cur.of}`, `Running: ${cur.ok + cur.failed} of ${cur.of} done`)
      : last ? `${fmtWhen(last.at, now)} · ${tc(`${last.ok}/${last.of} 成功`, `${last.ok} of ${last.of} ok`)} · ${fmtDur(last.took)}${last.note ? ` · ${last.note}` : ""}`
        : server ? serverHeard(r.name, now) : tc("还没运行过", "Not run yet");
    const warn = last && last.failed;
    const kitSteps = server ? r.steps.filter((k) => (catOf(k) || {}).browser) : [];
    const missedHere = S.missed.find((m) => m.id === r.id);
    return `<article class="tt-card tt-rc${r.on || r.sched.freq === "hand" ? "" : " paused"}">
      <div class="tt-rct"><h3>${esc(r.name)}</h3>${whereTag(r)}<span class="tt-grow"></span>
        ${r.sched.freq !== "hand" ? `<button class="tt-tog${r.on ? " on" : ""}" aria-pressed="${r.on}" data-a="ron" data-id="${esc(r.id)}"><i></i>${r.on ? tc("开", "On") : tc("关", "Off")}</button>` : ""}
        <button class="tt-btn tt-sm" data-a="editr" data-id="${esc(r.id)}">${tc("编辑", "Edit")}</button>
        <button class="tt-btn tt-sm${r.sched.freq === "hand" ? " tt-go" : ""}" data-a="runr" data-id="${esc(r.id)}">${ic("play", "width:12px;height:12px")}${tc("立即运行", "Run now")}</button></div>
      <div class="tt-when">${ic("cal")}${esc(schedWords(r.sched))}${r.idle ? tc(" · 仅当 Stash 空闲", " · only when Stash is idle") : ""}${tc(" · 约 ", " · about ")}${esc(fmtDur(r.steps.reduce((a, k) => a + estimate(k, S.lib, S.data.history), 0)))}</div>
      <div class="tt-chain">${r.steps.map((k, i) => `${i ? ic("arrow") : ""}<span class="tt-chip" style="--c:${tok((catOf(k) || {}).c)}">${ic((catOf(k) || {}).icon)}${esc(stepName(k))}</span>`).join("") || `<span class="tt-muted">${tc("没有步骤", "No steps")}</span>`}</div>
      <div class="tt-last"><span class="${warn ? "warn" : last || cur ? "ok" : ""}">${ic(warn ? "warn" : cur ? "clock" : "check")}${esc(lastTxt)}</span><span class="tt-grow"></span>
        <span>${next ? tc(`下一次：${esc(fmtWhen(next, now))}`, `Next: ${esc(fmtWhen(next, now))}`) : r.sched.freq === "hand" ? tc("按“立即运行”时运行", "Runs when you press Run now") : ""}</span></div>
      ${kitSteps.length ? `<div class="tt-banner">${ic("browser")}<span class="tt-grow">${tc(`${esc(kitSteps.map(stepName).join("、"))} 只能从浏览器运行；服务器脚本会跳过它们。`, `${esc(kitSteps.map(stepNameEn).join(", "))} run${kitSteps.length === 1 ? "s" : ""} from a browser only; the server script leaves ${kitSteps.length === 1 ? "it" : "them"} out.`)}</span></div>` : ""}
      ${!server && r.on && r.sched.freq !== "hand" ? `<div class="tt-banner tt-quiet">${ic("browser")}<span class="tt-grow">${tc(`到 ${esc(r.sched.time)} 时需要打开一个 Stash 标签页${missedHere ? "；上次错过了" : ""}。`, `Needs a Stash tab open at ${esc(r.sched.time)}${missedHere ? "; missed last time" : ""}.`)}</span><button class="tt-btn tt-sm" data-a="toserver" data-id="${esc(r.id)}">${tc("改在 Stash 里运行", "Run it in Stash")}</button></div>` : ""}
    </article>`;
  }

  // ── Task viewer ──────────────────────────────────────────────────────────
  function viewerHtml(now) {
    const R = S.data.runner, q = live(S.queue);
    const cur = R.cur, curJ = cur && cur.job ? q.find((j) => String(j.id) === String(cur.job)) || S.curJob : null;
    const running = curJ && curJ.status === "RUNNING" ? curJ : q.find((j) => j.status === "RUNNING");
    let runCard;
    if (running || cur) {
      const j = running || {};
      const ours = cur && (!running || String(running.id) === String(cur.job));
      // 0.6.3: Autopilot's own job (the scheduler's step) is not "outside Tasks"
      const apc = !ours && (apNow() || {}).cur, apJob = apc && running && String(apc.job) === String(running.id) ? apc : null;
      const p = j.progress > 0 ? j.progress : 0, started = tms(j.startTime) || (ours && cur.startedAt) || 0;
      const left = p > 0.02 && started ? ((now - started) * (1 - p)) / p : 0;
      const title = ours ? stepName(cur.k) : apJob ? stepName(apJob.k) : jobName(j.description);
      const armStop = S.armed === "stopcur";
      runCard = `<div class="tt-card tt-busy tt-run" role="status"><div class="tt-runh"><span class="tt-spin"></span><b>${esc(title)}</b>
        ${ours && (catOf(cur.k) || {}).heavy ? `<span class="tt-pill tt-or">${tc("重", "Heavy")}</span>` : ""}<span class="tt-grow"></span>
        ${p ? `<span class="tt-est tt-big">${Math.round(p * 100)}%</span>` : ""}
        ${ours ? `<button class="tt-btn tt-sm tt-dangerl${armStop ? " armed" : ""}" data-a="stopcur">${ic("stop", "width:12px;height:12px")}${armStop ? tc("再点一次即停止", "Click again to stop") : tc("停止", "Stop")}</button>`
          : `<button class="tt-btn tt-sm tt-dangerl${S.armed === `stop:${j.id}` ? " armed" : ""}" data-a="stopjob" data-id="${esc(j.id)}">${ic("stop", "width:12px;height:12px")}${S.armed === `stop:${j.id}` ? tc("再点一次即停止", "Click again to stop") : tc("停止", "Stop")}</button>`}</div>
        <div class="tt-track"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
        <div class="tt-runm">${started ? tc(`<span>开始于 <b>${esc(fmtAgo(started, now))}</b></span>`, `<span>Started <b>${esc(fmtAgo(started, now))}</b></span>`) : ours ? `<span>${tc("正在启动…", "Starting…")}</span>` : ""}
          ${left ? tc(`<span>按当前速度还约需 <b>${esc(fmtDur(left))}</b></span>`, `<span>About <b>${esc(fmtDur(left))}</b> left at this rate</span>`) : ""}
          ${ours ? `<span>${tc("来自", "From")} ${srcTag(cur.src)}</span>` : apJob ? `<span>${tc("来自", "From")} ${srcTag({ t: "server", name: "Autopilot" })}</span>` : `<span>${tc("由 Tasks 之外的来源启动", "Started outside Tasks")}</span>`}
          ${(running || {}).id ? `<span>${tc("Stash 任务", "Stash job")} <b>#${esc(running.id)}</b></span>` : ""}
          ${ours && cur.note ? `<span>${esc(cur.note)}</span>` : ""}
          ${(j.subTasks || []).length ? `<span>${esc(String(j.subTasks[0]).slice(0, 80))}</span>` : ""}</div></div>`;
    } else runCard = `<div class="tt-card tt-empty"><b>${tc("没有任务在运行", "Nothing is running")}</b><span>${R.wait.length ? tc("下一项在等 Stash 空闲。", "The next one waits for Stash to be free.") : tc("队列为空。", "Nothing queued.")}</span></div>`;
    const firstWhy = R.wait.length ? S.why[R.wait[0].id] : "";
    const banner = firstWhy === "Held: a scene is playing" || firstWhy === "已暂停：有场景正在播放" ? `<div class="tt-banner">${ic("pause")}<span class="tt-grow">${tc("有场景正在播放，所以下一步要等。", "A scene is playing, so the next step waits.")}</span>
      <button class="tt-btn tt-sm" data-a="force" data-id="${esc(R.wait[0].id)}">${tc("仍然发送下一项", "Send the next one anyway")}</button></div>` : "";
    const G = S.data.guards, others = q.filter((j) => !(running && j.id === running.id));
    const stashQ = `<section><div class="tt-sh" style="--c:var(--sx-cy)"><h3>${ic("server")}${tc("在 Stash 的队列里", "In Stash's queue")}</h3><span class="tt-muted">${tc("Stash 按顺序运行这些任务", "Stash runs these in order")}</span>
      <span class="tt-shw">${tc(`${fmtN(q.length)} / 最多 ${fmtN(G.maxQueue)}`, `${fmtN(q.length)} of at most ${fmtN(G.maxQueue)}`)}</span></div>
      <div class="tt-list">${others.length ? others.map((j, i) => { const a = S.armed === `stop:${j.id}`; return `<div class="tt-qrow" style="--c:var(--sx-cy)"><span class="tt-num">${i + 1}</span>${ic("server")}
        <div class="tt-what"><b>${esc(jobName(j.description))}</b><span>${esc(j.status === "READY" ? tc("等待中", "Waiting") : String(j.status || "").toLowerCase())}${tms(j.addTime) ? tc(` · 加入于 ${esc(fmtAgo(tms(j.addTime), now))}`, ` · added ${esc(fmtAgo(tms(j.addTime), now))}`) : ""}</span></div>
        ${R.cur && String(R.cur.job) === String(j.id) ? srcTag(R.cur.src) : `<span class="tt-src">${ic("server")}Stash</span>`}<span class="tt-est"></span>
        <div class="tt-qacts"><button class="tt-ib re${a ? " armed" : ""}" data-a="stopjob" data-id="${esc(j.id)}" aria-label="${tc("停止", "Stop")} ${esc(j.description || "")}" title="${a ? tc("再点一次即停止", "Click again to stop") : tc("停止", "Stop")}">${ic("x")}</button></div></div>`; }).join("")
        : `<div class="tt-none">${ic("check")}${tc("Stash 队列里没有别的任务。", "Nothing else in Stash's queue.")}</div>`}</div></section>`;
    const waitS = `<section><div class="tt-sh" style="--c:var(--sx-bl)"><h3>${ic("clock")}${tc("在此等待", "Waiting here")}</h3><span class="tt-muted">${tc("一次只发送一项", "sent one at a time")}</span>
      <span class="tt-grow"></span>${R.wait.length || R.hold ? `<button class="tt-btn tt-sm" data-a="holdall">${ic(R.hold ? "play" : "pause", "width:12px;height:12px")}${R.hold ? tc("继续", "Go on") : tc("全部暂停", "Hold all")}</button>` : ""}</div>
      <div class="tt-list">${R.wait.length ? R.wait.map((w, i) => { const c = catOf(w.k) || {}; const why = w.held ? tc("被你暂停了", "Held by you") : R.hold ? tc("已暂停：全部暂停", "Held: Hold all") : S.why[w.id] || (i ? tc("等上面那一项先跑", "Waits for the one above") : tc("下一项", "Next"));
        return `<div class="tt-qrow held" style="--c:${tok(c.c)}"><span class="tt-num">${i + 1}</span>${ic(c.icon)}
        <div class="tt-what"><b>${esc(stepName(w.k))}</b><span>${esc(why)}</span></div>${srcTag(w.src)}<span class="tt-est">${esc(fmtEst(estimate(w.k, S.lib, S.data.history)))}</span>
        <div class="tt-qacts"><button class="tt-ib" data-a="wup" data-id="${esc(w.id)}" aria-label="${tc("上移", "Move")} ${esc(stepName(w.k))}" ${i ? "" : "disabled"}>${ic("up")}</button>
          <button class="tt-ib" data-a="wdown" data-id="${esc(w.id)}" aria-label="${tc("下移", "Move")} ${esc(stepName(w.k))}" ${i < R.wait.length - 1 ? "" : "disabled"}>${ic("down")}</button>
          <button class="tt-ib${w.held ? " on" : ""}" data-a="whold" data-id="${esc(w.id)}" aria-label="${w.held ? tc("放行", "Release") : tc("暂停", "Hold")} ${esc(stepName(w.k))}" title="${w.held ? tc("放行", "Release") : tc("暂停", "Hold")}">${ic(w.held ? "play" : "pause")}</button>
          <button class="tt-ib re" data-a="wdel" data-id="${esc(w.id)}" aria-label="${tc("移出", "Take out")} ${esc(stepName(w.k))}" title="${tc("移出", "Take out")}">${ic("x")}</button></div></div>`; }).join("")
        : `<div class="tt-none">${ic("check")}${tc("这里没有等待的任务。", "Nothing waiting here.")}</div>`}</div></section>`;
    return `<div class="tt-split"><div class="tt-main">${runCard}${banner}${stashQ}${waitS}${historyHtml(now)}</div>${viewerSide(now)}</div>`;
  }
  // Tasks' history with the scheduler's (and the old server script's) steps
  // merged in for viewing and for the Overview's "last scan"
  const histAll = () => (S.data.history || []).concat(serverHist(S.notes));
  function allHistory() {
    return histAll().sort((a, b) => (b.end || b.start || 0) - (a.end || a.start || 0)).slice(0, HIST_MAX);
  }
  function historyHtml(now) {
    const list = allHistory(), n = histCounts(list), rows = histFilter(list, S.hf), shown = rows.slice(0, S.hmore);
    const chip = (k, l, st) => `<button class="tt-chip${S.hf === k ? " on" : ""}" aria-pressed="${S.hf === k}" data-a="hf" data-k="${k}"${st ? ` style="${st}"` : ""}>${l} <b>${fmtN(n[k])}</b></button>`;
    const R = { ok: ["check", "ok"], failed: ["x", "fail"], stopped: ["stop", "stop"], skipped: ["stop", "stop"] };
    return `<section><div class="tt-sh" style="--c:var(--sx-pu)"><h3>${ic("hist")}${tc("历史", "History")}</h3><span class="tt-muted">${tc(`最近 ${fmtN(HIST_MAX)} 个任务`, `the last ${fmtN(HIST_MAX)} jobs`)}</span></div>
      <div class="tt-tbar">${chip("all", tc("全部", "All"))}${chip("stash", "Stash")}${chip("kits", tc("工具包", "Toolkits"))}${chip("sd", "Suite Data")}<span class="tt-sep"></span>
        ${chip("routine", tc("来自例程", "From routines"))}${chip("you", tc("由你启动", "Started by you"))}<span class="tt-sep"></span>${chip("failed", tc("失败", "Failed"), "color:var(--sx-re-tx)")}${chip("stopped", tc("已停止", "Stopped"), "color:var(--sx-ye-tx)")}</div>
      ${shown.length ? `<div class="tt-tablebox"><table class="tt-table"><thead><tr><th>${tc("结果", "Result")}</th><th>${tc("任务", "Job")}</th><th>${tc("来源", "From")}</th><th>${tc("开始", "Started")}</th><th>${tc("耗时", "Took")}</th><th>${tc("备注", "Note")}</th></tr></thead><tbody>
        ${shown.map((h) => { const r = R[h.result] || R.ok; return `<tr><td><span class="tt-res ${r[1]}">${ic(r[0])}${esc(resultZh(h.result))}</span></td><td class="n">${esc(jobName(h.label))}</td><td>${srcTag(h.src)}</td>
          <td class="t">${h.start ? esc(fmtWhen(h.start, now)) : ""}</td><td class="t">${h.end >= h.start && h.start ? esc(fmtDur(h.end - h.start)) : ""}</td><td class="tt-wrap">${esc(h.note || "")}</td></tr>`; }).join("")}</tbody></table></div>
        ${rows.length > shown.length ? `<button class="tt-link" data-a="hmore">${tc(`再显示 ${fmtN(Math.min(50, rows.length - shown.length))} 个`, `Show ${fmtN(Math.min(50, rows.length - shown.length))} more`)}</button>` : ""}`
        : `<div class="tt-none">${ic("hist")}${tc("还没有记录。任务结束后会出现在这里。", "Nothing yet. Jobs show up here when they end.")}</div>`}</section>`;
  }
  function viewerSide(now) {
    const list = allHistory(), tp = timePerPlugin(list, now), top = tp.length ? tp[0].ms : 1;
    const month = list.filter((e) => e.end > now - 30 * 86400000), c = histCounts(month);
    const col = (name) => (name === "Stash" ? "bl" : name === "Suite Data" ? "gr" : "or");
    const act = `<div class="tt-card tt-sc"><h4 style="--c:var(--sx-pu)">${ic("bars")}${tc("最近 30 天", "Last 30 days")}</h4>
      ${tp.length ? `<div class="tt-act">${tp.map((a) => `<div class="tt-ar"><span>${esc(a.name)}</span><div class="tt-at"><i style="width:${Math.max(1, (a.ms / top) * 100).toFixed(1)}%;background:var(--sx-${col(a.name)})"></i></div><em>${esc(fmtDur(a.ms))}</em></div>`).join("")}</div>
        <p class="tt-note">${tc(`共 ${plural(month.length, "job")}：${fmtN(month.length - c.failed - c.stopped)} 个成功，${fmtN(c.failed)} 个失败，${fmtN(c.stopped)} 个停止或跳过。`,
          `${plural(month.length, "job")}: ${fmtN(month.length - c.failed - c.stopped)} ok, ${fmtN(c.failed)} failed, ${fmtN(c.stopped)} stopped or skipped.`)}</p>` : `<div class="tt-muted">${tc("还没有记录。", "Nothing yet.")}</div>`}</div>`;
    const R = S.data.runner, q = live(S.queue), G = S.data.guards;
    const heavyQ = q.find((j) => heavyJob(j.description));
    const guards = `<div class="tt-card tt-sc"><h4 style="--c:var(--sx-or)">${ic("gauge")}${tc("当前限制", "Guards right now")}</h4><div class="tt-kv">
      <span>${tc("一次只跑一个重任务", "One heavy task at a time")}</span><b style="color:var(--sx-${G.oneHeavy && heavyQ && R.wait.length ? "cy-tx" : "tx1b"})">${tc(G.oneHeavy ? (heavyQ && R.wait.length ? "正在拦着" : "开") : "关", G.oneHeavy ? (heavyQ && R.wait.length ? "holding" : "on") : "off")}</b>
      <span>${tc("场景播放", "Scene playing")}</span><b style="color:var(--sx-${playing() && G.holdPlay ? "ye-tx" : "tx1b"})">${tc(playing() ? (G.holdPlay ? "例程已暂停" : "是") : "否", playing() ? (G.holdPlay ? "holding routines" : "yes") : "no")}</b>
      <span>${tc("Stash 队列", "Stash's queue")}</span><b>${tc(`${fmtN(q.length)} / ${fmtN(G.maxQueue)}`, `${fmtN(q.length)} of ${fmtN(G.maxQueue)}`)}</b>
      ${G.night ? `<span>${tc("重任务", "Heavy work")}</span><b>${tc(inNight(new Date(now).getHours(), G.from, G.to) ? "现在允许" : `从 ${pad2(G.from)}:00 起`, inNight(new Date(now).getHours(), G.from, G.to) ? "allowed now" : `from ${pad2(G.from)}:00`)}</b>` : ""}</div>
      <button class="tt-link" data-tab="overview">${tc("到总览页修改", "Change on Overview")}</button></div>`;
    // 0.6.3: routines that are off (Autopilot's, say) are not listed with a "Next"
    const sv = S.data.routines.filter((r) => r.where === "server" && r.on);
    const server = `<div class="tt-card tt-sc"><h4 style="--c:var(--sx-gr)">${ic("server")}${tc("在 Stash 里运行", "Run in Stash")}</h4>${schedHtml(now, true)}
      ${sv.map((r) => `<div class="tt-nr"><b>${esc(r.name)}</b><span>${esc(serverHeard(r.name, now))}</span>${nextRun(r.sched, now) ? `<span>${tc(`下一次：${esc(fmtWhen(nextRun(r.sched, now), now))}`, `Next: ${esc(fmtWhen(nextRun(r.sched, now), now))}`)}</span>` : ""}</div>`).join("")}</div>`;
    return `<aside class="tt-side" aria-label="${tc("活动与限制", "Activity and guards")}">${act}${guards}${server}</aside>`;
  }

  // ═══ Sheets: the routine editor and the server script ══════════════════════

  function openSheet(sh) {
    S.sheet = sh;
    if (!sheetEl) { sheetEl = document.createElement("div"); sheetEl.className = "tt tt-veil"; sheetEl.addEventListener("click", onSheetClick); sheetEl.addEventListener("input", onSheetInput); }
    if (!sheetEl.isConnected) document.body.appendChild(sheetEl);
    document.documentElement.setAttribute("data-owns-keys", "taskstoolkit");
    renderSheet();
    setTimeout(() => { const f = sheetEl.querySelector("[data-focus]"); if (f) f.focus(); }, 0);
  }
  function closeSheet() {
    S.sheet = null;
    if (sheetEl) sheetEl.remove();
    if (document.documentElement.getAttribute("data-owns-keys") === "taskstoolkit") document.documentElement.removeAttribute("data-owns-keys");
  }
  function renderSheet() {
    if (!sheetEl || !S.sheet) return;
    const keep = document.activeElement && sheetEl.contains(document.activeElement) ? document.activeElement.getAttribute("data-f") : null;
    sheetEl.innerHTML = S.sheet.kind === "script" ? scriptSheet() : S.sheet.kind === "keep" ? keepSheet() : editSheet();
    if (keep) { const el = sheetEl.querySelector(`[data-f="${keep}"]`); if (el) { el.focus(); if (el.setSelectionRange && el.value) try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {} } }
  }
  function editSheet() {
    const r = S.sheet.r, kits = (S.lib && S.lib.kits) || [];
    const est = r.steps.reduce((a, k) => a + estimate(k, S.lib, S.data.history), 0);
    const stash = ["scan", "genfast", "identify", "autotag", "previews", "cleangen", "optimise", "backupdb"];
    const kitKs = KITS.filter(([id]) => kits.some((k) => k.id === id && k.present)).map(([id]) => `kit:${id}`)
      .concat(KIT_STEPS.filter((x) => kits.some((k) => k.id === x[1] && k.present && stepServer(catOf(`kit:${x[0]}`), k.version))).map((x) => `kit:${x[0]}`));
    const sdOn = S.lib && S.lib.sd && S.lib.sd.on;
    const mi = (k) => { const c = catOf(k); const note = c.locks ? tc("占用 Stash", "Locks Stash") : c.long ? tc("重任务 · 数小时", "Heavy · hours") : c.heavy ? tc("重", "Heavy") : tc("轻", "Light");
      return `<button class="tt-mi" role="menuitem" style="--c:${tok(c.c)}" data-a="addstep" data-k="${esc(k)}">${ic(c.icon)}${esc(c.name)}<span>${esc(c.browser ? fmtEst(estimate(k, S.lib, S.data.history)) : note)}</span></button>`; };
    const armDel = S.armed === "delr";
    const s = r.sched;
    return `<div class="tt-sheet" role="dialog" aria-label="${tc(`编辑例程 ${esc(r.name)}`, `Edit routine ${esc(r.name)}`)}">
      <div class="tt-ch">${ic("routine", "color:var(--sx-bl);width:18px;height:18px")}<b>${S.sheet.isNew ? tc("新建例程", "New routine") : tc("编辑例程", "Edit routine")}</b><div class="tt-grow"></div>
        <button class="tt-x" data-a="close" aria-label="${tc("关闭", "Close")}">${ic("x")}</button><kbd>Esc</kbd></div>
      <div class="tt-field"><label for="tt-rname">${tc("名称", "Name")}</label><input id="tt-rname" class="tt-input" data-f="name" data-focus value="${esc(r.name)}" maxlength="40"></div>
      <div class="tt-field"><span class="tt-lbl">${tc("步骤（按顺序）", "Steps, in order")}</span>
        <div class="tt-steps">${r.steps.length ? r.steps.map((k, i) => { const c = catOf(k) || { name: k };
          const off = c.kit && !kits.some((x) => x.id === c.kit && x.present);
          return `<div class="tt-step" style="--c:${tok(c.c)}" tabindex="0" data-step="${i}"><span class="tt-num">${i + 1}</span>${ic(c.icon)}
            <div class="tt-what"><b>${esc(c.name)}</b><span>${esc(off ? tc("未安装或已关闭：按失败跳过", "Not installed or off here: skipped as failed") : c.only && !stepServer(c, S.kitVer[c.kit]) ? tc(`需要 ${kitName(c.kit)} ${c.min}：更新前跳过`, `Needs ${kitName(c.kit)} ${c.min}: skipped until it is updated`)
              : r.where === "server" && c.kit && !kitServer(c.kit, S.kitVer[c.kit]) ? tc(`此版本只在自己的页面上规划扫描：更新到 ${c.min} 才能用在服务器脚本里`, `This version plans its scan on its page only: update it to ${c.min} for the server script`) : c.sub || "")}</span></div>
            <span class="tt-pill${c.heavy || c.locks ? " tt-or" : ""}">${c.locks ? tc("占用 Stash", "Locks Stash") : c.heavy ? tc("重", "Heavy") : tc("轻", "Light")}</span><span class="tt-est">${esc(fmtEst(estimate(k, S.lib, S.data.history)))}</span>
            <span class="tt-qacts"><button class="tt-ib" data-a="sup" data-i="${i}" aria-label="${tc("上移", "Move up")}" ${i ? "" : "disabled"}>${ic("up")}</button><button class="tt-ib" data-a="sdown" data-i="${i}" aria-label="${tc("下移", "Move down")}" ${i < r.steps.length - 1 ? "" : "disabled"}>${ic("down")}</button>
            <button class="tt-ib re" data-a="sdel" data-i="${i}" aria-label="${tc(`移除 ${esc(c.name)}`, `Take out ${esc(c.name)}`)}">${ic("x")}</button></span></div>`; }).join("") : `<div class="tt-none">${tc("还没有步骤：在下方添加一个。", "No steps yet: add one below.")}</div>`}</div></div>
      <div class="tt-field"><div class="tt-addrow"><button class="tt-btn tt-sm" data-a="addmenu" aria-expanded="${!!S.sheet.menu}">${ic("plus", "width:12px;height:12px")}${tc("添加步骤", "Add a step")}</button><span class="tt-muted">${tc("仅限安全的步骤。", "Only safe steps.")}</span></div>
        ${S.sheet.menu ? `<div class="tt-menu" role="menu"><div class="tt-two"><div><div class="tt-mh">Stash</div>${stash.map(mi).join("")}</div>
          <div>${kitKs.length ? `<div class="tt-mh">${tc("工具包：仅扫描，只读并列出", "Toolkits: scan only, reads and lists")}</div>${kitKs.map(mi).join("")}` : ""}${sdOn ? `<div class="tt-mh">Suite Data</div>${mi("sdbackup")}` : ""}</div></div>
          <p class="tt-mnote">${tc("保存、合并和删除仍留在它们自己的页面，你可以在那里先看到每一处改动。", "Saving, merging and deleting stay on their own pages, where you see each change first.")}</p></div>` : ""}</div>
      <div class="tt-two"><div class="tt-field"><span class="tt-lbl">${tc("何时", "When")}</span><div class="tt-rowf">
          <div class="tt-seg" role="group" aria-label="${tc("频率", "How often")}">${[["daily", tc("每天", "Daily")], ["weekly", tc("每周", "Weekly")], ["monthly", tc("每月", "Monthly")], ["hand", tc("手动", "By hand")]].map(([k, l]) => `<button class="${s.freq === k ? "on" : ""}" aria-pressed="${s.freq === k}" data-a="freq" data-k="${k}">${l}</button>`).join("")}</div>
          ${s.freq !== "hand" ? `<span class="tt-rowf tt-at"><label class="tt-lbl" for="tt-rtime">${tc("于", "at")}</label><input id="tt-rtime" class="tt-input sm" data-f="time" value="${esc(s.time)}" maxlength="5" inputmode="numeric"></span>` : ""}
          ${s.freq === "weekly" || s.freq === "monthly" ? `<select class="tt-input" data-f="dow" aria-label="${tc("日期", "Day")}">${DAYS.map((d, i) => `<option value="${i}"${+s.dow === i ? " selected" : ""}>${s.freq === "monthly" ? tc(`第一个${dayName(i)}`, `first ${d}`) : dayName(i)}</option>`).join("")}</select>` : ""}</div>
          ${s.freq !== "hand" && !parseHM(s.time) ? `<span class="tt-bad">${tc("时间格式如 02:00", "A time like 02:00")}</span>` : ""}</div>
        <div class="tt-field"><span class="tt-lbl">${tc("步骤失败时", "If a step fails")}</span><div class="tt-seg" role="group" aria-label="${tc("步骤失败时", "If a step fails")}" style="align-self:flex-start">
          <button class="${r.onFail === "stop" ? "on" : ""}" data-a="onfail" data-k="stop">${tc("停止整个例程", "Stop the routine")}</button><button class="${r.onFail === "continue" ? "on" : ""}" data-a="onfail" data-k="continue">${tc("继续下一步", "Go on with the next")}</button></div></div></div>
      <div class="tt-rowf">${[["idle", tc("仅在 Stash 空闲时", "Only when Stash is idle")], ["holdPlay", r.where === "server" ? tc("有场景播放时暂停（仅限本浏览器：Stash 看不到）", "Hold while a scene plays (this browser only: Stash cannot see it)") : tc("有场景播放时暂停", "Hold while a scene plays")]].map(([k, l]) => `<button class="tt-tog${r[k] ? " on" : ""}" aria-pressed="${!!r[k]}" data-a="rflag" data-k="${k}"><i></i>${l}</button>`).join("")}</div>
      <div class="tt-field"><span class="tt-lbl">${tc("运行位置", "Where it runs")}</span><div class="tt-two">
        <button class="tt-opt${r.where === "server" ? " on" : ""}" aria-pressed="${r.where === "server"}" data-a="where" data-k="server"><b><span class="tt-radio"></span>${ic("server", "color:var(--sx-gr)")}${tc("Stash（自行运行）", "Stash (runs by itself)")}</b>${tc("到点自行运行，不需要浏览器。", "Runs at its time, no browser needed.")}</button>
        <button class="tt-opt${r.where === "browser" ? " on" : ""}" aria-pressed="${r.where === "browser"}" data-a="where" data-k="browser"><b><span class="tt-radio"></span>${ic("browser", "color:var(--sx-bl)")}${tc("本浏览器", "This browser")}</b>${tc("仅当这里开着 Stash 标签页时才运行。", "Runs only while a Stash tab is open here.")}</button></div></div>
      ${S.sheet.err ? `<div class="tt-bad">${esc(S.sheet.err)}</div>` : ""}
      <div class="tt-foot"><span class="tt-muted">${tc("约需", "About")} ${esc(fmtDur(est))}${S.data.history.some((e) => r.steps.includes(e.k)) ? "" : tc("（首次运行前只是估计）", " (a guess until it has run)")}${tc("。", ".")}</span><span class="tt-grow"></span>
        ${S.sheet.isNew ? "" : `<button class="tt-btn tt-dangerl tt-sm${armDel ? " armed" : ""}" data-a="delr">${armDel ? tc("再点一次删除", "Click again to delete") : tc("删除例程", "Delete routine")}</button>`}
        <button class="tt-btn" data-a="close">${tc("暂不", "Not now")}</button><button class="tt-btn tt-pri" data-a="saver">${ic("check")}${tc("保存例程", "Save routine")}<kbd>Enter</kbd></button></div></div>`;
  }
  function scriptSheet() {
    const r = S.data.routines.find((x) => x.id === S.sheet.id);
    if (!r) return "";
    const now = Date.now(), d = new Date(now);
    const sc = serverScript(r, { stash: S.sheet.stash, date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, endpoints: idEndpoints(S.lib && S.lib.idDefaults, S.lib && S.lib.boxes), idDefaults: S.lib && S.lib.idDefaults, kitVers: S.kitVer });
    S.sheet.text = sc.text; S.sheet.file = sc.file;
    const run = S.notes && S.notes.runs && S.notes.runs[shSafe(r.name) || "Routine"];
    const heard = run ? `<div class="tt-heard${run.result === "ok" || run.result === "running" ? "" : " bad"}">${ic(run.result === "ok" ? "check" : run.result === "running" ? "clock" : "warn")}<span class="tt-grow">${esc(serverHeard(r.name, now))}</span><button class="tt-link" data-a="seehist">${tc("在历史里查看", "See in History")}</button></div>`
      : `<div class="tt-heard quiet">${ic("info")}<span class="tt-grow">${esc(S.notesErr ? tc(`Tasks Toolkit 的服务端部分没有响应（${S.notesErr}）。脚本仍会运行，只是页面无法显示它的结果。`, `Tasks Toolkit's server part did not answer (${S.notesErr}). The script still runs; the page just cannot show how it went.`) : tc("还没有收到这个脚本的消息。第一次运行后，结果会显示在这里和「历史」里。", "Not heard from this script yet. After its first run, how it went shows here and in History."))}</span></div>`;
    const os = S.sheet.os || "unraid";
    const steps = os === "unraid" ? [
      tc("在 Unraid 的 Apps 标签页里安装 <code>User Scripts</code>（如果还没有）。", "In Unraid, install <code>User Scripts</code> from the Apps tab if it is not there yet."),
      tc(`Settings → User Scripts → Add new script，命名为 <code>${esc(`stash-tasks-${sc.slug}`)}</code>。`, `Settings, User Scripts, Add new script. Name it <code>${esc(`stash-tasks-${sc.slug}`)}</code>.`),
      tc("Edit script，粘贴下面的脚本，并把 API key 填在 <code>STASH_API_KEY=\"\"</code> 的引号之间。确认 <code>STASH</code> 是服务器上访问 Stash 的地址。", "Edit script, paste the script below, and put your API key between the quotes of <code>STASH_API_KEY=\"\"</code>. Check <code>STASH</code> is Stash's address from the server."),
      sc.cron ? tc(`Schedule 选 Custom，再填 <code>${esc(sc.cron)}</code>（${esc(schedWords(r.sched))}）。应用。`, `Schedule: Custom, then <code>${esc(sc.cron)}</code> (${esc(schedWords(r.sched))}). Apply.`) : tc("保持现有计划，需要时点 Run Script。", "Leave the schedule as it is and use Run Script when you want it."),
    ] : [
      tc(`把脚本保存为服务器上的 <code>${esc(sc.file)}</code> 并赋予执行权限：<code>chmod +x ${esc(sc.file)}</code>。`, `Save the script on the server as <code>${esc(sc.file)}</code> and make it runnable: <code>chmod +x ${esc(sc.file)}</code>.`),
      tc("把 API key 填在 <code>STASH_API_KEY=\"\"</code> 的引号之间，并确认 <code>STASH</code> 是服务器上访问 Stash 的地址。它需要 <code>curl</code>。", "Put your API key between the quotes of <code>STASH_API_KEY=\"\"</code>, and check <code>STASH</code> is Stash's address from the server. It needs <code>curl</code>."),
      sc.cron ? tc(`运行 <code>crontab -e</code> 并添加：<code>${esc(`${sc.cron} /path/to/${sc.file} >> /tmp/stash-tasks-${sc.slug}.log 2>&1`)}</code>`, `Run <code>crontab -e</code> and add: <code>${esc(`${sc.cron} /path/to/${sc.file} >> /tmp/stash-tasks-${sc.slug}.log 2>&1`)}</code>`) : tc("需要时手动运行。", "Run it by hand when you want it."),
    ];
    return `<div class="tt-sheet tt-wide" role="dialog" aria-label="${tc(`在服务器上运行 ${esc(r.name)}`, `Run ${esc(r.name)} on your server`)}">
      <div class="tt-ch">${ic("server", "color:var(--sx-gr);width:18px;height:18px")}<b>${tc(`在服务器上运行 ${esc(r.name)}`, `Run ${esc(r.name)} on your server`)}</b><div class="tt-grow"></div><button class="tt-x" data-a="close" aria-label="${tc("关闭", "Close")}">${ic("x")}</button><kbd>Esc</kbd></div>
      <p class="tt-intro">${tc(`只有当你更希望由服务器而不是 Stash 的调度器来启动这个例程时才用：先在 Tasks 里把例程设为 <b>关闭</b>，否则它会跑两次。把这个脚本复制到服务器上一次；改了例程后要再复制一次。`, `Only if you would rather your server start this routine than Stash's scheduler: turn the routine <b>Off</b> in Tasks first, or it runs twice. Copy this script to the server once; copy it again after you change the routine.`)}</p>
      ${heard}
      <div class="tt-rowf"><span class="tt-lbl">${tc("你的服务器", "Your server")}</span><div class="tt-seg" role="group" aria-label="${tc("你的服务器", "Your server")}">
        <button class="${os === "unraid" ? "on" : ""}" data-a="os" data-k="unraid">Unraid User Scripts</button><button class="${os === "cron" ? "on" : ""}" data-a="os" data-k="cron">cron (Linux)</button></div>
        <label class="tt-lbl" for="tt-stash">${tc("从服务器访问 Stash 的地址", "Stash from the server")}</label><input id="tt-stash" class="tt-input" data-f="stash" value="${esc(S.sheet.stash)}" style="width:220px"></div>
      <ol class="tt-ol">${steps.map((t, i) => `<li><b>${i + 1}</b><span>${t}</span></li>`).join("")}</ol>
      ${sc.skipped.length ? `<div class="tt-banner">${ic("browser")}<span class="tt-grow">${tc(`脚本里略去：${esc(sc.skipped.join("、"))}。脚本会在每一项旁边说明原因；比「能在服务器上规划扫描」的版本更旧的工具包，仍可从浏览器例程运行。`, `Left out of the script: ${esc(sc.skipped.join(", "))}. The script says why beside each; a toolkit older than the one that plans its scan on the server still runs from a browser routine.`)}</span></div>` : ""}
      <pre class="tt-code" aria-label="${tc("脚本", "Script")}">${esc(sc.text)}</pre>
      <div class="tt-key">${ic("warn")}<span>${tc("拿到 API key 的任何东西都能在 Stash 里做任何事。只把它保留在服务器上的这个脚本里；本页面从不替它填写，也从不保存它。", "The API key lets anything that has it do everything in Stash. Keep it in this script on the server only; this page never fills it in and never stores it.")}</span></div>
      <div class="tt-foot"><button class="tt-btn tt-pri" data-a="copy">${ic("copy")}${tc("复制脚本", "Copy script")}</button><button class="tt-btn" data-a="dl">${ic("dl")}${tc(`下载 ${esc(sc.file)}`, `Download ${esc(sc.file)}`)}</button><span class="tt-grow"></span><button class="tt-btn" data-a="close">${tc("完成", "Done")}</button></div></div>`;
  }
  // 0.4.0: the optional fallback for the one limitation (Stash has no
  // start-up hook): an hourly knock from the server; and, folded, the old
  // per-routine script for whoever wants the server to run a routine
  function keepSheet() {
    const now = Date.now(), d = new Date(now);
    const sc = keepAliveScript({ stash: S.sheet.stash, date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` });
    S.sheet.text = sc.text; S.sheet.file = sc.file;
    const L = schedLine(S.sched, now, S.schedErr);
    const os = S.sheet.os || "unraid";
    const steps = os === "unraid" ? [
      tc("在 Unraid 的 Apps 标签页里安装 <code>User Scripts</code>（如果还没有）。", "In Unraid, install <code>User Scripts</code> from the Apps tab if it is not there yet."),
      tc("Settings → User Scripts → Add new script，命名为 <code>stash-tasks-scheduler</code>。", "Settings, User Scripts, Add new script. Name it <code>stash-tasks-scheduler</code>."),
      tc("Edit script，粘贴下面的脚本；如果你的 Stash 需要登录，把 API key 填在 <code>STASH_API_KEY=\"\"</code> 的引号之间。确认 <code>STASH</code> 是服务器上访问 Stash 的地址。", "Edit script, paste the script below, and put your API key between the quotes of <code>STASH_API_KEY=\"\"</code> if your Stash has a login. Check <code>STASH</code> is Stash's address from the server."),
      tc(`Schedule 选 Custom，再填 <code>${esc(sc.cron)}</code>（每小时）。应用。`, `Schedule: Custom, then <code>${esc(sc.cron)}</code> (every hour). Apply.`),
    ] : [
      tc(`把脚本保存为服务器上的 <code>${esc(sc.file)}</code> 并赋予执行权限：<code>chmod +x ${esc(sc.file)}</code>。`, `Save the script on the server as <code>${esc(sc.file)}</code> and make it runnable: <code>chmod +x ${esc(sc.file)}</code>.`),
      tc("如果你的 Stash 需要登录，把 API key 填在 <code>STASH_API_KEY=\"\"</code> 的引号之间，并确认 <code>STASH</code> 是服务器上访问 Stash 的地址。它需要 <code>curl</code>。", "Put your API key between the quotes of <code>STASH_API_KEY=\"\"</code> if your Stash has a login, and check <code>STASH</code> is Stash's address from the server. It needs <code>curl</code>."),
      tc(`运行 <code>crontab -e</code> 并添加：<code>${esc(`${sc.cron} /path/to/${sc.file} >/dev/null 2>&1`)}</code>`, `Run <code>crontab -e</code> and add: <code>${esc(`${sc.cron} /path/to/${sc.file} >/dev/null 2>&1`)}</code>`),
    ];
    const sv = S.data.routines.filter((r) => r.where === "server");
    return `<div class="tt-sheet tt-wide" role="dialog" aria-label="${tc("让 Stash 的调度器保持运行", "Keep Stash's scheduler running")}">
      <div class="tt-ch">${ic("server", "color:var(--sx-gr);width:18px;height:18px")}<b>${tc("让 Stash 的调度器保持运行（可选）", "Keep Stash's scheduler running (optional)")}</b><div class="tt-grow"></div><button class="tt-x" data-a="close" aria-label="${tc("关闭", "Close")}">${ic("x")}</button><kbd>Esc</kbd></div>
      <p class="tt-intro">${tc("在 Stash 里运行的例程无需任何设置：打开任意 Stash 页面就会启动 Tasks 的调度器，之后它会一直运行。Stash 没有插件启动钩子，所以 Stash 或其容器重启后，调度器会等第一个打开的 Stash 页面。如果 Stash 可能在你没打开页面时重启（比如夜里更新），可以让服务器每小时来敲一次门；调度器已在运行时，这一下只是询问。", "Nothing to set up for routines that run in Stash: any Stash page opened starts Tasks' scheduler, and it keeps running. Stash has no start-up hook for plugins, so after Stash or its container restarts the scheduler waits for the first Stash page. If Stash may restart when nobody opens it (an update at night), let your server knock once an hour; when the scheduler runs, the knock only asks.")}</p>
      <div class="tt-heard${L.ok ? "" : " bad"}">${ic(L.ok ? "check" : "warn")}<span class="tt-grow">${esc(L.text)}</span></div>
      <div class="tt-rowf"><span class="tt-lbl">${tc("你的服务器", "Your server")}</span><div class="tt-seg" role="group" aria-label="${tc("你的服务器", "Your server")}">
        <button class="${os === "unraid" ? "on" : ""}" data-a="os" data-k="unraid">Unraid User Scripts</button><button class="${os === "cron" ? "on" : ""}" data-a="os" data-k="cron">cron (Linux)</button></div>
        <label class="tt-lbl" for="tt-stash">${tc("从服务器访问 Stash 的地址", "Stash from the server")}</label><input id="tt-stash" class="tt-input" data-f="stash" value="${esc(S.sheet.stash)}" style="width:220px"></div>
      <ol class="tt-ol">${steps.map((t, i) => `<li><b>${i + 1}</b><span>${t}</span></li>`).join("")}</ol>
      <pre class="tt-code" aria-label="${tc("脚本", "Script")}">${esc(sc.text)}</pre>
      <div class="tt-key">${ic("warn")}<span>${tc("拿到 API key 的任何东西都能在 Stash 里做任何事。只把它保留在服务器上的这个脚本里；本页面从不替它填写，也从不保存它。", "The API key lets anything that has it do everything in Stash. Keep it in this script on the server only; this page never fills it in and never stores it.")}</span></div>
      ${sv.length ? `<details class="tt-recfold"><summary>${tc("改用服务器来运行例程（旧办法）", "Run a routine from the server instead (the old way)")}</summary><div class="tt-col">${sv.map((r) => `<div class="tt-rowf"><b>${esc(r.name)}</b><span class="tt-grow"></span><button class="tt-btn tt-sm" data-a="script" data-id="${esc(r.id)}">${ic("server")}${tc("它的脚本", "Its script")}</button></div>`).join("")}</div></details>` : ""}
      <div class="tt-foot"><button class="tt-btn tt-pri" data-a="copy">${ic("copy")}${tc("复制脚本", "Copy script")}</button><button class="tt-btn" data-a="dl">${ic("dl")}${tc(`下载 ${esc(sc.file)}`, `Download ${esc(sc.file)}`)}</button><span class="tt-grow"></span><button class="tt-btn" data-a="close">${tc("完成", "Done")}</button></div></div>`;
  }
  function onSheetInput(ev) {
    const f = ev.target.getAttribute && ev.target.getAttribute("data-f");
    if (!f || !S.sheet) return;
    if (S.sheet.kind === "script" || S.sheet.kind === "keep") { if (f === "stash") { S.sheet.stash = ev.target.value.trim(); clearTimeout(S.sheet.t); S.sheet.t = setTimeout(renderSheet, 400); } return; }
    const r = S.sheet.r;
    if (f === "name") r.name = ev.target.value;
    else if (f === "time") { r.sched.time = ev.target.value.trim(); if (parseHM(r.sched.time) || !r.sched.time) renderSheet(); }
    else if (f === "dow") { r.sched.dow = +ev.target.value || 0; renderSheet(); }
  }
  async function onSheetClick(ev) {
    if (ev.target === sheetEl) { closeSheet(); return; }
    const t = ev.target.closest("[data-a]");
    if (!t || !sheetEl.contains(t)) return;
    const a = t.dataset.a, sh = S.sheet;
    if (!sh) return;
    if (a === "close") { closeSheet(); return; }
    if (sh.kind === "script" || sh.kind === "keep") {
      if (a === "os") { sh.os = t.dataset.k; setPref("os", sh.os); renderSheet(); }
      else if (a === "script") openScript(t.dataset.id);
      else if (a === "copy") copyText(sh.text);
      else if (a === "dl") { const blob = new Blob([sh.text.replace(/\n/g, "\n")], { type: "text/x-sh" }); const el = document.createElement("a"); el.href = URL.createObjectURL(blob); el.download = sh.file;
        document.body.appendChild(el); el.click(); setTimeout(() => { URL.revokeObjectURL(el.href); el.remove(); }, 1000); }
      else if (a === "seehist") { closeSheet(); S.tab = "viewer"; S.hf = "routine"; render(); }
      return;
    }
    const r = sh.r;
    if (a === "addmenu") sh.menu = !sh.menu;
    else if (a === "addstep") { r.steps.push(t.dataset.k); sh.menu = false; }
    else if (a === "sup" || a === "sdown") { const i = +t.dataset.i, j = i + (a === "sup" ? -1 : 1); if (j >= 0 && j < r.steps.length) [r.steps[i], r.steps[j]] = [r.steps[j], r.steps[i]]; }
    else if (a === "sdel") r.steps.splice(+t.dataset.i, 1);
    else if (a === "freq") r.sched.freq = t.dataset.k;
    else if (a === "onfail") r.onFail = t.dataset.k;
    else if (a === "rflag") r[t.dataset.k] = !r[t.dataset.k];
    else if (a === "where") r.where = t.dataset.k;
    else if (a === "delr") { if (armed("delr")) { await deleteRoutine(r.id); return; } }
    else if (a === "saver") { await saveRoutine(); return; }
    renderSheet();
  }
  async function saveRoutine() {
    const sh = S.sheet, r = sh.r;
    r.name = String(r.name || "").trim();
    if (!r.name) { sh.err = tc("给它起个名字。", "Give it a name."); renderSheet(); return; }
    if (!routineSteps(r.steps).length) { sh.err = tc("至少添加一个步骤。", "Add at least one step."); renderSheet(); return; }
    if (r.sched.freq !== "hand" && !parseHM(r.sched.time)) { sh.err = tc("时间格式应为 02:00。", "The time should look like 02:00."); renderSheet(); return; }
    const now = Date.now();
    try {
      await save((d) => {
        const i = d.routines.findIndex((x) => x.id === r.id);
        const next = normRoutine({ ...(i >= 0 ? d.routines[i] : {}), ...r, steps: routineSteps(r.steps), edited: now, created: i >= 0 ? d.routines[i].created || now : now });
        if (i >= 0) d.routines[i] = next; else d.routines.push(next);
        return d;
      });
      const inStash = r.where === "server" && r.sched.freq !== "hand";
      closeSheet();
      toast(inStash ? (S.sched && S.sched.running ? tc(`${r.name} 已保存。Stash 会在它的时间自行运行。`, `${r.name} saved. Stash runs it by itself at its time.`) : tc(`${r.name} 已保存。Stash 的调度器没有运行：请在「例程」页启动它。`, `${r.name} saved. Stash's scheduler is not running: Start it on Routines.`)) : tc(`${r.name} 已保存。`, `${r.name} saved.`), inStash && !(S.sched && S.sched.running) ? "warn" : "done");
      render();
    } catch (e) { sh.err = tc(`未保存：${e.message}`, `Not saved: ${e.message}`); renderSheet(); }
  }
  async function deleteRoutine(id) {
    try {
      // its queued steps stay where they are (the user takes them out); only the routine goes
      await save((d) => { const i = d.routines.findIndex((x) => x.id === id); if (i < 0) return null; d.routines.splice(i, 1); return d; });
      closeSheet(); toast(tc("例程已删除。", "Routine deleted."), "done"); render();
    } catch (e) { S.sheet.err = e.message; renderSheet(); }
  }
  function openEditor(id) {
    const ex = id && S.data.routines.find((x) => x.id === id);
    const base = ex ? JSON.parse(JSON.stringify(ex)) : normRoutine({ id: newId("t"), name: "", steps: [], sched: { freq: "daily", time: "02:00", dow: 0 }, where: "browser" });
    openSheet({ kind: "edit", r: base, isNew: !ex, menu: !ex });
  }
  function openKeep() {
    const port = location.port || (location.protocol === "https:" ? "443" : "9999");
    openSheet({ kind: "keep", os: prefs.os || "unraid", stash: prefs.stash || `http://localhost:${port}` });
    loadNotes();
  }
  function openScript(id) {
    const port = location.port || (location.protocol === "https:" ? "443" : "9999");
    openSheet({ kind: "script", id, os: prefs.os || "unraid", stash: prefs.stash || `http://localhost:${port}` });
    loadNotes();
  }
  function copyText(text) {
    const ok = () => toast(tc("脚本已复制。粘贴到服务器上，然后填上你的 API key。", "Script copied. Paste it on the server, then add your API key."), "done");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta); ta.select();
      let done = false;
      try { done = document.execCommand("copy"); } catch (_) {}
      ta.remove();
      if (done) ok(); else toast(tc("无法复制：请选中脚本手动复制。", "Could not copy: select the script and copy it by hand."), "warn");
    }
  }

  // ═══ Page events ═══════════════════════════════════════════════════════════

  async function onClick(ev) {
    const t = ev.target.closest("[data-tab],[data-a],[data-go]");
    if (!t || !pageEl.contains(t)) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; setPref("tab", S.tab); S.hmore = 25; render(); if (S.tab !== "overview") loadNotes(); return; }
    if (t.dataset.go && !t.dataset.a) {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1) return;
      ev.preventDefault(); navigate(t.dataset.go); return;
    }
    const a = t.dataset.a, id = t.dataset.id, k = t.dataset.k;
    const now = Date.now();
    if (a === "reload") { S.dataErr = ""; loadData().then(() => render(), (e) => { S.dataErr = e.message; render(); }); }
    else if (a === "relib") loadLib(true);
    else if (a === "tick") {
      const O = overview({ ...S.lib, hist: histAll() }, now, prefs.ticks), row = O.safe.find((x) => x.k === k);
      if (row) { setPref("ticks", nextTicks(prefs.ticks, row)); render(); }
    }
    else if (a === "schedstart") { toast(tc("正在启动调度器…", "Starting Stash's scheduler…"), "info"); loadSched(true).then((st) => { toast(st && st.running ? tc("调度器正在运行。", "Stash's scheduler runs.") : tc(`未启动：${(st && (st.error || st.stopWhy)) || S.schedErr || "没有响应"}`, `Not started: ${(st && (st.error || st.stopWhy)) || S.schedErr || "no answer"}`), st && st.running ? "done" : "error"); render(); }); }
    else if (a === "schedstop") { if (armed("schedstop")) { try { await serverOp("scheduler_stop"); toast(tc("已请求调度器停止；下次打开 Stash 页面会重新启动它。", "Asked Stash's scheduler to stop; the next Stash page opened starts it again."), "info"); } catch (e) { toast(e.message, "error"); } await loadSched(); render(); } }
    else if (a === "keep") openKeep();
    else if (a === "apsw") { const ap = apNow(); apSwitch(!(ap && ap.on)); }
    else if (a === "apskip") apSet({ k, skip: ((apNow() || {}).skip || []).includes(k) ? "0" : "1" });
    else if (a === "apauto") { const ap = apNow(); apSet({ autoOn: ap && ap.autoOn === true ? "0" : "1" }); }
    else if (a === "dosafe") {
      const O = overview({ ...S.lib, hist: histAll() }, now, prefs.ticks);
      // what is already waiting here is not queued twice
      const waiting = new Set(S.data.runner.wait.map((w) => w.k).concat(S.data.runner.cur ? [S.data.runner.cur.k] : []));
      const ks = O.picked.filter((x) => !waiting.has(x));
      if (!ks.length) { toast(tc("这些已经在这里等待了。", "Those are already waiting here."), "info"); return; }
      await queueSteps(ks, { t: "safe", name: "Run the safe ones" }, { hold: true });
      S.tab = "viewer"; setPref("tab", S.tab); render();
    }
    else if (a === "runone") queueSteps([k], { t: "you", name: "You" });
    else if (a === "tonight") queueSteps([k], { t: "tonight", name: "Tonight" }, { after: tonight(now), hold: true });
    else if (a === "tomonthly") {
      try { await save((d) => { const r = d.routines.find((x) => x.id === id); if (!r || r.steps.includes(k)) return null; r.steps = r.steps.concat([k]); r.edited = r.edited || 0; return d; }); toast(tc(`已添加到 ${(S.data.routines.find((x) => x.id === id) || {}).name || "该例程"}。`, `Added to ${(S.data.routines.find((x) => x.id === id) || {}).name || "the routine"}.`), "done"); render(); }
      catch (e) { toast(e.message, "error"); }
    }
    else if (a === "fold") { S.fold[k] = !S.fold[k]; render(); }
    else if (a === "guard") { try { await save((d) => { d.guards = { ...d.guards, [k]: !d.guards[k] }; return d; }); render(); } catch (e) { toast(e.message, "error"); } }
    else if (a === "maxq") { try { await save((d) => { const v = Math.max(1, Math.min(10, (+d.guards.maxQueue || 3) + (+t.dataset.d))); if (v === d.guards.maxQueue) return null; d.guards = { ...d.guards, maxQueue: v }; return d; }); render(); } catch (e) { toast(e.message, "error"); } }
    else if (a === "runmissed") runRoutine(id, +t.dataset.due);
    else if (a === "skipmissed") skipDue(id, +t.dataset.due);
    else if (a === "newr") openEditor(null);
    else if (a === "editr") openEditor(id);
    else if (a === "runr") runRoutine(id, 0);
    else if (a === "script") openScript(id);
    else if (a === "toserver") {
      try { await save((d) => { const r = d.routines.find((x) => x.id === id); if (!r) return null; r.where = "server"; r.edited = now; return d; }); render(); toast(tc("从现在起由 Stash 自行运行。", "Stash runs it by itself from now on."), "done"); }
      catch (e) { toast(e.message, "error"); }
    }
    else if (a === "ron") { try { await save((d) => { const r = d.routines.find((x) => x.id === id); if (!r) return null; r.on = !r.on; r.edited = now; return d; }); render(); } catch (e) { toast(e.message, "error"); } }
    else if (a === "userec") {
      if (!armed("userec")) return;
      try { await save((d) => { d.routines = applyRecommended(d.routines, recommend(recInput()), now); return d; }); toast(tc("推荐的例程已设置好。Stash 会在各自的时间自行运行它们。", "Recommended routines set up. Stash runs them by itself at their times."), "done"); render(); }
      catch (e) { toast(tc(`未保存：${e.message}`, `Not saved: ${e.message}`), "error"); }
    }
    else if (a === "stopcur") { if (armed("stopcur")) stopCur(); }
    else if (a === "stopjob") { if (armed(`stop:${id}`)) stopStash(id); }
    else if (a === "force") { S.force = id; tick(); }
    else if (a === "holdall") { try { await save((d) => { d.runner.hold = !d.runner.hold; return d; }); render(); } catch (e) { toast(e.message, "error"); } }
    else if (a === "wup" || a === "wdown") editWait((w) => moveItem(w, id, a === "wup" ? -1 : 1));
    else if (a === "whold") editWait((w) => w.map((x) => (x.id === id ? { ...x, held: !x.held } : x)));
    else if (a === "wdel") editWait((w) => { const n = w.filter((x) => x.id !== id); return n.length === w.length ? null : n; });
    else if (a === "hf") { S.hf = k; S.hmore = 25; render(); }
    else if (a === "hmore") { S.hmore += 50; render(); }
  }
  // One key listener for the page and its sheets (THEME's keyboard rules):
  // an open sheet owns the keyboard; on the page 1-3 pick a tab.
  function onKey(ev) {
    if (!S.sheet && location.pathname !== PAGE_PATH) return;
    const tg = ev.target, typing = !!tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || ""));
    if (S.sheet) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSheet(); return; }
      if (ev.ctrlKey || ev.metaKey) return;
      if (S.sheet.kind === "edit" && ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown") && tg && tg.dataset && tg.dataset.step !== undefined) {
        ev.preventDefault(); ev.stopPropagation();
        const r = S.sheet.r, i = +tg.dataset.step, j = i + (ev.key === "ArrowUp" ? -1 : 1);
        if (j >= 0 && j < r.steps.length) { [r.steps[i], r.steps[j]] = [r.steps[j], r.steps[i]]; renderSheet(); const el = sheetEl.querySelector(`[data-step="${j}"]`); if (el) el.focus(); }
        return;
      }
      if (S.sheet.kind === "edit" && ev.key === "Enter" && !ev.repeat && !(tg && /^(BUTTON|SELECT|A)$/.test(tg.tagName || ""))) { ev.preventDefault(); ev.stopPropagation(); saveRoutine(); return; }
      if (typing || ev.altKey || ["Tab", "Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(ev.key)) { ev.stopPropagation(); return; }
      ev.preventDefault(); ev.stopPropagation();
      return;
    }
    if (!pageEl || typing || ev.ctrlKey || ev.metaKey || ev.altKey || ev.defaultPrevented || ev.repeat) return;
    const tab = TABS.find((x) => x[4] === ev.key);
    if (tab) { ev.preventDefault(); S.tab = tab[0]; setPref("tab", S.tab); render(); if (S.tab !== "overview") loadNotes(); }
  }

  function mountPage(el) {
    injectStyles();
    pageEl = el;
    lastHtml = "";
    el.addEventListener("click", onClick);
    render();
    (S.data ? Promise.resolve() : loadData()).catch((e) => { S.dataErr = e.message; }).then(() => { render(); loadLib(false); loadNotes(); tick(); });
  }
  (function registerPage() {
    const api = window.PluginApi;
    if (!api || !api.register || typeof api.register.route !== "function" || !api.React) return;
    const R = api.React;
    function TasksToolkitI18nPage() {
      const ref = R.useRef(null);
      R.useEffect(() => {
        const el = ref.current;
        mountPage(el);
        return () => { if (pageEl === el) pageEl = null; if (S.sheet) closeSheet(); };
      }, []);
      return R.createElement("div", { ref, className: "tt-page" });
    }
    try { api.register.route(PAGE_PATH, TasksToolkitI18nPage); }
    catch (e) { log(`Page not registered: ${e.message}`, "error"); }
  })();
  window.TasksToolkitI18n = { page: PAGE_PATH, version: PLUGIN_VERSION, open: () => navigate(PAGE_PATH) };

  // ── The top-bar entry, with a small running-job indicator ────────────────
  // 0.2.0 (user: "tasks header should show on the right side of the header
  // next to analytics"): an icon button among Stash's own right-hand buttons
  // (.navbar-buttons, outside the collapsing menu, so phones see it and its
  // badge too), just before the Statistics one, with that button's classes
  // so it looks like Stash's. No right-hand bar (an older or changed Stash):
  // the left menu, as 0.1.
  const NAV_ICON = `<svg class="tt-navico" viewBox="0 0 16 16" width="1em" height="1em" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON.tasks}</svg>`;
  const OLD_NAV_ICON = `<svg class="nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" viewBox="0 0 16 16" width="1em" height="1em" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON.tasks}</svg>`;
  // Where the entry goes, pure (tested with a fake bar): { parent, before,
  // linkCls, btnCls, right } or null
  function navPlan(doc) {
    const bar = doc.querySelector(".top-nav .navbar-buttons");
    if (bar) {
      const stats = bar.querySelector('a[href="/stats"]') || bar.querySelector('a[href$="/stats"]');
      // the link may sit in a wrapper of its own: insert beside what is a child of the bar
      let before = stats;
      while (before && before.parentNode && before.parentNode !== bar) before = before.parentNode;
      if (!before || before.parentNode !== bar) before = bar.querySelector(".navbar-toggler") || null;
      const sBtn = stats && stats.querySelector("button");
      return { parent: bar, before, right: true,
        linkCls: `${(stats && stats.className) || "nav-utility"} tt-nav`.replace(/\bactive\b/g, "").replace(/\s+/g, " ").trim(),
        btnCls: `${(sBtn && sBtn.className) || "minimal d-flex align-items-center h-100 btn btn-primary"} tt-navbtn`.replace(/\s+/g, " ").trim() };
    }
    const nav = doc.querySelector(".top-nav .navbar-collapse .navbar-nav");
    return nav ? { parent: nav, before: null, right: false } : null;
  }
  // 0.2.2 (user: "I couldn't see Tasks Toolkit in the mobile version"): Stash
  // hides every .nav-utility button under 576px, so phones also get an entry
  // in the collapsing menu, shown only at that width (d-sm-none)
  function menuItem(extra) {
    const item = document.createElement("div");
    item.className = `nav-link tt-nav col-4 col-sm-3 col-md-2 col-lg-auto${extra ? ` ${extra}` : ""}`;
    const a = document.createElement("a");
    a.href = PAGE_PATH;
    a.className = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary";
    a.innerHTML = OLD_NAV_ICON + `<span>${tc("任务", "Tasks")}</span><span class="tt-navjob"></span>`;
    a.addEventListener("click", (ev) => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return; ev.preventDefault(); a.blur(); navigate(PAGE_PATH); });
    item.appendChild(a);
    return item;
  }
  // 0.6.0 (user: "an easy switch on top right header next to the tasks
  // toolkit icon"): Autopilot's switch, right after the Tasks button; on
  // phones also in the collapsing menu, beside the Tasks entry there
  function apNavEl(extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tt-apsw${extra ? ` ${extra}` : ""}`;
    b.setAttribute("role", "switch");
    b.innerHTML = `<i></i><span>${tc("自动", "Auto")}</span>`;
    b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); b.blur(); const a = apNow(); apSwitch(!(a && a.on)); });
    return b;
  }
  function apNavDraw(el) {
    const st = apState(apNow(), S.queue, Date.now()), on = st.k === "on" || st.k === "run" || st.k === "nosched";
    if (el.dataset.k !== st.k) el.dataset.k = st.k;
    if (el.getAttribute("aria-checked") !== String(on)) el.setAttribute("aria-checked", String(on));
    if (el.title !== st.title) { el.title = st.title; el.setAttribute("aria-label", st.title); }
  }
  function renderNav() {
    let item = document.querySelector(".top-nav .tt-nav:not(.tt-navm)");
    const plan = navPlan(document);
    if (!plan) return;
    // drawn on the left before the right-hand bar was there: move it
    if (item && plan.right !== item.classList.contains("tt-navr")) { item.remove(); item = null; }
    if (!item) {
      injectStyles();
      if (plan.right) {
        item = document.createElement("a");
        item.href = PAGE_PATH;
        item.className = `${plan.linkCls} tt-navr`;
        const b = document.createElement("button");
        b.type = "button";
        b.className = plan.btnCls;
        b.setAttribute("aria-label", tc("任务", "Tasks"));
        b.innerHTML = NAV_ICON + `<span class="tt-navjob"></span>`;
        item.appendChild(b);
        item.addEventListener("click", (ev) => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return; ev.preventDefault(); b.blur(); navigate(PAGE_PATH); });
        plan.parent.insertBefore(item, plan.before);
      } else {
        item = menuItem("");
        plan.parent.appendChild(item);
      }
    }
    let sw = document.querySelector(".top-nav .tt-apsw:not(.tt-apswm)");
    if (!sw) sw = apNavEl("");
    // right after the Tasks button (or inside the left menu's entry)
    if (plan.right ? sw.previousElementSibling !== item : sw.parentNode !== item) {
      if (plan.right) item.parentNode.insertBefore(sw, item.nextSibling); else item.appendChild(sw);
    }
    let mItem = document.querySelector(".top-nav .tt-navm");
    const menu = plan.right ? document.querySelector(".top-nav .navbar-collapse .navbar-nav") : null;
    if (!plan.right && mItem) { mItem.remove(); mItem = null; }
    if (menu && !mItem) { mItem = menuItem("tt-navm d-sm-none"); mItem.appendChild(apNavEl("tt-apswm")); menu.appendChild(mItem); }
    for (const el of document.querySelectorAll(".top-nav .tt-apsw")) apNavDraw(el);
    const onPage = location.pathname === PAGE_PATH;
    if (item.classList.contains("tt-navr") && item.classList.contains("active") !== onPage) item.classList.toggle("active", onPage);
    // 0.6.1 (user: "I dont like this cramped view and the on / percentage on
    // tasks toolkit's icon"): the percentage sits beside the icon, nothing
    // when there is none; what runs and the time left are on hover
    const v = readView() || {};
    const wait = S.data ? S.data.runner.wait.length : v.wait || 0, missed = S.missed.length || v.missed || 0;
    const { text, kind, title } = navInfo(S.queue, wait, missed, Date.now());
    for (const it of [item, mItem]) {
      if (!it) continue;
      const badge = it.querySelector(".tt-navjob");
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.dataset.k !== kind) badge.dataset.k = kind;
      const a = it.tagName === "A" ? it : it.querySelector("a");
      if (a.title !== title) a.title = title;
    }
  }

  // locale 可能在静态 DOM 之后才到：到了就把顶栏和页面按当前语言重画一次
  _afterLocale.push(() => {
    try {
      renderNav();
      if (pageEl) { lastHtml = ""; render(); }
    } catch (_) {}
  });

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pagehide", dropLock);
  let navQueued = false;
  new MutationObserver(() => {
    if (navQueued) return;
    navQueued = true;
    // a timer, not requestAnimationFrame: rAF never fires in a hidden tab
    setTimeout(() => { navQueued = false; renderNav(); }, 120);
  }).observe(document.body, { childList: true, subtree: true });
  // every 3 s; the work inside is spaced by what is running (tick())
  setInterval(tick, 3000);
  setTimeout(tick, 1500);
  setTimeout(ensureScheduler, 2500);

  // ═══ Suite Data client (shared copy) ═══════════════════════════════════════
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
      if (!r || typeof r !== "object") throw new Error(tc("Suite Data 没有响应", "Suite Data did not answer"));
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
          tell(`${name}: ${tc("在 Suite Data 关闭期间所做的更改已作为备份保留（Suite Data，你的数据）。", "changes made while Suite Data was off were kept as a backup (Suite Data, Your data).")}`);
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
  // every element Tasks Toolkit draws sits under one of these: the page, its
  // sheets (mounted on body, carrying .tt), the toast and the top-bar entry
  const THEME = suiteTheme({ id: "taskstoolkit", scope: ".tt, #tt-toast, .tt-nav, .tt-apsw" });

  function injectStyles() {
    if (document.getElementById("taskstoolkit-styles")) return;
    THEME.start();
    const s = document.createElement("style");
    s.id = "taskstoolkit-styles";
    s.textContent = `
/* The Tasks page (the suite's page frame) and its sheets. Every colour is
   a theme token (docs/THEME.md "Theme tokens"); shadows scale with --sx-k. */
.tt { --acc: var(--sx-cy); max-width: 1180px; margin: 24px auto 48px; padding: 18px; color: var(--sx-tx); font-size: 14px; line-height: 1.43; text-align: left;
  background: var(--sx-bg); border-radius: 16px; border: 1px solid var(--sx-deep); border-top-color: var(--sx-slab); box-shadow: 0 20px 50px -20px rgba(0,0,0,calc(.7*var(--sx-k))); }
.tt *, .tt-veil * { box-sizing: border-box; }
.tt button, .tt input, .tt select { font: inherit; }
.tt h1, .tt h2, .tt h3, .tt h4, .tt p { margin: 0; }
.tt a { text-decoration: none; }
.tt-ic { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.tt kbd { font: 600 10.5px/1 ui-monospace, Consolas, monospace; color: var(--sx-tx2); background: var(--sx-bg2); border: 1px solid var(--sx-ui3); border-bottom-width: 2px; border-radius: 4px; padding: 2px 5px; margin-left: 2px; box-shadow: none; }
.tt-grow { flex: 1; min-width: 0; }
.tt-sep { width: 1px; height: 20px; background: var(--sx-ui2); margin: 0 6px; }
.tt-muted { color: var(--sx-tx2); font-size: 12px; }
.tt-note { color: var(--sx-tx2); font-size: 12px; margin: 0; }
.tt-bad { color: var(--sx-re-tx); font-size: 13px; }
.tt-none { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 9px; background: var(--sx-bg2); color: var(--sx-tx2); font-size: 13px; }
.tt-none .tt-ic { color: var(--sx-gr); }
.tt-col { display: flex; flex-direction: column; gap: 16px; }
.tt-rowf { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tt-rowf.tt-at { flex-wrap: nowrap; gap: 6px; }

/* header and tabs */
.tt-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.tt-title { font-size: 22px; font-weight: 700; color: var(--sx-hi); display: flex; align-items: center; gap: 8px; }
.tt-title .tt-ic { width: 20px; height: 20px; color: var(--acc); }
.tt-read { color: var(--sx-tx2); font-size: 12px; display: inline-flex; align-items: center; gap: 8px; }
.tt-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; padding: 4px; border-radius: 11px; background: var(--sx-bg2);
  border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); box-shadow: inset 0 2px 4px rgba(0,0,0,calc(.5*var(--sx-k))); }
.tt-tab { display: inline-flex; align-items: center; gap: 7px; background: none; border: 1px solid transparent; color: var(--sx-tx1b); border-radius: 8px; padding: 6px 13px; cursor: pointer; }
.tt-tab .tt-ic { color: var(--tc); opacity: .75; }
.tt-tab:hover { color: var(--sx-hi); }
.tt-tab.on { color: var(--sx-hi); background: var(--sx-ui2); background: color-mix(in srgb, var(--tc) 24%, var(--sx-ui));
  border-color: color-mix(in srgb, var(--tc) 55%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,calc(.4*var(--sx-k))); }
.tt-tab.on .tt-ic { opacity: 1; }

/* cards, buttons, pills, toggles, chips */
.tt-card, .tt-sheet { background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-radius: 12px;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 12px 24px -10px rgba(0,0,0,calc(.65*var(--sx-k))); }
.tt-card { padding: 10px 12px; }
.tt-card.tt-busy { border-top-color: var(--sx-cy); }
.tt-card.tt-empty { display: flex; flex-direction: column; gap: 3px; align-items: center; text-align: center; padding: 22px 16px; color: var(--sx-tx2); font-size: 13px; }
.tt-empty b { color: var(--sx-hi); font-size: 15px; font-weight: 600; }
.tt-empty .tt-btn { margin-top: 8px; }
.tt-btn { display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(180deg, var(--sx-ui2), var(--sx-ui)); color: var(--sx-tx);
  border: 1px solid var(--sx-line2); border-top-color: var(--sx-ui3); border-radius: 8px; padding: 5px 12px; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,calc(.5*var(--sx-k)));
  white-space: nowrap; font-size: 13px; text-decoration: none; }
.tt-btn:hover { color: var(--sx-hi); border-top-color: var(--sx-tx3); }
.tt-btn:disabled { opacity: .5; cursor: default; }
.tt-btn:focus-visible, .tt-chip:focus-visible, .tt-tab:focus-visible, .tt-tog:focus-visible, .tt-box:focus-visible, .tt-link:focus-visible, .tt-ib:focus-visible, .tt-step:focus-visible, .tt-opt:focus-visible, .tt-fold:focus-visible { outline: 2px solid var(--sx-bl); outline-offset: 2px; }
.tt-btn.tt-pri { background: linear-gradient(180deg, var(--acc), color-mix(in srgb, var(--acc) 75%, var(--sx-deep))); color: var(--sx-on); font-weight: 600; }
.tt-btn.tt-pri kbd { color: var(--sx-on); border-color: color-mix(in srgb, var(--sx-on) 35%, transparent); background: rgba(255,255,255,.15); }
.tt-btn.tt-go { background: linear-gradient(180deg, var(--sx-cy), var(--sx-cy-d)); color: var(--sx-on); font-weight: 600; }
.tt-btn.tt-dangerl { color: var(--sx-re-tx); }
.tt-btn.armed, .tt-ib.armed { background: linear-gradient(180deg, var(--sx-re), var(--sx-re-d)); color: var(--sx-on); font-weight: 600; }
.tt-btn.tt-sm { padding: 3px 8px; font-size: 12px; }
.tt-btn.tt-big { padding: 10px 18px; font-size: 15px; border-radius: 9px; }
.tt-btn.tt-big .tt-ic { width: 18px; height: 18px; }
.tt-btn small { font-weight: 400; opacity: .85; font-size: 13px; }
.tt-link { background: none; border: 0; color: var(--sx-bl); cursor: pointer; padding: 0; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; align-self: flex-start; }
.tt-link:hover { color: var(--sx-bl-tx); text-decoration: underline; }
.tt-x { background: none; border: 0; color: var(--sx-tx2); cursor: pointer; padding: 2px; display: inline-flex; }
.tt-x:hover { color: var(--sx-hi); }
.tt-ib { background: none; border: 1px solid transparent; border-radius: 7px; color: var(--sx-tx2); padding: 4px; cursor: pointer; display: inline-flex; }
.tt-ib:hover { color: var(--sx-hi); background: var(--sx-ui2); }
.tt-ib:disabled { opacity: .35; cursor: default; background: none; }
.tt-ib.re:hover { color: var(--sx-re-tx); }
.tt-ib.on { color: var(--sx-ye-tx); }
.tt-pill { font-size: 11px; color: var(--sx-tx1b); background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 6px; padding: 1px 6px;
  white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.tt-pill .tt-ic { width: 11px; height: 11px; stroke-width: 2; }
.tt-pill.tt-ye { color: var(--sx-ye-tx); border-color: color-mix(in srgb, var(--sx-ye) 40%, var(--sx-deep)); }
.tt-pill.tt-or { color: var(--sx-or-tx); }
.tt-pill.tt-re { color: var(--sx-re-tx); border-color: color-mix(in srgb, var(--sx-re) 40%, var(--sx-deep)); }
.tt-pill.tt-gr { color: var(--sx-gr-tx); border-color: color-mix(in srgb, var(--sx-gr) 40%, var(--sx-deep)); }
.tt-tog { display: inline-flex; align-items: center; gap: 7px; background: var(--sx-bg2); color: var(--sx-tx1b); border: 1px solid var(--sx-deep);
  border-bottom-color: var(--sx-ui2); border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 13px; text-align: left; }
.tt-tog i { width: 26px; height: 15px; border-radius: 8px; background: var(--sx-ui3); position: relative; flex: none; }
.tt-tog i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--sx-tx2); transition: left .15s; }
.tt-tog.on { color: var(--sx-hi); }
.tt-tog.on i { background: var(--acc); }
.tt-tog.on i::after { left: 13px; background: var(--sx-paper); }
.tt-tbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.tt-chip { display: inline-flex; align-items: center; gap: 5px; background: var(--sx-bg2); color: var(--sx-tx1b); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
  border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12.5px; }
.tt-chip .tt-ic { width: 13px; height: 13px; color: var(--c, var(--sx-tx1b)); }
.tt-chip b { color: inherit; font-variant-numeric: tabular-nums; margin-left: 2px; }
.tt-chip:hover { color: var(--sx-hi); }
.tt-chip.on { color: var(--sx-hi); background: var(--sx-ui2); background: color-mix(in srgb, var(--sx-pu) 22%, var(--sx-ui2)); border-color: color-mix(in srgb, var(--sx-pu) 50%, transparent); }
.tt-box { width: 20px; height: 20px; flex: none; border-radius: 5px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
  display: inline-flex; align-items: center; justify-content: center; color: var(--sx-on); cursor: pointer; padding: 0; }
.tt-box .tt-ic { width: 13px; height: 13px; stroke-width: 2.2; }
.tt-box.on { background: var(--sx-cy); border-color: var(--sx-cy); }
.tt-track { height: 9px; margin: 2px 0; background: var(--sx-bg2); border-radius: 4px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
.tt-track i { display: block; height: 100%; background: var(--sx-cy); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); transition: width .4s; }
.tt-spin { width: 13px; height: 13px; flex: none; display: inline-block; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--sx-cy) 30%, transparent);
  border-top-color: var(--sx-cy); animation: ttSpin .8s linear infinite; vertical-align: -2px; }
@keyframes ttSpin { to { transform: rotate(360deg); } }
.tt-load { padding: 48px 0; text-align: center; color: var(--sx-tx2); }
.tt-lbar { width: 260px; max-width: 80%; height: 6px; margin: 14px auto 0; background: var(--sx-bg2); border-radius: 3px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); }
.tt-lbar i { display: block; width: 40%; height: 100%; background: var(--acc); border-radius: 3px; animation: ttSlide 1.1s ease-in-out infinite; }
@keyframes ttSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .tt-lbar i, .tt-spin { animation: none; } }
.tt-banner { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 9px; font-size: 13px; color: var(--sx-ye-tx); margin-bottom: 12px;
  background: color-mix(in srgb, var(--sx-ye) 8%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-ye) 45%, transparent); flex-wrap: wrap; }
.tt-banner b { color: var(--sx-hi); }
.tt-banner .tt-ic { flex: none; }
.tt-banner.tt-info, .tt-banner.tt-quiet { color: var(--sx-tx1b); background: var(--sx-bg2); border-color: var(--sx-ui3); }
.tt-main .tt-banner, .tt-col .tt-banner, .tt-rc .tt-banner { margin-bottom: 0; }
.tt-rc .tt-banner { font-size: 12.5px; }

/* layout */
.tt-split { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
.tt-main { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.tt-side { flex: 1 1 300px; max-width: 340px; display: flex; flex-direction: column; gap: 14px; }

/* the hero: the one button */
.tt-hero { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding: 16px 18px; }
.tt-hero h2 { font-size: 16px; font-weight: 700; color: var(--sx-hi); }
.tt-hero p { margin: 3px 0 0; color: var(--sx-tx2); font-size: 13px; }
.tt-flow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; width: 100%; padding-top: 12px; border-top: 1px solid var(--sx-ui2); font-size: 12px; color: var(--sx-tx2); }
.tt-fs { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 3px; border-radius: 8px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); color: var(--sx-tx1b); }
.tt-fs b { width: 18px; height: 18px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--sx-cy) 30%, var(--sx-ui2)); color: var(--sx-hi); font-size: 11px; }
.tt-flow > .tt-ic { width: 12px; height: 12px; color: var(--sx-tx3); }

/* sections and rows */
.tt-sh { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; flex-wrap: wrap; }
.tt-sh h3 { font-size: 15px; font-weight: 500; color: var(--sx-hi); display: inline-flex; align-items: center; gap: 8px; }
.tt-sh h3 .tt-ic { color: var(--c); }
.tt-shw { margin-left: auto; font-size: 12.5px; color: var(--sx-tx2); }
.tt-list { display: flex; flex-direction: column; gap: 4px; }
.tt-row { display: grid; grid-template-columns: 20px 18px minmax(0, 1fr) auto 76px auto; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px; background: var(--sx-bg2);
  border: 1px solid transparent; font-size: 13px; }
.tt-row.off { opacity: .55; }
.tt-row > .tt-ic { color: var(--c, var(--sx-tx1b)); }
.tt-row.look { grid-template-columns: 18px minmax(0, 1fr) auto auto; }
.tt-row.long { grid-template-columns: 18px minmax(0, 1fr) auto 76px auto; }
.tt-what { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tt-what b { color: var(--sx-hi); font-weight: 600; font-size: 13.5px; }
.tt-what > span { color: var(--sx-tx2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tt-est { font-size: 12.5px; color: var(--sx-tx1b); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.tt-est.tt-big { font-size: 14px; color: var(--sx-hi); }
.tt-pills { display: flex; gap: 4px; justify-content: flex-end; }
.tt-pm { display: none; gap: 6px; align-items: center; margin-top: 4px; flex-wrap: wrap; font-size: 12px; color: var(--sx-tx1b); }
.tt-fold { display: none; align-items: center; gap: 10px; width: 100%; padding: 11px 12px; border-radius: 10px; background: var(--sx-bg2); border: 1px solid var(--sx-deep);
  border-bottom-color: var(--sx-ui2); color: var(--sx-tx1b); font-size: 13px; text-align: left; cursor: pointer; min-height: 44px; }
.tt-fold b { color: var(--sx-hi); font-weight: 600; }
.tt-fold > .tt-ic:first-child { color: var(--c); }
.tt-fold > .tt-ic:last-child { margin-left: auto; color: var(--sx-tx2); transition: transform .15s; }
.tt-fold.open > .tt-ic:last-child { transform: rotate(180deg); }
.tt-done { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--sx-tx2); padding: 4px 2px; }
.tt-done .tt-ic { color: var(--sx-gr); width: 14px; height: 14px; }
.tt-done b { color: var(--sx-tx1b); font-weight: 500; }

/* side cards */
.tt-sc { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.tt-sc h4 { font-size: 13px; font-weight: 600; color: var(--sx-hi); display: flex; align-items: center; gap: 7px; }
.tt-sc h4 .tt-ic { color: var(--c, var(--sx-tx1b)); }
.tt-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; font-size: 12.5px; align-items: baseline; }
.tt-kv span { color: var(--sx-tx2); white-space: nowrap; }
.tt-kv b { color: var(--sx-tx1b); font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
.tt-nr { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; border-radius: 9px; background: var(--sx-bg2); font-size: 12.5px; }
.tt-nr b { color: var(--sx-hi); font-weight: 600; font-size: 13px; }
.tt-nr > span { color: var(--sx-tx2); }
.tt-nr .tt-where { align-self: flex-start; }
.tt-guards { display: flex; flex-direction: column; gap: 5px; }
.tt-guards .tt-tog { width: 100%; justify-content: flex-start; }
.tt-guards .tt-tog.on i { background: var(--sx-cy); }
.tt-num-g { cursor: default; padding-top: 2px; padding-bottom: 2px; }
.tt-num-g .tt-ib { padding: 2px; }
.tt-gnum { font-variant-numeric: tabular-nums; color: var(--sx-hi); min-width: 14px; text-align: center; }

/* where a routine runs */
.tt-where { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; border-radius: 6px; padding: 1px 7px; white-space: nowrap; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); }
.tt-where .tt-ic { width: 12px; height: 12px; }
.tt-where.br { color: var(--sx-bl-tx); }
.tt-where.sv { color: var(--sx-gr-tx); }
.tt-where.hand { color: var(--sx-tx1b); }

/* routines */
.tt-recc { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; border-top-color: var(--sx-bl); }
.tt-rech { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.tt-rech h3 { font-size: 15px; font-weight: 600; color: var(--sx-hi); }
.tt-rech p { margin: 3px 0 0; font-size: 13px; color: var(--sx-tx2); max-width: 680px; }
.tt-recc .tt-btn.tt-pri { --acc: var(--sx-bl); }
.tt-recl { display: flex; flex-direction: column; gap: 6px; }
.tt-recr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.tt-recr > b { color: var(--sx-hi); min-width: 120px; }
.tt-week { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 4px 10px; font-size: 11.5px; color: var(--sx-tx2); }
.tt-day { position: relative; height: 18px; border-radius: 5px; background: var(--sx-bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); overflow: hidden; }
.tt-blk { position: absolute; top: 3px; bottom: 3px; border-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.tt-blk.n { background: var(--sx-bl); } .tt-blk.w { background: var(--sx-gr); } .tt-blk.m { background: var(--sx-or); }
.tt-hours { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--sx-tx2); font-variant-numeric: tabular-nums; }
.tt-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--sx-tx2); align-items: center; }
.tt-legend i { display: inline-block; width: 12px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.tt-rgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 12px; }
.tt-rc { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.tt-rc.paused { opacity: .7; }
.tt-rct { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tt-rct h3 { font-size: 15px; font-weight: 600; color: var(--sx-hi); }
.tt-when { font-size: 12.5px; color: var(--sx-tx1b); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tt-when .tt-ic { width: 14px; height: 14px; color: var(--sx-tx2); }
.tt-chain { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tt-chain .tt-chip { cursor: default; padding: 3px 8px; font-size: 12px; }
.tt-chain > .tt-ic { width: 11px; height: 11px; color: var(--sx-tx3); }
.tt-last { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid var(--sx-ui2); font-size: 12.5px; color: var(--sx-tx2); }
.tt-last > span:first-child { display: inline-flex; align-items: center; gap: 5px; }
.tt-last .ok { color: var(--sx-gr-tx); }
.tt-last .warn { color: var(--sx-ye-tx); }
.tt-last .tt-ic { width: 13px; height: 13px; }

/* sheets */
.tt.tt-veil { position: fixed; inset: 0; z-index: 1050; max-width: none; margin: 0; padding: 40px 12px; border: 0; border-radius: 0; box-shadow: none;
  background: color-mix(in srgb, var(--sx-bg) 66%, transparent); display: flex; justify-content: center; align-items: flex-start; overflow-y: auto; }
.tt-sheet { width: 700px; max-width: 100%; padding: 16px; border-radius: 14px; display: flex; flex-direction: column; gap: 14px;
  box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k))); }
.tt-sheet.tt-wide { width: 780px; }
.tt-ch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tt-ch b { color: var(--sx-hi); font-size: 17px; }
.tt-intro { color: var(--sx-tx1b); font-size: 13px; margin: 0; line-height: 1.5; }
.tt-field { display: flex; flex-direction: column; gap: 5px; }
.tt-field > label, .tt-lbl { font-size: 11px; color: var(--sx-tx2); letter-spacing: .02em; }
.tt-input { background: var(--sx-bg2); color: var(--sx-hi); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 8px; padding: 6px 10px; font-size: 14px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k))); }
.tt-input:focus { outline: 2px solid var(--sx-bl); outline-offset: 1px; }
.tt-input.sm { width: 84px; font-variant-numeric: tabular-nums; }
.tt-seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2); border-radius: 8px; flex-wrap: wrap; }
.tt-seg button { background: none; border: 1px solid transparent; color: var(--sx-tx1b); font-size: 12.5px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
.tt-seg button.on { color: var(--sx-hi); background: color-mix(in srgb, var(--sx-cy) 22%, var(--sx-ui2)); border-color: color-mix(in srgb, var(--sx-cy) 50%, transparent); }
.tt-steps { display: flex; flex-direction: column; gap: 4px; }
.tt-step { display: grid; grid-template-columns: 20px 18px minmax(0, 1fr) auto 64px auto; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 9px; background: var(--sx-bg2); font-size: 13px; border: 1px solid transparent; }
.tt-step > .tt-ic { color: var(--c, var(--sx-tx1b)); }
.tt-step:focus { border-color: color-mix(in srgb, var(--sx-cy) 55%, transparent); }
.tt-num { width: 20px; height: 20px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: var(--sx-ui2); color: var(--sx-tx1b); font-size: 11px; font-variant-numeric: tabular-nums; }
.tt-qacts { display: flex; gap: 2px; }
.tt-addrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tt-menu { margin-top: 6px; padding: 8px; display: flex; flex-direction: column; gap: 2px; background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px);
  border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-radius: 12px; box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k))); }
.tt-mh { font-size: 11px; color: var(--sx-tx2); padding: 6px 8px 2px; letter-spacing: .02em; }
.tt-mi { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 8px; background: none; border: 0; color: var(--sx-tx); font-size: 13px; text-align: left; cursor: pointer; width: 100%; }
.tt-mi:hover, .tt-mi:focus-visible { background: var(--sx-ui2); color: var(--sx-hi); outline: none; }
.tt-mi .tt-ic { color: var(--c, var(--sx-tx1b)); }
.tt-mi span { color: var(--sx-tx2); font-size: 12px; margin-left: auto; white-space: nowrap; }
.tt-mnote { margin: 6px 4px 2px; padding: 8px 10px; border-radius: 9px; background: var(--sx-bg2); font-size: 12px; color: var(--sx-tx2); line-height: 1.45; }
.tt-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.tt-opt { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
  cursor: pointer; text-align: left; color: var(--sx-tx1b); font-size: 12.5px; line-height: 1.45; }
.tt-opt b { color: var(--sx-hi); font-size: 13.5px; display: inline-flex; align-items: center; gap: 7px; }
.tt-opt.on { background: color-mix(in srgb, var(--sx-cy) 14%, var(--sx-ui)); border-color: color-mix(in srgb, var(--sx-cy) 55%, transparent); }
.tt-radio { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--sx-tx2); flex: none; display: inline-block; }
.tt-opt.on .tt-radio { border-color: var(--sx-cy); box-shadow: inset 0 0 0 3px var(--sx-ui), inset 0 0 0 7px var(--sx-cy); }
.tt-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--sx-ui2); }

/* task viewer */
.tt-run { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.tt-runh { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tt-runh b { color: var(--sx-hi); font-size: 15px; }
.tt-runm { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--sx-tx2); align-items: center; }
.tt-runm b { color: var(--sx-tx1b); font-weight: 500; font-variant-numeric: tabular-nums; }
.tt-qrow { display: grid; grid-template-columns: 20px 18px minmax(0, 1fr) auto 70px auto; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 9px; background: var(--sx-bg2); font-size: 13px; }
.tt-qrow > .tt-ic { color: var(--c, var(--sx-tx1b)); }
.tt-tablebox { overflow-x: auto; border-radius: 10px; }
.tt-table { width: 100%; border-collapse: separate; border-spacing: 0 3px; font-size: 13px; min-width: 720px; color: var(--sx-tx1b); }
.tt-table th { text-align: left; font-size: 11px; font-weight: 500; color: var(--sx-tx2); padding: 2px 10px; letter-spacing: .02em; border: 0; }
.tt-table td { background: var(--sx-bg2); padding: 7px 10px; white-space: nowrap; border: 0; vertical-align: middle; }
.tt-table td:first-child { border-radius: 9px 0 0 9px; }
.tt-table td:last-child { border-radius: 0 9px 9px 0; }
.tt-table td.n { color: var(--sx-hi); }
.tt-table td.t { font-variant-numeric: tabular-nums; }
.tt-table td.tt-wrap { white-space: normal; color: var(--sx-tx2); min-width: 160px; }
.tt-res { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; }
.tt-res .tt-ic { width: 13px; height: 13px; }
.tt-res.ok { color: var(--sx-gr-tx); } .tt-res.fail { color: var(--sx-re-tx); } .tt-res.stop { color: var(--sx-ye-tx); }
.tt-src { display: inline-flex; align-items: center; gap: 5px; color: var(--sx-tx2); font-size: 12.5px; white-space: nowrap; }
.tt-src .tt-ic { width: 13px; height: 13px; color: var(--c, var(--sx-tx2)); }
.tt-act { display: flex; flex-direction: column; gap: 9px; }
.tt-ar { display: grid; grid-template-columns: 112px minmax(0, 1fr) 56px; gap: 8px; align-items: center; font-size: 12.5px; }
.tt-ar span { color: var(--sx-tx1b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tt-ar em { font-style: normal; color: var(--sx-tx2); text-align: right; font-variant-numeric: tabular-nums; }
.tt-at { height: 8px; border-radius: 4px; background: var(--sx-bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,calc(.6*var(--sx-k))); overflow: hidden; display: flex; }
.tt-at i { display: block; height: 100%; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }

/* the script sheet */
.tt-code { margin: 0; padding: 12px 14px; border-radius: 10px; background: var(--sx-line2); border: 1px solid var(--sx-deep); border-bottom-color: var(--sx-ui2);
  box-shadow: inset 0 2px 5px rgba(0,0,0,calc(.5*var(--sx-k))); font: 12px/1.55 ui-monospace, Consolas, monospace; color: var(--sx-tx); white-space: pre; overflow: auto; max-height: 360px; }
.tt-ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--sx-tx1b); }
.tt-ol li { display: flex; gap: 10px; align-items: flex-start; line-height: 1.5; }
.tt-ol li > b { width: 20px; height: 20px; border-radius: 6px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--sx-gr) 35%, var(--sx-ui2)); color: var(--sx-hi); font-size: 11px; margin-top: 1px; }
.tt-ol code { font: 12px ui-monospace, Consolas, monospace; color: var(--sx-hi); background: var(--sx-bg2); border: 1px solid var(--sx-ui3); border-radius: 4px; padding: 0 5px; word-break: break-all; }
.tt-heard { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; font-size: 12.5px; color: var(--sx-gr-tx);
  background: color-mix(in srgb, var(--sx-gr) 10%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-gr) 45%, transparent); }
.tt-heard.bad { color: var(--sx-ye-tx); background: color-mix(in srgb, var(--sx-ye) 8%, var(--sx-bg2)); border-color: color-mix(in srgb, var(--sx-ye) 45%, transparent); }
.tt-heard.quiet { color: var(--sx-tx1b); background: var(--sx-bg2); border-color: var(--sx-ui3); }
.tt-sched { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 7px 10px; border-radius: 9px; font-size: 12.5px; line-height: 1.4; margin: 6px 0 8px;
  color: var(--sx-gr-tx); background: color-mix(in srgb, var(--sx-gr) 8%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-gr) 40%, transparent); }
.tt-sched.bad { color: var(--sx-ye-tx); background: color-mix(in srgb, var(--sx-ye) 7%, var(--sx-bg2)); border-color: color-mix(in srgb, var(--sx-ye) 40%, transparent); }
.tt-sched em { display: block; font-style: normal; color: var(--sx-tx1b); }
.tt-sched .tt-ic { flex: none; }
.tt-sched > .tt-grow { min-width: 0; flex: 1 1 220px; }
.tt-sched .tt-link { white-space: normal; text-align: left; }
.tt-key { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 9px; font-size: 12.5px; color: var(--sx-tx1b); line-height: 1.45;
  background: color-mix(in srgb, var(--sx-ye) 6%, var(--sx-bg2)); border: 1px solid color-mix(in srgb, var(--sx-ye) 35%, transparent); }
.tt-key .tt-ic { color: var(--sx-ye); margin-top: 2px; }

/* the top-bar entry: Stash's own nav button, a small badge for the job */
.tt-nav .tt-navjob { display: inline-block; min-width: 18px; margin-left: 5px; padding: 0 5px; border-radius: 6px; font-size: 11px; font-weight: 700; line-height: 17px;
  text-align: center; vertical-align: middle; font-variant-numeric: tabular-nums; }
.tt-nav .tt-navjob:empty { display: none; }
.tt .tt-yourh { margin: 4px 0 0; font-size: 15px; font-weight: 600; color: var(--sx-hi); }
.tt .tt-recfold > summary { cursor: pointer; padding: 8px 2px; color: var(--sx-tx2); font-size: 13px; }
.tt .tt-recfold > summary:hover { color: var(--sx-hi); }
.tt-nav .tt-navjob[data-k="run"] { background: color-mix(in srgb, var(--sx-cy) 22%, transparent); color: var(--sx-cy-tx); border: 1px solid color-mix(in srgb, var(--sx-cy) 55%, transparent); }
.tt-nav .tt-navjob[data-k="wait"] { background: var(--sx-ui2); color: var(--sx-tx1b); border: 1px solid var(--sx-ui3); }
.tt-nav .tt-navjob[data-k="miss"] { background: var(--sx-ye); color: var(--sx-on); }
@media (min-width: 1200px) { .tt-nav .nav-menu-icon { margin-right: .4em; } }
/* 0.2.0: the icon button beside Statistics. 0.6.1: the percentage beside the icon, plain text (no badge on its corner) */
.tt-navr .tt-navbtn { position: relative; gap: 6px; }
.tt-navr .tt-navico { width: 1.1em; height: 1.1em; display: block; flex: none; }
.tt-navr .tt-navjob { margin: 0; min-width: 0; padding: 0; border: 0 !important; background: none !important; font-size: 12px; line-height: 1; pointer-events: none; }
.tt-navr .tt-navjob[data-k="run"] { color: var(--sx-cy-tx); }
.tt-navr .tt-navjob[data-k="miss"] { color: var(--sx-ye-tx); }
/* 0.6.0: Autopilot's switch beside the Tasks button; green on, cyan while a task runs, yellow when the scheduler is not there */
.tt-apsw { display: inline-flex; align-items: center; gap: 6px; align-self: center; height: 26px; margin: 0 10px 0 4px; padding: 0 9px 0 6px; border-radius: 13px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .02em; line-height: 1; cursor: pointer; white-space: nowrap;
  color: var(--sx-tx2); background: var(--sx-bg2); border: 1px solid var(--sx-ui3); }
.tt-apsw:hover { color: var(--sx-hi); border-color: var(--sx-tx3, var(--sx-ui3)); }
.tt-apsw:focus-visible { outline: 2px solid var(--sx-bl); outline-offset: 2px; }
.tt-apsw i { position: relative; flex: none; width: 22px; height: 13px; border-radius: 7px; background: var(--sx-ui3); }
.tt-apsw i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--sx-tx2); transition: left .15s; }
.tt-apsw[aria-checked="true"] { color: var(--sx-gr-tx); border-color: color-mix(in srgb, var(--sx-gr) 55%, transparent); background: color-mix(in srgb, var(--sx-gr) 10%, var(--sx-bg2)); }
.tt-apsw[aria-checked="true"] i { background: var(--sx-gr); }
.tt-apsw[aria-checked="true"] i::after { left: 11px; background: var(--sx-paper); }
.tt-apsw[data-k="run"] { color: var(--sx-cy-tx); border-color: color-mix(in srgb, var(--sx-cy) 55%, transparent); background: color-mix(in srgb, var(--sx-cy) 10%, var(--sx-bg2)); }
.tt-apsw[data-k="run"] i { background: var(--sx-cy); }
.tt-apsw[data-k="run"] i::after { animation: tt-appulse 1.6s ease-in-out infinite; }
.tt-apsw[data-k="nosched"] { color: var(--sx-ye-tx); border-color: color-mix(in srgb, var(--sx-ye) 55%, transparent); }
.tt-apsw[data-k="nosched"] i { background: var(--sx-ye); }
@keyframes tt-appulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .tt-apsw[data-k="run"] i::after { animation: none; } }
.tt-navm .tt-apsw { margin: 6px auto 0; }
/* the card on the Overview */
.tt-ap { padding: 12px 14px; border-left: 3px solid var(--sx-ui3); }
.tt-ap[data-k="on"] { border-left-color: var(--sx-gr); }
.tt-ap[data-k="run"] { border-left-color: var(--sx-cy); }
.tt-ap[data-k="nosched"] { border-left-color: var(--sx-ye); }
.tt-aph { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tt-apbig { font-weight: 600; padding: 6px 12px; }
.tt-apbig .tt-ic { color: var(--sx-or); }
.tt-apbig.on i { background: var(--sx-gr); }
.tt-apline { min-width: 0; flex: 1 1 260px; color: var(--sx-tx1b); font-size: 13.5px; line-height: 1.45; }
.tt-apbody { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.tt-aptree { display: flex; flex-direction: column; gap: 4px; }
.tt-apr { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--sx-bg2); border: 1px solid var(--sx-deep); font-size: 13px; min-width: 0; }
.tt-apr > .tt-ic { color: var(--c); flex: none; }
.tt-apr > b { flex: none; font-weight: 600; color: var(--sx-hi); white-space: nowrap; }
.tt-apr > .tt-muted { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
.tt-apr.off { opacity: .55; }
.tt-apr.cur { border-color: color-mix(in srgb, var(--sx-cy) 60%, transparent); background: color-mix(in srgb, var(--sx-cy) 8%, var(--sx-bg2)); }
.tt-apr .tt-apt { display: flex; gap: 10px; flex: none; margin-left: auto; }
.tt-apr .tt-apw, .tt-apr .tt-apn { font-size: 12px; color: var(--sx-tx2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tt-apr .tt-apn { min-width: 108px; text-align: right; color: var(--sx-tx1b); }
.tt-apset { display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 575.98px) {
  .tt-apr { flex-wrap: wrap; }
  .tt-apr > .tt-muted, .tt-apr > .tt-grow { display: none; }
  .tt-apr .tt-apn { min-width: 0; }
  .tt-apsw span { display: none; }
  .tt-apsw { padding: 0 5px; margin: 0 4px 0 0; }
}

/* the toast (the suite's one design) */
#tt-toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 10px;
  max-width: min(420px, calc(100vw - 24px)); padding: 9px 14px; color: var(--sx-tx); font-size: 13.5px; line-height: 1.4; text-align: left;
  background: linear-gradient(180deg, var(--sx-raise) 0, var(--sx-ui) 64px); border: 1px solid var(--sx-line); border-top-color: var(--sx-edge); border-left: 3px solid var(--tk, var(--sx-bl));
  border-radius: 12px; box-shadow: 0 1px 0 rgba(0,0,0,calc(.7*var(--sx-k))), 0 20px 50px -12px rgba(0,0,0,calc(.75*var(--sx-k))); }
#tt-toast[hidden] { display: none; }
#tt-toast.tt-t-done { --tk: var(--sx-gr); } #tt-toast.tt-t-warn { --tk: var(--sx-ye); } #tt-toast.tt-t-error { --tk: var(--sx-re); }
#tt-toast .tt-link { flex: none; font-size: 13px; background: none; border: 0; color: var(--sx-bl); cursor: pointer; padding: 0; }

/* tablets: the side column under the main one */
@media (max-width: 991.98px) { .tt-side { max-width: none; flex-basis: 100%; } .tt-rgrid { grid-template-columns: minmax(0, 1fr); } }
/* phones (Bootstrap's sm): the slab edge to edge with 12px sides; the tabs a
   grid of three; a row's pills and time under its title; Too long and Needs
   a look folded; no key hints */
@media (max-width: 575.98px) {
  .tt { margin: 0 0 24px; padding: 12px; border-radius: 0; border-left: 0; border-right: 0; }
  .tt kbd { display: none; }
  .tt-tabs { margin-left: 0; width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tt-tab { justify-content: center; padding: 8px 6px; font-size: 13px; }
  .tt-read { margin-left: auto; }
  .tt-hero { padding: 14px; gap: 10px; }
  .tt-hero .tt-btn.tt-big { width: 100%; justify-content: center; min-height: 48px; flex-wrap: wrap; }
  .tt-flow > span:not(.tt-fs), .tt-flow > .tt-grow { display: none; }
  .tt-row, .tt-row.long, .tt-row.look { grid-template-columns: 20px 18px minmax(0, 1fr); align-items: start; padding: 10px; }
  .tt-row.long, .tt-row.look { grid-template-columns: 18px minmax(0, 1fr) auto; }
  .tt-row > .tt-ic { margin-top: 2px; }
  .tt-row .tt-what > span { display: none; }
  .tt-row .tt-pm { display: flex; }
  .tt-row > .tt-pills, .tt-row > .tt-est, .tt-row > .tt-ib { display: none; }
  .tt-fold { display: flex; }
  .tt-sec { display: none; }
  .tt-sec.open { display: block; }
  .tt-sec .tt-sh { display: none; }
  .tt-qrow, .tt-qrow.held { grid-template-columns: 20px 18px minmax(0, 1fr) auto; }
  .tt-qrow > .tt-src, .tt-qrow > .tt-est { display: none; }
  .tt-two { grid-template-columns: minmax(0, 1fr); }
  .tt-step { grid-template-columns: 20px 18px minmax(0, 1fr) auto; }
  .tt-step > .tt-pill, .tt-step > .tt-est { display: none; }
  .tt.tt-veil { padding: 0; }
  .tt-sheet, .tt-sheet.tt-wide { width: 100%; border-radius: 0; min-height: 100%; }
  .tt-rgrid { grid-template-columns: minmax(0, 1fr); }
  .tt-rc { padding: 12px; }
}
`;
    document.head.appendChild(s);
  }
})();
