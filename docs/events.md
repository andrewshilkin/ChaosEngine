# Events (stalker-anomaly)

Twenty events across five categories. Categories are not decoration: a ballot
takes **one event per category**, so a vote offers a monster, some loot, a world
change and a player effect rather than four spawns in a row.

## mutants

| id | name | cooldown | weight | count |
| --- | --- | --- | --- | --- |
| `spawn_bloodsucker` | Bloodsucker | 180s | 0.4 | 1 (hard cap) |
| `spawn_snork` | Snork | 150s | 0.6 | 1 (hard cap) |
| `spawn_zombies` | Zombie Horde | 120s | 1.0 | 4, max 6 |
| `spawn_dogs` | Blind Dog Pack | 100s | 1.0 | 4, max 6 |
| `spawn_rats` | Rat Swarm | 90s | 1.0 | 4, max 6 |

## factions

| id | name | cooldown | weight | count |
| --- | --- | --- | --- | --- |
| `spawn_bandits` | Bandit Ambush | 150s | 0.8 | 3, max 4 |
| `spawn_military` | Military Patrol | 180s | 0.6 | 3, max 4 |
| `spawn_monolith` | Monolith Squad | 300s | 0.2 | 2, max 4 |
| `spawn_stalkers` | Wandering Loners | 120s | 0.8 | 3, max 4 |

Faction NPCs use the stock `sim_default_*` profiles, so whether they shoot on
sight is decided by Anomaly's own faction relations and the player's standing.

## loot

| id | name | cooldown | weight | notes |
| --- | --- | --- | --- | --- |
| `give_random_weapon` | Supply Drop | 90s | 1.0 | one stock weapon at 60–100% condition |
| `give_supplies` | Care Package | 100s | 1.0 | 4 random medkits/food/ammo/grenades, max 8 |
| `give_artefact` | Artefact | 240s | 0.4 | one random artefact |
| `spawn_corpse` | Fresh Corpse | 150s | 0.8 | a dead stalker with their gear, 12–25 m away |

## player

| id | name | cooldown | weight | parameters |
| --- | --- | --- | --- | --- |
| `heal_player` | Field Medic | 120s | 1.0 | — |
| `damage_player` | Pain | 90s | 1.0 | `power` 0.05–0.6, default 0.25 |
| `irradiate_player` | Hot Dose | 150s | 0.8 | `amount` 0.05–0.5, default 0.2 |

## world

| id | name | cooldown | weight | notes |
| --- | --- | --- | --- | --- |
| `nightfall` | Nightfall | 900s | 0.5 | skips forward to 23:00; offered 05:00–20:00 |
| `daybreak` | Daybreak | 900s | 0.5 | skips forward to 08:00; offered 20:00–05:00 |
| `emission` | Emission | 1800s | 0.1 | — |
| `psi_storm` | Psi Storm | 1200s | 0.2 | — |

Names, categories, cooldowns, weights and default parameters come from
[`adapters/stalker-anomaly/events.json`](../adapters/stalker-anomaly/events.json),
which overrides whatever the mod itself declares. Delete an entry there to fall
back to the mod's values, or set `"enabled": false` to keep an event implemented
but out of every ballot.

## Spawn placement

`level.vertex_in_direction()` does not teleport something N metres away — it
walks the AI navigation grid and returns wherever the walk *stopped*. Indoors,
in a corridor or against a cliff it comes back with a vertex barely off the
starting point. Trusting that result is how the first version put bloodsuckers
directly on top of the player.

So `find_spawn_point()` tries up to twelve random directions, measures the
distance actually achieved, and only accepts a candidate that is genuinely far
enough away. If all twelve come back short the event **refuses** and logs how
close it got. Nothing appearing is a better outcome than a bloodsucker spawning
inside the player, and a refusal in a vote is visible feedback rather than a
silent ambush.

## Danger tiers

How many appear, and from how far, comes from a tier rather than per-event
guesswork. The table lives at the top of `chaos_game_events.script`:

| tier | count | distance | for |
| --- | --- | --- | --- |
| `apex` | exactly 1 | 30–50 m | already a serious fight on its own |
| `pack` | 1–6, default 4 | 22–38 m | individually weak, dangerous in numbers |
| `squad` | 1–4, default 3 | 35–60 m | armed humans, who shoot from range |
| `prop` | 1–3, default 1 | 12–25 m | harmless scenery: corpses, crates |

The cap is declared on the event's `count` parameter, so the **game** enforces
it — the parameter validator clamps whatever the host asks for. A bot, a
manifest or a mistyped CLI command asking for five bloodsuckers gets one. Same
principle as everywhere else: the host proposes, the game decides.

Adding a monster is one row in `MUTANTS` or `FACTIONS`. Put anything genuinely
lethal — chimera, controller, burer, pseudogiant — in `apex`.

## Behaviour notes

**`heal_player`** uses the same idiom Anomaly's own scripts use for a full heal:
health, bleeding and psy health to full, radiation to zero.

**`damage_player`** applies a wound hit rather than writing health directly, so
armour, effects and death handling all behave normally. It refuses when the hit
would be lethal — chaos should hurt, not end a 40-hour run.

**`nightfall`/`daybreak`** only ever move the clock *forward*; rewinding game
time upsets schedulers throughout Anomaly. Each reports itself unavailable when
it is already that time of day, so the pair never appears as a no-op.

**`emission`** and **`psi_storm`** delegate to Anomaly's own `surge_manager` and
`psi_storm_manager`, and report themselves unavailable while one is already
running.

## Not implemented yet

**Helicopter flyby.** A `helicopter` section exists, but `se_heli` expects smart
terrain registration and a `[logic]` block with patrol paths before it will fly
or attack. Spawning a bare one next to the player would most likely produce a
broken object or a crash, and that is not something worth guessing at without
being able to iterate in game. It needs a session with the game open.
