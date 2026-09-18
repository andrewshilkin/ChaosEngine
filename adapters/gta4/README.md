# GTA IV adapter (ScriptHookDotNet)

20 events, driven by the same Discord bot and the same protocol as the
S.T.A.L.K.E.R. adapter. Nothing on the host side changes between games.

## Requirements

* GTA IV with **ScriptHook** and **ScriptHookDotNet** installed (`ScriptHook.dll`
  and `ScriptHookDotNet.asi` in the game folder — yours already has both)
* .NET Framework 4

## Install

```bash
npm run install-mod -- --game gta4 --game-root "C:/Games/Grand Theft Auto IV/GTAIV"
```

That copies one file, `ChaosEngine.cs`, into `<GTA IV>\scripts\`, and creates
the spool folder. **There is no build step** — the Script Hook compiles plain
`.cs` scripts when the game loads them.

## Verify without Discord

Start GTA IV and load into the world (not the menu — the script waits for a
playable character before it does anything). Then check
`<GTA IV>\scripts\chaos.log`:

```
[ChaosEngine] INFO starting up
[ChaosEngine] INFO registered 20 events
[ChaosEngine] INFO ipc: spool ready at ...\scripts\chaos
```

| Key | Effect |
| --- | --- |
| `F8` | dump the event registry to the log |
| `F10` | run the next event in the registry, ignoring cooldowns (cycles) |
| `F11` | show a fake vote line for 10 seconds |

If nothing appears at all, the script did not compile: **read
`ScriptHookDotNet.log`** in the game folder. It records every compile error.

## Then from outside the game

```bash
npm run chaos -- --dir "C:/Games/Grand Theft Auto IV/GTAIV/scripts/chaos" status
npm run chaos -- --dir "<that path>" fire spawn_police count=4
npm run chaos -- --dir "<that path>" vote --duration 20 --voters 8
```

To point the Discord bot at GTA IV instead of Anomaly, change two lines in
`packages/discord-bot/config.json`:

```json
"game": {
  "gameRoot": "C:/Games/Grand Theft Auto IV/GTAIV",
  "spoolDir": "C:/Games/Grand Theft Auto IV/GTAIV/scripts/chaos",
  "manifest": "C:/Games/ChaosEngine/adapters/gta4/events.json"
}
```

`spoolDir` is needed because GTA IV keeps its spool under `scripts\`, not
`appdata\`. Run one bot per game.

## Events

| id | name | category | cooldown | parameters |
| --- | --- | --- | --- | --- |
| `wanted` | Wanted | police | 120s | `stars` 1–6, default 3 |
| `remove_wanted` | Clean Record | police | 180s | — |
| `spawn_police` | Police Response | police | 150s | `count` 1–6, default 3 |
| `helicopter` | Helicopter | police | 300s | — |
| `spawn_enemy` | Ambush | hostiles | 120s | `count` 1–6, default 3 |
| `vehicle_attack` | Car Chase | hostiles | 180s | `count` 1–3, default 2 |
| `spawn_vehicle` | Free Car | gifts | 120s | — |
| `random_weapon` | Random Weapon | gifts | 90s | — |
| `remove_weapons` | Disarmed | gifts | 240s | — |
| `heal` | Patch Up | player | 120s | — |
| `damage` | Pain | player | 120s | `amount` 5–60, default 25 |
| `ragdoll` | Ragdoll | player | 90s | `seconds` 1–10, default 4 |
| `burn` | On Fire | player | 240s | lasts 8s, then extinguished |
| `super_jump` | Moon Jump | player | 240s | `seconds` 10–120, default 30 |
| `speed` | Time Warp | player | 240s | `scale` 0.3–1.8, default 0.5 |
| `random_teleport` | Somewhere Else | player | 300s | — |
| `explode` | Explosion | world | 180s | — |
| `weather` | Weather | world | 300s | — |
| `time` | Time Skip | world | 300s | `hour` 0–23, default 23 |
| `chaos` | CHAOS | world | 600s | `count` 2–5, default 3 |

Names, categories, cooldowns, weights and defaults come from
[`events.json`](events.json). The game clamps every parameter to the range it
declares, so a host asking for 20 police officers gets 6.

## Implementation notes

**Where the numbers come from.** GTA IV's .NET API is not the one people expect
from later Script Hooks, and several members are write-only. Each of these was
checked by reflecting over the shipped `ScriptHookDotNet.dll` rather than
guessed:

* There is **no `Weapons.Give()`**. A weapon is issued by setting the ammo on
  its slot: `ped.Weapons.FromType(type).Ammo = 200`.
* `Ped.MaxHealth`, `Ped.GravityMultiplier` and `Game.TimeScale` are **write-only**,
  so cleanup restores a known-good value rather than a remembered one.
* `World.ExtinguishFire` takes a position and a radius; the `ScriptedFire`
  returned by `StartFire` can delete itself, which is what `burn` uses.

**Super jump is low gravity.** GTA IV has no super-jump switch, so Moon Jump
sets `GravityMultiplier` to 0.35 for the duration. Same effect, using an API
that certainly exists.

**Time Warp is `Game.TimeScale`.** That slows or speeds the whole world, not
just the player — GTA IV has no clean per-player movement multiplier through
this API. It is a good chaos event, just not literally "player speed".

**Spawns snap to the street network.** `World.GetNextPositionOnStreet` keeps
vehicles out of walls and off rooftops; peds use `GetGroundPosition`. A model
that fails to load falls back to a generic ped or vehicle rather than throwing.

**`chaos` cannot recurse or cheat.** It picks from whatever else is *currently
available*, excluding itself, so it can never fire something the game would
otherwise refuse.

**Explosions are offset three metres.** A detonation exactly on the player is an
instant death, which is a worse story than a near miss.

## Troubleshooting

**Nothing in `scripts\chaos.log`.** The script did not compile or did not load.
`ScriptHookDotNet.log` in the game folder has the reason. `npm run check:csharp`
compiles the same file against the same assembly and will usually reproduce it.

**Events log as executed but nothing happens.** The script booted before the
world was ready. It waits for a playable character, but loading a save while
events are queued can still land one early — it will be logged and refused.

**`unavailable` from an event.** That is the game refusing on purpose: dead
player, no wanted level to clear, too little health to survive being set on
fire. `F8` prints the availability of everything.
