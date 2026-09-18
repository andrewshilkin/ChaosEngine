# STALKER Discord Chaos --- Development Plan

## 1. Goal

Build a custom **S.T.A.L.K.E.R. Anomaly 1.5.3** mod that allows a
Discord community to vote on random events that happen in-game.

Core loop:

**Discord → Discord Bot → Local IPC → Anomaly Mod → Event Manager → Game
Event → In-Game UI**

No Twitch and no Chaos Tricks.

------------------------------------------------------------------------

## 2. MVP Scope

The first playable version should include:

-   Discord bot
-   Discord button-based voting
-   Configurable voting duration
-   Four event choices per vote
-   One vote per Discord user
-   Vote result calculation
-   Local Discord-to-game communication
-   Anomaly event manager
-   Five initial game events
-   Basic in-game voting display
-   Basic event notification
-   Event cooldowns
-   Logging

### MVP success criteria

A Discord user can:

1.  See a vote in Discord.
2.  Select an event.
3.  Wait for the voting timer to finish.
4.  See the winning event.
5.  Have that event executed inside Anomaly.
6.  See an in-game notification confirming the event.

------------------------------------------------------------------------

## 3. Architecture

``` text
Discord
   │
   ▼
Discord Bot
   │
   ├── VotingManager
   ├── EventRegistry
   ├── CooldownManager
   └── GameConnection
   │
   ▼
localhost IPC
   │
   ▼
Anomaly Mod
   │
   ├── IPC Handler
   ├── EventManager
   ├── GameState
   └── ChaosUI
   │
   ▼
Game Event
```

The Discord bot must not contain game-specific logic.

The Anomaly mod must not depend on Discord.

The IPC layer should only transport commands and results.

------------------------------------------------------------------------

## 4. Phase 1 --- Anomaly Mod Foundation

### Tasks

-   Create a minimal Anomaly addon/mod structure.
-   Add custom Lua scripts.
-   Verify scripts are loaded when Anomaly starts.
-   Add a dedicated log file or clear debug logging.
-   Add a simple in-game test notification.
-   Confirm the mod works without Chaos Tricks or Twitch.

### Acceptance criteria

Starting Anomaly produces:

``` text
[DiscordChaos] Mod loaded
```

and the game can display:

``` text
DISCORD CHAOS
TEST EVENT
```

No Discord integration is required yet.

------------------------------------------------------------------------

## 5. Phase 2 --- Event Manager

Create a generic event execution layer.

Example:

``` lua
EventManager.execute("spawn_bloodsucker")
EventManager.execute("spawn_zombies")
EventManager.execute("give_random_weapon")
```

Each event should have:

``` text
id
name
category
duration
cooldown
execute()
cleanup()
```

The EventManager is responsible for:

-   finding events
-   validating events
-   checking cooldowns
-   executing events
-   tracking active events
-   cleaning up temporary events
-   logging execution

Discord must never directly execute Lua functions.

------------------------------------------------------------------------

## 6. Phase 3 --- Initial Events

Implement five simple events first:

``` text
spawn_bloodsucker
spawn_zombies
give_random_weapon
heal_player
damage_player
```

Initially trigger these events directly from test code.

Do not connect Discord until all five events work reliably inside the
game.

### Example

``` lua
EventManager.execute("spawn_bloodsucker", {
    count = 5
})
```

------------------------------------------------------------------------

## 7. Phase 4 --- In-Game UI

Create a simple UI layer independent from Discord.

Required API:

``` lua
ChaosUI.showVote(options, duration)
ChaosUI.updateVote(votes)
ChaosUI.hideVote()

ChaosUI.showEvent(event)
ChaosUI.hideEvent()
```

### Voting display

``` text
DISCORD CHAOS

1. Bloodsuckers       42%
2. Zombie Horde       31%
3. Random Weapon      19%
4. Emission            8%

Voting: 17s
```

### Winner display

``` text
DISCORD CHAOS

BLOODSUCKERS
```

### Event notification

``` text
⚠ BLOODSUCKERS × 5
```

Keep the first UI implementation simple. Visual polish comes after the
integration works.

------------------------------------------------------------------------

## 8. Phase 5 --- Local IPC

The preferred communication method is:

``` text
127.0.0.1:8765
```

Use a local WebSocket if practical.

Fallback options:

1.  Local HTTP
2.  Temporary file/message queue

The IPC protocol should use JSON.

Example command:

``` json
{
  "type": "event",
  "id": "spawn_bloodsucker",
  "parameters": {
    "count": 5
  }
}
```

Example response:

``` json
{
  "type": "event_result",
  "id": "spawn_bloodsucker",
  "success": true
}
```

The IPC layer must validate incoming event IDs and parameters.

Never execute arbitrary Lua code received from the bot.

------------------------------------------------------------------------

## 9. Phase 6 --- Discord Bot

Use:

-   Node.js
-   TypeScript
-   discord.js

Suggested structure:

``` text
discord-bot/
├── src/
│   ├── bot.ts
│   ├── voting.ts
│   ├── events.ts
│   ├── game-client.ts
│   └── config.ts
├── package.json
└── config.json
```

Responsibilities:

### bot.ts

-   Discord connection
-   commands
-   vote messages
-   buttons

### voting.ts

-   active vote
-   user votes
-   vote changes
-   timer
-   winner calculation

### events.ts

-   available event definitions
-   event display names
-   categories
-   parameters

### game-client.ts

-   localhost connection
-   send event commands
-   receive game results
-   reconnect handling

### config.ts

-   Discord token
-   channel IDs
-   vote duration
-   IPC address
-   cooldown configuration

------------------------------------------------------------------------

## 10. Phase 7 --- Discord Voting

Use Discord buttons instead of text commands.

Example:

``` text
DISCORD CHAOS

Choose the next event:

[ Bloodsuckers ]
[ Zombie Horde ]
[ Random Weapon ]
[ Emission ]

Voting ends in 20 seconds.
```

Voting rules:

-   One vote per Discord user.
-   Users can change their vote before the timer expires.
-   Vote counts update automatically.
-   Voting closes automatically.
-   Winner is selected automatically.
-   Ties use a deterministic rule.
-   Events on cooldown cannot appear.
-   Bot logs the final result.

------------------------------------------------------------------------

## 11. Phase 8 --- First Full Integration

This is the main MVP milestone.

Complete flow:

``` text
Discord vote starts
       ↓
Players click buttons
       ↓
Timer expires
       ↓
Bot calculates winner
       ↓
Bot sends JSON over localhost
       ↓
Anomaly receives command
       ↓
IPC Handler validates command
       ↓
EventManager executes event
       ↓
Game event happens
       ↓
Anomaly UI displays result
       ↓
Bot announces winner
```

Example:

``` text
Discord:

Bloodsuckers       42%
Zombie Horde       31%
Random Weapon      19%
Emission             8%

Winner: Bloodsuckers
```

Game:

``` text
DISCORD CHAOS

BLOODSUCKERS × 5
```

------------------------------------------------------------------------

## 12. Phase 9 --- Event Registry

Expand the event system into categories.

``` text
events/
├── mutants/
│   ├── bloodsucker
│   ├── snork
│   ├── boar
│   └── chimera
│
├── factions/
│   ├── monolith
│   ├── bandits
│   └── military
│
├── player/
│   ├── heal
│   ├── damage
│   ├── teleport
│   └── random_weapon
│
├── world/
│   ├── emission
│   ├── psi_storm
│   └── weather
│
└── chaos/
    ├── remove_inventory
    ├── explode_nearby
    └── random_event
```

Target after MVP:

**20--30 events.**

------------------------------------------------------------------------

## 13. Phase 10 --- Data-Driven Events

Move event configuration out of hardcoded logic where practical.

Example:

``` json
{
  "id": "spawn_bloodsucker",
  "name": "Bloodsucker Hunt",
  "category": "mutants",
  "duration": 30,
  "cooldown": 120,
  "weight": 1.0,
  "parameters": {
    "count": 5
  }
}
```

Configuration should control:

-   display name
-   category
-   duration
-   cooldown
-   probability/weight
-   event parameters

Code should control actual game execution.

------------------------------------------------------------------------

## 14. Phase 11 --- Balance

Add event weights and cooldowns.

Suggested rarity model:

``` text
Common    1.0
Rare      0.5
Epic      0.2
Extreme   0.1
```

Suggested categories:

``` text
Mutants
Factions
Player
World
Weapons
Extreme
```

The goal is to prevent the same powerful event from appearing
continuously.

------------------------------------------------------------------------

## 15. Phase 12 --- Game State

After the MVP, expose limited game state to the bot.

Potential data:

``` text
player health
player location
player money
combat status
current level
current faction
active emission
```

This allows context-aware event selection.

Example:

``` text
Player is already fighting:
→ avoid another extreme combat event
```

or:

``` text
Player is outside:
→ allow emission event
```

Do not implement this before the basic event pipeline is stable.

------------------------------------------------------------------------

## 16. Phase 13 --- Viewer Progression

Optional post-MVP system.

Viewers accumulate Chaos Points.

Example:

``` text
100 points   → Boar
500 points   → Bloodsucker
1000 points  → Chimera
5000 points  → Emission
```

This can later create persistent community progression.

------------------------------------------------------------------------

## 17. Repository Structure

``` text
stalker-discord-chaos/
│
├── game-mod/
│   ├── gamedata/
│   │   ├── scripts/
│   │   ├── configs/
│   │   └── ui/
│   └── README.md
│
├── discord-bot/
│   ├── src/
│   │   ├── bot.ts
│   │   ├── voting.ts
│   │   ├── events.ts
│   │   ├── game-client.ts
│   │   └── config.ts
│   ├── package.json
│   └── README.md
│
├── events/
│   └── events.json
│
├── docs/
│   ├── protocol.md
│   └── events.md
│
└── README.md
```

------------------------------------------------------------------------

## 18. Milestones

### M1 --- Game Hook

Anomaly loads the custom mod and executes a test Lua function.

### M2 --- Game Events

EventManager can execute the first five events.

### M3 --- Game UI

The game displays vote and event notifications.

### M4 --- IPC

An external process can trigger an event in Anomaly.

### M5 --- Discord

Discord bot can connect and send commands through IPC.

### M6 --- MVP

Complete Discord → vote → IPC → game → event flow.

### M7 --- Content

Expand to 20--30 events.

### M8 --- Advanced

Game-state awareness, viewer progression, advanced balancing and
persistent statistics.

------------------------------------------------------------------------

## 19. Estimated Effort

  Area                                 Estimate
  ------------------------------ --------------
  Anomaly scripting foundation           2--4 h
  Event Manager                          1--2 h
  First 5 events                         2--4 h
  In-game UI                             2--4 h
  Local IPC                              1--3 h
  Discord bot                            1--2 h
  Voting system                          1--2 h
  Integration/debugging                  3--6 h
  **MVP total**                    **13--27 h**
  20--30 events + balancing        **+8--15 h**

The biggest technical risk is **Anomaly scripting and IPC**, not the
Discord bot.

------------------------------------------------------------------------

## 20. Development Order

Do not start with Discord.

Build in this exact order:

``` text
1. Anomaly addon loads
        ↓
2. Lua test script works
        ↓
3. EventManager works
        ↓
4. Spawn Bloodsucker works
        ↓
5. Five events work
        ↓
6. In-game UI works
        ↓
7. Local IPC works
        ↓
8. External test client triggers event
        ↓
9. Discord bot connects
        ↓
10. Discord voting works
        ↓
11. Full integration
        ↓
12. Add more events
        ↓
13. Balance and polish
```

### First task

The first development task is only:

**Anomaly 1.5.3 → custom addon → Lua script loads → EventManager → spawn
Bloodsucker → in-game notification.**

Once this works, the rest of the system can be built around a proven
game-side event API.
