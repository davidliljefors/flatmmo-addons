(function () {
  "use strict";

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function hhmm() {
    const d = new Date();
    const p = (n) => (n < 10 ? "0" : "") + n;
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // Chat "tag" -> [badge label, css class].
  const TAGS = {
    donor: ["DONOR", "fmc-tag-donor"],
    contributor: ["CONTRIB", "fmc-tag-contributor"],
    investor: ["INVESTOR", "fmc-tag-investor"],
    "investor-plus": ["INVESTOR", "fmc-tag-investor"],
    "investor-gold": ["GOLD INV", "fmc-tag-owner"],
    moderator: ["MOD", "fmc-tag-mod"],
    owner: ["OWNER", "fmc-tag-owner"],
  };

  const CSS_ID = "fml-chatbox-style";
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = el("style");
    style.id = CSS_ID;
    style.textContent = `
      #fml-chatbox {
        position: fixed; z-index: 58; box-sizing: border-box;
        display: flex; flex-direction: column;
        background: var(--fmc-bg, #0e1116);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.5);
        font-family: sans-serif; color: #e6ecf3; overflow: hidden;
      }
      #fml-chatbox .fmc-head { flex: 0 0 auto; display: flex; align-items: center; padding: 3px 9px; background: rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.10); }
      #fml-chatbox .fmc-title { font-size: 13px; font-weight: bold; letter-spacing: .06em; text-transform: uppercase; color: #cdd6e0; }
      #fml-chatbox .fmc-tabs { margin-left: auto; display: flex; gap: 5px; }
      #fml-chatbox .fmc-tab { font-size: 12px; font-weight: bold; letter-spacing: .05em; text-transform: uppercase; color: #8b97a5; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); border-radius: 6px; padding: 2px 10px; cursor: pointer; display: flex; align-items: center; gap: 5px; user-select: none; }
      #fml-chatbox .fmc-tab:hover { color: #cdd6e0; background: rgba(255,255,255,0.10); }
      #fml-chatbox .fmc-tab.fmc-active { color: #eaf2ff; background: rgba(120,170,255,0.22); border-color: rgba(120,170,255,0.5); }
      #fml-chatbox .fmc-count { color: #6fb1ff; font-weight: bold; }
      #fml-chatbox .fmc-count:empty { display: none; }
      #fml-chatbox .fmc-log.fmc-filter-local .fmc-msg[data-fmc-ch="global"] { display: none; }
      #fml-chatbox .fmc-log.fmc-filter-global .fmc-msg[data-fmc-ch="local"] { display: none; }
      #fml-chatbox .fmc-log { flex: 1 1 auto; overflow-y: auto; padding: 6px 9px; display: flex; flex-direction: column; gap: 2px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent; }
      #fml-chatbox .fmc-log::-webkit-scrollbar { width: 8px; }
      #fml-chatbox .fmc-log::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 8px; }
      #fml-chatbox .fmc-empty { color: #6f7c8a; font-size: 14px; padding: 2px; }
      #fml-chatbox .fmc-msg { font-size: 14.5px; line-height: 1.4; word-break: break-word; }
      #fml-chatbox .fmc-time { color: #66727f; font-size: 12.5px; margin-right: 5px; font-variant-numeric: tabular-nums; }
      #fml-chatbox .fmc-sigil { width: 14px; height: 14px; object-fit: contain; image-rendering: pixelated; vertical-align: -2px; margin-right: 3px; }
      #fml-chatbox .fmc-user { font-weight: bold; }
      #fml-chatbox .fmc-tag { font-size: 10.5px; font-weight: bold; padding: 0 4px; border-radius: 4px; margin-right: 4px; color: #fff; letter-spacing: .04em; }
      #fml-chatbox .fmc-tag-donor { background: #a9791b; }
      #fml-chatbox .fmc-tag-contributor { background: #0f766e; }
      #fml-chatbox .fmc-tag-investor { background: #5b3aa6; }
      #fml-chatbox .fmc-tag-mod { background: #2f7d33; }
      #fml-chatbox .fmc-tag-owner { background: #a12d2d; }
      #fml-chatbox .fmc-inputrow { flex: 0 0 auto; padding: 6px; border-top: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04); }

      /* Re-style the reparented native chat input to match the FML look. */
      #fml-chatbox .chat-input {
        position: static !important; transform: none !important; top: auto !important; left: auto !important;
        width: 100% !important; padding: 0 !important; margin: 0 !important; z-index: auto !important;
        background: none !important; pointer-events: auto !important; overflow: visible !important;
        display: flex !important; align-items: center; gap: 7px;
      }
      #fml-chatbox .chat-text-input-img { width: 18px !important; height: 18px !important; vertical-align: middle; flex: 0 0 auto; pointer-events: auto !important; }
      #fml-chatbox .chat-text-input {
        flex: 1 1 auto !important; min-width: 0 !important; height: 28px !important; box-sizing: border-box !important;
        padding: 0 10px !important; border-radius: 7px !important; border: 1px solid rgba(255,255,255,0.16) !important;
        background: #0d1117 !important; color: #e6ecf3 !important; font-size: 15px !important; font-family: sans-serif !important;
        outline: none !important; pointer-events: auto !important;
      }
      #fml-chatbox .chat-text-input:focus { border-color: rgba(120,170,255,0.7) !important; }
    `;
    document.head.appendChild(style);
  }

  class ChatBox extends FML.Plugin {
    constructor() {
      super("chat-box", {
        config: [
          { id: "height", type: "integer", label: "Chat height (px)", min: 90, max: 500, default: 300 },
          { id: "timestamps", type: "checkbox", label: "Show timestamps", default: true },
        ],
      });
    }

    // ---- lifecycle ----

    onStart() {
      injectCss();

      this.filter = "global";
      this.unread = { local: 0, global: 0 };

      this.el = el("div");
      this.el.id = "fml-chatbox";
      const head = el("div", "fmc-head");
      head.appendChild(el("span", "fmc-title", "Chat"));
      head.appendChild(this.buildTabs());
      this.log = el("div", "fmc-log");
      this._empty = el("div", "fmc-empty", "No messages yet.");
      this.log.appendChild(this._empty);
      this.inputRow = el("div", "fmc-inputrow");
      this.el.append(head, this.log, this.inputRow);
      document.body.appendChild(this.el);

      this.setFilter(this.filter);
      this.adoptNativeInput();
      this.hideNativeLog();
      this.hookAddToChat();
      this.applyStyle();
      this.observe();
      // Require an explicit focus to type into chat: block the game's "type anywhere
      // to chat" (it appends keys to the input whenever the page body is focused).
      this._keypressGuard = (e) => this.guardKeypress(e);
      window.addEventListener("keypress", this._keypressGuard, true);
      this._offGlobal = FML.onGlobal(() => this.applyStyle()); // live-update on global colour change
      setTimeout(() => this.position(), 60); // canvas may still be sizing right after login
    }

    onSettings() {
      this.applyStyle();
    }

    onStop() {
      if (this._offGlobal) { this._offGlobal(); this._offGlobal = null; }
      if (this._keypressGuard) { window.removeEventListener("keypress", this._keypressGuard, true); this._keypressGuard = null; }
      if (this._origAddToChat) { window.add_to_chat = this._origAddToChat; this._origAddToChat = null; }
      if (this._nativeInput && this._nativeInputHome) this._nativeInputHome.appendChild(this._nativeInput);
      if (this._nativeLog) this._nativeLog.style.display = this._nativeLogDisplay || "";
      if (this._onResize) { window.removeEventListener("resize", this._onResize); this._onResize = null; }
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this.el) this.el.remove();
      this.el = this.log = this.inputRow = this._empty = null;
      this._nativeInput = this._nativeTextInput = this._nativeLog = null;
      this._tabs = null;
    }

    // The game types into the chat input whenever the page body is focused ("type
    // anywhere to chat"). Block that in the capture phase so chat only takes keys once
    // you've focused it - but leave NPC dialogs/modals (which also read keys) alone,
    // and never intercept while an input (incl. our own) is focused.
    guardKeypress(e) {
      if ((typeof has_modal_open === "function" && has_modal_open()) ||
          (typeof has_npc_chat_message_modal_open === "function" && has_npc_chat_message_modal_open()) ||
          (typeof has_npc_chat_options_modal_open === "function" && has_npc_chat_options_modal_open())) return;
      const a = document.activeElement;
      if (a && a.id === "body") e.stopImmediatePropagation();
    }

    // ---- tabs / channels ----

    buildTabs() {
      const wrap = el("div", "fmc-tabs");
      this._tabs = {};
      for (const ch of ["global", "local"]) {
        const btn = el("div", "fmc-tab");
        btn.appendChild(el("span", "fmc-tab-name", ch === "local" ? "Local" : "Global"));
        const count = el("span", "fmc-count"); // shows "(N)" unread next to the name
        btn.appendChild(count);
        btn.addEventListener("click", () => this.setFilter(ch, true));
        this._tabs[ch] = { btn, count };
        wrap.appendChild(btn);
      }
      return wrap;
    }

    // Switch the active tab: filters the log, clears that tab's unread, and (on a
    // user click) focuses the input so you can type into the channel you picked.
    setFilter(ch, focus) {
      if (ch !== "local" && ch !== "global") return;
      this.filter = ch;
      this.unread[ch] = 0;
      if (this.log) {
        this.log.classList.toggle("fmc-filter-local", ch === "local");
        this.log.classList.toggle("fmc-filter-global", ch === "global");
        this.log.scrollTop = this.log.scrollHeight;
      }
      this.updateTabUI();
      if (focus && this._nativeTextInput) this._nativeTextInput.focus();
    }

    updateTabUI() {
      if (!this._tabs) return;
      for (const ch of ["global", "local"]) {
        const t = this._tabs[ch];
        if (!t) continue;
        const n = this.unread[ch] || 0;
        t.btn.classList.toggle("fmc-active", this.filter === ch);
        t.count.textContent = n > 0 ? "(" + (n > 99 ? "99+" : n) + ")" : "";
      }
    }

    // ---- native chat integration ----

    // Move the game's own input into our bar so sending, focus handling and
    // FlatMMOPlus custom commands keep working; we only restyle it.
    adoptNativeInput() {
      const input = document.getElementById("chat-input");
      if (!input) return;
      this._nativeInput = input;
      this._nativeInputHome = input.parentNode;
      this.inputRow.appendChild(input);
      this._nativeTextInput = document.getElementById("chat-text-input"); // for focus-on-tab
    }

    hideNativeLog() {
      const log = document.getElementById("chat");
      if (!log) return;
      this._nativeLog = log;
      this._nativeLogDisplay = log.style.display;
      log.style.display = "none";
    }

    // Every line the game shows goes through add_to_chat; wrap it to also render ours.
    hookAddToChat() {
      if (typeof window.add_to_chat !== "function") return;
      this._origAddToChat = window.add_to_chat;
      const self = this;
      window.add_to_chat = function (username, tag, icon, color, message) {
        self._origAddToChat.apply(this, arguments);
        try { self.addMessage(username, tag, icon, color, message); } catch (e) { /* keep native chat safe */ }
      };
    }

    // ---- rendering ----

    // Local is "actually local" chat only: nearby players you can see on screen, which
    // is the regular player CHAT (a real username). Everything else is Global - yells
    // ("<name> yelled"), DMs ("[PM …]"), and the server's CHAT_LOCAL_MESSAGE lines
    // (username "none": server notices, level-ups, area/rest messages).
    classify(username, message) {
      if (/^\s*\[PM\b/.test(String(message))) return "global";        // DMs
      const u = String(username);
      if (u === "none" || u === "" || / yelled$/.test(u)) return "global";
      return "local";                                                 // nearby player chat
    }

    addMessage(username, tag, icon, color, message) {
      if (!this.log) return;
      if (this._empty && this._empty.isConnected) this._empty.remove();

      const channel = this.classify(username, message);
      const stick = this.atBottom();

      // Yells arrive as "<name> yelled" in grey; show them as a plain "<name>:" in
      // white so a global message reads like any other line.
      const isYell = / yelled$/.test(String(username));
      const name = isYell ? String(username).replace(/ yelled$/, "") : username;
      const rowColor = isYell ? "white" : color;

      const row = el("div", "fmc-msg");
      row.dataset.fmcCh = channel;
      if (rowColor) row.style.color = rowColor;
      if (this.settings.timestamps) row.appendChild(el("span", "fmc-time", hhmm()));
      if (icon && icon !== "none") {
        const img = el("img", "fmc-sigil");
        img.src = icon;
        img.alt = "";
        row.appendChild(img);
      }
      if (name && name !== "none" && String(name).length) {
        const badge = TAGS[tag] ? el("span", "fmc-tag " + TAGS[tag][1], TAGS[tag][0]) : null;
        if (badge) row.appendChild(badge);
        row.appendChild(el("span", "fmc-user", name + ": "));
      }
      row.appendChild(el("span", "fmc-text", message == null ? "" : String(message)));

      this.log.appendChild(row);
      this.trim();

      if (channel !== this.filter) {
        this.unread[channel] = (this.unread[channel] || 0) + 1;
        this.updateTabUI();
      } else if (stick) {
        this.log.scrollTop = this.log.scrollHeight;
      }
    }

    atBottom() {
      const l = this.log;
      return l.scrollHeight - l.scrollTop <= l.clientHeight + 12;
    }

    trim() {
      while (this.log.childElementCount > 250) this.log.removeChild(this.log.firstElementChild);
    }

    // ---- layout ----

    applyStyle() {
      if (!this.el) return;
      // Background comes from the loader's global panel colour; the chat bar sits
      // under the canvas and never uses opacity.
      this.el.style.setProperty("--fmc-bg", FML.globalSettings().panelBg);
      this.el.style.height = (this.settings.height || 175) + "px";
      this.position();
    }

    // Sit under the canvas, spanning its width (not the side panels).
    position() {
      if (!this.el) return;
      const c = document.getElementById("canvas");
      if (!c) return;
      const r = c.getBoundingClientRect();
      this.el.style.left = Math.round(r.left) + "px";
      this.el.style.top = Math.round(r.bottom + 6) + "px";
      this.el.style.width = Math.round(r.width) + "px";
    }

    observe() {
      this._onResize = () => this.position();
      window.addEventListener("resize", this._onResize);
      const c = document.getElementById("canvas");
      if (c && typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(() => this.position());
        this._ro.observe(c);
      }
    }
  }

  new ChatBox();
})();
