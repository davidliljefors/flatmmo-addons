# FlatMMO Addon Development - Memory / Reference

This repo builds **FlatMMO** mods. There are two layers:

- **FlatMMOPlus** - the upstream plugin framework (loaded from greasyfork, not in
  this repo). Provides `FlatMMOPlusPlugin` + the websocket/chat/paint hooks.
- **Flat Mod Loader (FML)** - our loader that sits on top of FlatMMOPlus
  (`flat-mod-loader/flat-mod-loader.js`, global `window.FML`). It gives mods a
  Plugin base, a draggable/dockable Panel, a keyed List, game helpers, a manager
  UI, and - crucially - it **fetches and runs mods from GitHub sources** so a user
  installs ONE userscript (FML) and then toggles individual mods in a manager.

**New mods are plain JS files using the FML API - no userscript header, no
`@require`.** You almost never touch FlatMMOPlus or write a `.user.js` anymore.

## Repo layout

- `flat-mod-loader/flat-mod-loader.js` - the loader (the only installed userscript).
- `mods/` - all mods live here.
  - `mods/index.json` - the source manifest: one entry per mod (id/name/
    author/description/entry/hash). **This is the single source of truth for a
    mod's metadata** - mods do NOT declare an `about` block.
  - `mods/<kebab-name>/<kebab-name>.js` - one folder per mod, each a plain-JS IIFE.
- `hash_mods.py` - rehashes every mod's entry file into `mods/index.json`'s `hash`
  field. **Run this after editing any mod's `.js` file** - the loader uses the
  hash (not a version number) to decide whether to re-download a mod.
- `serve.py` - CORS dev server (port 8611) so you can run mods off localhost.
- `gamesrc/` - **local copy of the live game source** (see "Getting the game source").
  Our ground truth: when you need a global, DOM id, CSS class, or websocket
  command, **grep `gamesrc/` first** - don't guess.
- `FlatMMOPlus/` - reference notes only; the real FlatMMOPlus is @required from
  greasyfork by the loader. (The base `FlatMMOPlusPlugin` is not in this repo.)

## How mods get loaded (and the dev loop)

1. The user installs **Flat Mod Loader** once (`@match *://flatmmo.com/play.php*`,
   `@grant none`, `@require` FlatMMOPlus greasyfork script 544062).
2. In the manager (bottom-left "Flat Mod Loader" launcher, or `/fml` in chat) they
   add a **source**: a GitHub repo URL (or a localhost URL for dev). FML expects
   that repo to have `mods/index.json`.
3. Each mod has a per-mod enable toggle, **default OFF**. Enabling one loads its
   `entry` file and injects it as a `<script>` in page context, and the mod's
   top-level `new MyMod()` registers an `FML.Plugin`. The `mods/index.json`
   fetch itself is always cache-busted/`no-store`, but the entry file is only
   re-fetched when its `hash` (in `index.json`) differs from what's cached in
   `localStorage` - so run `hash_mods.py` whenever you change a mod's code.

Sources: `github.com/owner/repo[/tree/branch]` normalizes to the raw base (no
branch → tries `main` then `master`). Other URLs (localhost, etc.) are used as-is.

**Dev loop** run the bundled server and add `http://localhost:8611/` as a
source.

```powershell
python serve.py            # serves the repo root on http://127.0.0.1:8611/ (CORS + no-store)
```

Verify a mod is served:

```powershell
(Invoke-WebRequest 'http://localhost:8611/mods/loot-tracker/loot-tracker.js' -UseBasicParsing).StatusCode
Invoke-RestMethod 'http://localhost:8611/mods/index.json'
```

After editing a mod, run `python hash_mods.py` to update its `hash` in
`mods/index.json`, then reload the game - the changed hash makes the loader
re-fetch and re-cache that mod's script. (Skipping the rehash means the loader
keeps serving the old cached copy.) Tampermonkey/Greasemonkey **caches
`@require`** content, so after editing `flat-mod-loader.js` itself you must
reinstall / force-update it (or bump its `@version`) for the browser to
re-fetch.

## Writing a new mod

### 1. Add the folder + file

`mods/<kebab-name>/<kebab-name>.js`. Then add an entry to `mods/index.json`:

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "author": "Frappe",
  "description": "One sentence shown in the manager.",
  "entry": "mods/my-mod/my-mod.js",
  "hash": ""
}
```

`id` is the stable key (kebab-case, matches the folder/file name); `entry` is
always written explicitly. **Name/author/description live ONLY here** - the
loader reads them and hands them to FlatMMOPlus for you. Leave `hash` as `""`
and run `python hash_mods.py` to fill it in (see below).

### 2. Mod skeleton

```js
(function () {
  "use strict";

  const { util } = FML; // optional: util.fmt / util.pretty / util.clampPct

  class MyMod extends FML.Plugin {
    constructor() {
      super("my-mod", {
        config: [
          { id: "someOption", type: "checkbox", label: "Do the thing", default: true },
        ],
      });
      // Init instance fields here (after super()). onStart is deferred to a
      // microtask, so these are guaranteed set before it runs.
      this.panel = null;
    }

    onStart() {
      // Enabled. Build panels, add listeners, start timers.
      this.panel = new FML.Panel(this, { title: "My Mod", width: 220 });
      this.panel.mount();
      this.every(1000, () => this.tick()); // auto-cleared on stop
    }

    onStop() {
      // Disabled. Tear everything down.
      if (this.panel) this.panel.unmount();
      this.panel = null;
    }

    onSettings(s) {
      // Configs changed while enabled. `s` and `this.settings` are the values.
      if (this.panel) this.panel.applySettings(s);
    }
  }

  new MyMod();
})();
```

That's it - constructing the instance registers it. No `==UserScript==` header,
no `about`, no manual `FlatMMOPlus.registerPlugin`.

### Lifecycle rules (important)

- **Do NOT override `onLogin()` or `onConfigsChanged()`** - `FML.Plugin` owns them
  and turns them into `onStart` / `onStop` / `onSettings`.
- `onStart()` runs when the mod becomes enabled; `onStop()` when disabled. Toggling
  a mod in the manager (and "Reset mod settings") drives these live, no reload.
- Read settings via `this.settings.<id>` (built each apply) or `this.getConfig(id)`.
- `this.every(ms, fn)` registers an interval that is auto-cleared on stop - prefer
  it over bare `setInterval`.
- **FlatMMOPlus hooks fire even while your mod is "stopped".** The plugin stays
  registered with FlatMMOPlus for its whole life; FML enable/disable only calls
  onStart/onStop. So any hook that reacts to game events must guard on your own
  active state, e.g. `if (!this.panel) return;` at the top of `onMessageReceived`.

### FlatMMOPlus hooks you can override on the mod

These pass straight through from FlatMMOPlus (guard them as above):

- `onMessageReceived(data)` - raw inbound websocket string (`"CMD=a~b~c"`, one per
  frame, NOT pre-split).
- `onMessageSent(message)` - return truthy to **block** the outbound message.
- `onChat(data)` - parsed chat `{username, tag, sigil, color, message, yell}`.
- `onPanelChanged(before, after)`, `onMapChanged(before, after)`,
  `onInventoryChanged(before, after)`.
- `onDamageTaken(hpBefore, hpAfter)`, `onFightStarted()`, `onFightEnded()`,
  `onActionChanged()`.
- Canvas paint hooks (every frame; globals `ctx`, `TILE_SIZE` available):
  `onPaint()`, `onPaintObjects()`, `onPaintNpcs()`.

## FML API reference

### `FML.Plugin` (extend this)

- `super(id, { config: [...] })` - `id` matches `index.json`. FML auto-prepends an
  `enabled` checkbox to your config and sources `about` from `index.json`.
- Hooks: `onStart()`, `onStop()`, `onSettings(s)` (+ any FlatMMOPlus hook above).
- `this.settings` - object of current config values.
- `this.getConfig(id)` - single value.
- `this.every(ms, fn)` - managed interval (auto-cleared on stop).

**Config types** (the manager renders each; FML supplies `enabled` itself):
`checkbox`/`bool`/`boolean`; `integer`/`int` (`min`,`max`);
`number`/`float`/`num` (`min`,`max`,`step`); `range` (`min`,`max`,`step`);
`string`/`text` (`max`); `select` (`options`: `[{value,label}]` or strings);
`color` (hex string); `label`; `panel`; `list`/`array`; `relation`/`key`/`object`.

### `FML.Panel(plugin, opts)`

`position: fixed`, id `fml-<pluginId>`, styled + prefixed `fml-`. Panels are
**docked by default** (right-side dock); drag the header out to float.

Options (all optional): `title`, `width`, `maxHeight`, `collapsible` (def true),
`draggable` (def true), `collapsed` (def false), `resizable` (def true),
`closable` (def true), `dockable` (def true).

Members / methods:
- `panel.body` - append your content here. Also `panel.el` (the `#fml-<id>` root),
  `panel.header`, `panel.actions`.
- `panel.mount()` / `panel.unmount()` - call in onStart / onStop.
- `panel.applySettings(s)` - re-read global look (call from onSettings).
- `panel.addHeaderButton({ text|img, title, onClick })` - button left of the X.
- `panel.addMenuItem({ label, onClick })` - entry in the header hamburger (☰).
  The hamburger is **hidden entirely** if a panel adds no items. Put per-mod
  actions here (e.g. "Reset loot", "Customize…").
- `panel.setTitle(t)`, `panel.toggleCollapse()`, `panel.setCollapsed(v)`,
  `panel.close()` (disables the mod), `panel.resetPosition()`.
- Size (drag grip) and position persist to `fml.<id>.size` / `.pos` / `.docked`.

Panel background + opacity are **global** (see below), not per-panel. Docked
panels are forced opaque (the dock has its own backing).

### `FML.List(container)` - keyed row reuse + reorder

- `list.row(key, () => buildEl)` - get/create the row element for `key`.
- `list.setOrder([keys])`, `list.has(key)`, `list.keys()`, `list.remove(key)`,
  `list.clear()`. Use it to render lists that update every tick without churn.

### `FML.util`

- `util.fmt(n)` → `"12.3k"` / `"4.5m"` / `"1.2b"`.
- `util.pretty(name)` → `format_snake_case` if present, else Title Case.
- `util.clampPct(v, default)` → 0..1.

### `FML.game` (thin accessors for game globals)

- `game.npcs()`, `game.getVar(key)`, `game.level(xp)`, `game.xpForLevel(level)`,
  `game.localName()`, `game.attackNpc(uuid)`, `game.switchPanel(id)`.

### Global panel settings (shared background + opacity)

Managed in the manager's "⚙ Global settings" card. Panels apply it automatically;
**non-panel mods** (e.g. the chat bar) should subscribe:

- `FML.globalSettings()` → `{ panelBg, panelOpacity }` (defaults `#0e1116`, `92`).
- `FML.setGlobal(key, value)` - write + live re-apply.
- `FML.onGlobal(fn)` - subscribe to changes; returns an unsubscribe fn (call it
  in onStop).

### `FML.setConfig(plugin, key, value)`

Programmatically write `flatmmoplus.<id>.config` and fire `onConfigsChanged`.

## Getting / refreshing the game source

The game requires a login, but a throwaway **guest** account works and can pull
every JS file. Repro with `curl` (cookie jar keeps the PHP session):

1. `GET https://flatmmo.com/g/` (Continue as Guest) → redirects to character creation.
2. `POST https://flatmmo.com/forms/post-create-character.php`
   body: `name=<uniquename>&hair=none&skin=none&body=none&legs=none&is_hardcore=0&is_one_life=0`
3. `GET https://flatmmo.com/api/worlds.php` → get a `world_id` (e.g. `1`), and the
   dashboard gives a `char_id`.
4. `POST https://flatmmo.com/play.php` body: `char_id=<id>&world_id=<id>` → the real game HTML.
5. Script tags in that HTML point at `js/<name>.js?v=…`. Download each from
   `https://flatmmo.com/js/<name>.js`. CSS is `https://flatmmo.com/styles.css`.

Game scripts (load order): `Globals, npc_animations, animations, tiles, maps,
websocket, misc, loop, map_objects, particles, projectiles, chat, hit_splats,
items, xp_drop, npcs, quests, bank, canvas, dev, ui, other`.

Do **not** try to read the game through markdown readers / CORS proxies - they
strip `<script>` tags. Use the guest-login curl flow above.

## Game internals (confirmed from `gamesrc/`)

### Global objects & functions

- `Globals.websocket` - the WebSocket. Send with `Globals.websocket.send("CMD=args")`.
- `Globals.local_username`, `Globals.tabActive`.
- `players[username]` - has `.hp`, `.max_hp`, `.in_combat_ticker`, pathing, etc.
- `items`, `item_sell_prices`, `get_sell_price(item)`, `current_map`, `maps`.
- `ground_items` - array of on-screen drops, each with a `.uuid`.
- `server_command(command, values)` in `websocket.js` - the big inbound dispatcher
  (`switch` over command names; `values` is the `~`-split payload). Grep here to
  learn any server → client message shape.
- `switch_panels(id, locked)`, `play_sound(file, volume)`, `open_modal(id)`,
  `format_snake_case(name)`, `format_time(sec)`.
- Ticks: `one_tick()` runs on `setInterval(…, 500)` (**1 tick = 500 ms**, so
  2 ticks = 1 second). `clientTickAt` counts ticks. The **client does not
  decrement** most server-pushed timers (potions, hunting) - for a smooth
  countdown you decrement locally between server updates.
- Canvas is `#canvas` (native `1536×896`, class `auto-rezise`). Overlays (chat,
  etc.) are `position:absolute` siblings of the canvas inside the same `<td>`,
  using canvas-space coordinates.

### Useful inbound messages (for `onMessageReceived`)

- `ADD_GROUND_ITEM=<uuid>~<item>~<amt>~<x>~<y>` - an item appeared on the ground.
  `RESET_GROUND_ITEMS` - full re-sync of visible ground items (re-fires the adds).
- `PLAY_SOUND=kill.mp3` - the kill marker (fires right after a monster dies).
- `POTION_TIMERS=name~tick~name~tick~…` - buff timers (`ui.js`, keeps tick>0).
- Everything is a raw `"CMD=a~b~c"` string; match with `data.startsWith("CMD=")`.

### UI / DOM

- Side interface buttons/panels: `#ui-button-<id>` / `#ui-panel-<id>`.
- Player HP text: `#ui-player-hp`, `#ui-player-max_hp`. Sleep: `#sleep-value`.
- Item icon path: `images/items/<item_name>.png`.
- Inventory items: `#ui-panel-inventory-content img[data-item-name]`.
- Vanilla buff panel: `#ui-potions` (`.potion-box` / `.potion-timer`); state is the
  bare global `potions_active` = `{ potionName: ticksRemaining }`.

## Gotchas (learned the hard way)

- **Bare globals, not `window.`**: top-level `class`/`let`/`const` in game scripts
  (e.g. `Globals`, `npcs`, `ground_items`, `potions_active`) are NOT on `window`
  (`window.Globals` is `undefined`). Read the **bare** identifier, typeof-guarded.
  Top-level `function foo(){}` IS on `window` (and assigning `window.foo = fn`
  replaces what bare `foo()` calls resolve to - that's how overrides work).
- **`Map` is shadowed**: `maps.js` defines `class Map`, so in page context
  `new Map()` gives the game's Map (no `.has`/`.get`). Use `Object.create(null)`
  for lookups. (`Set` is fine.)
- **`onMessageReceived` runs while disabled** - guard on your own start-state.
- **Changing a mod's `id`** makes FML treat it as a brand-new mod: disabled by
  default (enable flag is keyed by id), and its panel pos/size/dock reset.
- **Don't declare `about`** in a mod - `index.json` is the only source. FML sets it
  for you; an old FML (<1.2.3) won't, so keep the loader current.
- **Forgetting to run `hash_mods.py`** after editing a mod means the loader keeps
  serving the old cached script (the `hash` in `index.json` didn't change, so it
  never re-fetches).
- Prefer **message-driven** state over reading/patching game globals; avoid
  monkey-patching shared globals when a websocket message or DOM read will do.

## Conventions

- Prefix injected DOM ids/classes/styles with your mod id or `fml-` (e.g.
  `#fml-my-mod`, `mm-row`) to avoid clashing with the game and other mods.
- Do setup in `onStart()`, tear down fully in `onStop()`, re-apply look/settings in
  `onSettings()`. Keep a single injected `<style>` element per mod (id-guarded).
- Run `python hash_mods.py` (updates `mods/index.json`'s `hash` fields) whenever
  you change a mod's `.js` file.
- Git commits: imperative subject ≤50 chars, body wrapped at 72, omit body if not useful.
- User preferences: no defensive/"protective" guards for things that can't happen,
  no monkey-patching shared globals.