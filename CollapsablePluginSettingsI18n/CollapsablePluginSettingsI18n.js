/**
 * Collapsable Plugin Settings - Stash UI plugin (bilingual 中文/EN fork)
 *
 * Makes the plugin groups in Settings -> Plugins and Settings -> Tasks ->
 * Plugin Tasks collapsible, searchable and sortable; the toolbar is
 * right-aligned at the height of the section heading and the optional slider
 * replaces Stash's Enable/Disable buttons.
 *
 * This is a localization fork: the functional logic follows the upstream
 * plugin by Jacksyy420 (https://github.com/Jacksyy420/Stash-Plugins).
 */
(function () {
  "use strict";
  if (window.__CollapsablePluginSettingsI18nLoaded) return;
  window.__CollapsablePluginSettingsI18nLoaded = true;

  // ==================== i18n ====================
  var PLUGIN_VERSION = '0.10.1-3';
  var _intlLocale = '';
  function tc(zh, en) {
    if (_intlLocale.indexOf('zh') === 0) return zh;
    return en;
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
      console.warn('[CollapsablePluginSettingsI18n] i18n bridge failed:', e);
    }
  })();
  console.log('[CollapsablePluginSettingsI18n] Collapsable Plugin Settings I18n v' + PLUGIN_VERSION + ' loaded');

  const PLUGIN_ID = "CollapsablePluginSettingsI18n"; // = file name of the YAML without extension
  const STORAGE_KEY = "cspI18n_collapsedGroups";
  const SORT_KEY = "cspI18n_sortMode";
  const SORT_MODES = ["default", "asc", "desc", "enabled", "disabled"];

  // Adjust here if the DOM of your Stash version differs
  const SELECTORS = {
    pane: "#configuration-tabs-tabpane-plugins", // Settings -> "Plugins" tab
    group: ".setting-group",                      // one plugin group
  };

  // Settings -> "Tasks" tab -> "Plugin Tasks" section
  const TASKS = {
    pane: "#configuration-tabs-tabpane-tasks",
    // Heading of the section (lower case); add the text of your UI language if needed
    headings: ["plugin tasks", "plugin-tasks", "plugin-aufgaben", "plugin aufgaben", "插件任务"],
    prefix: "tasks:", // keeps identical plugin names in both tabs apart in storage
  };

  // "collapsed" | "expanded" | "remember"
  let mode = "remember";
  // Slider instead of the Enable/Disable buttons (Settings -> Plugins)
  const DEFAULT_COLORS = { enabled: "#FFD700", disabled: "#dc3545" }; // gold / red
  let switchOn = false;
  const ready = {}; // Scope-ID -> { container, promise }
  let lastActiveId = null;
  let toolbar = null;
  let searchInput = null;
  let countEl = null;
  let toolbarSelect = null; // the toolbar's <select>, kept for the label refresh
  let sortOptionEls = [];   // its <option> elements, in SORT_MODES order
  let collapseAllBtn = null;
  let expandAllBtn = null;
  let currentScope = null; // scope the toolbar is currently aligned to
  let rafId = 0;
  let settleUntil = 0;
  let query = ""; // current search term (not stored)
  let sortMode = "default"; // "default" | "asc" | "desc" | "enabled" | "disabled" (stored)
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (SORT_MODES.includes(saved)) sortMode = saved;
  } catch {}
  // State of the current visit (for the modes collapsed/expanded)
  const sessionState = {};
  const lastNativeClick = new WeakMap();

  function normalizeMode(value) {
    const v = String(value || "").trim().toLowerCase();
    // The German aliases are kept for settings saved by earlier versions
    if (["collapsed", "collapse", "eingeklappt", "einklappen"].includes(v)) return "collapsed";
    if (["expanded", "expand", "ausgeklappt", "ausklappen"].includes(v)) return "expanded";
    return "remember";
  }

  // Accepts any CSS color ("#FFD700", "gold", "rgb(...)"); otherwise the default is used
  function validColor(value, fallback) {
    const c = String(value == null ? "" : value).trim();
    if (!c) return fallback;
    try {
      if (typeof CSS !== "undefined" && CSS.supports) {
        return CSS.supports("color", c) ? c : fallback;
      }
    } catch {}
    return /^[#\w(),.%\s-]+$/.test(c) ? c : fallback;
  }

  function applySliderSettings(cfg) {
    const on = cfg && cfg.enableSlider;
    switchOn = on === true || String(on).toLowerCase() === "true";
    const root = document.documentElement;
    root.style.setProperty("--csp-on", validColor(cfg && cfg.sliderColorEnabled, DEFAULT_COLORS.enabled));
    root.style.setProperty("--csp-off", validColor(cfg && cfg.sliderColorDisabled, DEFAULT_COLORS.disabled));
  }

  // Reads the settings of this plugin (Settings -> Plugins -> this plugin)
  async function loadSettings() {
    let cfg = null;
    try {
      // A plain string URL on purpose: plugins that wrap window.fetch (e.g.
      // Shinobi-Api) call url.includes(...) on the first argument and throw a
      // TypeError on a URL object, which made every settings read fail.
      const graphqlUrl = new URL("graphql", document.baseURI).href;
      const res = await fetch(graphqlUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { configuration { plugins } }" }),
      });
      const json = await res.json();
      const all = json && json.data && json.data.configuration.plugins;
      cfg = (all && all[PLUGIN_ID]) || {};
    } catch {
      cfg = null;
    }
    mode = normalizeMode(cfg && cfg.defaultState);
    applySliderSettings(cfg);
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }

  // Name of a group = text of its header (e.g. the plugin name)
  function groupKey(header) {
    const title = header.querySelector("h3, h4, h2, .setting-heading") || header;
    return (title.textContent || "").trim().split("\n")[0];
  }

  function nameOf(group) {
    return groupKey(group.firstElementChild || group);
  }

  function isCollapsed(key) {
    if (key in sessionState) return sessionState[key];
    if (mode === "remember") return !!loadState()[key];
    return mode === "collapsed";
  }

  function setCollapsed(key, collapsed) {
    sessionState[key] = collapsed;
    if (mode === "remember") {
      const s = loadState();
      if (collapsed) s[key] = true;
      else delete s[key];
      saveState(s);
    }
  }

  function clearSession(sc) {
    Object.keys(sessionState).forEach((k) => {
      if (k.startsWith(TASKS.prefix) === sc.native) delete sessionState[k];
    });
  }

  // ---- Bereiche (Scopes) -------------------------------------------------

  // Heading that is exactly "Plugins" (not "Installed Plugins"). It may sit inside
  // or just above the tab content, so the surrounding area is searched.
  // Fallback: first heading outside of a plugin group.
  const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, .setting-heading";

  // Heading of the Plugins tab (lower case); add the text of your UI language if needed
  const PANE_HEADINGS = ["plugins", "插件"];

  function findHeading(pane) {
    const scope =
      (pane.closest(".tab-content") && pane.closest(".tab-content").parentElement) ||
      pane.parentElement ||
      document;
    const all = Array.from(scope.querySelectorAll(HEADING_SELECTOR)).filter(
      (h) => !h.closest("[data-csp-key]")
    );
    const exact = all.find(
      (h) => h.offsetParent !== null && PANE_HEADINGS.includes((h.textContent || "").trim().toLowerCase())
    );
    return exact || all.find((h) => pane.contains(h)) || null;
  }

  function resolveScopes() {
    if (!location.pathname.startsWith("/settings")) return [];
    const out = [];

    const pluginsPane = document.querySelector(SELECTORS.pane);
    if (pluginsPane) {
      out.push({
        id: "plugins",
        native: false, // own collapse mechanism
        prefix: "",
        pane: pluginsPane,
        container: pluginsPane,
        heading: findHeading(pluginsPane),
        groups: Array.from(pluginsPane.querySelectorAll(SELECTORS.group)),
      });
    }

    const tasksPane = document.querySelector(TASKS.pane);
    if (tasksPane) {
      const h1Of = (sec) => Array.from(sec.children).find((c) => c.tagName === "H1");
      const section = Array.from(tasksPane.querySelectorAll(".setting-section")).find((sec) => {
        const h = h1Of(sec);
        return h && TASKS.headings.includes((h.textContent || "").trim().toLowerCase());
      });
      if (section) {
        out.push({
          id: "tasks",
          native: true, // Stash collapses these groups itself -> operate its button
          prefix: TASKS.prefix,
          pane: tasksPane,
          container: section,
          heading: h1Of(section),
          groups: Array.from(section.querySelectorAll(SELECTORS.group)),
        });
      }
    }
    return out;
  }

  function pickActive(scopes) {
    return (
      scopes.find((sc) => sc.pane.offsetParent !== null && sc.groups.some((g) => g.dataset.cspKey)) ||
      null
    );
  }

  function getActiveScope() {
    return pickActive(resolveScopes());
  }

  // ---- Collapsing --------------------------------------------------------

  // Stash-native groups (Plugin Tasks): read the state from the collapse container
  // (class "show") and click Stash's arrow button when needed.
  function setNativeCollapsed(group, collapsed) {
    const wrap = group.children[1];
    const btn = group.querySelector(".setting-group-collapse-button");
    if (!wrap || !btn) return;
    const open = wrap.classList.contains("show");
    if (collapsed !== open) return; // already in the desired state
    const last = lastNativeClick.get(group) || 0;
    if (Date.now() - last < 400) return; // animation still running
    lastNativeClick.set(group, Date.now());
    btn.click();
  }

  // Only data attributes are set, class/children are never modified:
  // React overwrites className on every re-render (e.g. when enabling or
  // disabling a plugin), data attributes are left untouched.
  function enhanceGroup(group, sc) {
    const header = group.firstElementChild;
    if (!header || group.children.length < 2) return; // nothing to collapse

    const key = sc.prefix + groupKey(header);
    const ok = sc.native
      ? group.hasAttribute("data-csp-native")
      : header.hasAttribute("data-csp-header");
    if (group.dataset.cspKey === key && ok) return;

    group.dataset.cspKey = key;
    const collapsed = isCollapsed(key);
    if (sc.native) {
      group.setAttribute("data-csp-native", "");
      setNativeCollapsed(group, collapsed);
    } else {
      header.setAttribute("data-csp-header", "");
      group.setAttribute("data-csp-collapsed", String(collapsed));
    }
  }

  // ---- Search and sorting ------------------------------------------------

  // Filters the groups by the search term (name, description, settings).
  // Only data attributes, so React is not disturbed.
  function applyFilter(sc, isActive) {
    const q = isActive ? query.trim().toLowerCase() : "";
    let shown = 0;
    sc.groups.forEach((g) => {
      const match = !q || (g.textContent || "").toLowerCase().includes(q);
      if (match) {
        shown++;
        if (g.hasAttribute("data-csp-hidden")) g.removeAttribute("data-csp-hidden");
      } else if (g.getAttribute("data-csp-hidden") !== "true") {
        g.setAttribute("data-csp-hidden", "true");
      }
    });
    if (isActive && countEl) {
      // Writing the same text again would itself create DOM mutations and keep
      // the mutation observer busy, so it is only written when it changed.
      const text = q ? shown + " / " + sc.groups.length : "";
      if (countEl.textContent !== text) countEl.textContent = text;
    }
  }

  function isDisabled(group) {
    const header = group.firstElementChild;
    return !!header && header.classList.contains("disabled");
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  // The Enable/Disable button is the last button in the header of a plugin,
  // not counting Stash's collapse arrow (a "Reload UI" button may precede it).
  function findEnableButton(group) {
    const header = group.firstElementChild;
    if (!header) return null;
    const buttons = Array.from(header.querySelectorAll("button")).filter(
      (b) => !b.classList.contains("setting-group-collapse-button")
    );
    return buttons.length ? buttons[buttons.length - 1] : null;
  }

  // The real button stays in place and keeps Stash's click handler. It is only
  // marked with attributes and restyled as a slider by the CSS, so React is not
  // disturbed. The state is read from the class "disabled" Stash sets on the header.
  function applySwitch(group) {
    const header = group.firstElementChild;
    if (!header) return;
    const target = switchOn ? findEnableButton(group) : null;
    header.querySelectorAll("[data-csp-switch]").forEach((b) => {
      if (b !== target) {
        ["data-csp-switch", "data-csp-state", "role", "aria-checked"].forEach((n) => b.removeAttribute(n));
      }
    });
    if (!target) return;
    const on = !isDisabled(group);
    setAttr(target, "data-csp-switch", "");
    setAttr(target, "data-csp-state", on ? "on" : "off");
    setAttr(target, "role", "switch");
    setAttr(target, "aria-checked", String(on));
  }

  // Sorting purely via CSS "order" (flex container): DOM nodes are not moved,
  // so React stays untouched. Non-plugin elements in the same container keep
  // their original position; the groups only swap places among themselves.
  function applySort(sc) {
    const byParent = new Map();
    sc.groups.forEach((g) => {
      const list = byParent.get(g.parentElement) || [];
      list.push(g);
      byParent.set(g.parentElement, list);
    });

    byParent.forEach((list, parent) => {
      const children = Array.from(parent.children);

      if (sortMode === "default") {
        if (parent.hasAttribute("data-csp-sorted")) parent.removeAttribute("data-csp-sorted");
        children.forEach((c) => {
          if (c.style.order) c.style.order = "";
        });
        return;
      }

      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const byName = (a, b) => collator.compare(nameOf(a), nameOf(b));
      let sorted;
      if (sortMode === "enabled" || sortMode === "disabled") {
        // Stash marks the header of a disabled plugin with the class "disabled".
        // Groups with the same state are ordered by name (A - Z).
        const rank = (g) => (isDisabled(g) === (sortMode === "disabled") ? 0 : 1);
        sorted = list.slice().sort((a, b) => rank(a) - rank(b) || byName(a, b));
      } else {
        sorted = list.slice().sort(byName);
        if (sortMode === "desc") sorted.reverse();
      }

      const slots = [];
      children.forEach((c, i) => {
        if (list.includes(c)) slots.push(i);
        else c.style.order = String(i);
      });
      sorted.forEach((g, j) => {
        g.style.order = String(slots[j]);
      });
      if (parent.getAttribute("data-csp-sorted") !== "true") {
        parent.setAttribute("data-csp-sorted", "true");
      }
    });
  }

  // ---- Klicks ------------------------------------------------------------

  // A single delegated click handler -> survives replaced DOM nodes
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    // Own mechanism ("Plugins" tab)
    const header = target.closest("[data-csp-header]");
    if (header) {
      // Do not intercept clicks on controls (e.g. Enable/Disable)
      if (target.closest("button, input, select, textarea, a, label")) return;
      const group = header.parentElement;
      if (!group || !group.dataset.cspKey) return;
      const collapsed = group.getAttribute("data-csp-collapsed") !== "true";
      group.setAttribute("data-csp-collapsed", String(collapsed));
      setCollapsed(group.dataset.cspKey, collapsed);
      return;
    }

    // Stash-native groups (Plugin Tasks): remember the result after the animation
    const ng = target.closest("[data-csp-native]");
    if (ng && ng.firstElementChild && ng.firstElementChild.contains(target)) {
      setTimeout(() => {
        const wrap = ng.children[1];
        if (wrap && ng.dataset.cspKey) {
          setCollapsed(ng.dataset.cspKey, !wrap.classList.contains("show"));
        }
      }, 500);
    }
  });

  // ---- Toolbar -----------------------------------------------------------

  // The toolbar is built once and reused, and it can be built before the locale
  // bridge has delivered the locale. Its labels are therefore read lazily and
  // re-applied whenever the toolbar is built and on every run() (refreshLabels).
  function toolbarLabels() {
    return {
      searchPlaceholder: tc("搜索插件…", "Search plugins…"),
      searchAria: tc("搜索插件", "Search plugins"),
      sortAria: tc("排序方式", "Sort by"),
      sortLabels: {
        default: tc("默认顺序", "Default order"),
        asc: tc("名称（A - Z）", "Name (A - Z)"),
        desc: tc("名称（Z - A）", "Name (Z - A)"),
        enabled: tc("已启用优先", "Enabled first"),
        disabled: tc("已禁用优先", "Disabled first"),
      },
      collapseAll: tc("全部折叠", "Collapse all"),
      expandAll: tc("全部展开", "Expand all"),
    };
  }

  function refreshLabels() {
    if (!toolbar || !document.body.contains(toolbar)) return;
    const t = toolbarLabels();
    if (searchInput) {
      if (searchInput.placeholder !== t.searchPlaceholder) searchInput.placeholder = t.searchPlaceholder;
      if (searchInput.getAttribute("aria-label") !== t.searchAria) {
        searchInput.setAttribute("aria-label", t.searchAria);
      }
    }
    if (toolbarSelect && toolbarSelect.getAttribute("aria-label") !== t.sortAria) {
      toolbarSelect.setAttribute("aria-label", t.sortAria);
    }
    SORT_MODES.forEach((sortKey, i) => {
      const o = sortOptionEls[i];
      if (o && o.textContent !== t.sortLabels[sortKey]) o.textContent = t.sortLabels[sortKey];
    });
    if (collapseAllBtn && collapseAllBtn.textContent !== t.collapseAll) {
      collapseAllBtn.textContent = t.collapseAll;
    }
    if (expandAllBtn && expandAllBtn.textContent !== t.expandAll) {
      expandAllBtn.textContent = t.expandAll;
    }
  }

  // The toolbar is attached to document.body (outside the React tree) so React
  // is not confused when it renders the plugin list.
  function ensureToolbar() {
    if (toolbar && document.body.contains(toolbar)) return toolbar;

    toolbar = document.createElement("div");
    toolbar.className = "csp-toolbar";

    const mk = (label, collapse) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-secondary btn-sm";
      b.textContent = label;
      b.addEventListener("click", () => {
        const sc = getActiveScope();
        if (!sc) return;
        sc.groups.forEach((g) => {
          const key = g.dataset.cspKey;
          if (!key) return;
          if (sc.native) setNativeCollapsed(g, collapse);
          else g.setAttribute("data-csp-collapsed", String(collapse));
          setCollapsed(key, collapse);
        });
      });
      return b;
    };

    const t = toolbarLabels();
    const input = document.createElement("input");
    searchInput = input;
    input.type = "search";
    input.className = "form-control form-control-sm csp-search";
    input.placeholder = t.searchPlaceholder;
    input.setAttribute("aria-label", t.searchAria);
    input.value = query;
    const onSearch = () => {
      query = input.value;
      const sc = getActiveScope();
      if (!sc) return;
      applyFilter(sc, true);
      positionToolbar(sc);
    };
    input.addEventListener("input", onSearch);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        onSearch();
      }
    });

    countEl = document.createElement("span");
    countEl.className = "csp-count";

    const sort = document.createElement("select");
    toolbarSelect = sort;
    sort.className = "form-control form-control-sm csp-sort";
    sort.setAttribute("aria-label", t.sortAria);
    sortOptionEls = SORT_MODES.map((value) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = t.sortLabels[value];
      sort.appendChild(o);
      return o;
    });
    sort.value = sortMode;
    sort.addEventListener("change", () => {
      sortMode = sort.value;
      try {
        localStorage.setItem(SORT_KEY, sortMode);
      } catch {}
      resolveScopes().forEach(applySort);
      const sc = getActiveScope();
      if (sc) positionToolbar(sc);
    });

    collapseAllBtn = mk(t.collapseAll, true);
    expandAllBtn = mk(t.expandAll, false);
    toolbar.append(input, countEl, sort, collapseAllBtn, expandAllBtn);
    document.body.appendChild(toolbar);
    refreshLabels(); // the locale may have arrived between two runs
    return toolbar;
  }

  // The toolbar stays outside the React tree and is placed by coordinates,
  // right-aligned at the height of the heading.
  function positionToolbar(sc) {
    if (!toolbar || toolbar.style.display === "none") return;
    const heading = sc.heading;

    let top, right;
    if (heading) {
      const hr = heading.getBoundingClientRect();
      const box = heading.parentElement || sc.pane;
      const br = box.getBoundingClientRect();
      const padRight = parseFloat(getComputedStyle(box).paddingRight) || 0;
      top = hr.top + hr.height / 2 - toolbar.offsetHeight / 2;
      right = br.right - padRight;
    } else {
      const first = sc.groups.find((g) => g.dataset.cspKey) || sc.groups[0];
      top = first.getBoundingClientRect().top - toolbar.offsetHeight - 8;
      const padRight = parseFloat(getComputedStyle(sc.pane).paddingRight) || 0;
      right = sc.pane.getBoundingClientRect().right - padRight;
    }

    const topPx = Math.round(top + window.scrollY) + "px";
    const leftPx = Math.round(Math.max(0, right - toolbar.offsetWidth + window.scrollX)) + "px";
    if (toolbar.style.top !== topPx) toolbar.style.top = topPx;
    if (toolbar.style.left !== leftPx) toolbar.style.left = leftPx;
  }

  // The heading moves when sections above it (e.g. "Generate") are collapsed or
  // expanded. That only changes classes/heights and triggers no DOM mutation.
  // Therefore the toolbar is re-aligned on every frame for a short time after
  // clicks, animations and resizes.
  function tick() {
    rafId = 0;
    if (currentScope && toolbar && toolbar.style.display !== "none") {
      positionToolbar(currentScope);
    }
    if (performance.now() < settleUntil) rafId = requestAnimationFrame(tick);
  }

  function kick(ms) {
    settleUntil = Math.max(settleUntil, performance.now() + (ms || 900));
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  // Dialogues are appended to <body> (outside the React root) as full-screen
  // overlays. Some of them live in a lower stacking context than the toolbar
  // (e.g. Ascension's .hon-modal uses z-index 1000, the toolbar uses 1030), so
  // the toolbar would float above the dialogue. It therefore steps aside while
  // such an overlay is open.
  function overlayOpen() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return Array.from(document.body.children).some((el) => {
      if (el === toolbar) return false;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width >= w * 0.9 && r.height >= h * 0.9;
    });
  }

  function updateToolbar(sc) {
    currentScope = sc;
    if (!sc || overlayOpen()) {
      if (toolbar) toolbar.style.display = "none";
      return;
    }
    ensureToolbar().style.display = "flex";
    positionToolbar(sc);
    kick();
  }

  // ---- Flow --------------------------------------------------------------

  async function run() {
    let scopes = resolveScopes();

    // Newly appeared sections: re-read the setting (in case it changed)
    Object.keys(ready).forEach((id) => {
      if (!scopes.some((sc) => sc.id === id)) delete ready[id];
    });
    scopes.forEach((sc) => {
      if (!ready[sc.id] || ready[sc.id].container !== sc.container) {
        ready[sc.id] = {
          container: sc.container,
          promise: loadSettings().then(() => clearSession(sc)),
        };
      }
    });
    await Promise.all(scopes.map((sc) => ready[sc.id].promise));

    scopes = resolveScopes(); // the DOM may have changed while waiting
    scopes.forEach((sc) => sc.groups.forEach((g) => enhanceGroup(g, sc)));
    scopes.forEach((sc) => {
      if (sc.id === "plugins") sc.groups.forEach(applySwitch);
    });

    const active = pickActive(scopes);
    const activeId = active ? active.id : null;
    if (activeId !== lastActiveId) {
      lastActiveId = activeId;
      query = ""; // reset the search term when switching tabs
      if (searchInput) searchInput.value = "";
    }

    scopes.forEach((sc) => {
      applyFilter(sc, sc === active);
      applySort(sc);
    });
    updateToolbar(active);
    refreshLabels();
  }

  // React renders dynamically -> watch the DOM.
  // The page mutates continuously (other plugins re-render all the time), so a
  // plain debounce would be reset over and over and could never fire - which
  // left the toolbar and the collapsing dead for the whole session. The next
  // run is therefore only scheduled once and is guaranteed to happen.
  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 100);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"], // Stash toggles "disabled" when a plugin is enabled/disabled
  });

  if (window.PluginApi && PluginApi.Event) {
    PluginApi.Event.addEventListener("stash:location", () => setTimeout(run, 50));
  }

  // The settings of this plugin are edited on the same page. After a change they
  // are read again, so the slider and its colors update without a page reload.
  let settingsTimers = [];
  function scheduleSettingsRefresh() {
    settingsTimers.forEach(clearTimeout);
    settingsTimers = [1200, 3500].map((ms) =>
      setTimeout(async () => {
        await loadSettings();
        run();
      }, ms)
    );
  }
  ["change", "focusout"].forEach((type) =>
    document.addEventListener(
      type,
      (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('[id^="plugin-' + PLUGIN_ID + '-"]')) scheduleSettingsRefresh();
      },
      true
    )
  );

  window.addEventListener("resize", () => kick());
  document.addEventListener("click", () => kick(), true);
  document.addEventListener("transitionend", () => kick(300), true);
  document.addEventListener("animationend", () => kick(300), true);

  run();
})();
