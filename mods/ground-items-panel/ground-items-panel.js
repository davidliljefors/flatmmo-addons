(function () {
  "use strict";

  const { util, game } = FML;

  function readGroundItems() { return game.groundItems() || []; }

  const CSS_ID = "fml-grounditemspanel-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-ground-items-panel .gip-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 7px; background: rgba(255,255,255,0.05); border: 1px solid transparent; cursor: pointer; transition: background .12s, filter .12s; }
      #fml-ground-items-panel .gip-row:hover { background: rgba(80,180,255,0.24); filter: brightness(1.08); }
      #fml-ground-items-panel .gip-row.gip-pinned { background: rgba(240,196,60,0.14); border-color: rgba(240,196,60,0.55); }
      #fml-ground-items-panel .gip-row.gip-pinned::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; background: #f0c43c; border-radius: 3px; }
      #fml-ground-items-panel .gip-icon { width: var(--gip-icon, 32px); height: var(--gip-icon, 32px); object-fit: contain; image-rendering: pixelated; flex-shrink: 0; }
      #fml-ground-items-panel .gip-name { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
      #fml-ground-items-panel .gip-qty { font-size: 12px; font-weight: bold; color: #9fb0c0; flex: 0 0 auto; }
      #fml-ground-items-panel .gip-empty { padding: 8px 9px; font-size: 12px; color: #8a94a0; text-align: center; }
    `;
    document.head.appendChild(style);
  }

  class GroundItemsPanel extends FML.Mod {
    constructor() {
      super("ground-items-panel", {
        config: [
          { id: "iconSize", type: "integer", label: "Item icon size (px)", min: 16, max: 64, default: 32 },
          { id: "sortNewestFirst", type: "checkbox", label: "Newest on top", default: false },
          { id: "showQty", type: "checkbox", label: "Show quantity", default: true },
        ],
      });

      this.firstSeen = {};           // uuid -> first-seen timestamp (screen age)
      this.pinnedNames = new Set();  // item names pinned to the top
    }

    // ---- lifecycle (from FML.Mod) ----

    onStart() {
      injectCss();
      this.panel = new FML.Panel(this, { title: "Ground Items", collapsible: true, width: 210 });
      this.list = new FML.List(this.panel.body);
      this.panel.mount();
      this.applyIconSize();
      // Ground items sync via server pushes (RESET_GROUND_ITEMS + ADD_GROUND_ITEM); poll to reflect them.
      this.every(250, () => this.render());
      this.render();
    }

    onSettings(s) {
      if (this.panel) this.panel.applySettings(s);
      this.applyIconSize();
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
      if (this.panel) this.panel.el.style.setProperty("--gip-icon", (this.settings.iconSize || 32) + "px");
    }

    togglePin(name) {
      if (!name) return;
      if (this.pinnedNames.has(name)) this.pinnedNames.delete(name);
      else this.pinnedNames.add(name);
      this.render();
    }

    // ---- data ----

    // Returns the current on-screen ground-item uuids, recording first-seen times and
    // dropping any that are no longer present (picked up, or fell out of range).
    collectItems() {
      const src = readGroundItems();
      const now = Date.now();
      const present = new Set();
      const nameByUuid = {};
      const list = [];

      for (const g of src) {
        if (!g || !g.uuid) continue;
        present.add(g.uuid);
        nameByUuid[g.uuid] = g.name;
        if (this.firstSeen[g.uuid] == null) this.firstSeen[g.uuid] = now;
        list.push(g.uuid);
      }

      for (const uuid in this.firstSeen) {
        if (!present.has(uuid)) { delete this.firstSeen[uuid]; this.list.remove(uuid); }
      }

      // Pinned item names float to the top, then screen-age order within groups.
      const dir = this.settings.sortNewestFirst ? -1 : 1;
      list.sort((a, b) => {
        const ap = this.pinnedNames.has(nameByUuid[a]) ? 0 : 1;
        const bp = this.pinnedNames.has(nameByUuid[b]) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return (this.firstSeen[a] - this.firstSeen[b]) * dir || (a < b ? -1 : 1);
      });
      return list;
    }

    // ---- view ----

    buildRow(uuid) {
      const row = document.createElement("div");
      row.className = "gip-row";

      const icon = document.createElement("img");
      icon.className = "gip-icon";
      icon.draggable = false;
      icon.alt = "";

      const nameEl = document.createElement("div");
      nameEl.className = "gip-name";
      const qtyEl = document.createElement("div");
      qtyEl.className = "gip-qty";

      row.append(icon, nameEl, qtyEl);

      // Clicking the row is the same as clicking the item on the ground.
      row.onclick = () => game.clickGroundItem(uuid);
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.togglePin(row._name); };

      row._els = { icon, nameEl, qtyEl };
      row._name = null;
      return row;
    }

    showEmpty(v) {
      if (v) {
        if (!this._empty) {
          this._empty = document.createElement("div");
          this._empty.className = "gip-empty";
          this._empty.textContent = "No items on the ground";
        }
        if (!this._empty.isConnected) this.panel.body.appendChild(this._empty);
      } else if (this._empty && this._empty.isConnected) {
        this._empty.remove();
      }
    }

    render() {
      if (!this.list) return;
      const uuids = this.collectItems();
      this.panel.setTitle("Ground Items (" + uuids.length + ")");
      if (this.panel.collapsed) return;

      if (uuids.length === 0) { this.list.clear(); this.showEmpty(true); return; }
      this.showEmpty(false);

      const byUuid = {};
      for (const g of readGroundItems()) if (g && g.uuid) byUuid[g.uuid] = g;

      for (const uuid of uuids) {
        const g = byUuid[uuid];
        if (!g) continue;
        const row = this.list.row(uuid, () => this.buildRow(uuid));
        const e = row._els;

        if (row._name !== g.name) { e.icon.src = "images/items/" + g.name + ".png"; row._name = g.name; }
        e.nameEl.textContent = util.pretty(g.name);
        const qty = parseInt(g.amount) || 0;
        e.qtyEl.textContent = this.settings.showQty && qty > 1 ? "\u00D7" + util.fmt(qty) : "";
        row.classList.toggle("gip-pinned", this.pinnedNames.has(g.name));
      }
      this.list.setOrder(uuids);
    }
  }

  new GroundItemsPanel();
})();
