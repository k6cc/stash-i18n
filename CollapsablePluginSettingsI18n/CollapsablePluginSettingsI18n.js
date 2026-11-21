/**
 * Collapsable Plugin Settings - Stash UI plugin (bilingual 中文/EN fork)
 *
 * Adds Collapse all / Expand all, a default state and sorting to the plugin
 * groups in Settings -> Plugins and Settings -> Tasks -> Plugin Tasks; it
 * operates Stash's own arrow buttons and the optional slider replaces Stash's
 * Enable/Disable buttons.
 *
 * This is a localization fork: the functional logic follows the upstream
 * plugin by Jacksyy420 (https://github.com/Jacksyy420/Stash-Plugins).
 */
(function () {
  "use strict";
  if (window.__CollapsablePluginSettingsI18nLoaded) return;
  window.__CollapsablePluginSettingsI18nLoaded = true;

  // ==================== i18n ====================
  var PLUGIN_VERSION = '0.11.3-1';
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
  let switchOn = true;
  const ready = {}; // Scope-ID -> { container, promise }
  let toolbar = null;
  let toolbarSelect = null; // the toolbar's <select>, kept for the label refresh
  let sortOptionEls = [];   // its <option> elements, in SORT_MODES order
  let collapseAllBtn = null;
  let expandAllBtn = null;
  let currentScope = null; // scope the toolbar is currently aligned to
  let rafId = 0;
  let settleUntil = 0;
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
    // On by default: only an explicit "off" in the plugin settings turns the slider off.
    const on = cfg && cfg.enableSlider;
    switchOn = on === undefined || on === null || on === true || String(on).toLowerCase() === "true";
    const root = document.documentElement;
    root.style.setProperty("--csp-on", validColor(cfg && cfg.sliderColorEnabled, DEFAULT_COLORS.enabled));
    root.style.setProperty("--csp-off", validColor(cfg && cfg.sliderColorDisabled, DEFAULT_COLORS.disabled));
  }

  // Reads the settings of this plugin (Settings -> Plugins -> this plugin)
  async function loadSettings() {
    let cfg = null;
    try {
      // Pass a plain string: other plugins wrap window.fetch and expect args[0] to be a string
      const graphqlUrl = new URL("graphql", document.baseURI).href;
      const res = await fetch(graphqlUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { configuration { plugins } }" }),
      });
      const json = await res.json();
      if (json && json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
      const all = json && json.data && json.data.configuration.plugins;
      cfg = (all && all[PLUGIN_ID]) || {};
    } catch (err) {
      console.warn("[CollapsablePluginSettingsI18n] Could not read the plugin settings:", err);
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

  // true = collapsed, false = expanded, undefined = no preference (keep Stash's own default)
  function isCollapsed(key) {
    if (key in sessionState) return sessionState[key];
    if (mode === "remember") {
      const saved = loadState()[key];
      return typeof saved === "boolean" ? saved : undefined;
    }
    return mode === "collapsed";
  }

  function setCollapsed(key, collapsed) {
    sessionState[key] = collapsed;
    if (mode === "remember") {
      const s = loadState();
      s[key] = collapsed;
      saveState(s);
    }
  }

  function clearSession(sc) {
    Object.keys(sessionState).forEach((k) => {
      if (k.startsWith(TASKS.prefix) === (sc.id === "tasks")) delete sessionState[k];
    });
  }

  // ---- Scopes ------------------------------------------------------------

  const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, .setting-heading";

  // Heading of the Plugins tab (lower case); only a fallback for the structural lookup
  const PANE_HEADINGS = ["plugins", "插件"];

  const h1Of = (sec) => Array.from(sec.children).find((c) => c.tagName === "H1") || null;

  // Heading of the plugin list in the Plugins tab. Found by structure, so it works in every
  // UI language: the last section that contains plugin groups (the sections "Installed Plugins"
  // and "Available Plugins" come before it). Fallback: heading text, then the first heading.
  function findHeading(pane) {
    const sections = Array.from(pane.querySelectorAll(".setting-section")).filter((sec) =>
      sec.querySelector(SELECTORS.group)
    );
    const h = sections.length ? h1Of(sections[sections.length - 1]) : null;
    if (h) return h;

    const scope =
      (pane.closest(".tab-content") && pane.closest(".tab-content").parentElement) ||
      pane.parentElement ||
      document;
    const all = Array.from(scope.querySelectorAll(HEADING_SELECTOR)).filter(
      (el) => !el.closest("[data-csp-key]")
    );
    const exact = all.find(
      (el) => el.offsetParent !== null && PANE_HEADINGS.includes((el.textContent || "").trim().toLowerCase())
    );
    return exact || all.find((el) => pane.contains(el)) || null;
  }

  // The section "Plugin Tasks" in the Tasks tab. Found by structure, so it works in every UI
  // language: Stash renders it as the last block of ".tasks-panel-tasks", after the last <hr>
  // (and not at all when no enabled plugin has tasks). Fallback: heading text.
  function findPluginTasksSection(tasksPane) {
    const list = tasksPane.querySelector(".tasks-panel-tasks");
    if (list) {
      const hrs = Array.from(list.children).filter((c) => c.tagName === "HR");
      const last = hrs[hrs.length - 1];
      const next = last && last.nextElementSibling;
      const sec = next && (next.matches(".setting-section") ? next : next.querySelector(".setting-section"));
      if (sec && sec.querySelector(SELECTORS.group)) return sec;
    }
    return (
      Array.from(tasksPane.querySelectorAll(".setting-section")).find((sec) => {
        const h = h1Of(sec);
        return h && TASKS.headings.includes((h.textContent || "").trim().toLowerCase());
      }) || null
    );
  }

  function resolveScopes() {
    if (!location.pathname.startsWith("/settings")) return [];
    const out = [];

    const pluginsPane = document.querySelector(SELECTORS.pane);
    if (pluginsPane) {
      out.push({
        id: "plugins",
        prefix: "",
        pane: pluginsPane,
        container: pluginsPane,
        heading: findHeading(pluginsPane),
        groups: Array.from(pluginsPane.querySelectorAll(SELECTORS.group)),
      });
    }

    const tasksPane = document.querySelector(TASKS.pane);
    if (tasksPane) {
      const section = findPluginTasksSection(tasksPane);
      if (section) {
        out.push({
          id: "tasks",
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

  // Stash collapses and expands the plugin groups itself (arrow button, click on the header).
  // This plugin only operates that button: it reads the state from the collapse container
  // (class "show") and clicks Stash's arrow when the group is not in the desired state.
  // Groups without an arrow (plugins without settings) are left alone.
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

  // Only data attributes are set, class/children are never modified: React overwrites
  // className on every re-render, data attributes are left untouched.
  function enhanceGroup(group, sc) {
    const header = group.firstElementChild;
    if (!header || group.children.length < 2) return; // nothing to collapse

    const key = sc.prefix + groupKey(header);
    if (group.dataset.cspKey === key && group.hasAttribute("data-csp-native")) return;

    group.dataset.cspKey = key;
    group.setAttribute("data-csp-native", "");
    // Apply the default state (setting "Default state"); no preference = Stash's own default
    const collapsed = isCollapsed(key);
    if (collapsed !== undefined) setNativeCollapsed(group, collapsed);
  }

  // ---- Sorting and slider ------------------------------------------------

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
        ["data-csp-switch", "data-csp-state", "data-csp-noarrow", "role", "aria-checked"].forEach((n) => b.removeAttribute(n));
      }
    });
    if (!target) return;
    const on = !isDisabled(group);
    setAttr(target, "data-csp-switch", "");
    setAttr(target, "data-csp-state", on ? "on" : "off");
    setAttr(target, "role", "switch");
    setAttr(target, "aria-checked", String(on));
    // Plugins without Stash's arrow get the arrow's width as free space,
    // so all sliders line up in one column.
    const arrow = header.querySelector(".setting-group-collapse-button");
    if (arrow) {
      const cs = getComputedStyle(arrow);
      const w = arrow.getBoundingClientRect().width + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
      if (w > 0) document.documentElement.style.setProperty("--csp-arrow-w", w + "px");
      target.removeAttribute("data-csp-noarrow");
    } else {
      setAttr(target, "data-csp-noarrow", "");
    }
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

    // Remember the state Stash's arrow / header click produced (after the animation).
    // Clicks on other buttons and links of the header (Enable/Disable, link) do not count.
    const ng = target.closest("[data-csp-native]");
    const onArrow = !!target.closest(".setting-group-collapse-button");
    if (
      ng &&
      ng.firstElementChild &&
      ng.firstElementChild.contains(target) &&
      ng.querySelector(".setting-group-collapse-button") &&
      (onArrow || !target.closest("button, a, input, select, textarea, label"))
    ) {
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
          if (!key || !g.querySelector(".setting-group-collapse-button")) return; // nothing to collapse
          setNativeCollapsed(g, collapse);
          setCollapsed(key, collapse);
        });
      });
      return b;
    };

    const t = toolbarLabels();
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
    toolbar.append(sort, collapseAllBtn, expandAllBtn);
    document.body.appendChild(toolbar);
    refreshLabels(); // the locale may have arrived between two runs
    return toolbar;
  }

  const visibleEl = (el) => el.getClientRects().length > 0;
  const inOwn = (el) => el.closest(SELECTORS.group) || el.closest(".csp-toolbar");

  // Finds the filter field of Stash and the button that follows it (the reload button) by
  // structure and position, never by text: the filter is the text input closest to the heading
  // (same row), the reload button is the next button after it in the DOM in that same row.
  // Returns null if either is missing (older Stash versions), then the toolbar is right-aligned.
  function findAnchor(sc) {
    const heading = sc.heading;
    if (!heading) return null;
    const hr = heading.getBoundingClientRect();
    const cy = hr.top + hr.height / 2;
    const scope = heading.closest(".setting-section") || sc.pane;
    const inputs = Array.from(scope.querySelectorAll("input")).filter(
      (el) => !inOwn(el) && visibleEl(el) && /^(text|search|)$/.test(el.getAttribute("type") || "")
    );
    let filter = null, best = 60;
    inputs.forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - cy);
      if (d < best) { best = d; filter = el; }
    });
    if (!filter) return null;
    const fr = filter.getBoundingClientRect();
    const fy = fr.top + fr.height / 2;
    const buttons = Array.from(scope.querySelectorAll("button")).filter((el) => !inOwn(el) && visibleEl(el));
    const reload = buttons.find((b) => {
      if (!(filter.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const r = b.getBoundingClientRect();
      return Math.abs(r.top + r.height / 2 - fy) < 40 && r.left >= fr.right - 1;
    });
    return reload ? { filter, reload } : null;
  }

  let anchorEl = null;
  function setAnchor(el) {
    if (anchorEl === el) return;
    if (anchorEl) anchorEl.removeAttribute("data-csp-anchor");
    anchorEl = el;
    if (el) el.setAttribute("data-csp-anchor", "");
  }

  // The toolbar stays outside the React tree and is placed by coordinates: between the filter
  // field and the reload button if both exist, otherwise right-aligned at the height of the heading.
  function positionToolbar(sc) {
    if (!toolbar || toolbar.style.display === "none") return;
    const heading = sc.heading;

    const anchor = findAnchor(sc);
    setAnchor(anchor ? anchor.reload : null);
    // The reload button gets a left margin (CSS) as wide as the toolbar, which frees the space.
    const wPx = toolbar.offsetWidth + 8 + "px";
    if (document.documentElement.style.getPropertyValue("--csp-toolbar-w") !== wPx)
      document.documentElement.style.setProperty("--csp-toolbar-w", wPx);

    let top, right;
    if (anchor) {
      const rr = anchor.reload.getBoundingClientRect();
      top = rr.top + rr.height / 2 - toolbar.offsetHeight / 2;
      right = rr.left - 8;
    } else if (heading) {
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

    // The toolbar is position: fixed, so viewport coordinates are used (no scroll offset).
    // This also works when Stash scrolls an inner container instead of the window.
    // On narrow screens the toolbar may still be wider than the pane: clamp against the
    // viewport so it never extends past the right screen edge.
    const width = toolbar.offsetWidth;
    const topPx = Math.round(top) + "px";
    const leftPx = Math.round(Math.max(0, Math.min(right - width, window.innerWidth - width))) + "px";
    if (toolbar.style.top !== topPx) toolbar.style.top = topPx;
    if (toolbar.style.left !== leftPx) toolbar.style.left = leftPx;

    // Hide the toolbar while its heading is scrolled out of view, so it never floats over the
    // navigation bar or other content.
    const hidden = top < headerBottom() || top + toolbar.offsetHeight > window.innerHeight;
    const visibility = hidden ? "hidden" : "";
    if (toolbar.style.visibility !== visibility) toolbar.style.visibility = visibility;
  }

  // Lower edge of everything that is stuck to the top of the viewport: the fixed navigation bar
  // and sticky panels below it, for example the "Current tasks" (job queue) panel of the Tasks
  // tab. Content that is only sticky but not stuck yet does not count. 0 if there is nothing.
  function headerBottom() {
    const stuck = [];
    document
      .querySelectorAll(".fixed-top, .sticky-top, nav.navbar, #tasks-panel .tasks-panel-queue")
      .forEach((el) => {
        const pos = getComputedStyle(el).position;
        if (pos !== "fixed" && pos !== "sticky") return;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom < window.innerHeight * 0.8) stuck.push(r);
      });
    stuck.sort((x, y) => x.top - y.top);
    let bottom = 0;
    stuck.forEach((r) => {
      if (r.top <= bottom + 2) bottom = Math.max(bottom, r.bottom); // stacked directly below
    });
    return bottom;
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
  // overlays. Some of them do not outrank the toolbar (e.g. Ascension's
  // .hon-modal also uses z-index 1000, and the toolbar is appended to <body>
  // later, so it wins the tie), so the toolbar would float above the dialogue.
  // It therefore steps aside while such an overlay is open.
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
      setAnchor(null);
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
    scopes.forEach(applySort);
    updateToolbar(active);
    refreshLabels();
  }

  // React renders dynamically -> observe the DOM.
  // The next run is scheduled only once per interval (throttle, not debounce): if other
  // plugins keep touching the DOM, a debounce that restarts on every mutation would never fire.
  let timer = null;
  let running = false;
  let rerun = false;

  async function runSafe() {
    if (running) {
      rerun = true; // changes arrived while running -> run once more afterwards
      return;
    }
    running = true;
    try {
      await run();
    } catch (err) {
      console.warn("[CollapsablePluginSettingsI18n] Update failed:", err);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  }

  function schedule(delay) {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      runSafe();
    }, delay == null ? 100 : delay);
  }

  const observer = new MutationObserver(() => schedule());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"], // Stash toggles "disabled" when a plugin is enabled/disabled
  });

  if (window.PluginApi && PluginApi.Event) {
    PluginApi.Event.addEventListener("stash:location", () => schedule(50));
  }

  // The settings of this plugin are edited on the same page. After a change they
  // are read again, so the slider and its colors update without a page reload.
  let settingsTimers = [];
  function scheduleSettingsRefresh() {
    settingsTimers.forEach(clearTimeout);
    settingsTimers = [1200, 3500].map((ms) =>
      setTimeout(async () => {
        await loadSettings();
        runSafe();
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
  document.addEventListener("scroll", () => kick(150), { capture: true, passive: true });
  document.addEventListener("click", () => kick(), true);
  document.addEventListener("transitionend", () => kick(300), true);
  document.addEventListener("animationend", () => kick(300), true);

  runSafe();
})();
