(function () {
  "use strict";

  const { util, game } = FML;

  const SKILLS = [
    "melee", "archery", "magic", "health", "worship", "mining", "forging", "crafting",
    "enchantment", "fishing", "woodcutting", "firemake", "cooking", "brewing", "farming",
    "stealing", "hunting", "summoning", "agility",
  ];

  const CSS_ID = "fml-xptracker-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-xp-tracker .xt-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; background: rgba(255,255,255,0.05); transition: background .25s; cursor: pointer; }
      #fml-xp-tracker .xt-row:hover { filter: brightness(1.12); }
      #fml-xp-tracker .xt-icon { width: 30px; height: 30px; object-fit: contain; image-rendering: pixelated; flex-shrink: 0; }
      /* Collapsed: compact row (same height as loot tracker items) showing only the icon + XP/hr. */
      #fml-xp-tracker .xt-row.xt-collapsed { padding: 2px 3px; gap: 7px; }
      #fml-xp-tracker .xt-row.xt-collapsed .xt-icon { width: 22px; height: 22px; }
      #fml-xp-tracker .xt-row.xt-collapsed .xt-line1,
      #fml-xp-tracker .xt-row.xt-collapsed .xt-toln,
      #fml-xp-tracker .xt-row.xt-collapsed .xt-gain,
      #fml-xp-tracker .xt-row.xt-collapsed .xt-reset { display: none; }
      /* Rate hidden in the expanded view when "Show XP per hour" is off; collapsed always shows it. */
      #fml-xp-tracker .xt-row.xt-hide-rate:not(.xt-collapsed) .xt-rate { display: none; }
      #fml-xp-tracker .xt-info { flex: 1 1 auto; min-width: 0; line-height: 1.25; }
      #fml-xp-tracker .xt-line1 { display: flex; align-items: baseline; gap: 6px; }
      #fml-xp-tracker .xt-name { font-size: 13px; font-weight: bold; }
      #fml-xp-tracker .xt-lvl { font-size: 11px; color: #9fb0c0; }
      #fml-xp-tracker .xt-line2 { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
      #fml-xp-tracker .xt-gain { color: #7CFC7C; font-weight: bold; }
      #fml-xp-tracker .xt-rate { color: #9fb0c0; }
      #fml-xp-tracker .xt-toln { font-size: 11px; color: #f0c46a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #fml-xp-tracker .xt-reset { flex-shrink: 0; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16); color: #cbd4dd; font-size: 14px; line-height: 1; }
      #fml-xp-tracker .xt-reset:hover { background: rgba(224,64,58,0.4); filter: brightness(1.1); }
      #fml-xp-tracker .xt-empty { padding: 8px 9px; font-size: 12px; color: #8a94a0; text-align: center; }
    `;
    document.head.appendChild(style);
  }

  class XpTracker extends FML.Plugin {
    constructor() {
      super("xp-tracker", {
        config: [
          { id: "showRate", type: "checkbox", label: "Show XP per hour", default: true },
          { id: "showProgress", type: "checkbox", label: "Show level progress bar", default: true },
          { id: "hideMaxed", type: "checkbox", label: "Hide maxed skills", default: false },
        ],
      });
      this.skills = {};  // skill -> { gained, lastDrop, startTime }
      this.collapsed = new Set();  // skills collapsed to the compact icon + XP/hr row
    }

    // ---- lifecycle (from FML.Plugin) ----

    onStart() {
      injectCss();
      this.panel = new FML.Panel(this, { title: "XP Tracker", collapsible: true, width: 232 });
      this.panel.addMenuItem({ label: "Reset all skills", onClick: () => this.resetAll() });
      this.list = new FML.List(this.panel.body);
      this.panel.mount();
      // Re-render every 2s so XP/hr refreshes on a steady cadence (less jittery).
      this.every(2000, () => this.render(true));
      this.render(true);
    }

    onSettings(s) {
      if (this.panel) this.panel.applySettings(s);
      this.render(true);
    }

    onStop() {
      if (this.panel) this.panel.unmount();
      this.panel = null;
      this.list = null;
      this.skills = {};
      this.collapsed.clear();
    }

    // ---- data ----

    // Accumulate exactly like the game's own session tracker (xp_drop.js): read the
    // XP_DROP stream for the local player and skip non-numeric drops. Eating food
    // emits XP_DROP with xp="gulp" (a heal, not training), so isNaN() drops it.
    onMessageReceived(data) {
      if (typeof data !== "string" || !data.startsWith("XP_DROP=")) return;
      const v = data.substring("XP_DROP=".length).split("~");
      if (v[0] !== game.localName()) return;
      const skill = v[1];
      if (!SKILLS.includes(skill)) return;
      const xp = parseInt(v[2]);
      if (isNaN(xp) || xp <= 0) return;
      let s = this.skills[skill];
      if (!s) s = this.skills[skill] = { gained: 0, lastDrop: 0, startTime: Date.now() };
      s.gained += xp;
      s.lastDrop = xp;
      this.render(false); // gain updates immediately; XP/hr waits for the 2s tick
    }

    resetAll() { this.skills = {}; this.collapsed.clear(); this.list.clear(); this.render(true); }
    resetSkill(skill) { delete this.skills[skill]; this.collapsed.delete(skill); this.list.remove(skill); this.render(true); }

    // Collapse/expand a single skill to the compact icon + XP/hr row.
    toggleCollapse(skill) {
      if (this.collapsed.has(skill)) this.collapsed.delete(skill);
      else this.collapsed.add(skill);
      this.render(true);
    }

    // ---- view ----

    buildRow(skill) {
      const row = document.createElement("div");
      row.className = "xt-row";

      const icon = document.createElement("img");
      icon.className = "xt-icon";
      icon.draggable = false;
      icon.alt = "";
      icon.src = "images/icons/" + skill + "_large.png";

      const info = document.createElement("div");
      info.className = "xt-info";
      const line1 = document.createElement("div");
      line1.className = "xt-line1";
      const name = document.createElement("span");
      name.className = "xt-name";
      name.textContent = util.pretty(skill);
      const lvl = document.createElement("span");
      lvl.className = "xt-lvl";
      line1.append(name, lvl);
      const line2 = document.createElement("div");
      line2.className = "xt-line2";
      const gain = document.createElement("span");
      gain.className = "xt-gain";
      const rate = document.createElement("span");
      rate.className = "xt-rate";
      line2.append(gain, rate);
      const actions = document.createElement("div");
      actions.className = "xt-toln";
      info.append(line1, line2, actions);

      const reset = document.createElement("button");
      reset.className = "xt-reset";
      reset.textContent = "\u21BA";
      reset.title = "Reset " + util.pretty(skill);
      reset.onclick = (ev) => { ev.stopPropagation(); this.resetSkill(skill); };

      // Click anywhere on the row to collapse/expand it (reset stops the toggle).
      icon.title = util.pretty(skill);
      row.onclick = () => this.toggleCollapse(skill);

      row.append(icon, info, reset);
      row._els = { lvl, gain, rate, actions };
      return row;
    }

    showEmpty(v) {
      if (v) {
        if (!this._empty) {
          this._empty = document.createElement("div");
          this._empty.className = "xt-empty";
          this._empty.textContent = "No XP gained yet";
        }
        if (!this._empty.isConnected) this.panel.body.appendChild(this._empty);
      } else if (this._empty && this._empty.isConnected) {
        this._empty.remove();
      }
    }

    render(updateRate) {
      if (!this.list) return;
      let skills = Object.keys(this.skills);
      if (this.settings.hideMaxed) {
        skills = skills.filter((skill) => game.level(game.getVar(skill + "_xp")) < 100);
      }
      skills.sort((a, b) => this.skills[a].startTime - this.skills[b].startTime || (a < b ? -1 : 1));

      // Drop rows no longer shown (reset, or a skill hidden once it maxed).
      for (const key of this.list.keys()) if (!skills.includes(key)) this.list.remove(key);

      this.panel.setTitle("XP Tracker" + (skills.length ? " (" + skills.length + ")" : ""));

      if (skills.length === 0) { this.list.clear(); this.showEmpty(true); return; }
      this.showEmpty(false);

      for (const skill of skills) {
        const st = this.skills[skill];
        const row = this.list.row(skill, () => this.buildRow(skill));
        const e = row._els;
        const currentXP = game.getVar(skill + "_xp");
        const level = game.level(currentXP);

        row.classList.toggle("xt-collapsed", this.collapsed.has(skill));
        row.classList.toggle("xt-hide-rate", !this.settings.showRate);

        e.lvl.textContent = level >= 100 ? "Lv max" : "Lv " + level;
        e.gain.textContent = "+" + util.fmt(st.gained);

        // XP/hr refreshes on the 2s tick (updateRate) so it doesn't jitter on every
        // drop; collapsed rows show only XP/hr, so keep it populated regardless.
        if (updateRate || !e.rate.textContent) {
          e.rate.textContent = util.fmt(st.gained / ((Date.now() - st.startTime) / 3600000)) + "/hr";
        }

        if (level >= 100) {
          e.actions.textContent = "Max level";
        } else {
          const remaining = game.xpForLevel(level + 1) - currentXP;
          const n = Math.max(0, Math.ceil(remaining / st.lastDrop));
          e.actions.textContent = n.toLocaleString() + " action" + (n === 1 ? "" : "s") + " \u2192 Lv " + (level + 1);
        }

        // Fill the row background to the player's progress through the current level.
        if (this.settings.showProgress) {
          let pct = 100;
          if (level < 100) {
            const lvStart = game.xpForLevel(level);
            const lvEnd = game.xpForLevel(level + 1);
            pct = Math.max(0, Math.min(100, ((currentXP - lvStart) / (lvEnd - lvStart)) * 100));
          }
          row.style.background = `linear-gradient(to right, rgba(124,252,124,0.20) ${pct}%, rgba(255,255,255,0.05) ${pct}%)`;
        } else {
          row.style.background = "";
        }
      }
      this.list.setOrder(skills);
    }
  }

  new XpTracker();
})();
