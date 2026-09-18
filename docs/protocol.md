# Chaos Engine protocol v1

One line of JSON per message, UTF-8, newline terminated. Every message has a
`type`. Messages from the game additionally carry `protocol` (an integer) and
`game` (the adapter id, e.g. `stalker-anomaly`).

The canonical TypeScript definitions are in
[`packages/core/src/protocol.ts`](../packages/core/src/protocol.ts); the Lua
implementation is in
[`chaos_rt_ipc.script`](../adapters/stalker-anomaly/game-mod/gamedata/scripts/chaos_rt_ipc.script).

## Transport

### File spool (shipped)

Two append-only files in one directory:

```
chaos_in.jsonl     host -> game    (commands)
chaos_out.jsonl    game -> host    (results, heartbeats)
```

For Anomaly the directory is `<game root>/appdata/chaos/`.

Rules that make this safe without locking:

* Each side only ever **appends whole lines**, in one write.
* Each side only ever **consumes lines terminated by a newline**. A partial
  trailing line is kept until its newline arrives.
* Each side tracks a byte offset into the file it reads. If the file is shorter
  than the offset, the other side restarted: reset the offset to 0.
* On start, the game truncates its **outbox** (so the host never replays a stale
  session) and seeks its **inbox** to the end (so it never replays stale
  commands). The host does the mirror image: truncate the inbox, read the outbox
  from the start.

The plan preferred a WebSocket on `127.0.0.1:8765`. X-Ray's Lua has no sockets,
so this is the plan's documented fallback. `Transport` in
`packages/core/src/transport/transport.ts` is the seam — a WebSocket or HTTP
transport slots in there without the engine noticing.

### Liveness

The game sends a `heartbeat` every 5 seconds. The host marks the game
disconnected after 15 seconds of silence.

## Request correlation

Commands that expect an answer carry a `request_id` (a UUID). The reply echoes
it. The host times out after 5 seconds and reports `error: "timeout"`.

## Host -> game

| type | fields | reply |
| --- | --- | --- |
| `ping` | `request_id` | `pong` |
| `describe` | `request_id` | `events` |
| `event` | `request_id`, `id`, `parameters` | `event_result` |
| `reset` | `request_id` | `ack` |
| `vote_start` | `options[]`, `duration` | none |
| `vote_update` | `options[]`, `seconds_left` | none |
| `vote_end` | `winner` | none |
| `notify` | `text`, `seconds?` | none |

`options` is an array of `{ label, percent }` — display only; the game never
needs to know which event an option maps to.

```json
{"type":"event","request_id":"9f1c…","id":"spawn_bloodsucker","parameters":{"count":5}}
```

## Game -> host

| type | fields |
| --- | --- |
| `hello` | `events[]`, `ui` |
| `events` | `request_id`, `events[]` |
| `event_result` | `request_id`, `id`, `success`, `error?`, `message?`, `name?`, `instance_id?`, `duration?`, `cooldown_remaining?` |
| `heartbeat` | `active[]`, `online` |
| `pong` / `ack` | `request_id` |
| `error` | `request_id?`, `error` |
| `goodbye` | — |

```json
{"protocol":1,"game":"stalker-anomaly","type":"event_result",
 "request_id":"9f1c…","id":"spawn_bloodsucker","success":true,"name":"Bloodsuckers"}
```

### Event descriptor

```json
{
  "id": "spawn_bloodsucker",
  "name": "Bloodsuckers",
  "category": "mutants",
  "duration": 0,
  "cooldown": 180,
  "weight": 0.5,
  "params": { "count": { "type": "number", "min": 1, "max": 8, "default": 3 } },
  "available": true
}
```

`duration` is how long the event stays active before its `cleanup()` runs; `0`
is instant. `available` is the game's own judgement at the moment it described
itself — for example, `emission` reports `false` while an emission is already
running.

### Failure reasons

`unknown_event`, `on_cooldown`, `global_cooldown`, `unavailable`,
`bad_parameters`, `bad_request`, `refused`, `exception`, plus `timeout`, which
the host synthesises when the game does not answer.

## Security

* The protocol carries ids and parameters. Never code, never file paths, never
  Lua.
* The game validates the id against its own registry and rejects anything else.
* Parameters are coerced to their declared type and clamped to their declared
  range before an event sees them.
* Both sides treat a malformed line as something to log and skip, never as a
  reason to stop.
