(function () {
  "use strict";

  // --- talking to the game --------------------------------------------------
  const send = (cmd) => Globals.websocket.send(cmd);
  const openPanel = (id) => window.FlatMMOPlus.setPanel(id);
  const readInt = (node) => (node ? parseInt(node.textContent, 10) || 0 : 0);

  const worship = {
    level: () => readInt(document.getElementById("ui-skill-worship-level")),
    // NB: the game element really is spelled "warship-points".
    points: () => readInt(document.querySelector('display-backend-value[data-id="warship-points"]')),
  };

  // Worship perks are triggered by clicking their real tile. If the Worship tab
  // was never opened this session the tile isn't in the DOM, so hop over, click,
  // and hop back to wherever the player was.
  function fireWorshipTile(slug) {
    const find = () => document.querySelector(`#ui-panel-worship-content img[src*="${slug}"]`);
    const here = find();
    if (here) return (here.closest(".worship-entry") || here).click();
    const back = window.FlatMMOPlus && window.FlatMMOPlus.currentPanel;
    openPanel("worship");
    setTimeout(() => {
      const t = find();
      if (t) (t.closest(".worship-entry") || t).click();
      if (back) openPanel(back);
    }, 150);
  }

  function openBindingsModal() {
    if (typeof window.close_modal === "function") {
      try { window.close_modal("settings-modal"); } catch (_) { /* wasn't open */ }
    }
    if (typeof window.open_key_bindings_modal === "function") window.open_key_bindings_modal();
  }

  // --- the action catalog ---------------------------------------------------
  // Factories build tiny action objects. Each carries an icon + fire(). A worship
  // perk also reports its unlock level and, when short on points, why it's blocked.
  const GROUPS = ["Worship", "Teleport scrolls", "Utility"];

  const perk = (id, name, tile, unlock, cost) => ({
    id, name, group: "Worship",
    icon: `images/worship/${tile}.png`,
    unlock,
    blockedReason: () => (worship.points() < cost ? `needs ${cost} worship point${cost === 1 ? "" : "s"}` : null),
    fire() { if (worship.points() >= cost) fireWorshipTile(tile); },
  });
  const teleScroll = (id, name, item, icon) => ({
    id, name, group: "Teleport scrolls",
    icon: icon || `images/items/${item}.png`,
    fire: () => send("TELE_BOOK=" + item),
  });
  const tool = (id, name, icon, fire) => ({ id, name, group: "Utility", icon, fire });

  const CATALOG = [
    perk("everbrook", "Everbrook", "teleport_everbrook", 5, 3),
    perk("mystic_vale", "Mystic Vale", "teleport_mysticvale", 10, 3),
    perk("omboko", "Omboko", "teleport_omboko", 20, 3),
    perk("dock_haven", "Dock Haven", "teleport_dock_haven", 25, 3),
    perk("jafa_outpost", "Jafa Outpost", "teleport_jafa_outpost", 40, 3),
    perk("frostvale", "Frostvale", "teleport_frostvale", 45, 3),
    perk("mass_pickup", "Mass Pickup", "mass_pickup", 55, 1),
    perk("dig", "Dig", "dig", 9, 0),
    perk("remote_sell", "Remote Sell", "remote_sell", 7, 5),
    perk("timers", "Timers", "timers", 15, 0),
    perk("focus", "Focus", "focus", 30, 5),
    perk("hell_bury", "Hell Bury", "auto_hell_burying", 35, 0),
    perk("clarity", "Clarity", "clarity", 60, 15),
    teleScroll("chefs_house", "Chef\u2019s House", "chefs_house_teleport_scroll", "images/items/chefs_hat.png"),
    teleScroll("thieves_hideout", "Thieves Hideout", "thieves_hideout_teleport_scroll", "images/icons/stealing.png"),
    teleScroll("greenhouse", "Greenhouse", "greenhouse_teleport_scroll", "images/icons/farming.png"),
    teleScroll("rogues_grave", "Rogue\u2019s Grave", "rogue_teleport_scroll", "images/items/sand.png"),
    teleScroll("phantos_mansion", "Phantos Mansion", "phantos_teleport_scroll", "images/ui/cemetery_child.png"),
    tool("stuck", "Stuck", null, () => send("CHAT=/stuck")),
    tool("hunting", "Hunting", "images/icons/hunting_large.png", () => openPanel("hunting")),
    tool("keybinds", "Key Bindings", "images/ui/settings.png", openBindingsModal),
  ];
  // NB: FlatMMO's maps.js defines a global `class Map`, which SHADOWS the built-in
  // Map in page context - so `new Map()` here would NOT be a real Map. Use a plain
  // null-prototype lookup that exposes the same .has()/.get() we rely on.
  const _byId = Object.create(null);
  CATALOG.forEach((a) => { _byId[a.id] = a; });
  const BY_ID = { has: (id) => id in _byId, get: (id) => _byId[id] };

  // --- saved bar ------------------------------------------------------------
  // { columns:int, bar:[actionId], keys:{ actionId: "Ctrl+KeyD" } }
  const STORE = "fml.hotbar.bar";
  const STARTER = ["stuck", "hunting", "keybinds", "dig"];

  const clampCols = (n) => Math.max(1, Math.min(12, parseInt(n, 10) || 5));
  const safeParse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; } };

  function freshBar() { return { columns: 5, bar: STARTER.filter((id) => BY_ID.has(id)), keys: {} }; }

  function sanitize(cfg) {
    const seen = new Set();
    const bar = [];
    (cfg.bar || []).forEach((id) => {
      if (BY_ID.has(id) && !seen.has(id)) { seen.add(id); bar.push(id); }
    });
    const keys = {};
    Object.entries(cfg.keys || {}).forEach(([id, combo]) => {
      if (BY_ID.has(id) && typeof combo === "string" && combo) keys[id] = combo;
    });
    return { columns: clampCols(cfg.columns), bar, keys };
  }

  function readBar() {
    const direct = safeParse(localStorage.getItem(STORE));
    if (direct && Array.isArray(direct.bar)) return sanitize(direct);
    return freshBar();
  }

  const saveBar = (cfg) => localStorage.setItem(STORE, JSON.stringify(cfg));

  // --- hotkey helpers -------------------------------------------------------
  function comboFor(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(e.code);
    return parts.join("+");
  }
  const comboText = (combo) => (combo || "").split("+")
    .map((p) => (p.startsWith("Key") ? p.slice(3) : p.startsWith("Digit") ? p.slice(5) : p))
    .join(" + ");
  function typingInto(t) {
    const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || (t && t.isContentEditable);
  }

  // Tiny DOM shorthand.
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const CSS_ID = "fml-hotbar-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = el("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-hotbar .fml-body { flex-direction: column; gap: 6px; }
      #fml-hotbar .hb-grid { display: grid; grid-template-columns: repeat(var(--hb-cols, 5), minmax(0, 1fr)); gap: 6px; }
      #fml-hotbar .hb-tile { width: 100%; aspect-ratio: 1 / 1; box-sizing: border-box; display: grid; place-items: center; padding: 3px; border-radius: 8px; cursor: pointer; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.15); color: #e7edf4; transition: background .12s, transform .05s; }
      #fml-hotbar .hb-tile:hover { background: rgba(255,255,255,0.17); }
      #fml-hotbar .hb-tile:active { transform: translateY(1px); }
      #fml-hotbar .hb-tile:disabled { cursor: default; }
      #fml-hotbar .hb-tile.hb-blocked { opacity: 0.38; filter: grayscale(80%); }
      #fml-hotbar .hb-img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
      #fml-hotbar .hb-word { font-size: 10px; font-weight: 700; text-align: center; line-height: 1.05; letter-spacing: .02em; }
      #fml-hotbar .hb-empty { font-size: 12px; color: #9fb0c0; padding: 6px 2px; }

      .hb-overlay { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,0.55); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 12px 12px; box-sizing: border-box; }
      .hb-box { width: 470px; max-width: 100%; max-height: 84vh; overflow-y: auto; overscroll-behavior: contain; background: #12161c; color: #e6ecf3; border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; padding: 14px 16px; font-family: sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
      .hb-head { display: flex; align-items: center; margin-bottom: 10px; }
      .hb-heading { flex: 1 1 auto; font-size: 15px; font-weight: 700; }
      .hb-x { cursor: pointer; color: #9fb0c0; font-weight: bold; font-size: 18px; line-height: 1; }
      .hb-x:hover { color: #e0403a; }
      .hb-cols { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #b9c4d0; margin-bottom: 8px; }
      .hb-num { width: 58px; padding: 3px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.18); background: #0d1117; color: #e6ecf3; }
      .hb-sec { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #7f8b99; margin: 12px 0 6px; }
      .hb-group { font-size: 12px; font-weight: 700; color: #cfe3ff; margin: 9px 0 3px; }
      .hb-barlist { display: flex; flex-direction: column; gap: 4px; }
      .hb-brow, .hb-arow { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; font-size: 13px; }
      .hb-brow { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); }
      .hb-arow { background: rgba(255,255,255,0.03); }
      .hb-brow.hb-dragging { opacity: 0.5; }
      .hb-brow.hb-drop-top { box-shadow: inset 0 2px 0 #6ab0ff; }
      .hb-brow.hb-drop-bottom { box-shadow: inset 0 -2px 0 #6ab0ff; }
      .hb-grip { cursor: grab; color: #6f7c8a; flex: 0 0 auto; }
      .hb-rowicon { width: 22px; height: 22px; object-fit: contain; image-rendering: pixelated; flex: 0 0 auto; }
      .hb-rowicon-empty { display: inline-block; }
      .hb-rowname { flex: 1 1 auto; min-width: 0; }
      .hb-rowname.hb-locked { color: #7f8b99; }
      .hb-key { min-width: 84px; padding: 3px 8px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16); color: #dfe6ee; font-size: 11px; }
      .hb-key:hover { background: rgba(255,255,255,0.16); }
      .hb-key-x { cursor: pointer; background: none; border: none; color: #9fb0c0; font-size: 14px; padding: 0 2px; }
      .hb-key-x:hover { color: #e0403a; }
      .hb-remove, .hb-add { padding: 3px 11px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 700; border: 1px solid rgba(255,255,255,0.18); }
      .hb-remove { background: rgba(224,64,58,0.16); border-color: rgba(224,64,58,0.4); color: #ffd7d4; }
      .hb-remove:hover { background: rgba(224,64,58,0.4); }
      .hb-add { background: rgba(60,150,90,0.18); border-color: rgba(60,150,90,0.45); color: #cdf3d8; }
      .hb-add:hover { background: rgba(60,150,90,0.4); }
      .hb-add:disabled { opacity: 0.4; cursor: default; }
      .hb-note { font-size: 12px; color: #8a94a0; padding: 4px 2px; }
      .hb-foot { display: flex; gap: 8px; margin-top: 14px; }
      .hb-flat { padding: 6px 14px; border-radius: 7px; cursor: pointer; font-weight: 700; font-size: 12px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.1); color: #e6ecf3; }
      .hb-flat:hover { background: rgba(255,255,255,0.2); }
      .hb-reset { margin-right: auto; }
      .hb-done { background: #2b6cb0; border-color: #3b82c4; }
    `;
    document.head.appendChild(style);
  }

  class Hotbar extends FML.Mod {
    constructor() {
      super("hotbar", {
        config: [],
      });

      this.cfg = readBar();
      this._keyHandler = null;
      this._pointsWatch = null;
      this._pointsTimer = null;
      this._binding = false;   // a hotkey is being recorded
      this._modal = null;      // { restore() }
      this._content = null;    // customiser content container
      this._drag = null;       // id of the row being dragged
    }

    // --- lifecycle ---
    onStart() {
      injectCss();
      this.panel = new FML.Panel(this, { title: "Hotbar", collapsible: true, width: 240 });
      this.panel.addMenuItem({ label: "Customize\u2026", onClick: () => this.openCustomizer() });
      this.panel.mount();
      this.bindKeys();
      this.watchPoints();
      this.paint();
    }

    onSettings(s) {
      if (this.panel) this.panel.applySettings(s);
      this.paint();
    }

    onStop() {
      this.unbindKeys();
      if (this._pointsWatch) { this._pointsWatch.disconnect(); this._pointsWatch = null; }
      if (this._pointsTimer) { clearTimeout(this._pointsTimer); this._pointsTimer = null; }
      this.closeCustomizer();
      if (this.panel) this.panel.unmount();
      this.panel = null;
    }

    save() { saveBar(this.cfg); this.paint(); }

    // --- the bar ---
    paint() {
      if (!this.panel) return;
      const cols = clampCols(this.cfg.columns);
      // Columns drive a 1fr grid, so N tiles fill the panel's CURRENT width exactly
      // (each tile is square via aspect-ratio). Drag the panel corner to set the width.
      this.panel.el.style.setProperty("--hb-cols", cols);

      const body = this.panel.body;
      body.innerHTML = "";
      const ids = this.cfg.bar.filter((id) => BY_ID.has(id));
      if (!ids.length) {
        body.appendChild(el("div", "hb-empty", "Empty bar - open \u2630 \u2192 Customize\u2026"));
        return;
      }
      const grid = el("div", "hb-grid");
      ids.forEach((id) => grid.appendChild(this.tile(id)));
      body.appendChild(grid);
      this.reflectGates();
    }

    tile(id) {
      const a = BY_ID.get(id);
      const btn = el("button", "hb-tile");
      btn.title = a.name;
      btn.dataset.id = id;
      if (a.icon) {
        const img = el("img", "hb-img");
        img.src = a.icon;
        img.alt = a.name;
        btn.appendChild(img);
      } else {
        btn.appendChild(el("span", "hb-word", a.name));
      }
      btn.onclick = () => a.fire();
      return btn;
    }

    // Dim any worship tile the player can't currently afford. Driven live by a
    // MutationObserver on the game's worship-points readout.
    reflectGates() {
      if (!this.panel) return;
      this.panel.body.querySelectorAll(".hb-tile").forEach((btn) => {
        const a = BY_ID.get(btn.dataset.id);
        const why = a && a.blockedReason ? a.blockedReason() : null;
        btn.classList.toggle("hb-blocked", !!why);
        btn.disabled = !!why;
        btn.title = why ? `${a.name} - ${why}` : (a ? a.name : "");
      });
    }

    watchPoints() {
      const node = document.querySelector('display-backend-value[data-id="warship-points"]');
      if (!node) { this._pointsTimer = setTimeout(() => this.watchPoints(), 500); return; }
      if (this._pointsWatch) return;
      this._pointsWatch = new MutationObserver(() => this.reflectGates());
      this._pointsWatch.observe(node, { childList: true, characterData: true, subtree: true });
    }

    // --- hotkeys ---
    bindKeys() {
      this._keyHandler = (e) => {
        if (this._binding || this._modal) return;
        if (typingInto(e.target)) return;
        const combo = comboFor(e);
        const id = Object.keys(this.cfg.keys).find((k) => this.cfg.keys[k] === combo);
        if (id && BY_ID.has(id)) { e.preventDefault(); e.stopPropagation(); BY_ID.get(id).fire(); }
      };
      document.addEventListener("keydown", this._keyHandler, true);
    }
    unbindKeys() {
      if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
    }

    // --- customiser modal ---
    openCustomizer() {
      if (this._modal) return;
      injectCss();
      const overlay = el("div", "hb-overlay");
      overlay.id = "fml-hb-modal";
      const prevOverflow = document.documentElement.style.overflow;
      this._modal = { restore: () => { overlay.remove(); document.documentElement.style.overflow = prevOverflow; this._modal = null; this._content = null; } };
      overlay.onclick = (e) => { if (e.target === overlay) this.closeCustomizer(); };

      const box = el("div", "hb-box");
      const head = el("div", "hb-head");
      head.appendChild(el("div", "hb-heading", "Customize Hotbar"));
      const x = el("span", "hb-x", "\u00D7");
      x.onclick = () => this.closeCustomizer();
      head.appendChild(x);
      box.appendChild(head);

      const cols = el("div", "hb-cols");
      cols.appendChild(el("label", null, "Columns"));
      const num = el("input", "hb-num");
      num.type = "number"; num.min = "1"; num.max = "12"; num.value = clampCols(this.cfg.columns);
      num.onchange = () => { this.cfg.columns = clampCols(num.value); num.value = this.cfg.columns; this.save(); };
      cols.appendChild(num);
      box.appendChild(cols);

      this._content = el("div", "hb-content");
      box.appendChild(this._content);
      this.renderCustomizer();

      const foot = el("div", "hb-foot");
      const reset = el("button", "hb-flat hb-reset", "Reset");
      reset.onclick = () => { this.cfg = freshBar(); num.value = this.cfg.columns; this.save(); this.renderCustomizer(); };
      const done = el("button", "hb-flat hb-done", "Done");
      done.onclick = () => this.closeCustomizer();
      foot.append(reset, done);
      box.appendChild(foot);

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      document.documentElement.style.overflow = "hidden";
    }

    closeCustomizer() {
      this._binding = false;
      if (this._modal) this._modal.restore();
    }

    renderCustomizer() {
      const root = this._content;
      if (!root) return;
      root.innerHTML = "";

      root.appendChild(el("div", "hb-sec", "Hotbar - Drag to reorder"));
      const list = el("div", "hb-barlist");
      if (!this.cfg.bar.length) {
        list.appendChild(el("div", "hb-note", "Nothing here yet - add actions below."));
      } else {
        this.cfg.bar.forEach((id) => { if (BY_ID.has(id)) list.appendChild(this.barRow(BY_ID.get(id))); });
      }
      root.appendChild(list);

      root.appendChild(el("div", "hb-sec", "Add actions"));
      const onBar = new Set(this.cfg.bar);
      const level = worship.level();
      GROUPS.forEach((group) => {
        const items = CATALOG.filter((a) => a.group === group && !onBar.has(a.id));
        if (!items.length) return;
        root.appendChild(el("div", "hb-group", group));
        items.forEach((a) => root.appendChild(this.addRow(a, level)));
      });
    }

    barRow(a) {
      const row = el("div", "hb-brow");
      row.dataset.id = a.id;
      row.draggable = true;

      row.appendChild(el("span", "hb-grip", "\u283F"));
      row.appendChild(this.rowIcon(a));
      row.appendChild(el("span", "hb-rowname", a.name));

      const key = el("button", "hb-key");
      const paintKey = () => { const c = this.cfg.keys[a.id]; key.textContent = c ? comboText(c) : "Set key"; };
      paintKey();
      key.onclick = () => this.recordKey(a.id, key, paintKey);
      row.appendChild(key);

      const clearKey = el("button", "hb-key-x", "\u00D7");
      clearKey.title = "Clear hotkey";
      clearKey.onclick = () => { delete this.cfg.keys[a.id]; paintKey(); this.save(); };
      row.appendChild(clearKey);

      const remove = el("button", "hb-remove", "Remove");
      remove.onclick = () => this.removeFromBar(a.id);
      row.appendChild(remove);

      this.wireReorder(row);
      return row;
    }

    addRow(a, level) {
      const row = el("div", "hb-arow");
      row.appendChild(this.rowIcon(a));
      const locked = a.unlock != null && level < a.unlock;
      const name = el("span", "hb-rowname" + (locked ? " hb-locked" : ""), locked ? `${a.name} \u00B7 lvl ${a.unlock}` : a.name);
      row.appendChild(name);
      const add = el("button", "hb-add", locked ? "Locked" : "Add");
      add.disabled = locked;
      add.onclick = () => this.addToBar(a.id);
      row.appendChild(add);
      return row;
    }

    rowIcon(a) {
      if (a.icon) { const img = el("img", "hb-rowicon"); img.src = a.icon; img.alt = ""; return img; }
      return el("span", "hb-rowicon hb-rowicon-empty");
    }

    // --- bar mutations ---
    addToBar(id) {
      if (!BY_ID.has(id) || this.cfg.bar.includes(id)) return;
      this.cfg.bar.push(id);
      this.save();
      this.renderCustomizer();
    }
    removeFromBar(id) {
      this.cfg.bar = this.cfg.bar.filter((x) => x !== id);
      delete this.cfg.keys[id];
      this.save();
      this.renderCustomizer();
    }
    moveInBar(fromId, toId, after) {
      if (!fromId || fromId === toId) return;
      const bar = this.cfg.bar;
      const from = bar.indexOf(fromId);
      if (from < 0) return;
      bar.splice(from, 1);
      let to = bar.indexOf(toId);
      if (to < 0) to = bar.length - 1;
      bar.splice(after ? to + 1 : to, 0, fromId);
      this.save();
      this.renderCustomizer();
    }

    wireReorder(row) {
      const clearMarks = () => this._content.querySelectorAll(".hb-drop-top, .hb-drop-bottom")
        .forEach((r) => r.classList.remove("hb-drop-top", "hb-drop-bottom"));
      row.addEventListener("dragstart", (e) => { this._drag = row.dataset.id; e.dataTransfer.effectAllowed = "move"; row.classList.add("hb-dragging"); });
      row.addEventListener("dragend", () => { row.classList.remove("hb-dragging"); clearMarks(); });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const below = e.clientY > r.top + r.height / 2;
        row.classList.toggle("hb-drop-bottom", below);
        row.classList.toggle("hb-drop-top", !below);
      });
      row.addEventListener("dragleave", () => row.classList.remove("hb-drop-top", "hb-drop-bottom"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const below = e.clientY > r.top + r.height / 2;
        clearMarks();
        this.moveInBar(this._drag, row.dataset.id, below);
      });
    }

    recordKey(id, btn, repaint) {
      btn.textContent = "Press a key\u2026";
      this._binding = true;
      const onKey = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (["Control", "Alt", "Shift", "Meta"].includes(ev.key)) return; // wait for the real key
        if (ev.key !== "Escape") this.cfg.keys[id] = comboFor(ev);
        document.removeEventListener("keydown", onKey, true);
        this._binding = false;
        repaint();
        this.save();
      };
      document.addEventListener("keydown", onKey, true);
    }
  }

  new Hotbar();
})();
