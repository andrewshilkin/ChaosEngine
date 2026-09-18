# S.T.A.L.K.E.R. Anomaly 1.5.3 adapter

## Install

```bash
npm run install-mod -- --game-root "C:/Games/Anomaly"
```

That copies `game-mod/gamedata/scripts/*.script` into `<game root>/gamedata/scripts/`.
Add `--link` to junction the folder instead, so edits take effect on the next
game start without re-copying.

Nothing in Anomaly is overwritten: every file is new and prefixed `chaos_`, and
the UI goes through Anomaly's own notification statics rather than replacing any
UI XML.
The mod should therefore coexist with other addons, including MO2 setups (point
`--game-root` at the mod folder and let MO2 do the overlay).

## Verify without Discord

Start the game and load a save. You should see `DISCORD CHAOS ready` on screen,
and this in `appdata/chaos.log`:

```
[DiscordChaos] INFO registered 20 events
[DiscordChaos] INFO bootstrap registered
[DiscordChaos] INFO init: starting up
[DiscordChaos] INFO ipc: spool path is ...\appdata\chaos\
[DiscordChaos] INFO ipc: spool ready at ...\appdata\chaos\
[DiscordChaos] INFO Mod loaded
```

That log is a lot easier to read than the engine's own `appdata/logs/*.log`,
which carries the same lines buried in engine spam.

| Key | Effect |
| --- | --- |
| `F8` | dump the registry to the log, show a test notification |
| `F10` | run the next event in the registry, ignoring cooldowns (cycles) |
| `F11` | show a fake vote panel for 10 seconds |

Rebind them at the top of `chaos_boot.script`.

## Then from outside the game

```bash
npm run chaos -- --game-root "C:/Games/Anomaly" status
npm run chaos -- --game-root "C:/Games/Anomaly" fire spawn_bloodsucker count=5
```

## Files

| File | Role |
| --- | --- |
| `chaos_boot.script` | entry point: registers callbacks, debug keys, the tick |
| `chaos_game_events.script` | the events — the only file with game knowledge |
| `chaos_rt_manager.script` | reusable event manager |
| `chaos_rt_ipc.script` | reusable spool transport and protocol handlers |
| `chaos_rt_ui.script` | HUD overlay (X-Ray specific, game agnostic) |
| `chaos_rt_json.script` | dependency-free JSON codec |
| `chaos_rt_log.script` | logging |

`events.json` sits next to this README and controls presentation and balance;
see [`docs/events.md`](../../docs/events.md).

## Troubleshooting

**Nothing in the log at all.** The scripts did not load. Confirm they are in
`<game root>/gamedata/scripts/` and that `gamedata` is actually being read (a
`DO_NOT_INSTALL_OLD_ADDONS` install still reads `gamedata`, MO2 installs do not
unless the mod is enabled). Run `npm run lint:lua` to rule out a syntax error.

**`Mod loaded` but the host says "not connected".** The host is pointed at the
wrong directory. The mod logs its spool path on start; pass exactly that to
`--dir`, or pass `--game-root` and let the tool derive it.

**F9 does nothing useful.** Anomaly binds F9 to quick_load. The debug keys are
F8, F10 and F11.

**Events run but nothing appears on screen.** Messages use Anomaly's own
notification lines, which are suppressed while a full-screen UI (inventory, PDA,
map) is open.

**An event reports `unavailable`.** That is the game refusing on purpose — the
player is dead or not spawned, or an emission is already running. `F8` prints
the availability of every event.
