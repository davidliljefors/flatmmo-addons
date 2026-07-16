// ==UserScript==
// @name         Flat Mod Loader
// @namespace    flatmmo
// @version      1.2.8
// @description  A mod loader for FlatMMO: mod base (panels, dock, manager) plus fetch-and-run mods from GitHub sources (each a repo with a mods/index.json). Install once; add sources and toggle mods in the manager.
// @author       Frappe
// @match        *://flatmmo.com/play.php*
// @grant        none
// @require      https://update.greasyfork.org/scripts/544062/FlatMMOPlus.js
// ==/UserScript==

/*
 * Flat Mod Loader (FML). Runs on top of FlatMMOPlus (page context, @grant none).
 * Exposes window.FML: a Mod base, a draggable/dockable Panel, a keyed List, game
 * helpers, a manager UI, and a mod loader that fetches mods from GitHub "sources" (a repo
 * with a mods/index.json) and injects the enabled ones. Mods are plain JS using the FML
 * API - no userscript header or @require needed.
 */
(function () {
  "use strict";

  const VERSION = "1.2.8";
  if (window.FML && window.FML.version >= VERSION) return;

  const DOCK_W = 280; // px width of the right-side dock sidebar

  // The bank / global-market overlay (`.storage` in the game's own CSS) is sized with
  // min-width/min-height instead of a fixed box, so a wide postings grid or long item
  // list makes it grow past the canvas's actual 1536x896 footprint. Our dock and chat
  // bar are anchored to the canvas's rect, so once the overlay outgrows the canvas it
  // spills out from under them instead of the other way around. Cap it to the canvas's
  // box and let it scroll internally so it can never extend past where we've docked.
  if (!document.getElementById("fml-game-layout-fix")) {
    const gameFixStyle = document.createElement("style");
    gameFixStyle.id = "fml-game-layout-fix";
    gameFixStyle.textContent = `.storage { max-width: 1536px !important; max-height: 896px !important; overflow: auto !important; }`;
    document.head.appendChild(gameFixStyle);
  }

  // ---- small utils ----------------------------------------------------------

  const util = {
    fmt(n) {
      n = Math.floor(Number(n) || 0);
      if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "b";
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
      return String(n);
    },
    pretty(name) {
      if (typeof format_snake_case === "function") return format_snake_case(name);
      return String(name || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    },
    clampPct(v, d) {
      return Math.max(0, Math.min(100, Number(v == null ? d : v))) / 100;
    },
  };

  // Thin, direct accessors for the game globals our mods keep re-reading.
  const game = {
    npcs() { return typeof npcs !== "undefined" ? npcs : window.npcs; },
    getVar(key) { return window.get_var(key); },
    level(xp) { return window.get_level(xp); },
    xpForLevel(level) { return window.get_xp_required(level); },
    localName() { return typeof Globals !== "undefined" ? Globals.local_username : undefined; },
    attackNpc(uuid) { window.send_unrepeatable_bytes_1s("CLICKS_NPC=" + uuid); },
    switchPanel(id) { window.switch_panels(id); },
  };

  // ---- keyed list (row reuse + reorder) -------------------------------------

  class FMLList {
    constructor(container) {
      this.container = container;
      this.rows = {};
      this._order = "";
    }
    row(key, create) {
      let r = this.rows[key];
      if (!r || !r.isConnected) { r = this.rows[key] = create(); }
      return r;
    }
    has(key) { return !!this.rows[key]; }
    keys() { return Object.keys(this.rows); }
    setOrder(keys) {
      const k = keys.join(",");
      if (k === this._order) return;
      for (const key of keys) if (this.rows[key]) this.container.appendChild(this.rows[key]);
      this._order = k;
    }
    remove(key) {
      if (this.rows[key]) { this.rows[key].remove(); delete this.rows[key]; }
      this._order = "";
    }
    clear() {
      for (const k in this.rows) this.rows[k].remove();
      this.rows = {};
      this._order = "";
    }
  }

  // ---- draggable / collapsible styled panel ---------------------------------

  function ensurePanelStyle() {
    if (document.getElementById("fml-panel-style")) return;
    const style = document.createElement("style");
    style.id = "fml-panel-style";
    style.textContent = `
      .fml-panel {
        position: fixed; z-index: 60;
        display: flex; flex-direction: column;
        width: var(--fml-w, 220px); max-height: var(--fml-h, 340px);
        border-radius: 10px; background: var(--fml-bg, #0e1116);
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 2px 10px rgba(0,0,0,0.5);
        font-family: sans-serif; color: #fff; overflow: hidden; user-select: none;
      }
      .fml-header {
        flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
        padding: 4px 6px 4px 8px; background: rgba(255,255,255,0.06);
        border-bottom: 1px solid rgba(255,255,255,0.10); cursor: grab; touch-action: none;
      }
      .fml-header:active { cursor: grabbing; }
      .fml-titlewrap { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; cursor: pointer; }
      .fml-chevron { font-size: 9px; color: #aeb8c4; transition: transform .15s; }
      .fml-panel.fml-collapsed .fml-chevron { transform: rotate(-90deg); }
      .fml-panel.fml-collapsed .fml-body { display: none; }
      .fml-title {
        font-size: 12px; font-weight: bold; letter-spacing: .04em; text-transform: uppercase;
        color: #cdd6e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fml-actions { display: flex; align-items: center; gap: 5px; flex-shrink: 0; margin-left: auto; }
      .fml-btn {
        height: 22px; padding: 0 8px; border-radius: 6px; cursor: pointer;
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16);
        font-size: 11px; font-weight: bold; color: #dfe6ee;
        display: flex; align-items: center; gap: 4px; transition: background .12s, filter .12s;
      }
      .fml-btn:hover { background: rgba(255,255,255,0.18); filter: brightness(1.1); }
      .fml-btn img { width: 16px; height: 16px; object-fit: contain; image-rendering: pixelated; }
      .fml-close-btn { padding: 0 7px; font-size: 15px; line-height: 1; }
      .fml-close-btn:hover { background: rgba(224,64,58,0.5); filter: none; }
      .fml-menu-btn { padding: 0 7px; font-size: 14px; line-height: 1; }
      .fml-menu {
        position: fixed; z-index: 10000; min-width: 168px; padding: 4px; display: none; flex-direction: column; gap: 1px;
        background: #12161c; border: 1px solid rgba(255,255,255,0.16); border-radius: 8px;
        box-shadow: 0 6px 22px rgba(0,0,0,0.6); font-family: sans-serif;
      }
      .fml-menu.fml-open { display: flex; }
      .fml-menu-item { padding: 6px 10px; border-radius: 6px; font-size: 12px; color: #dfe6ee; cursor: pointer; white-space: nowrap; }
      .fml-menu-item:hover { background: rgba(255,255,255,0.12); }
      .fml-menu-sep { height: 1px; margin: 3px 4px; background: rgba(255,255,255,0.10); }
      .fml-body { flex: 1 1 auto; overflow-y: auto; padding: 5px; display: flex; flex-direction: column; gap: 4px; }
      .fml-panel.fml-collapsed { height: auto !important; }
      .fml-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 2; }
      .fml-resize::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px; border-right: 2px solid rgba(255,255,255,0.4); border-bottom: 2px solid rgba(255,255,255,0.4); }
      .fml-panel.fml-collapsed .fml-resize { display: none; }
      #fml-dock {
        position: fixed; z-index: 59; display: none; flex-direction: column; gap: 6px;
        width: var(--fml-dock-w, ${DOCK_W}px); box-sizing: border-box; padding: 6px;
        overflow-y: auto; overflow-x: hidden;
        background: rgba(10,13,18,0.92); border: 1px solid rgba(255,255,255,0.14);
        border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.5);
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent;
      }
      #fml-dock.fml-dock-show { display: flex; }
      #fml-dock::-webkit-scrollbar { width: 8px; }
      #fml-dock::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 8px; }
      #fml-dock.fml-dock-hint { border-color: rgba(120,170,255,0.9); box-shadow: 0 0 0 2px rgba(120,170,255,0.35), 0 2px 12px rgba(0,0,0,0.5); }
      .fml-dock-empty { margin: auto; padding: 12px 10px; text-align: center; font: 12px/1.4 sans-serif; color: #9fb0c0; border: 2px dashed rgba(255,255,255,0.18); border-radius: 8px; }
      .fml-dock-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 2; }
      .fml-dock-resize::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px; border-right: 2px solid rgba(255,255,255,0.4); border-bottom: 2px solid rgba(255,255,255,0.4); }
      .fml-panel.fml-docked { position: relative; left: auto; top: auto; width: 100%; box-shadow: none; flex: 0 0 auto; }
      .fml-panel.fml-docked .fml-header { cursor: grab; }
      .fml-panel.fml-docked .fml-resize { display: none; }
    `;
    document.head.appendChild(style);
  }

  class FMLPanel {
    constructor(mod, opts = {}) {
      this.mod = mod;
      this.collapsible = opts.collapsible !== false;
      this.draggable = opts.draggable !== false;
      this.collapsed = !!opts.collapsed;
      this.resizable = opts.resizable !== false;
      this.closable = opts.closable !== false;
      this.dockable = opts.dockable !== false;
      this._width = opts.width || null;
      this._maxHeight = opts.maxHeight || null;
      this.docked = this.dockable && FML._loadDocked(mod.id);
      this._pos = FML._loadPos(mod.id);
      this._size = this.resizable ? FML._loadSize(mod.id) : null;
      mod._panel = this;
      ensurePanelStyle();
      this._build(opts.title || (mod.opts.about && mod.opts.about.name) || mod.id);
    }

    _build(title) {
      const el = document.createElement("div");
      el.className = "fml-panel";
      el.id = "fml-" + this.mod.id;

      const header = document.createElement("div");
      header.className = "fml-header";

      const tw = document.createElement("div");
      tw.className = "fml-titlewrap";
      const chev = document.createElement("span");
      chev.className = "fml-chevron";
      chev.textContent = "\u25BC";
      const t = document.createElement("span");
      t.className = "fml-title";
      t.textContent = title;
      if (this.collapsible) tw.appendChild(chev);
      tw.appendChild(t);
      // The title area (chevron + name) is the collapse toggle - a plain click
      // target, deliberately excluded from the drag handler so it shows the click
      // cursor rather than the grab cursor.
      tw.onclick = () => { if (this.collapsible) this.toggleCollapse(); };

      const actions = document.createElement("div");
      actions.className = "fml-actions";

      header.appendChild(tw);
      header.appendChild(actions);

      // Base-owned options menu (hamburger): built-in reset + client addMenuItem().
      const menuBtn = document.createElement("button");
      menuBtn.className = "fml-btn fml-menu-btn";
      menuBtn.textContent = "\u2630";
      menuBtn.title = "Options";
      menuBtn.onclick = (e) => { e.stopPropagation(); this._toggleMenu(); };
      actions.appendChild(menuBtn);
      this.menuBtn = menuBtn;
      this.menu = document.createElement("div");
      this.menu.className = "fml-menu";
      document.body.appendChild(this.menu);
      this._menuItems = [];

      if (this.closable) {
        const close = document.createElement("button");
        close.className = "fml-btn fml-close-btn";
        close.title = "Close (re-enable from the FML manager)";
        close.textContent = "\u00D7";
        close.onclick = (e) => { e.stopPropagation(); this.close(); };
        actions.appendChild(close);
        this._closeBtn = close;
      }

      const body = document.createElement("div");
      body.className = "fml-body";

      el.appendChild(header);
      el.appendChild(body);

      this.el = el;
      this.header = header;
      this.titleEl = t;
      this.actions = actions;
      this.body = body;
      if (this.collapsed) el.classList.add("fml-collapsed");
      if (this.docked) el.classList.add("fml-docked");
      if (this.resizable) {
        el.classList.add("fml-resizable");
        const handle = document.createElement("div");
        handle.className = "fml-resize";
        handle.title = "Drag to resize";
        el.appendChild(handle);
        this.handle = handle;
      }
      this._wireHeader();
      if (this.resizable) this._wireResize();
      this._rebuildMenu();
    }

    addHeaderButton({ text, img, title, onClick }) {
      const b = document.createElement("button");
      b.className = "fml-btn";
      if (img) { const i = document.createElement("img"); i.src = img; i.alt = title || ""; b.appendChild(i); }
      if (text) b.appendChild(document.createTextNode(text));
      if (title) b.title = title;
      b.onclick = (e) => { e.stopPropagation(); onClick(e); };
      if (this._closeBtn) this.actions.insertBefore(b, this._closeBtn);
      else this.actions.appendChild(b);
      return b;
    }

    // Add an entry to the panel's hamburger options menu. { label, onClick }.
    addMenuItem({ label, onClick }) {
      const item = { label, onClick };
      this._menuItems.push(item);
      this._rebuildMenu();
      return item;
    }

    _rebuildMenu() {
      const menu = this.menu;
      menu.innerHTML = "";
      const add = (label, fn) => {
        const mi = document.createElement("div");
        mi.className = "fml-menu-item";
        mi.textContent = label;
        mi.onclick = (e) => { e.stopPropagation(); this._closeMenu(); fn(e); };
        menu.appendChild(mi);
      };
      for (const it of this._menuItems) add(it.label, it.onClick);
      // No menu items -> hide the hamburger button entirely.
      if (this.menuBtn) this.menuBtn.style.display = this._menuItems.length ? "" : "none";
    }

    _toggleMenu() {
      if (this.menu.classList.contains("fml-open")) this._closeMenu();
      else this._openMenu();
    }

    _openMenu() {
      const menu = this.menu;
      menu.classList.add("fml-open");
      const r = this.menuBtn.getBoundingClientRect();
      const mw = menu.offsetWidth || 168, mh = menu.offsetHeight || 0;
      const left = Math.max(6, Math.min(r.right - mw, window.innerWidth - mw - 6));
      let top = r.bottom + 4;
      if (top + mh > window.innerHeight - 6) top = Math.max(6, r.top - mh - 4);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
      this._onDocDown = (e) => { if (e.target !== this.menuBtn && !menu.contains(e.target)) this._closeMenu(); };
      setTimeout(() => document.addEventListener("pointerdown", this._onDocDown), 0);
    }

    _closeMenu() {
      if (this.menu) this.menu.classList.remove("fml-open");
      if (this._onDocDown) { document.removeEventListener("pointerdown", this._onDocDown); this._onDocDown = null; }
    }

    setTitle(text) { this.titleEl.textContent = text; }
    setCollapsed(v) { this.collapsed = v; this.el.classList.toggle("fml-collapsed", v); }
    toggleCollapse() { this.setCollapsed(!this.collapsed); }
    close() { FML.setConfig(this.mod, "enabled", false); }

    mount() {
      if (!this._resizeBound) {
        this._resizeBound = () => this.layout();
        window.addEventListener("resize", this._resizeBound);
      }
      if (this.docked) {
        FML.dock.add(this);
      } else if (!this.el.isConnected) {
        document.body.appendChild(this.el);
      }
      this.applySettings(this.mod.settings);
    }

    unmount() {
      if (this._resizeBound) { window.removeEventListener("resize", this._resizeBound); this._resizeBound = null; }
      this._closeMenu();
      if (this.menu) this.menu.remove();
      if (this.docked) FML.dock.remove(this, false); // keep docked state so re-enable restores it
      this.el.remove();
    }

    applySettings() {
      if (this._width) this.el.style.setProperty("--fml-w", this._width + "px");
      if (this._maxHeight) this.el.style.setProperty("--fml-h", this._maxHeight + "px");
      // Panel background + opacity are GLOBAL (managed in the loader's "Global
      // settings"), not per-mod. Docked panels sit in the dock's own panel, so they
      // stay fully opaque and only take the shared background colour.
      const g = FML.globalSettings();
      this.el.style.setProperty("--fml-bg", g.panelBg);
      this.el.style.opacity = this.docked ? "1" : String(util.clampPct(g.panelOpacity, 92));
      // A user-dragged size overrides the width/max-height derived from settings.
      if (!this.docked && this.resizable && this._size) this._applySize(this._size.w, this._size.h);
      this.layout();
    }

    resetPosition() {
      this._pos = null;
      FML._savePos(this.mod.id, null);
      if (this.resizable) {
        this._size = null;
        FML._saveSize(this.mod.id, null);
        this.el.style.width = "";
        this.el.style.height = "";
        this.el.style.maxHeight = "";
      }
      this.layout();
    }

    layout() {
      if (this.docked) return; // the dock positions docked panels in its stack
      const el = this.el;
      const canvas = document.getElementById("canvas");
      const rect = canvas
        ? canvas.getBoundingClientRect()
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

      let left, top;
      if (this._pos) {
        left = this._pos.left;
        top = this._pos.top;
      } else {
        // First load: top-left of the play area. Drag anywhere; the spot is saved.
        left = rect.left + 8;
        top = rect.top + 8;
      }
      // Keep a grabbable sliver on screen no matter what.
      left = Math.max(0, Math.min(left, window.innerWidth - 40));
      top = Math.max(0, Math.min(top, window.innerHeight - 20));
      el.style.left = left + "px";
      el.style.top = top + "px";
    }

    _wireHeader() {
      this.header.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest("button")) return;          // header action buttons
        if (e.target.closest(".fml-titlewrap")) return; // title = collapse toggle, not a drag handle
        this._startDrag(e);
      });
    }

    // One header drag handles everything: move a floating panel, and dock / undock /
    // reorder by dragging over (or out of) the side dock - no dock button needed.
    _startDrag(e) {
      const rect = this.el.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      if (this.dockable) FML.dock.beginDropHint();

      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        const overDock = this.dockable && FML.dock.pointInDock(ev.clientX, ev.clientY);
        if (overDock) {
          if (!this.docked) this.setDocked(true);
          FML.dock.dragTo(this, ev.clientY);
          FML.dock.highlight(true);
        } else {
          if (this.docked) { this._pos = { left: ev.clientX - offX, top: ev.clientY - offY }; this.setDocked(false); }
          FML.dock.highlight(false);
          if (this.draggable) { this._pos = { left: ev.clientX - offX, top: ev.clientY - offY }; this.layout(); }
        }
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (this.dockable) FML.dock.endDropHint();
        if (!moved) return;
        if (this.docked) FML.dock.persistOrder();
        else if (this.draggable) FML._savePos(this.mod.id, this._pos);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      e.preventDefault();
    }

    _applySize(w, h) {
      this._size = { w, h };
      this.el.style.width = w + "px";
      this.el.style.height = h + "px";
      this.el.style.maxHeight = "none"; // let the drag exceed the settings cap
    }

    _wireResize() {
      this.handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const rect = this.el.getBoundingClientRect();
        const startW = rect.width, startH = rect.height;
        const move = (ev) => {
          const w = Math.max(140, Math.min(startW + (ev.clientX - startX), window.innerWidth - 20));
          const h = Math.max(80, Math.min(startH + (ev.clientY - startY), window.innerHeight - 20));
          this._applySize(w, h);
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          FML._saveSize(this.mod.id, this._size);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      });
    }

    // ---- docking ----
    toggleDock() { this.setDocked(!this.docked); }

    setDocked(v) {
      if (v === this.docked) return;
      this.docked = v;
      FML._saveDocked(this.mod.id, v);
      this.el.classList.toggle("fml-docked", v);
      if (v) {
        // Drop floating inline styles so the docked CSS (relative, 100% width) applies.
        this.el.style.left = "";
        this.el.style.top = "";
        this.el.style.width = "";
        this.el.style.height = "";
        this.el.style.maxHeight = "";
        FML.dock.add(this);
        this.applySettings(); // docked -> fully opaque
      } else {
        FML.dock.remove(this, true);
        this.el.style.height = "";
        this.el.style.maxHeight = "";
        if (!this.el.isConnected) document.body.appendChild(this.el);
        this.applySettings();
      }
    }
  }

  // ---- mod base --------------------------------------------------------------

  class FMLMod extends FlatMMOPlusPlugin {
    constructor(id, opts) {
      opts = opts || {};
      opts.config = opts.config || [];
      if (!opts.config.some((c) => c.id === "enabled")) {
        opts.config.unshift({ id: "enabled", type: "checkbox", label: "Enabled", default: true });
      }
      const meta = FML._modMeta(id);
      opts.about = { name: meta.name, version: meta.version, author: meta.author, description: meta.description };
      super(id, opts);
      this._timers = [];
      this._active = false;
      this._ready = false;
      this._settings = {};
      FML._register(this);

      // Register synchronously so FlatMMOPlus loads the mod's config right away - the
      // loader reads it via setConfig() immediately after injecting the mod. (The
      // "onStart runs before the subclass constructor finishes" hazard is handled by
      // deferring _apply() in onLogin(), not by delaying registration.)
      FML._registerWithFlatMMOPlus(this);
    }

    get settings() { return this._settings; }

    // Interval that is auto-cleared when the mod stops/disables.
    every(ms, fn) { const h = setInterval(fn, ms); this._timers.push(h); return h; }
    _clearTimers() { this._timers.forEach(clearInterval); this._timers = []; }

    // FlatMMOPlus lifecycle -> our simpler onStart/onStop/onSettings hooks.
    // Defer _apply() to a microtask: FlatMMOPlus calls onLogin() synchronously from
    // registerPlugin() (inside super()), i.e. BEFORE the mod subclass constructor body
    // has run. The microtask lets `new Mod()` fully return (fields set) before onStart().
    onLogin() { this._ready = true; queueMicrotask(() => this._apply()); }
    onConfigsChanged() { if (this._ready) this._apply(); }

    _apply() {
      const s = {};
      for (const c of this.opts.config) s[c.id] = this.getConfig(c.id);
      this._settings = s;

      if (s.enabled === false) {
        if (this._active) { this._active = false; this._clearTimers(); if (this.onStop) this.onStop(); }
        return;
      }
      if (!this._active) { this._active = true; if (this.onStart) this.onStart(); }
      if (this.onSettings) this.onSettings(s);
    }
  }

  // ---- shared config preset for panel mods ----------------------------------

  // Deprecated: panel background + opacity are now GLOBAL (see the manager's "Global
  // settings"). Kept as a no-op so any mod that still spreads it keeps loading.
  function panelConfig() { return []; }

  // ---- global panel settings (shared background + opacity) ------------------

  const GLOBAL_DEFAULTS = { panelBg: "#0e1116", panelOpacity: 92, dockWidth: DOCK_W };

  function globalSettings() {
    const bg = localStorage.getItem("fml.global.panelBg");
    const op = localStorage.getItem("fml.global.panelOpacity");
    const dw = localStorage.getItem("fml.global.dockWidth");
    const dh = localStorage.getItem("fml.global.dockHeight");
    return {
      panelBg: bg || GLOBAL_DEFAULTS.panelBg,
      panelOpacity: op == null ? GLOBAL_DEFAULTS.panelOpacity : Number(op),
      dockWidth: dw == null ? GLOBAL_DEFAULTS.dockWidth : Number(dw),
      // null = auto (matches the canvas height); a number is a user-dragged override.
      dockHeight: dh == null ? null : Number(dh),
    };
  }

  function setGlobal(key, value) {
    localStorage.setItem("fml.global." + key, String(value));
    FML._applyGlobal();
  }

  // Subscribe to global-settings changes (for non-panel mods like the chat bar).
  function onGlobal(fn) {
    FML._globalListeners.push(fn);
    return () => { const i = FML._globalListeners.indexOf(fn); if (i >= 0) FML._globalListeners.splice(i, 1); };
  }

  // ---- config persistence (drive FlatMMOPlus programmatically) --------------

  function setConfig(mod, key, value) {
    // Ensure mod.config exists WITHOUT calling FlatMMOPlusPlugin.getConfig() (FlatMMOPlus's
    // own base class): its auto-load path calls FlatMMOPlus.loadPluginConfigs as a static,
    // but that's a prototype method - so it throws if the mod isn't registered yet. Load it
    // the working way (on the instance) when registered, else start from an empty object.
    if (!mod.config) {
      const fmp = window.FlatMMOPlus;
      if (fmp && typeof fmp.loadPluginConfigs === "function" && mod.id in fmp.plugins) {
        fmp.loadPluginConfigs(mod.id);
      }
      if (!mod.config) mod.config = {};
    }
    mod.config[key] = value;
    localStorage.setItem(`flatmmoplus.${mod.id}.config`, JSON.stringify(mod.config));
    if (mod.onConfigsChanged) mod.onConfigsChanged();
  }

  const BOOL = ["checkbox", "bool", "boolean"];
  const INT = ["integer", "int"];
  const FLOAT = ["number", "float", "num"];
  const RANGE = ["range"];
  const STR = ["string", "text"];
  const SEL = ["select"];
  const COL = ["color"];

  // ---- manager UI -----------------------------------------------------------

  function ensureManagerStyle() {
    if (document.getElementById("fml-manager-style")) return;
    const style = document.createElement("style");
    style.id = "fml-manager-style";
    style.textContent = `
      #fml-launcher {
        position: fixed; left: 8px; bottom: 8px; z-index: 90;
        padding: 3px 8px; border-radius: 6px; cursor: pointer;
        background: rgba(14,17,22,0.85); color: #cfe3ff; border: 1px solid rgba(255,255,255,0.18);
        font-family: sans-serif; font-size: 11px; font-weight: bold; opacity: 0.75;
      }
      #fml-launcher:hover { opacity: 1; }
      #fml-manager-overlay {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(0,0,0,0.55); display: flex; align-items: flex-start; justify-content: center;
        padding: 6vh 12px 12px; box-sizing: border-box;
      }
      #fml-manager {
        width: 460px; max-width: 100%; max-height: 88vh; overflow-y: auto; overscroll-behavior: contain;
        background: #12161c; color: #e6ecf3; border: 1px solid rgba(255,255,255,0.16);
        border-radius: 10px; padding: 14px; font-family: sans-serif; box-shadow: 0 6px 30px rgba(0,0,0,0.6);
      }
      #fml-manager h3 { margin: 0 0 10px; font-size: 15px; }
      .fml-card { border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
      .fml-card-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,0.04); cursor: pointer; }
      .fml-card-name { flex: 1 1 auto; font-weight: bold; font-size: 13px; }
      .fml-switch { position: relative; width: 38px; height: 20px; flex-shrink: 0; }
      .fml-switch input { opacity: 0; width: 0; height: 0; }
      .fml-slider { position: absolute; inset: 0; border-radius: 20px; background: #444; transition: .15s; }
      .fml-slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; border-radius: 50%; background: #fff; transition: .15s; }
      .fml-switch input:checked + .fml-slider { background: #3ba55d; }
      .fml-switch input:checked + .fml-slider::before { transform: translateX(18px); }
      .fml-card-body { padding: 8px 10px; display: none; border-top: 1px solid rgba(255,255,255,0.08); }
      .fml-card.fml-open .fml-card-body { display: block; }
      .fml-field { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
      .fml-field label { flex: 1 1 auto; color: #b9c4d0; }
      .fml-field input[type=number], .fml-field input[type=text], .fml-field select { width: 120px; }
      .fml-field .fml-rangeval { width: 34px; text-align: right; color: #9fb0c0; }
      .fml-reset-pos { margin-top: 8px; font-size: 11px; color: #cfe3ff; cursor: pointer; text-decoration: underline; }
      #fml-manager .fml-close { float: right; cursor: pointer; color: #9fb0c0; font-weight: bold; }
      .fml-mods { margin-bottom: 12px; }
      .fml-mods-title { font-size: 13px; font-weight: bold; margin: 2px 0 8px; color: #cfe3ff; }
      .fml-src-add { display: flex; gap: 6px; margin-bottom: 8px; }
      .fml-src-add input { flex: 1 1 auto; min-width: 0; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.18); background: #0d1117; color: #e6ecf3; }
      .fml-btn { padding: 3px 10px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); color: #e6ecf3; font-weight: bold; }
      .fml-btn:hover { background: rgba(255,255,255,0.2); }
      .fml-manager-footer { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: flex-end; }
      .fml-nuke { background: rgba(224,64,58,0.22); border-color: rgba(224,64,58,0.5); color: #ffd7d4; }
      .fml-nuke:hover { background: rgba(224,64,58,0.45); }
      .fml-src-empty { color: #8a94a0; font-size: 12px; }
      .fml-src { border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
      .fml-src-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(255,255,255,0.04); }
      .fml-src-url { flex: 1 1 auto; min-width: 0; font-size: 11px; color: #b9c4d0; word-break: break-all; }
      .fml-src-rm { cursor: pointer; color: #9fb0c0; font-weight: bold; flex-shrink: 0; }
      .fml-src-rm:hover { color: #e0403a; }
      .fml-src-note { padding: 6px 10px; font-size: 12px; color: #8a94a0; }
      .fml-src-err { color: #e0857f; }
      .fml-mod { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid rgba(255,255,255,0.06); }
      .fml-mod-info { flex: 1 1 auto; min-width: 0; }
      .fml-mod-name { font-size: 13px; font-weight: bold; }
      .fml-mod-desc { font-size: 11px; color: #9fb0c0; }
      .fml-src .fml-card { border: 0; border-radius: 0; margin: 0; border-top: 1px solid rgba(255,255,255,0.06); }
    `;
    document.head.appendChild(style);
  }

  function renderField(mod, cfg) {
    const field = document.createElement("div");
    field.className = "fml-field";
    const label = document.createElement("label");
    label.textContent = cfg.label || cfg.id;
    const value = mod.getConfig(cfg.id);

    let input;
    if (BOOL.includes(cfg.type)) {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!value;
      input.onchange = () => setConfig(mod, cfg.id, input.checked);
    } else if (RANGE.includes(cfg.type)) {
      input = document.createElement("input");
      input.type = "range";
      input.min = cfg.min ?? 0; input.max = cfg.max ?? 100; input.step = cfg.step ?? 1;
      input.value = value;
      const val = document.createElement("span");
      val.className = "fml-rangeval";
      val.textContent = value;
      input.oninput = () => { val.textContent = input.value; setConfig(mod, cfg.id, parseInt(input.value)); };
      field.appendChild(label); field.appendChild(input); field.appendChild(val);
      return field;
    } else if (INT.includes(cfg.type) || FLOAT.includes(cfg.type)) {
      input = document.createElement("input");
      input.type = "number";
      if (cfg.min != null) input.min = cfg.min;
      if (cfg.max != null) input.max = cfg.max;
      if (cfg.step != null) input.step = cfg.step;
      input.value = value;
      const parse = INT.includes(cfg.type) ? parseInt : parseFloat;
      input.onchange = () => setConfig(mod, cfg.id, parse(input.value));
    } else if (SEL.includes(cfg.type)) {
      input = document.createElement("select");
      (cfg.options || []).forEach((opt) => {
        const o = document.createElement("option");
        const ov = typeof opt === "object" ? opt.value : opt;
        o.value = ov; o.textContent = typeof opt === "object" ? opt.label : opt;
        if (ov === value) o.selected = true;
        input.appendChild(o);
      });
      input.onchange = () => setConfig(mod, cfg.id, input.value);
    } else if (COL.includes(cfg.type)) {
      input = document.createElement("input");
      input.type = "color";
      input.value = value || "#000000";
      input.oninput = () => setConfig(mod, cfg.id, input.value);
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = value == null ? "" : value;
      input.onchange = () => setConfig(mod, cfg.id, input.value);
    }

    field.appendChild(label);
    field.appendChild(input);
    return field;
  }

  // One unified entry per mod: name + version + enable toggle in the head, and the
  // mod's live settings (once loaded) in the expandable body - no separate card.
  function buildModCard(s, m) {
    const mod = loader.mod(m);
    const enabled = loader.isEnabled(s, m);

    const card = document.createElement("div");
    card.className = "fml-card";

    const head = document.createElement("div");
    head.className = "fml-card-head";
    const name = document.createElement("div");
    name.className = "fml-card-name";
    name.textContent = (m.name || m.id) + (m.version ? "  v" + m.version : "");

    const sw = document.createElement("label");
    sw.className = "fml-switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabled;
    cb.onchange = () => (cb.checked ? loader.enable(s, m) : loader.disable(s, m));
    sw.onclick = (e) => e.stopPropagation(); // toggle shouldn't expand the card
    const slider = document.createElement("span");
    slider.className = "fml-slider";
    sw.appendChild(cb); sw.appendChild(slider);

    head.appendChild(name);
    head.appendChild(sw);

    const body = document.createElement("div");
    body.className = "fml-card-body";
    if (m._error) {
      const err = document.createElement("div");
      err.className = "fml-src-err";
      err.style.cssText = "font-size:12px;margin-bottom:4px;";
      err.textContent = "Error: " + m._error;
      body.appendChild(err);
    }
    if (m.description) {
      const d = document.createElement("div");
      d.className = "fml-mod-desc";
      d.style.marginBottom = "6px";
      d.textContent = m.description;
      body.appendChild(d);
    }
    if (mod) {
      for (const cfg of mod.opts.config) {
        if (cfg.id === "enabled") continue;
        body.appendChild(renderField(mod, cfg));
      }
      const reset = document.createElement("div");
      reset.className = "fml-reset-pos";
      reset.textContent = "Reset mod settings";
      reset.title = "Clear this mod's saved settings and panel position/size back to defaults.";
      reset.onclick = () => {
        if (!window.confirm("Reset " + (m.name || m.id) + " to default settings?\n\nThis clears its saved settings and panel position, size and dock state.")) return;
        loader.resetMod(m);
      };
      body.appendChild(reset);
    } else {
      const n = document.createElement("div");
      n.className = "fml-mod-desc";
      n.textContent = enabled ? "Loading…" : "Enable to load and configure.";
      body.appendChild(n);
    }

    head.onclick = () => card.classList.toggle("fml-open");
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  // Collapsible "Global settings" card: shared panel background + opacity that every
  // mod panel uses. Live-applies on change (docked panels + chat ignore opacity).
  function buildGlobalCard() {
    const g = globalSettings();
    const card = document.createElement("div");
    card.className = "fml-card";

    const head = document.createElement("div");
    head.className = "fml-card-head";
    const name = document.createElement("div");
    name.className = "fml-card-name";
    name.textContent = "\u2699 Global settings";
    head.appendChild(name);
    head.onclick = () => card.classList.toggle("fml-open");

    const body = document.createElement("div");
    body.className = "fml-card-body";

    const bgField = document.createElement("div");
    bgField.className = "fml-field";
    const bgLabel = document.createElement("label");
    bgLabel.textContent = "Panel background";
    const bgInput = document.createElement("input");
    bgInput.type = "color";
    bgInput.value = g.panelBg;
    bgInput.oninput = () => setGlobal("panelBg", bgInput.value);
    bgField.append(bgLabel, bgInput);

    const opField = document.createElement("div");
    opField.className = "fml-field";
    const opLabel = document.createElement("label");
    opLabel.textContent = "Panel opacity (%)";
    const opInput = document.createElement("input");
    opInput.type = "range";
    opInput.min = 10; opInput.max = 100; opInput.step = 5;
    opInput.value = g.panelOpacity;
    const opVal = document.createElement("span");
    opVal.className = "fml-rangeval";
    opVal.textContent = g.panelOpacity;
    opInput.oninput = () => { opVal.textContent = opInput.value; setGlobal("panelOpacity", parseInt(opInput.value)); };
    opField.append(opLabel, opInput, opVal);

    const note = document.createElement("div");
    note.className = "fml-mod-desc";
    note.style.marginTop = "4px";
    note.textContent = "Applies to all mod panels (docked panels ignore opacity). Drag the dock's bottom-right handle to resize it.";

    body.append(bgField, opField, note);
    card.append(head, body);
    return card;
  }

  const manager = {
    open() {
      ensureManagerStyle();
      if (document.getElementById("fml-manager-overlay")) return;
      const overlay = document.createElement("div");
      overlay.id = "fml-manager-overlay";
      // Pin the page while the manager is open so scrolling the window doesn't move it.
      const prevOverflow = document.documentElement.style.overflow;
      const closeOverlay = () => { overlay.remove(); document.documentElement.style.overflow = prevOverflow; };
      overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };

      const box = document.createElement("div");
      box.id = "fml-manager";
      const title = document.createElement("h3");
      title.textContent = "Flat Mod Loader";
      const close = document.createElement("span");
      close.className = "fml-close";
      close.textContent = "\u00D7";
      close.onclick = () => closeOverlay();
      title.appendChild(close);
      box.appendChild(title);
      box.appendChild(buildGlobalCard());

      const modsEl = document.createElement("div");
      modsEl.className = "fml-mods";
      box.appendChild(modsEl);
      this._modsEl = modsEl;
      this.renderMods();

      const footer = document.createElement("div");
      footer.className = "fml-manager-footer";
      const nuke = document.createElement("button");
      nuke.className = "fml-btn fml-nuke";
      nuke.textContent = "Nuke all configs";
      nuke.title = "Clear every mod's saved settings, panel positions and stale configs, then reload. Your mod sources are kept.";
      nuke.onclick = () => {
        if (!window.confirm("Nuke all Flat Mod Loader configs?\n\nThis clears every mod's settings, panel positions/sizes, the dock layout, which mods are enabled, and any stale saved configs (including old Quick Actions), then reloads the page.\n\nYour mod SOURCES are kept.")) return;
        FML._nukeData();
        location.reload();
      };
      footer.appendChild(nuke);
      box.appendChild(footer);

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      document.documentElement.style.overflow = "hidden";
    },
    refreshMods() { if (this._modsEl && this._modsEl.isConnected) this.renderMods(); },
    renderMods() {
      const host = this._modsEl;
      if (!host) return;
      host.innerHTML = "";
      const h = document.createElement("div");
      h.className = "fml-mods-title";
      h.textContent = "Mod sources";
      host.appendChild(h);

      const addRow = document.createElement("div");
      addRow.className = "fml-src-add";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "GitHub repo URL...";
      const addBtn = document.createElement("button");
      addBtn.className = "fml-btn";
      addBtn.textContent = "Add";
      const submit = () => { const v = input.value.trim(); if (v) { loader.addSource(v); input.value = ""; } };
      addBtn.onclick = submit;
      input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
      addRow.appendChild(input); addRow.appendChild(addBtn);
      host.appendChild(addRow);

      if (loader.sources.length === 0) {
        const none = document.createElement("div");
        none.className = "fml-src-empty";
        none.textContent = "No sources yet. Add a GitHub repo that has a mods/index.json.";
        host.appendChild(none);
        return;
      }

      for (const s of loader.sources) {
        const src = document.createElement("div");
        src.className = "fml-src";
        const head = document.createElement("div");
        head.className = "fml-src-head";
        const url = document.createElement("span");
        url.className = "fml-src-url";
        url.textContent = s.url;
        const rm = document.createElement("span");
        rm.className = "fml-src-rm";
        rm.textContent = "\u00D7";
        rm.title = "Remove source";
        rm.onclick = () => loader.removeSource(s.url);
        head.appendChild(url); head.appendChild(rm);
        src.appendChild(head);

        if (s.loading) {
          const n = document.createElement("div"); n.className = "fml-src-note"; n.textContent = "Loading…"; src.appendChild(n);
        } else if (s.error) {
          const n = document.createElement("div"); n.className = "fml-src-note fml-src-err"; n.textContent = s.error; src.appendChild(n);
        } else if (s.mods.length === 0) {
          const n = document.createElement("div"); n.className = "fml-src-note"; n.textContent = "No mods found."; src.appendChild(n);
        }

        for (const m of s.mods) src.appendChild(buildModCard(s, m));
        host.appendChild(src);
      }
    },
    injectLauncher() {
      ensureManagerStyle();
      if (document.getElementById("fml-launcher")) return;
      const b = document.createElement("div");
      b.id = "fml-launcher";
      b.textContent = "Mods";
      b.title = "Open Flat Mod Loader";
      b.onclick = () => manager.open();
      document.body.appendChild(b);
    },
  };

  // ---- dock sidebar ---------------------------------------------------------

  const dock = {
    el: null,
    _panels: [],
    _hinting: false,
    _empty: null,
    ensure() {
      if (this.el) return;
      ensurePanelStyle();
      const el = document.createElement("div");
      el.id = "fml-dock";
      document.body.appendChild(el);
      this.el = el;
      el.style.setProperty("--fml-dock-w", globalSettings().dockWidth + "px");
      this._wireResize();
      window.addEventListener("resize", () => this.layout());
      this.layout();
    },
    // Drag the bottom-right handle to resize the dock (both width and height, like a
    // panel's own resize grip). Width always persists; height persists too and then
    // overrides the default canvas-derived height until dragged again.
    _wireResize() {
      const handle = document.createElement("div");
      handle.className = "fml-dock-resize";
      this.el.appendChild(handle);
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const rect = this.el.getBoundingClientRect();
        const startW = rect.width, startH = rect.height;
        const move = (ev) => {
          const w = Math.max(180, Math.min(startW + (ev.clientX - startX), window.innerWidth - 20));
          const h = Math.max(120, Math.min(startH + (ev.clientY - startY), window.innerHeight - 20));
          this.el.style.setProperty("--fml-dock-w", w + "px");
          this.el.style.height = h + "px";
          this.layout(true); // keep left/top synced; don't let layout stomp our live height
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          const r = this.el.getBoundingClientRect();
          localStorage.setItem("fml.global.dockHeight", String(Math.round(r.height)));
          setGlobal("dockWidth", Math.round(r.width));
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      });
    },
    // Re-applies the global dock width (called from FML._applyGlobal on change).
    applyGlobal() {
      if (!this.el) return;
      this.el.style.setProperty("--fml-dock-w", globalSettings().dockWidth + "px");
      this.layout();
    },
    layout(skipHeight) {
      if (!this.el) return;
      // Read the actual rendered width (not the saved setting) so this stays accurate
      // mid-drag, when the CSS var has already changed but nothing's persisted yet.
      const dockW = this.el.getBoundingClientRect().width || globalSettings().dockWidth;
      const canvas = document.getElementById("canvas");
      const rect = canvas
        ? canvas.getBoundingClientRect()
        : { right: window.innerWidth - dockW - 10, top: 0, height: window.innerHeight };
      let left = Math.min(rect.right + 6, window.innerWidth - dockW - 4);
      left = Math.max(0, left);
      this.el.style.left = left + "px";
      this.el.style.top = Math.max(0, rect.top) + "px";
      // A user-dragged height overrides the default (match-the-canvas) height.
      if (!skipHeight) {
        const dockH = globalSettings().dockHeight;
        this.el.style.height = (dockH != null ? dockH : rect.height) + "px";
      }
    },
    add(panel) {
      this.ensure();
      if (!this._panels.includes(panel)) this._panels.push(panel);
      const order = FML._loadDockOrder();
      if (!order.includes(panel.mod.id)) { order.push(panel.mod.id); FML._saveDockOrder(order); }
      this._reorder();
      this.el.classList.add("fml-dock-show");
      this._updateEmpty();
      this.layout();
    },
    remove(panel, forget) {
      const i = this._panels.indexOf(panel);
      if (i >= 0) this._panels.splice(i, 1);
      if (forget) FML._saveDockOrder(FML._loadDockOrder().filter((x) => x !== panel.mod.id));
      if (this.el && panel.el.parentNode === this.el) this.el.removeChild(panel.el);
      this._updateEmpty();
      if (this.el && this._panels.length === 0 && !this._hinting) this.el.classList.remove("fml-dock-show");
    },
    _reorder() {
      const order = FML._loadDockOrder();
      this._panels.sort((a, b) => order.indexOf(a.mod.id) - order.indexOf(b.mod.id));
      for (const p of this._panels) this.el.appendChild(p.el);
    },
    // Live reorder while a docked panel is dragged: place it by pointer Y.
    dragTo(panel, y) {
      const arr = this._panels.filter((p) => p !== panel);
      let idx = arr.length;
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i].el.getBoundingClientRect();
        if (y < r.top + r.height / 2) { idx = i; break; }
      }
      arr.splice(idx, 0, panel);
      if (arr.some((p, i) => this._panels[i] !== p)) {
        this._panels = arr;
        for (const p of this._panels) this.el.appendChild(p.el);
      }
    },
    persistOrder() {
      FML._saveDockOrder(this._panels.map((p) => p.mod.id));
    },
    // --- drag-and-drop docking (panels dock by being dragged over this sidebar) ---
    pointInDock(x, y) {
      if (!this.el) return false;
      const r = this.el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },
    beginDropHint() {
      this.ensure();
      this._hinting = true;
      this.el.classList.add("fml-dock-show");
      this.layout();
      this._updateEmpty();
    },
    endDropHint() {
      this._hinting = false;
      this.highlight(false);
      this._updateEmpty();
      if (this.el && this._panels.length === 0) this.el.classList.remove("fml-dock-show");
    },
    highlight(on) {
      if (this.el) this.el.classList.toggle("fml-dock-hint", !!on);
    },
    _updateEmpty() {
      if (!this.el) return;
      const need = this._hinting && this._panels.length === 0;
      if (need && !this._empty) {
        this._empty = document.createElement("div");
        this._empty.className = "fml-dock-empty";
        this._empty.textContent = "Drop here to dock";
        this.el.appendChild(this._empty);
      } else if (!need && this._empty) {
        this._empty.remove();
        this._empty = null;
      }
    },
  };

  // ---- mod loader -----------------------------------------------------------

  // A GitHub repo URL (…/owner/repo or …/tree/branch) maps to raw candidate bases;
  // any other URL (e.g. http://localhost:8611/) is used as a base directly.
  function normalizeSource(url) {
    url = String(url || "").trim();
    const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+))?\/?$/i);
    if (gh) {
      const branches = gh[3] ? [gh[3]] : ["main", "master"];
      return branches.map((b) => `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${b}/`);
    }
    return [url.endsWith("/") ? url : url + "/"];
  }
  function bust(u) { return u + (u.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(); }
  function injectMod(code, name) {
    const el = document.createElement("script");
    el.textContent = "//# sourceURL=fml-mod/" + (name || "mod") + ".js\n" + code;
    document.documentElement.appendChild(el);
  }

  const loader = {
    sources: [],   // [{ url, base, mods:[{id,name,version,description,entry,_error}], error, loading }]
    _loaded: {},   // "url|id" -> true (already injected this page load)
    key(url, id) { return url + "|" + id; },
    init() {
      this.sources = FML._loadSources().map((url) => ({ url, base: null, mods: [], error: null, loading: true }));
      this.sources.forEach((s) => this.refresh(s));
    },
    async refresh(s) {
      s.loading = true; s.error = null;
      manager.refreshMods();
      let idx = null, base = null;
      for (const c of normalizeSource(s.url)) {
        try {
          const r = await fetch(bust(c + "mods/index.json"), { cache: "no-store" });
          if (!r.ok) continue;
          idx = await r.json(); base = c; break;
        } catch (e) { /* try next candidate */ }
      }
      s.loading = false;
      if (!idx) { s.error = "Couldn't read mods/index.json (check the URL / branch / CORS)."; manager.refreshMods(); return; }
      s.base = base;
      s.mods = (Array.isArray(idx) ? idx : idx.mods || []).filter((m) => m && m.id);
      manager.refreshMods();
      for (const m of s.mods) if (FML._loadModEnabled(this.key(s.url, m.id))) this.load(s, m);
    },
    mod(m) { return FML._mods.find((x) => x.id === m.id) || null; },
    async load(s, m) {
      const k = this.key(s.url, m.id);
      if (!this._loaded[k]) {
        m._error = null;
        const entry = m.entry || ("mods/" + m.id + "/mod.js");
        try {
          const r = await fetch(bust(s.base + entry), { cache: "no-store" });
          if (!r.ok) throw new Error("HTTP " + r.status);
          injectMod(await r.text(), m.id); // runs synchronously → the mod registers now
          this._loaded[k] = true;
        } catch (e) {
          m._error = String((e && e.message) || e);
          manager.refreshMods();
          return;
        }
      }
      // Switch the freshly-registered (or already-loaded) mod ON, overriding any
      // stale saved `enabled:false` - so a single toggle is enough to run it.
      const p = this.mod(m);
      if (p) setConfig(p, "enabled", true);
      manager.refreshMods();
    },
    enable(s, m) { FML._saveModEnabled(this.key(s.url, m.id), true); this.load(s, m); },
    disable(s, m) {
      FML._saveModEnabled(this.key(s.url, m.id), false);
      const p = this.mod(m);
      if (p) setConfig(p, "enabled", false);
      manager.refreshMods();
    },
    isEnabled(s, m) { return FML._loadModEnabled(this.key(s.url, m.id)); },
    // Reset ONE mod to defaults (like "Nuke", scoped): wipe its saved settings +
    // panel position/size/dock, then restart it live so it rebuilds with defaults.
    resetMod(m) {
      const p = this.mod(m);
      const wasActive = !!(p && p._active);
      if (wasActive) setConfig(p, "enabled", false); // onStop: tear down panel/hooks
      FML._nukeMod(m.id);
      if (p) {
        p.config = {};                                // drop in-memory settings
        if (wasActive) setConfig(p, "enabled", true); // onStart: rebuild with defaults
      }
      manager.refreshMods();
    },
    addSource(url) {
      url = String(url || "").trim();
      if (!url || this.sources.some((x) => x.url === url)) return;
      const s = { url, base: null, mods: [], error: null, loading: true };
      this.sources.push(s);
      FML._saveSources(this.sources.map((x) => x.url));
      this.refresh(s);
    },
    removeSource(url) {
      const s = this.sources.find((x) => x.url === url);
      if (s) for (const m of s.mods) this.disable(s, m);
      this.sources = this.sources.filter((x) => x.url !== url);
      FML._saveSources(this.sources.map((x) => x.url));
      manager.refreshMods();
    },
  };

  // ---- namespace ------------------------------------------------------------

  const FML = {
    version: VERSION,
    Mod: FMLMod,
    Panel: FMLPanel,
    List: FMLList,
    util,
    game,
    panelConfig,
    setConfig,
    manager,
    dock,
    loader,
    globalSettings,
    setGlobal,
    onGlobal,
    _globalListeners: (window.FML && window.FML._globalListeners) || [],
    _applyGlobal() {
      dock.applyGlobal();
      for (const p of this._mods) { if (p._panel) { try { p._panel.applySettings(); } catch (e) {} } }
      for (const fn of this._globalListeners.slice()) { try { fn(globalSettings()); } catch (e) {} }
    },
    _mods: (window.FML && window.FML._mods) || [],
    _register(mod) { this._mods.push(mod); },
    _modMeta(id) {
      for (const s of loader.sources) {
        const m = (s.mods || []).find((mm) => mm.id === id);
        if (m) return m;
      }
      return null;
    },
    // FlatMMOPlus itself still calls these "plugins" - that's its own external API name,
    // kept here (registerPlugin) at the boundary so the rest of FML can say "mod".
    _registerWithFlatMMOPlus(mod) {
      if (window.FlatMMOPlus && typeof window.FlatMMOPlus.registerPlugin === "function") {
        window.FlatMMOPlus.registerPlugin(mod);
      } else {
        const iv = setInterval(() => {
          if (window.FlatMMOPlus && typeof window.FlatMMOPlus.registerPlugin === "function") {
            clearInterval(iv);
            window.FlatMMOPlus.registerPlugin(mod);
          }
        }, 250);
      }
    },
    _loadPos(id) {
      try { return JSON.parse(localStorage.getItem(`fml.${id}.pos`)) || null; } catch (e) { return null; }
    },
    _savePos(id, pos) {
      if (pos) localStorage.setItem(`fml.${id}.pos`, JSON.stringify(pos));
      else localStorage.removeItem(`fml.${id}.pos`);
    },
    _loadSize(id) {
      try { return JSON.parse(localStorage.getItem(`fml.${id}.size`)) || null; } catch (e) { return null; }
    },
    _saveSize(id, size) {
      if (size) localStorage.setItem(`fml.${id}.size`, JSON.stringify(size));
      else localStorage.removeItem(`fml.${id}.size`);
    },
    // Panels default to DOCKED. Absent preference → docked; "1"/"0" are explicit
    // choices (so an undock persists instead of reverting to the docked default).
    _loadDocked(id) { const v = localStorage.getItem(`fml.${id}.docked`); return v === null ? true : v === "1"; },
    _saveDocked(id, v) { localStorage.setItem(`fml.${id}.docked`, v ? "1" : "0"); },
    _loadDockOrder() { try { return JSON.parse(localStorage.getItem("fml.dock.order")) || []; } catch (e) { return []; } },
    _saveDockOrder(arr) { localStorage.setItem("fml.dock.order", JSON.stringify(arr)); },
    _loadSources() { try { return JSON.parse(localStorage.getItem("fml.sources")) || []; } catch (e) { return []; } },
    _saveSources(arr) { localStorage.setItem("fml.sources", JSON.stringify(arr)); },
    _loadModEnabled(key) { return localStorage.getItem("fml.mod." + key + ".enabled") === "1"; },
    _saveModEnabled(key, v) { if (v) localStorage.setItem("fml.mod." + key + ".enabled", "1"); else localStorage.removeItem("fml.mod." + key + ".enabled"); },
    // Wipe all loader/mod data (mod configs, panel positions, dock, enabled flags,
    // and legacy keys). Keeps `fml.sources` so mods reappear after the reload.
    _nukeData() {
      const keep = new Set(["fml.sources"]);
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || keep.has(k)) continue;
        if (k.startsWith("fml.") || k.startsWith("flatmmoplus.") || k === "fmmoQuickActionsConfig") kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
      return kill.length;
    },
    // Wipe ONE mod's saved data: its config + all fml.<id>.* keys (panel pos/size/dock
    // and any saved layout). Keeps the loader's enabled flag so the mod stays installed.
    _nukeMod(id) {
      const kill = ["flatmmoplus." + id + ".config"];
      const prefix = "fml." + id + ".";
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
      return kill.length;
    },
  };

  window.FML = FML;
  window.FMLMod = FMLMod;
  window.FMLPanel = FMLPanel;
  window.FMLList = FMLList;

  // Wait for the game UI, then add the launcher + a /fml chat command.
  const bootIv = setInterval(() => {
    if (!document.getElementById("canvas")) return;
    clearInterval(bootIv);
    manager.injectLauncher();
    if (window.FlatMMOPlus && typeof window.FlatMMOPlus.registerCustomChatCommand === "function") {
      window.FlatMMOPlus.registerCustomChatCommand("fml", () => manager.open(), "Open Flat Mod Loader");
    }
    loader.init();
  }, 300);
})();
