(function () {
  "use strict";

  const { util } = FML;

  // ticks: 1 tick = 500ms, 2 ticks = 1 second. Compact single-unit label: "2h", "13m", "53s".
  function formatTime(ticks) {
    const s = Math.max(0, Math.floor(ticks / 2));
    if (s >= 3600) return Math.floor(s / 3600) + "h";
    if (s >= 60) return Math.floor(s / 60) + "m";
    return s + "s";
  }

  const CSS_ID = "fml-buffpanel-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
      #ui-potions { display: none !important; }
      #fml-buff-panel .fml-body { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
      #fml-buff-panel .bp-slot { box-sizing: border-box; width: var(--bp-size, 44px); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 3px 2px 2px; border-radius: 6px; border: 1px solid var(--bp-normal-border); background: var(--bp-normal-bg); box-shadow: 0 1px 4px rgba(0,0,0,0.4); transition: background .2s, border-color .2s; }
      #fml-buff-panel .bp-slot.bp-warn { border-color: var(--bp-warn-border); background: var(--bp-warn-bg); animation: bp-pulse 1s ease-in-out infinite; }
      #fml-buff-panel .bp-icon { width: calc(var(--bp-size, 44px) * 0.64); height: auto; image-rendering: pixelated; }
      #fml-buff-panel .bp-time { margin-top: 2px; width: 100%; text-align: center; white-space: nowrap; overflow: hidden; font-family: sans-serif; font-size: 12px; font-weight: bold; line-height: 1; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
      #fml-buff-panel .bp-empty { padding: 6px 8px; font-size: 12px; color: #8a94a0; }
      @keyframes bp-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.55); } }
    `;
    document.head.appendChild(style);
  }

  class BuffPanel extends FML.Plugin {
    constructor() {
      super("buff-panel", {
        config: [
          { id: "size", type: "integer", label: "Icon slot size (px)", min: 24, max: 80, default: 44 },
          { id: "warnSeconds", type: "integer", label: "Low-time warning (seconds)", min: 0, max: 600, default: 30 },
          { id: "normalColor", type: "color", label: "Normal background", default: "#9b0074" },
          { id: "warnColor", type: "color", label: "Low-time background", default: "#b00020" },
        ],
      });

      this.localTimers = {};   // { name: ticksRemaining }, decremented locally
      this.slotEls = {};       // { name: HTMLElement }
      this._order = "";        // current DOM order (sorted by remaining ticks)
    }

    // ---- lifecycle (from FML.Plugin) ----

    onStart() {
      injectCss();
      this.panel = new FML.Panel(this, { title: "Buffs", collapsible: true, width: 220 });
      this.applyColors();
      this.panel.mount();
      // Authoritative timers arrive via POTION_TIMERS (onMessageReceived). The client
      // never decrements them, so we count down locally at 1 tick / 500ms.
      this.seedFromGame();
      this.every(500, () => this.tick());
      this.render();
    }

    onSettings(s) {
      if (this.panel) this.panel.applySettings(s);
      this.applyColors();
      this.render();
    }

    onStop() {
      if (this.panel) this.panel.unmount();
      this.panel = null;
      this.slotEls = {};
      this.localTimers = {};
      this._order = "";
      this._empty = null;
      const style = document.getElementById(CSS_ID);
      if (style) style.remove(); // restores the vanilla #ui-potions panel
    }

    applyColors() {
      if (!this.panel) return;
      const s = this.settings;
      const el = this.panel.el;
      el.style.setProperty("--bp-size", s.size + "px");
      el.style.setProperty("--bp-normal-bg", (s.normalColor || "#9b0074") + "cc");
      el.style.setProperty("--bp-normal-border", s.normalColor || "#9b0074");
      el.style.setProperty("--bp-warn-bg", (s.warnColor || "#b00020") + "e6");
      el.style.setProperty("--bp-warn-border", s.warnColor || "#b00020");
    }

    // ---- data ----

    // Authoritative potion timers come from the POTION_TIMERS server message (the same
    // source the game uses to fill potions_active). Reading that global directly is
    // scope-fragile from an injected mod, so we parse the wire message instead.
    onMessageReceived(data) {
      if (typeof data !== "string" || !data.startsWith("POTION_TIMERS=")) return;
      const v = data.substring("POTION_TIMERS=".length).split("~");
      for (let i = 0; i + 1 < v.length; i += 2) {
        const name = v[i];
        const tick = parseInt(v[i + 1]);
        if (name && tick > 0) this.localTimers[name] = tick; // adopt authoritative value
      }
      this.render();
    }

    // Best-effort instant fill if potions_active happens to be reachable, so existing
    // buffs show immediately instead of waiting for the next POTION_TIMERS push.
    seedFromGame() {
      const src = (typeof potions_active !== "undefined" && potions_active) || null;
      if (!src) return;
      for (const name in src) {
        const t = parseInt(src[name]);
        if (t > 0) this.localTimers[name] = t;
      }
    }

    tick() {
      for (const name in this.localTimers) {
        this.localTimers[name] -= 1;
        if (this.localTimers[name] <= 0) delete this.localTimers[name];
      }
      this.render();
    }

    // ---- view ----

    createSlot(name) {
      const slot = document.createElement("div");
      slot.className = "bp-slot";
      slot.dataset.name = name;
      slot.title = util.pretty(name);
      const img = document.createElement("img");
      img.className = "bp-icon";
      img.draggable = false;
      img.alt = "";
      img.src = "images/items/" + name + ".png";
      const time = document.createElement("span");
      time.className = "bp-time";
      slot.append(img, time);
      return slot;
    }

    showEmpty(v) {
      if (v) {
        if (!this._empty) {
          this._empty = document.createElement("div");
          this._empty.className = "bp-empty";
          this._empty.textContent = "No active buffs";
        }
        if (!this._empty.isConnected) this.panel.body.appendChild(this._empty);
      } else if (this._empty && this._empty.isConnected) {
        this._empty.remove();
      }
    }

    render() {
      if (!this.panel) return;
      const body = this.panel.body;
      const warnTicks = this.settings.warnSeconds * 2;
      // Sort by remaining ticks so the buff about to expire is first.
      const names = Object.keys(this.localTimers).sort((a, b) => this.localTimers[a] - this.localTimers[b]);
      const seen = new Set();

      for (const name of names) {
        seen.add(name);
        const ticks = this.localTimers[name];
        let slot = this.slotEls[name];
        if (!slot || !slot.isConnected) {
          slot = this.createSlot(name);
          this.slotEls[name] = slot;
          body.appendChild(slot);
        }
        slot.querySelector(".bp-time").textContent = formatTime(ticks);
        slot.classList.toggle("bp-warn", warnTicks > 0 && ticks <= warnTicks);
      }

      for (const name in this.slotEls) {
        if (!seen.has(name)) {
          this.slotEls[name].remove();
          delete this.slotEls[name];
        }
      }

      // Put the slots in sorted order in the DOM, but only when the order actually
      // changed - re-appending every tick would stutter the low-time pulse.
      const order = names.join(",");
      if (order !== this._order) {
        for (const name of names) body.appendChild(this.slotEls[name]);
        this._order = order;
      }

      this.showEmpty(names.length === 0);
    }
  }

  new BuffPanel();
})();
