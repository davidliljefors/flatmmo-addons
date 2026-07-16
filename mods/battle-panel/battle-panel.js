(function () {
  "use strict";

  const { util, game } = FML;

  function readNpcs() { return game.npcs() || {}; }

  function hpColor(pct) {
    if (pct <= 0.3) return "#e0403a";
    if (pct <= 0.6) return "#e0a92f";
    return "#49c93c";
  }

  const CSS_ID = "fml-battlepanel-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-battle-panel .bp-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 7px; background: rgba(255,255,255,0.05); border: 1px solid transparent; cursor: pointer; transition: background .12s, filter .12s; }
      #fml-battle-panel .bp-row:hover { background: rgba(255,80,80,0.28); filter: brightness(1.08); }
      #fml-battle-panel .bp-row.bp-pinned { background: rgba(240,196,60,0.14); border-color: rgba(240,196,60,0.55); }
      #fml-battle-panel .bp-row.bp-pinned::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; background: #f0c43c; border-radius: 3px; }
      #fml-battle-panel .bp-icon { width: var(--bp-icon, 32px); height: var(--bp-icon, 32px); object-fit: contain; image-rendering: pixelated; flex-shrink: 0; }
      #fml-battle-panel .bp-info { flex: 1 1 auto; min-width: 0; }
      #fml-battle-panel .bp-name { font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
      #fml-battle-panel .bp-hpbar { position: relative; margin-top: 3px; height: 13px; border-radius: 4px; background: rgba(0,0,0,0.45); overflow: hidden; }
      #fml-battle-panel .bp-hpfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: #49c93c; transition: width .15s linear, background .15s; }
      #fml-battle-panel .bp-hptext { position: relative; display: block; text-align: center; font-size: 10px; line-height: 13px; font-weight: bold; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.95); }
      #fml-battle-panel .bp-row.bp-nohp .bp-hpbar { display: none; }
      /* Compact ("one-line") mode: one slim row per enemy - icon + HP bar, name hidden. */
      #fml-battle-panel.bp-compact .bp-row { padding: 2px 4px; gap: 7px; }
      #fml-battle-panel.bp-compact .bp-icon { width: 22px; height: 22px; }
      #fml-battle-panel.bp-compact .bp-name { display: none; }
      #fml-battle-panel.bp-compact .bp-hpbar { margin-top: 0; }
      #fml-battle-panel .bp-empty { padding: 8px 9px; font-size: 12px; color: #8a94a0; text-align: center; }
    `;
    document.head.appendChild(style);
  }

  class BattlePanel extends FML.Plugin {
    constructor() {
      super("battle-panel", {
        config: [
          { id: "iconSize", type: "integer", label: "Enemy icon size (px)", min: 16, max: 64, default: 44 },
          { id: "sortNewestFirst", type: "checkbox", label: "Newest on top", default: false },
          { id: "includeNonCombat", type: "checkbox", label: "Include non-combat NPCs", default: false },
          { id: "showHpBar", type: "checkbox", label: "Show HP bars", default: true },
          { id: "compact", type: "checkbox", label: "Compact mode (one line, icon + HP bar, no name)", default: false },
        ],
      });

      this.firstSeen = {};            // uuid -> first-seen timestamp (screen age)
      this.pinnedTypes = new Set();   // npc.name values pinned to the top
    }

    // ---- lifecycle (from FML.Plugin) ----

    onStart() {
      injectCss();
      this.panel = new FML.Panel(this, { title: "Enemies", collapsible: true, width: 210 });
      this.list = new FML.List(this.panel.body);
      this.panel.mount();
      this.applyIconSize();
      this.applyCompact();
      // NPC positions/HP update via server pushes; poll to reflect them.
      this.every(250, () => this.render());
      this.render();
    }

    onSettings(s) {
      if (this.panel) this.panel.applySettings(s);
      this.applyIconSize();
      this.applyCompact();
      this.render();
    }

    onStop() {
      if (this.panel) this.panel.unmount();
      this.panel = null;
      this.list = null;
      this.firstSeen = {};
      this._empty = null;
    }

    applyIconSize() {
      if (this.panel) this.panel.el.style.setProperty("--bp-icon", (this.settings.iconSize || 32) + "px");
    }

    // Compact ("one-line") mode: name hidden, small icon + HP bar on a single slim row.
    applyCompact() {
      if (this.panel) this.panel.el.classList.toggle("bp-compact", !!this.settings.compact);
    }

    togglePin(name) {
      if (!name) return;
      if (this.pinnedTypes.has(name)) this.pinnedTypes.delete(name);
      else this.pinnedTypes.add(name);
      this.render();
    }

    // ---- data ----

    // Returns the current attackable/visible enemy uuids, recording first-seen
    // times and dropping any that left the screen.
    collectEnemies() {
      const src = readNpcs();
      const now = Date.now();
      const present = new Set();
      const nameByUuid = {};
      const list = [];

      for (const uuid in src) {
        if (!Object.prototype.hasOwnProperty.call(src, uuid)) continue;
        const npc = src[uuid];
        if (!npc || npc.is_hidden) continue;
        const isCombat = (parseInt(npc.max_hp) || 0) > 0;
        if (!isCombat && !this.settings.includeNonCombat) continue;
        present.add(uuid);
        nameByUuid[uuid] = npc.name;
        if (this.firstSeen[uuid] == null) this.firstSeen[uuid] = now;
        list.push(uuid);
      }

      // Forget anyone no longer on screen.
      for (const uuid in this.firstSeen) {
        if (!present.has(uuid)) { delete this.firstSeen[uuid]; this.list.remove(uuid); }
      }

      // Pinned enemy types float to the top, then screen-age order within groups.
      const dir = this.settings.sortNewestFirst ? -1 : 1;
      list.sort((a, b) => {
        const ap = this.pinnedTypes.has(nameByUuid[a]) ? 0 : 1;
        const bp = this.pinnedTypes.has(nameByUuid[b]) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return (this.firstSeen[a] - this.firstSeen[b]) * dir || (a < b ? -1 : 1);
      });
      return list;
    }

    // ---- view ----

    buildRow(uuid) {
      const row = document.createElement("div");
      row.className = "bp-row";

      const icon = document.createElement("img");
      icon.className = "bp-icon";
      icon.draggable = false;
      icon.alt = "";

      const info = document.createElement("div");
      info.className = "bp-info";
      const nameEl = document.createElement("div");
      nameEl.className = "bp-name";
      const bar = document.createElement("div");
      bar.className = "bp-hpbar";
      const fill = document.createElement("div");
      fill.className = "bp-hpfill";
      const hptext = document.createElement("span");
      hptext.className = "bp-hptext";
      bar.append(fill, hptext);
      info.append(nameEl, bar);
      row.append(icon, info);

      row.onclick = () => game.attackNpc(uuid);
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.togglePin(row._name); };

      row._els = { icon, nameEl, fill, hptext };
      row._name = null;
      return row;
    }

    showEmpty(v) {
      if (v) {
        if (!this._empty) {
          this._empty = document.createElement("div");
          this._empty.className = "bp-empty";
          this._empty.textContent = "No enemies nearby";
        }
        if (!this._empty.isConnected) this.panel.body.appendChild(this._empty);
      } else if (this._empty && this._empty.isConnected) {
        this._empty.remove();
      }
    }

    render() {
      if (!this.list) return;
      const uuids = this.collectEnemies();
      this.panel.setTitle("Enemies (" + uuids.length + ")");
      if (this.panel.collapsed) return;

      if (uuids.length === 0) { this.list.clear(); this.showEmpty(true); return; }
      this.showEmpty(false);

      const src = readNpcs();
      for (const uuid of uuids) {
        const npc = src[uuid];
        if (!npc) continue;
        const row = this.list.row(uuid, () => this.buildRow(uuid));
        const e = row._els;

        const name = npc.name;
        if (row._name !== name) { e.icon.src = "images/npcs/" + name + "_stand1.png"; row._name = name; }
        e.nameEl.textContent = util.pretty(npc.label || npc.name);

        const hp = Math.max(0, parseInt(npc.hp) || 0);
        const maxhp = Math.max(0, parseInt(npc.max_hp) || 0);
        const hasHp = this.settings.showHpBar && maxhp > 0;
        row.classList.toggle("bp-nohp", !hasHp);
        if (hasHp) {
          const pct = Math.max(0, Math.min(1, hp / maxhp));
          e.fill.style.width = (pct * 100).toFixed(1) + "%";
          e.fill.style.background = hpColor(pct);
          e.hptext.textContent = hp + " / " + maxhp;
        }
        row.classList.toggle("bp-pinned", this.pinnedTypes.has(name));
      }
      this.list.setOrder(uuids);
    }
  }

  new BattlePanel();
})();
