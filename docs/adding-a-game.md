# Adding another game

Nothing in `packages/core` or `packages/discord-bot` changes. The engine, the
ballots, the voting, the Discord frontend and the CLI are all game-agnostic
already — supporting a new game means writing an **adapter** and nothing else.

This guide is written from having done it once, for S.T.A.L.K.E.R. Anomaly. The
"Lessons" section near the end is the part worth reading twice: every item in it
cost real debugging time, and most of them will bite again on a different
engine.

---

## 1. What an adapter is

Two things:

1. **An in-game component** that speaks the protocol and can actually do things
   to the game.
2. **An optional `events.json`** that retunes names, categories, weights,
   cooldowns and default parameters without touching game code.

That's it. The adapter never knows Discord exists.

```
Discord ──▶ bot ──▶ ChaosEngine ──▶ transport ──▶ YOUR ADAPTER ──▶ game
                         │                              │
                  ballots, voting,               event registry,
                  cooldown mirror,               cooldowns, caps,
                  repeat avoidance               on-screen feedback
```

## 2. The contract

Your adapter must:

| It must | Why |
| --- | --- |
| Announce itself with `hello`, listing every event it can perform | the host builds ballots from this |
| Answer `describe` with a refreshed list, with an honest `available` flag | so ballots never offer something that will be refused |
| Answer `event` by validating the id, validating parameters, running it, and replying `event_result` | this is the whole point |
| Enforce its own cooldowns and caps | the host mirrors them, but **the game is the authority** |
| Send a `heartbeat` every few seconds | liveness |
| Optionally display `vote_start` / `vote_update` / `vote_end` / `notify` | player-facing feedback |

Deliberately small. Everything hard — weighting, per-category variety, repeat
avoidance, tie rules, rate limits, presentation — lives in the host.

Full message shapes: [protocol.md](protocol.md).

### The one rule that matters

**The host proposes, the game decides.** A malicious, buggy or mistyped host
must never be able to do something the game considers unreasonable. Concretely:

* An unknown event id is rejected, not guessed at.
* Parameters are coerced to their declared type and **clamped to their declared
  range** before an event sees them. Asking for 5 bloodsuckers gets you 1,
  because the mod declares `max = 1` on that parameter.
* No code ever crosses the boundary. The protocol carries ids and numbers.

## 3. Pick a transport

| Transport | Use when |
| --- | --- |
| **File spool** (shipped) | the game can read and write files — which is nearly all of them. Lowest common denominator, no networking needed. |
| WebSocket / HTTP | the game's scripting has sockets. Implement `Transport` in `packages/core/src/transport/` and the engine will not notice the difference. |

Anomaly uses the file spool because X-Ray's Lua sandbox has **no sockets at
all** — worth checking early, before designing around one.

The spool is two append-only JSON-lines files in a directory both sides can
reach. The rules that make it safe without locking are in
[protocol.md](protocol.md#transport); the short version is *append whole lines,
consume only newline-terminated ones, track a byte offset, and resync when the
file shrinks under you*.

## 4. The reference implementation

`packages/core/src/testing/mock-game.ts` is a complete working adapter in ~250
lines of TypeScript. It answers every message type, enforces cooldowns, and is
what the engine's own tests run against.

**Read that file first.** It is the shortest honest description of what you have
to build, and you can run the whole host pipeline against it before writing a
line of game code:

```bash
npm run mock-game -- --dir ./tmp/spool
npm run chaos -- --dir ./tmp/spool list
npm run chaos -- --dir ./tmp/spool vote --duration 15 --voters 10
```

## 5. Structure your adapter the same way

The Anomaly adapter splits into reusable runtime and game knowledge. Copy the
split; it is what makes the third game cheaper than the second.

| File | Reusable? | Role |
| --- | --- | --- |
| `chaos_rt_json.script` | any Lua 5.1 | JSON codec, no dependencies |
| `chaos_rt_log.script` | any Lua 5.1 | levelled logging to engine log + file |
| `chaos_rt_manager.script` | any Lua 5.1 | registration, validation, cooldowns, active-event tracking, cleanup |
| `chaos_rt_ipc.script` | any Lua with `io` | transport and protocol handlers |
| `chaos_rt_ui.script` | X-Ray only | on-screen feedback |
| `chaos_game_events.script` | **game-specific** | the events themselves |
| `chaos_boot.script` | **game-specific** | wiring into the engine's callbacks |

Only the bottom two rows are new work for a new X-Ray game. For a different
engine entirely, the top four are still a design to copy even if the code isn't.

## 6. Writing an event

An event is data plus two functions:

```lua
chaos_rt_manager.register({
    id       = "spawn_bloodsucker",      -- [a-z0-9_], unique
    name     = "Bloodsucker",            -- shown to voters
    category = "mutants",                -- ballots take one event per category
    duration = 0,                        -- seconds; 0 = instant
    cooldown = 180,                      -- seconds before it can run again
    weight   = 0.4,                      -- rarity: 1.0 common … 0.1 extreme
    params   = {
        count = { type = "number", min = 1, max = 1, default = 1 },
    },
    available = function(ctx) return ctx.actor ~= nil end,
    execute   = function(ctx, params) ... return true end,
    cleanup   = function(ctx, state) ... end,   -- only for duration > 0
})
```

`execute` returns `true`, `true, state` (state is handed back to `cleanup`), or
`false, "reason"`. Anything it throws is caught and reported as `exception`, so
one broken event cannot take the game down.

### Categories are not decoration

The default ballot strategy takes **one event per category**, so a vote offers a
monster, some loot, a world change and a player effect rather than four spawns
in a row. Design categories so that any four of them make an interesting vote.
Anomaly uses: `mutants`, `factions`, `player`, `loot`, `world`.

### Tiers beat per-event guesswork

Pull "how many, how far away" into one table rather than deciding per event:

```lua
local TIERS = {
    apex  = { min = 1, max = 1, default = 1, near = 30, far = 50 },
    pack  = { min = 1, max = 6, default = 4, near = 22, far = 38 },
    squad = { min = 1, max = 4, default = 3, near = 35, far = 60 },
    prop  = { min = 1, max = 3, default = 1, near = 12, far = 25 },
}
```

Adding a monster becomes one row, and balance lives in one place. Note the cap
is declared on the *parameter*, so the validator enforces it — nobody can ask
for five of something capped at one.

### Guidelines that keep an event set playable

* **Give everything a cooldown.** Without one, a chat spams the same button.
* **Weight extremes down hard.** Suggested: common `1.0`, rare `0.5`, epic
  `0.2`, extreme `0.1`.
* **Use `available` honestly.** An emission during an emission, a spawn while
  the player is loading — report `false` and the host will not offer it.
* **Refuse rather than ruin.** `damage_player` returns
  `false, "would be lethal"` instead of ending a 40-hour run. A refusal is
  visible feedback; a ruined save is not.
* **Make failure loud in the log, quiet in the game.** A spawn that cannot find
  a valid position should log why and do nothing, not drop a monster in a wall.

## 7. Lessons from doing this once

Every one of these cost real time on Anomaly. Check each against your engine
before you assume it doesn't apply.

### Don't trust engine placement APIs to mean what they say

`level.vertex_in_direction(vertex, direction, distance)` does not put you
`distance` away — it walks the navigation mesh and returns wherever the walk
*stopped*. Indoors, in a corridor, against a cliff, that's a metre from where
you started. Trusting it put bloodsuckers directly on top of the player.

**Do this instead:** try several directions, *measure the distance actually
achieved*, accept only a candidate that really is far enough, and refuse after
N attempts.

### Assume a session reload destroys your scripting VM

X-Ray rebuilds the entire Lua state when a save is loaded. Anything you cached
is gone, and — much worse — anything you handed to the engine that outlives the
VM is now a dangling pointer. A script-created UI window pushed into the HUD
render list crashed the game on every quick load.

**Do this instead:** prefer the engine's own long-lived UI primitives over
objects you create and own. If you must create one, find a teardown hook that
*reliably* fires first, and verify it does.

### The game clock is not the wall clock

`time_global()` stops while the game is paused — which is exactly when a player
alt-tabs to the voting frontend. Heartbeats stop, and a host with a short
timeout declares the game dead every time someone looks at Discord.

**Do this instead:** be generous with staleness windows (60s), be generous with
request timeouts (15s), and let commands queue rather than fail. Distinguish
"quiet" from "gone" when reporting status.

### Your file transport will be truncated underneath you

The game truncates its outbox when a new session starts. Two separate bugs came
from this:

1. Truncation *between* the size check and the read gives you a slice of the new
   file at the old file's offsets — garbage arriving as half a line.
2. If the new file happens to be *exactly* as long as the offset you had already
   read to, a size-only check concludes "nothing new" and goes **permanently
   deaf**.

**Do this instead:** re-stat after reading and discard if the file shrank; track
modification time as well as size; resync the buffer when a line fails to parse.

### Check the engine's existing key bindings

`F9` was bound to `quick_load`. The "debug key does nothing, then the game
crashes" report was one keypress doing exactly what the engine intended.

### Missing directories are not your script's to create

Lua's `io.open` will not create a directory, and — contrary to reasonable
expectation — neither did the engine's own file writer. The spool folder never
appeared, the transport never opened, and nothing said so.

**Do this instead:** have the *host* create shared directories, retry rather
than failing permanently, and log the reason the first time.

## 8. Test without launching the game

Iterating through a three-minute game load is how a day disappears. Two things
make that unnecessary:

**A headless harness.** `tools/lua-harness/` loads the real `.script` files into
a Lua VM with stubbed engine APIs and plays a whole session in about a second:
startup with no spool directory, debug keys, IPC commands, malformed input,
spawn placement with the navigation walk deliberately blocked, and a save
reload. It cannot catch engine-level crashes, but it catches load order, nil
references, silent early returns and logic errors.

```bash
npm run test:lua
```

The stubs live in `xray-stubs.lua` and are worth copying in spirit: each one
*records* what it was asked to do, so the scenario can assert on outcomes rather
than just "didn't throw".

**A manifest drift check.** `events.json` only retunes events the game already
has, so an id in one and not the other fails silently. `npm run check:manifest`
turns that into an error.

## 8b. A second adapter, in practice

The GTA IV adapter is the honest test of everything above: a different engine, a
different language, a different transport folder — and **zero host changes**.
What it actually took:

| Step | Effort |
| --- | --- |
| Reflect over the modding API to get real signatures | the bulk of it |
| Port the runtime (JSON, log, manager, IPC) from Lua to C# | mechanical |
| Write 20 events | the fun part |
| Host-side work | none |

The single most valuable step was **reflecting over the shipped assembly**
rather than trusting memory or a wiki. GTA IV's .NET API is not the one people
expect from later Script Hooks: there is no `Weapons.Give()`, and `MaxHealth`,
`GravityMultiplier` and `TimeScale` are write-only. Every one of those would
have been a silent in-game failure; instead they were compile errors found in a
second.

Do the equivalent for your engine before writing a line of event code. For a
.NET game that means `ReflectionOnlyLoadFrom` + `GetExportedTypes`, then dumping
the members you need — copy the DLL out of the game folder first, because a
downloaded file carries a mark-of-the-web that makes the loader refuse it.

Then wire a **compile or parse check into the test suite on day one**:
`npm run lint:lua` for the Lua adapter, `npm run check:csharp` for the C# one.
Both answer the same question — would this even load? — without a game.


## 9. Checklist

```bash
npm run lint:lua                          # syntax-check the Lua
npm run test:lua                          # run the adapter headlessly
npm run check:manifest                    # events.json and the mod agree
npm run mock-game -- --dir ./tmp/spool    # develop the host against a fake game
npm run chaos -- --dir <spool> list       # the adapter describes itself
npm run chaos -- --dir <spool> fire <id>  # one event, end to end
npm run chaos -- --dir <spool> vote       # a full vote, end to end
```

Then, in the game: does it load, does an event fire, does it survive a save
reload, and does the host still see it afterwards. Those four cover almost
everything that goes wrong.
