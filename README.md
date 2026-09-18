# Chaos Engine

A reusable engine for letting a community vote on chaotic events that happen
inside a game, plus a S.T.A.L.K.E.R. Anomaly 1.5.3 adapter as the first target.

```
Discord  ->  Discord bot  ->  ChaosEngine  ->  transport  ->  game adapter  ->  game
                                  |                                 |
                             voting, ballots,                 event registry,
                             cooldowns, registry              cooldowns, UI
```

The split that matters: **the bot knows nothing about any game, and the game
knows nothing about Discord.** Both only speak the protocol in
[`docs/protocol.md`](docs/protocol.md). Supporting a second game means writing a
new adapter, not touching the bot; adding a second frontend (a web page, Twitch,
a stream overlay) means writing a new frontend, not touching the game.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | The reusable engine. Registry, cooldowns, ballots, voting, transports, protocol, CLI, mock game. No game and no Discord in here. |
| `packages/discord-bot` | The Discord frontend: buttons, embeds, slash commands. |
| `adapters/stalker-anomaly` | The Anomaly adapter: the in-game Lua mod plus its `events.json`. |
| `tools` | Lua syntax linter, the headless Lua harness, and the mod installer. |
| `docs` | Protocol, event authoring, and how to add another game. |

Inside the game mod the same split repeats: `chaos_rt_*.script` is reusable
runtime (JSON, logging, event manager, IPC, UI) and `chaos_game_events.script`
is the only file that knows what a bloodsucker is.

## Requirements

* Node 20 or newer (18 works for the engine and CLI, but discord.js pulls in
  `undici`, which wants >= 18.17).
* S.T.A.L.K.E.R. Anomaly 1.5.3 for the game side.

## Quick start

```bash
npm install
npm run build
npm test
```

### 1. Run the pipeline with no game at all

```bash
npm run mock-game -- --dir ./tmp/spool
```

and in a second terminal:

```bash
npm run chaos -- --dir ./tmp/spool list
npm run chaos -- --dir ./tmp/spool fire spawn_zombies count=12
npm run chaos -- --dir ./tmp/spool vote --duration 15 --voters 10
```

The mock game implements the same protocol as the Lua adapter, so anything that
works against it works against Anomaly.

### 2. Install the game mod

```bash
npm run install-mod -- --game-root "C:/Games/Anomaly"
```

Use `--link` instead of copying while developing, so edits to a `.script` file
take effect on the next game start.

Start Anomaly and load a save. You should see `DISCORD CHAOS ready` on screen
and `[DiscordChaos] Mod loaded` in `appdata/chaos.log`. Debug keys, no Discord
needed (F9 is not available -- Anomaly binds it to quick_load):

| Key | Effect |
| --- | --- |
| `F8` | dump the event registry to the log, show a test notification |
| `F10` | run the next event in the registry (cycles through all of them) |
| `F11` | show a fake vote panel for 10 seconds |

### 3. Drive the running game from outside

```bash
npm run chaos -- --game-root "C:/Games/Anomaly" status
npm run chaos -- --game-root "C:/Games/Anomaly" list
npm run chaos -- --game-root "C:/Games/Anomaly" fire spawn_bloodsucker count=5
npm run chaos -- --game-root "C:/Games/Anomaly" vote --duration 20 --voters 8
```

### 4. Add Discord

```bash
cp packages/discord-bot/config.example.json packages/discord-bot/config.json
# edit channelId / guildId / gameRoot, then:
DISCORD_TOKEN=... npm run bot
```

The bot needs the `bot` and `applications.commands` scopes, and permission to
send messages and embeds in the vote channel. Commands:

| Command | Who | What |
| --- | --- | --- |
| `/chaos vote` | admin | start a vote now |
| `/chaos status` | anyone | game connection, event count, spool path |
| `/chaos events` | anyone | list events with cooldowns and availability |
| `/chaos fire <id>` | admin | run one event immediately |

Useful settings in `config.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| `vote.strategy` | `groups` | `groups` takes one event per category; `flat` weights across everything |
| `vote.botVoters` | `2` | automated voters added to every vote, so a quiet channel still produces a result worth watching |
| `vote.autoIntervalSeconds` | `0` | run votes on a loop instead of only on command |

Bot voters appear in the tally as ordinary votes and a human majority always
overrules them.

## Testing

```bash
npm test            # everything below, in order
npm run lint:lua    # parse every .script as Lua 5.1
npm run test:lua    # run the mod headlessly against stubbed X-Ray APIs
```

`npm run test:lua` is worth knowing about. It loads the real `chaos_*.script`
files into a Lua VM with stubbed engine APIs and plays out a whole session:
start-up with no spool directory, the debug keys, IPC commands, malformed input,
and a quick load. It will not catch engine-level crashes, but it catches load
order, nil references and silent early returns in about a second, instead of
after a three-minute game load.

## How a vote plays out

1. The bot asks the engine for a ballot. By default it takes one event per
   category, so a vote spans a monster, some loot, a world change and a player
   effect rather than four spawns in a row. Anything disabled, on cooldown or
   that the game reported as unavailable is skipped.
2. The vote is posted as buttons, and mirrored onto the in-game notification line.
3. One vote per Discord user; changing it before the timer expires is allowed.
4. On expiry the winner is chosen — most votes, ties broken by whichever option
   reached that count first, then by ballot order.
5. The engine sends the winning event id and its parameters to the game.
6. The game validates the id against its registry, checks its own cooldowns, and
   runs it. The result comes back and is shown in Discord and in game.

The game is always the authority on whether an event may run. The host-side
cooldowns exist only so a ballot is not built out of choices that would be
refused.

## Safety

The protocol carries event **ids** and validated parameters. No code crosses the
boundary in either direction, and the Lua side never evaluates anything it
receives — an unknown id is rejected and logged.

## Status against the development plan

Phases 1–8 of `stalker_discord_chaos_development_plan.md` are implemented: mod
foundation, event manager, initial events, in-game UI, local IPC, Discord bot,
button voting, and the full integration. Phases 9–11 are partly in place (the
registry has categories, weights and a data-driven `events.json`); phases 12–13
(game state exposure, viewer progression) are not started.

Two deliberate departures from the plan, both documented in
[`docs/protocol.md`](docs/protocol.md):

* **Transport.** The plan preferred a WebSocket on `127.0.0.1:8765`. X-Ray's Lua
  sandbox has no sockets, so the shipped transport is the plan's fallback: a
  JSON-lines file spool. It is behind the `Transport` interface, so a socket
  transport can be added later without touching the engine.
* **In-game UI.** Rendered through Anomaly's own notification statics rather
  than a custom window. A script-created `CUIScriptWnd` pushed into the HUD
  render list crashes the game on quick load -- X-Ray rebuilds the entire Lua
  VM when a save is loaded, with no callback that reliably fires first, so the
  window is collected while the engine still holds a pointer to it. The cost is
  that the vote board is one line instead of four; a full panel needs a custom
  static registered in UI XML.
