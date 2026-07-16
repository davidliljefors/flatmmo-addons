(function () {
  "use strict";

  const { util } = FML;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function hms(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => (n < 10 ? "0" : "") + n;
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  }

  const CSS_ID = "fml-loot-tracker-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = el("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-loot-tracker .lt-summary { display: flex; align-items: baseline; gap: 0 4px; font-size: 12px; color: #cdd6e0; padding: 1px 2px 5px; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 3px; }
      #fml-loot-tracker .lt-total { font-size: 14px; font-weight: bold; color: #e6ecf3; }
      #fml-loot-tracker .lt-unit { color: #9fb0c0; }
      #fml-loot-tracker .lt-time { color: #8a94a0; margin-left: auto; }
      #fml-loot-tracker .lt-list { display: flex; flex-direction: column; gap: 2px; }
      #fml-loot-tracker .lt-row { display: flex; align-items: center; gap: 7px; padding: 2px 3px; border-radius: 5px; }
      #fml-loot-tracker .lt-row:hover { background: rgba(255,255,255,0.06); }
      #fml-loot-tracker .lt-icon { width: 22px; height: 22px; object-fit: contain; image-rendering: pixelated; flex: 0 0 auto; }
      #fml-loot-tracker .lt-name { flex: 1 1 auto; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #fml-loot-tracker .lt-qty { font-size: 12px; font-weight: bold; color: #dfe6ee; flex: 0 0 auto; }
    `;
    document.head.appendChild(style);
  }

  class LootTracker extends FML.Mod {
    constructor() {
      super("loot-tracker", {
        config: [
          {
            id: "sortBy", type: "select", label: "Sort by", default: "quantity",
            options: [
              { value: "quantity", label: "Quantity" },
              { value: "name", label: "Name" },
            ],
          },
        ],
      });

      this.loot = {};                     // itemName -> total amount looted this session
      this.startAt = 0;
      this._seen = Object.create(null);   // ground-item uuid -> true (dedupe re-syncs)
      this._pending = [];                 // recent NEW drops awaiting a kill sound: { item, amount, at }
    }

    // ---- lifecycle ----

    onStart() {
      injectCss();
      this.loot = {};
      this.startAt = Date.now();
      this._seen = Object.create(null);
      this._pending = [];
      this.seedSeenGround();

      this.panel = new FML.Panel(this, { title: "Loot", collapsible: true, width: 220 });
      this.panel.addMenuItem({ label: "Reset loot", onClick: () => this.reset() });

      this.summaryEl = el("div", "lt-summary");
      this.listWrap = el("div", "lt-list");
      this.panel.body.append(this.summaryEl, this.listWrap);
      this.list = new FML.List(this.listWrap);

      this.panel.mount();
      this.every(1000, () => this.render()); // keep the elapsed clock ticking
      this.render();
    }

    onSettings(s) {
      if (this.panel) this.panel.applySettings(s);
      this.render();
    }

    onStop() {
      if (this.panel) this.panel.unmount();
      this.panel = null;
      this.list = null;
      this.loot = {};
      this._seen = Object.create(null);
      this._pending = [];
    }

    // ---- data ----

    onMessageReceived(data) {
      if (!this.panel || typeof data !== "string") return;

      // A RESET_GROUND_ITEMS begins a fresh batch of ground items; the NEW drops in that
      // batch (deduped by uuid) become your loot when the kill sound fires.
      if (data.startsWith("RESET_GROUND_ITEMS")) this._pending = [];
      else if (data.startsWith("ADD_GROUND_ITEM=")) this.noteDrop(data);
      else if (data.startsWith("PLAY_SOUND=kill.mp3")) this.bankKillLoot();
    }

    // Buffer a NEW ground drop (unseen uuid) in the current batch. Re-syncs of
    // already-seen items are skipped so a re-sync never recounts the same pile.
    noteDrop(data) {
      const v = data.substring("ADD_GROUND_ITEM=".length).split("~");
      const uuid = v[0], item = v[1], amount = parseInt(v[2]);
      if (!uuid || !item || isNaN(amount) || this._seen[uuid]) return;
      this._seen[uuid] = true;
      this._pending.push({ item, amount });
    }

    // A kill just happened → the new drops collected since the last ground reset are
    // this kill's loot.
    bankKillLoot() {
      if (!this._pending.length) return;
      for (const d of this._pending) this.add(d.item, d.amount);
      this._pending = [];
      this.render();
    }

    // Mark the ground items already on screen as "seen" so the first re-sync doesn't
    // bank pre-existing / other players' drops as your loot.
    seedSeenGround() {
      try {
        if (typeof ground_items !== "undefined" && Array.isArray(ground_items)) {
          for (const g of ground_items) if (g && g.uuid) this._seen[g.uuid] = true;
        }
      } catch (e) { /* ground_items not reachable */ }
    }

    add(item, amount) {
      if (!item || isNaN(amount) || amount <= 0) return;
      this.loot[item] = (this.loot[item] || 0) + amount;
    }

    reset() {
      this.loot = {};
      this.startAt = Date.now();
      this._seen = Object.create(null);
      this._pending = [];
      if (this.list) this.list.clear();
      this.render();
    }

    sortedKeys() {
      const by = this.settings.sortBy || "quantity";
      const keys = Object.keys(this.loot);
      if (by === "name") keys.sort((a, b) => util.pretty(a).localeCompare(util.pretty(b)));
      else keys.sort((a, b) => this.loot[b] - this.loot[a]);
      return keys;
    }

    // ---- view ----

    render() {
      if (!this.panel) return;

      let totalQty = 0;
      for (const it in this.loot) totalQty += this.loot[it];
      const elapsed = this.startAt ? Date.now() - this.startAt : 0;

      this.summaryEl.innerHTML = "";
      this.summaryEl.appendChild(el("span", "lt-total", util.fmt(totalQty)));
      this.summaryEl.appendChild(el("span", "lt-unit", totalQty === 1 ? " item" : " items"));
      this.summaryEl.appendChild(el("span", "lt-time", hms(elapsed)));

      const keys = this.sortedKeys();
      if (!keys.length) return;

      for (const it of keys) {
        const row = this.list.row(it, () => this.buildRow(it));
        row._qty.textContent = "\u00D7" + util.fmt(this.loot[it]);
      }
      this.list.setOrder(keys);
    }

    buildRow(item) {
      const row = el("div", "lt-row");
      const img = el("img", "lt-icon");
      img.src = `images/items/${item}.png`;
      img.alt = "";
      const name = el("span", "lt-name", util.pretty(item));
      const qty = el("span", "lt-qty");
      row.append(img, name, qty);
      row._qty = qty;
      return row;
    }
  }

  new LootTracker();
})();
