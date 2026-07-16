(function () {
  "use strict";

  const INVENTORY_CONTENT_ID = "ui-panel-inventory-content";

  function isBankOpen() { return typeof window.is_bank_open === "function" && !!window.is_bank_open(); }
  function isInTrade() { return typeof window.is_in_trade === "function" && !!window.is_in_trade(); }
  function sendDrop(item, dropAll) {
    // Same commands the vanilla right-click "Drop ALL" / "Drop One" buttons send.
    Globals.websocket.send((dropAll ? "DROP_ALL_ITEM=" : "DROP_ITEM=") + item);
  }

  class ShiftToDrop extends FML.Mod {
    constructor() {
      super("shift-to-drop", {
        config: [
          {
            id: "modifier", type: "select", label: "Modifier key", default: "shift",
            options: [
              { value: "shift", label: "Shift" },
              { value: "ctrl", label: "Ctrl" },
              { value: "alt", label: "Alt" },
            ],
          },
          {
            id: "quantity", type: "select", label: "Drop amount", default: "all",
            options: [
              { value: "all", label: "Entire stack" },
              { value: "one", label: "One" },
            ],
          },
        ],
      });
      this._onPointerDown = null;
    }

    onStart() {
      // Capture-phase pointerdown so we run BEFORE the item's inline onpointerdown
      // (which would use/equip the item) and can cancel it.
      this._onPointerDown = (e) => {
        if (e.button !== 0) return;               // left click only
        if (!this.modifierPressed(e)) return;     // modifier held only
        const img = e.target && e.target.closest && e.target.closest("img[data-item-name]");
        if (!img) return;
        const inv = document.getElementById(INVENTORY_CONTENT_ID);
        if (!inv || !inv.contains(img)) return;   // must be an inventory item
        if (isBankOpen() || isInTrade()) return;  // that click means deposit/offer
        const item = img.getAttribute("data-item-name");
        if (!item) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        sendDrop(item, this.settings.quantity !== "one");
      };
      document.addEventListener("pointerdown", this._onPointerDown, true);
    }

    onStop() {
      if (this._onPointerDown) {
        document.removeEventListener("pointerdown", this._onPointerDown, true);
        this._onPointerDown = null;
      }
    }

    modifierPressed(e) {
      switch (this.settings.modifier) {
        case "ctrl": return e.ctrlKey;
        case "alt": return e.altKey;
        default: return e.shiftKey;
      }
    }
  }

  new ShiftToDrop();
})();
