(function () {
  "use strict";

  const { util } = FML;

  const DOUBLE_SLUG = "double_count";
  const HALF_SLUG = "half_count";

  // cd is in seconds (matches the game's format_time(seconds)).
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    if (s <= 0) return "0:00";
    if (typeof format_time === "function") {
      const r = format_time(s);
      if (r && r !== "0") return r;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => (n < 10 ? "0" : "") + n;
    return h > 0 ? h + ":" + pad(m) + ":" + pad(sec) : m + ":" + pad(sec);
  }

  const CSS_ID = "fml-huntingpanel-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-hunting-panel .hp-main { display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 4px; border-radius: 7px; cursor: pointer; transition: background .15s, filter .15s; }
      #fml-hunting-panel .hp-main:hover { background: rgba(255,255,255,0.14); filter: brightness(1.08); }
      #fml-hunting-panel .hp-monster { width: var(--hp-icon, 44px); height: var(--hp-icon, 44px); object-fit: contain; image-rendering: pixelated; }
      #fml-hunting-panel .hp-info { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; overflow: hidden; }
      #fml-hunting-panel .hp-kills { font-size: 17px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
      #fml-hunting-panel .hp-kills.hp-done { color: #7CFC7C; }
      #fml-hunting-panel .hp-kills.hp-idle { font-size: 14px; font-weight: normal; color: #e9d4ea; }
      #fml-hunting-panel .hp-time { font-size: 12px; color: #f2d9ef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
      #fml-hunting-panel .hp-time.hp-expired { color: #ff9b9b; }
      #fml-hunting-panel .hp-toggles { display: flex; gap: 5px; margin-left: auto; flex-shrink: 0; }
      #fml-hunting-panel .hp-pill { display: flex; align-items: center; gap: 4px; padding: 2px 7px 2px 4px; border-radius: 999px; background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.22); cursor: pointer; transition: background .15s, opacity .15s, filter .15s; }
      #fml-hunting-panel .hp-pill:hover { filter: brightness(1.15); }
      #fml-hunting-panel .hp-pill-icon { width: 18px; height: 18px; object-fit: contain; image-rendering: pixelated; }
      #fml-hunting-panel .hp-pill-state { font-size: 13px; font-weight: bold; line-height: 1; }
      #fml-hunting-panel .hp-pill.hp-on { background: rgba(45,160,60,0.55); border-color: #7CFC7C; }
      #fml-hunting-panel .hp-pill.hp-on .hp-pill-state { color: #d6ffd6; }
      #fml-hunting-panel .hp-pill.hp-off .hp-pill-state { color: #ffd0d0; }
      #fml-hunting-panel .hp-pill.hp-locked { opacity: 0.5; }
      #fml-hunting-panel .hp-pill.hp-unknown { opacity: 0.7; }
    `;
    document.head.appendChild(style);
  }

  class HuntingPanel extends FML.Plugin {
    constructor() {
      super("hunting-panel", {
        config: [
          { id: "iconSize", type: "integer", label: "Monster icon size (px)", min: 24, max: 96, default: 44 },
          { id: "showTimer", type: "checkbox", label: "Show time remaining", default: true },
          { id: "showToggles", type: "checkbox", label: "Show Double/Half Count toggles", default: true },
          { id: "hideWhenIdle", type: "checkbox", label: "Hide panel when no expedition is active", default: false },
        ],
      });

      // Current expedition, from REFRESH_HUNTING_TAB. null = none active.
      this.expedition = null; // { monster, at, goal, xpPer, isBoss, cd }
      this.cdAnchor = 0;      // Date.now() when cd was last received (for local countdown)

      // Perk state, cached from HUNTING_POINTS_SHOP.
      this.perkState = {};
      this.shopSeen = false;

      // Saved originals (restored on stop).
      this._origAddSlayer = null;
      this._origOpenShop = null;
      this._origConfirmModal = null;

      this._silentShop = false;   // suppress the shop modal for our own toggles
      this._silentTimer = null;
      this._pendingToggleConfirm = false; // next confirm dialog is our toggle's
      this._pendingToggleName = null;
      this._pendingToggleTimer = null;
    }

    // ---- lifecycle (from FML.Plugin) ----

    onStart() {
      injectCss();
      this.installHooks();
      this.buildPanel();
      // Local 1s countdown for the timer (server only pushes on events).
      this.every(1000, () => this.render());
      this.render();
    }

    onSettings(s) {
      if (this.panel) {
        this.panel.applySettings(s);
        this.panel.el.style.setProperty("--hp-icon", (s.iconSize || 44) + "px");
      }
      this.render();
    }

    onStop() {
      this.removeHooks();
      this.clearSilentShop();
      this._pendingToggleConfirm = false;
      if (this._pendingToggleTimer) { clearTimeout(this._pendingToggleTimer); this._pendingToggleTimer = null; }
      if (this.panel) this.panel.unmount();
      this.panel = null;
      this.els = null;
    }

    // ---- server messages ----

    onMessageReceived(data) {
      if (typeof data !== "string") return;
      if (data.startsWith("REFRESH_HUNTING_TAB=")) {
        const values = data.substring("REFRESH_HUNTING_TAB=".length).split("~");
        const cd = parseInt(values[0]);
        const monster = values[1];
        const at = parseInt(values[2]);
        const goal = parseInt(values[3]);
        const xpPer = parseInt(values[4]);
        const isBoss = parseInt(values[5]) === 1;
        if (!monster || monster === "none") {
          this.expedition = null;
        } else {
          this.expedition = {
            monster,
            at: isNaN(at) ? 0 : at,
            goal: isNaN(goal) ? 0 : goal,
            xpPer: isNaN(xpPer) ? 0 : xpPer,
            isBoss,
            cd: isNaN(cd) ? 0 : cd,
          };
          this.cdAnchor = Date.now();
        }
        this.render();
      }
    }

    // Parse a HUNTING_POINTS_SHOP values array: [points, (name, desc, cost, has, on)*].
    cacheShop(values) {
      const map = {};
      for (let i = 1; i + 4 < values.length + 1 && i < values.length; i += 5) {
        const name = values[i];
        if (name == null) break;
        map[name] = {
          name,
          label: util.pretty(name),
          desc: values[i + 1],
          cost: values[i + 2],
          has: values[i + 3] === "true",
          on: values[i + 4] === "true",
        };
      }
      this.perkState = map;
      this.shopSeen = true;
      this.render();
    }

    // ---- game hooks ----

    installHooks() {
      const self = this;

      // Suppress the vanilla top-left task HUD; we read the data ourselves in
      // onMessageReceived, so just neutralise the draw.
      if (typeof window.add_slayer_label === "function" && !this._origAddSlayer) {
        this._origAddSlayer = window.add_slayer_label;
      }
      window.add_slayer_label = function () { /* suppressed by hunting-panel */ };
      if (typeof window.delete_top_left_ui_notification === "function") window.delete_top_left_ui_notification("slayer");

      // Wrap the shop renderer to cache perk state and suppress the modal pop when
      // WE trigger a toggle. Normal (user) opens still show the modal.
      if (typeof window.open_hunting_points_shop === "function" && !this._origOpenShop) {
        this._origOpenShop = window.open_hunting_points_shop;
      }
      window.open_hunting_points_shop = function (values) {
        self.cacheShop(values);
        if (self._silentShop) {
          self.clearSilentShop();
          return; // silent refresh from our own toggle: don't open the modal
        }
        if (self._origOpenShop) return self._origOpenShop(values);
      };

      // A perk toggle is answered with a Yes/No confirmation. When it's ours,
      // send the dialog's own "Yes" command straight to the server and never show
      // the popup - the toggle confirmation is always skipped.
      if (typeof window.open_confirmation_modal === "function" && !this._origConfirmModal) {
        this._origConfirmModal = window.open_confirmation_modal;
      }
      window.open_confirmation_modal = function (title, image_path, desc, btn1, btn2, callback) {
        if (self._pendingToggleConfirm) {
          self._pendingToggleConfirm = false;
          if (self._pendingToggleTimer) { clearTimeout(self._pendingToggleTimer); self._pendingToggleTimer = null; }
          const cb = callback;
          const ours = !!cb && (
            (self._pendingToggleName && cb.indexOf(self._pendingToggleName) !== -1) ||
            cb.toUpperCase().indexOf("HUNTER_SHOP") !== -1
          );
          if (ours) {
            Globals.websocket.send(cb); // _silentShop stays armed
            return; // don't open the confirmation modal
          }
        }
        const ret = self._origConfirmModal
          ? self._origConfirmModal.call(this, title, image_path, desc, btn1, btn2, callback)
          : undefined;
        if (self._silentShop) {
          const noBtn = document.getElementById("general-confirm-modal-btn2");
          if (noBtn) {
            const prevNo = noBtn.onclick;
            noBtn.onclick = function (e) {
              self.clearSilentShop();
              if (typeof prevNo === "function") return prevNo.call(this, e);
            };
          }
        }
        return ret;
      };
    }

    removeHooks() {
      if (this._origAddSlayer) { window.add_slayer_label = this._origAddSlayer; this._origAddSlayer = null; }
      if (this._origOpenShop) { window.open_hunting_points_shop = this._origOpenShop; this._origOpenShop = null; }
      if (this._origConfirmModal) { window.open_confirmation_modal = this._origConfirmModal; this._origConfirmModal = null; }
    }

    // ---- perk resolution ----

    resolvePerk(kind) {
      const slug = kind === "double" ? DOUBLE_SLUG : HALF_SLUG;
      if (this.perkState[slug]) return this.perkState[slug];
      const tokens = kind === "double" ? ["double", "count"] : ["half", "count"];
      for (const k in this.perkState) {
        const low = k.toLowerCase();
        if (tokens.every((t) => low.includes(t))) return this.perkState[k];
      }
      return null;
    }

    toggle(kind) {
      const perk = this.resolvePerk(kind);
      // Unknown (shop never synced) or not purchased: open the shop - perk on/off
      // + owned state only ever arrives via HUNTING_POINTS_SHOP.
      if (!perk || !perk.has) { this.openShop(); return; }
      // Do NOT flip locally: the server shows a Yes/No confirmation, and only the
      // authoritative HUNTING_POINTS_SHOP (sent after "Yes") changes real state.
      this.armSilentShop();
      // Mark the next confirmation dialog as ours so it's auto-confirmed. One-shot;
      // self-heals after 5s.
      this._pendingToggleName = perk.name;
      this._pendingToggleConfirm = true;
      if (this._pendingToggleTimer) clearTimeout(this._pendingToggleTimer);
      this._pendingToggleTimer = setTimeout(() => {
        this._pendingToggleConfirm = false;
        this._pendingToggleTimer = null;
      }, 5000);
      Globals.websocket.send("PURCHASE_OR_TOGGLE_HUNTER_SHOP=" + perk.name);
    }

    // Open the hunter shop via the remote "Contact Hunter" flow - the only way to
    // receive HUNTING_POINTS_SHOP, which syncs perk state into the panel.
    openShop() {
      Globals.websocket.send("HUNTING_CONTACT");
    }

    // Suppress the next toggle-driven shop refresh from popping the shop modal.
    armSilentShop() {
      this._silentShop = true;
      if (this._silentTimer) clearTimeout(this._silentTimer);
      // The refresh only arrives after the user confirms; keep the flag alive,
      // then self-heal as a fallback.
      this._silentTimer = setTimeout(() => this.clearSilentShop(), 60000);
    }

    clearSilentShop() {
      this._silentShop = false;
      if (this._silentTimer) { clearTimeout(this._silentTimer); this._silentTimer = null; }
    }

    // ---- DOM ----

    buildPanel() {
      this.panel = new FML.Panel(this, { title: "Hunting", collapsible: true, width: 220 });
      this.panel.el.style.setProperty("--hp-icon", (this.settings.iconSize || 44) + "px");
      const body = this.panel.body;

      const main = document.createElement("div");
      main.className = "hp-main";
      main.title = "Open hunting tab";
      main.onclick = () => { if (typeof window.switch_panels === "function") window.switch_panels("hunting"); };

      const monster = document.createElement("img");
      monster.className = "hp-monster";
      monster.draggable = false;
      monster.alt = "";

      const info = document.createElement("div");
      info.className = "hp-info";
      const kills = document.createElement("div");
      kills.className = "hp-kills";
      const time = document.createElement("div");
      time.className = "hp-time";
      info.append(kills, time);

      // Toggles sit on the same row as the monster button, pushed to the right
      // (margin-left:auto). stopPropagation so clicking the toggle area or its gap
      // doesn't also open the hunting tab via the row's onclick.
      const toggles = document.createElement("div");
      toggles.className = "hp-toggles";
      toggles.onclick = (e) => e.stopPropagation();
      const pillDouble = this.createPill("double");
      const pillHalf = this.createPill("half");
      toggles.append(pillDouble, pillHalf);

      main.append(monster, info, toggles);
      body.append(main);
      this.els = { monster, kills, time, toggles, pillDouble, pillHalf };
      this.panel.mount();
    }

    createPill(kind) {
      const pill = document.createElement("div");
      pill.className = "hp-pill";
      pill.dataset.kind = kind;
      const img = document.createElement("img");
      img.className = "hp-pill-icon";
      img.draggable = false;
      img.alt = "";
      const state = document.createElement("span");
      state.className = "hp-pill-state";
      pill.append(img, state);
      pill.onclick = (e) => { e.stopPropagation(); this.toggle(kind); };
      return pill;
    }

    // ---- render ----

    render() {
      if (!this.panel || !this.els) return;
      const s = this.settings;
      const exp = this.expedition;
      const els = this.els;

      if (!exp && s.hideWhenIdle) {
        this.panel.el.style.display = "none";
        return;
      }
      this.panel.el.style.display = "";

      if (exp) {
        els.monster.style.display = "";
        els.monster.src = "images/npcs/" + exp.monster + "_stand1.png";
        els.monster.title = util.pretty(exp.monster) + (exp.isBoss ? " (Boss task)" : "");

        const done = exp.goal > 0 && exp.at >= exp.goal;
        els.kills.textContent = exp.at + "/" + exp.goal;
        els.kills.className = "hp-kills" + (done ? " hp-done" : "");

        if (s.showTimer) {
          const remaining = exp.cd - Math.floor((Date.now() - this.cdAnchor) / 1000);
          els.time.style.display = "";
          // Match the game: cd 1 is the "done" state, shown as 0:00 (it never renders 0:01).
          els.time.textContent = remaining <= 1 ? "0:00" : formatTime(remaining);
          els.time.className = "hp-time" + (remaining <= 1 ? " hp-expired" : "");
        } else {
          els.time.style.display = "none";
        }
      } else {
        // No expedition: compact idle state, still clickable to assign one.
        els.monster.style.display = "";
        els.monster.src = "images/icons/hunting_large.png";
        els.monster.title = "Hunting";
        els.kills.textContent = "No expedition";
        els.kills.className = "hp-kills hp-idle";
        els.time.style.display = "none";
      }

      els.toggles.style.display = s.showToggles ? "" : "none";
      if (s.showToggles) {
        this.renderPill(els.pillDouble, "double", "Double Count");
        this.renderPill(els.pillHalf, "half", "Half Count");
      }
    }

    renderPill(pill, kind, fallbackLabel) {
      const perk = this.resolvePerk(kind);
      const img = pill.querySelector(".hp-pill-icon");
      const state = pill.querySelector(".hp-pill-state");
      const label = perk ? perk.label : fallbackLabel;
      const slug = perk ? perk.name : (kind === "double" ? DOUBLE_SLUG : HALF_SLUG);

      img.src = "images/icons/" + slug + ".png";

      if (!this.shopSeen || !perk) {
        pill.className = "hp-pill hp-unknown";
        state.textContent = "?";
        pill.title = label + ": unknown - click to open the Hunter Shop and sync.";
        return;
      }
      if (!perk.has) {
        // Not purchased: just grey it out, no tooltip.
        pill.className = "hp-pill hp-locked";
        state.textContent = "\u2013"; // en dash
        pill.title = "";
        return;
      }
      pill.className = "hp-pill " + (perk.on ? "hp-on" : "hp-off");
      state.textContent = perk.on ? "\u2713" : "\u2717"; // check / cross
      pill.title = label + ": " + (perk.on ? "ON" : "OFF") + " - click to turn " + (perk.on ? "off" : "on") + ".";
    }
  }

  new HuntingPanel();
})();
