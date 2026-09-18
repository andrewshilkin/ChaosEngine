--[[
	The scenario the harness runs.

	It models what the game actually does, which is not what the first version
	of this mod assumed:

	  * Anomaly binds F9 to quick_load, so F9 is not available as a debug key.
	  * Loading a save rebuilds the entire Lua VM. on_game_start runs again and
	    every module-level value starts out fresh.
	  * <appdata>\chaos\ does not exist until the host creates it, and neither
	    io.open nor the engine writer will create it from Lua.
--]]

local failures = 0
local function check(label, cond, detail)
	if cond then
		print("  ok    " .. label)
	else
		failures = failures + 1
		print("  FAIL  " .. label .. (detail and ("  <- " .. tostring(detail)) or ""))
	end
end

local function section(name)
	print("")
	print(name)
end

local function tick(times, step)
	for _ = 1, (times or 1) do
		HARNESS.advance(step or 120)
		SendScriptCallback("actor_on_update", {}, 0)
	end
end

local function outbox()
	return HARNESS.files[chaos_rt_ipc.spool_dir() .. "chaos_out.jsonl"] or ""
end

local function append_command(json)
	local inbox = chaos_rt_ipc.spool_dir() .. "chaos_in.jsonl"
	HARNESS.files[inbox] = (HARNESS.files[inbox] or "") .. json .. "\n"
end

--------------------------------------------------------------------------------

section("debug keys must not collide with Anomaly's own bindings")
check("F9 is not used as a debug key (it is quick_load)",
	not HARNESS.script_uses("chaos_boot", "DIK_F9"))

section("session 1: the spool directory does not exist yet")
HARNESS.start_game()
check("events registered", chaos_rt_manager.count() == 42, chaos_rt_manager.count())
check("bootstrap logged", HARNESS.has_log("bootstrap registered"))

SendScriptCallback("actor_on_first_update", {}, 0)
check("no callback errors", #HARNESS.errors == 0, HARNESS.errors[1])
check("init reported starting", HARNESS.has_log("init: starting up"))
check("mod still reports loaded", HARNESS.has_log("Mod loaded"))
check("missing spool directory is reported, not silent",
	HARNESS.has_log("the directory does not exist yet"))
check("ipc knows it is not ready", chaos_rt_ipc.is_ready() == false)

section("session 1: the mod stays usable without a host")
tick(10)
SendScriptCallback("on_key_press", DIK_keys.DIK_F10)
check("F10 still runs an event", #HARNESS.spawned > 0 or #HARNESS.items > 0)
SendScriptCallback("on_key_press", DIK_keys.DIK_F11)
tick(3)
check("F11 shows a vote line", #HARNESS.notifications > 0)
check("no callback errors while degraded", #HARNESS.errors == 0, HARNESS.errors[1])

section("the host appears and creates the directory")
HARNESS.dirs[chaos_rt_ipc.spool_dir()] = true
HARNESS.advance(6000)
tick(2)
check("spool picked up on retry", chaos_rt_ipc.is_ready() == true)
check("spool ready logged", HARNESS.has_log("ipc: spool ready"))
check("hello written", outbox():find('"type":"hello"', 1, true) ~= nil, outbox():sub(1, 160))

section("session 1: talking to the host")
tick(10)
check("heartbeat written", outbox():find("heartbeat", 1, true) ~= nil)

append_command('{"type":"event","request_id":"req-1","id":"heal_player","parameters":{}}')
tick(6)
check("event_result returned", outbox():find('"request_id":"req-1"', 1, true) ~= nil, outbox():sub(-240))

append_command("{not json at all}")
append_command('{"type":"ping","request_id":"req-2"}')
tick(6)
check("ping answered after malformed JSON", outbox():find('"request_id":"req-2"', 1, true) ~= nil)

append_command('{"type":"event","request_id":"req-3","id":"rm_minus_rf","parameters":{}}')
tick(6)
check("unknown event id rejected", outbox():find("unknown_event", 1, true) ~= nil)

append_command('{"type":"vote_start","options":[{"label":"Bloodsuckers","percent":0},{"label":"Zombie Horde","percent":0}],"duration":20}')
append_command('{"type":"vote_update","options":[{"label":"Bloodsuckers","percent":60},{"label":"Zombie Horde","percent":40}],"seconds_left":12}')
tick(6)
local last = HARNESS.notifications[#HARNESS.notifications]
check("vote board rendered through the engine's own static",
	last ~= nil and last.msg:find("Bloodsuckers", 1, true) ~= nil,
	last and last.msg)
check("the mod never creates its own HUD dialog", #HARNESS.dialogs == 0,
	#HARNESS.dialogs .. " dialog(s) added to the render list")

section("spawns keep their distance from the player")
HARNESS.block_rate = 0.0
local mark = #HARNESS.spawned
chaos_rt_manager.execute("spawn_dogs", { count = 4 }, { ignore_cooldown = true })
local closest = math.huge
for i = mark + 1, #HARNESS.spawned do
	closest = math.min(closest, HARNESS.spawned[i].distance)
end
check("nothing spawns inside the pack tier minimum of 22m", closest >= 22,
	string.format("closest was %.1fm", closest))

-- Every direction the AI grid walk tries comes back short: indoors, in a
-- corridor, against a cliff. The event must refuse, not spawn on the player.
HARNESS.block_rate = 1.0
mark = #HARNESS.spawned
local blocked = chaos_rt_manager.execute("spawn_bloodsucker", nil, { ignore_cooldown = true })
check("a blocked spawn refuses instead of landing on the player",
	blocked.success == false and #HARNESS.spawned == mark,
	tostring(blocked.error) .. ", spawned " .. (#HARNESS.spawned - mark))
check("the refusal is logged with the distance it managed",
	HARNESS.has_log("no point at least"))
HARNESS.block_rate = 0.0

section("time of day")
HARNESS.set_hour(12)
check("nightfall is offered during the day", chaos_rt_manager.is_available("nightfall"))
check("daybreak is not", not chaos_rt_manager.is_available("daybreak"))
chaos_rt_manager.execute("nightfall", nil, { ignore_cooldown = true })
check("the clock moved to night", HARNESS.hour() == 23, HARNESS.hour())
check("daybreak is offered at night", chaos_rt_manager.is_available("daybreak"))
chaos_rt_manager.execute("daybreak", nil, { ignore_cooldown = true })
check("the clock moved to morning", HARNESS.hour() == 8, HARNESS.hour())
check("time never runs backwards", (function()
	for i = 1, #HARNESS.time_changes do
		if HARNESS.time_changes[i].hours < 0 then return false end
	end
	return true
end)())
HARNESS.set_hour(12)

section("danger tier caps how many mutants a single event can spawn")
local function spawned_since(mark, needle)
	local n = 0
	for i = mark + 1, #HARNESS.spawned do
		if HARNESS.spawned[i].section:find(needle) then n = n + 1 end
	end
	return n
end

local mark = #HARNESS.spawned
chaos_rt_manager.execute("spawn_bloodsucker", { count = 5 }, { ignore_cooldown = true })
check("an apex monster is clamped to one, however many the host asks for",
	spawned_since(mark, "bloodsucker") == 1, spawned_since(mark, "bloodsucker"))

mark = #HARNESS.spawned
chaos_rt_manager.execute("spawn_dogs", { count = 4 }, { ignore_cooldown = true })
check("a pack monster spawns the number asked for",
	spawned_since(mark, "dog") == 4, spawned_since(mark, "dog"))

mark = #HARNESS.spawned
chaos_rt_manager.execute("spawn_zombies", { count = 99 }, { ignore_cooldown = true })
check("a pack is still capped at its declared maximum",
	spawned_since(mark, "zombie") == 6, spawned_since(mark, "zombie"))

section("an ally is recruited once the engine brings them online")
HARNESS.block_rate = 0.0
local before = #HARNESS.spawned
local r = chaos_rt_manager.execute("spawn_ally", nil, { ignore_cooldown = true })
check("the ally spawns", r.success == true and #HARNESS.spawned == before + 1, tostring(r.error))

-- add_to_actor_squad needs the online game object, which does not exist yet.
HARNESS.run_time_events()
check("nobody is recruited while the NPC is still offline", #axr_companions.recruited == 0)

HARNESS.online_objects[5001] = true
for id in pairs(HARNESS.online_objects) do HARNESS.online_objects[id] = true end
local spawned_id = 5000 + #HARNESS.spawned
HARNESS.online_objects[spawned_id] = true
for _ = 1, 4 do HARNESS.run_time_events() end
check("recruited once they come online", #axr_companions.recruited > 0,
	"recruited: " .. #axr_companions.recruited)

section("a companion who never arrives is given up on, not retried forever")
HARNESS.online_objects = {}
chaos_rt_manager.execute("spawn_ally", nil, { ignore_cooldown = true })
for _ = 1, 30 do HARNESS.run_time_events() end
check("the retry queue drains", #HARNESS.time_events == 0, #HARNESS.time_events)
check("giving up is logged", HARNESS.has_log("never came online"))

section("quick load: the Lua VM is rebuilt from scratch")
SendScriptCallback("actor_on_net_destroy", {})
HARNESS.reset_vm()
HARNESS.reload_scripts()
HARNESS.start_game()
SendScriptCallback("actor_on_first_update", {}, 0)
tick(10)
check("no errors across the reload", #HARNESS.errors == 0, HARNESS.errors[1])
check("re-initialised after reload", HARNESS.has_log("Mod loaded"))
check("events registered exactly once", chaos_rt_manager.count() == 42, chaos_rt_manager.count())
check("no duplicate-registration warning", not HARNESS.has_log("registered twice"))
check("callbacks not duplicated", HARNESS.callback_count("actor_on_update") == 1,
	HARNESS.callback_count("actor_on_update"))
check("spool reclaimed immediately", chaos_rt_ipc.is_ready() == true)
check("fresh session said hello again", outbox():find('"type":"hello"', 1, true) ~= nil)
check("outbox truncated for the new session",
	select(2, outbox():gsub('"type":"hello"', "")) == 1,
	"hello count: " .. select(2, outbox():gsub('"type":"hello"', "")))

section("the host can still drive the reloaded session")
append_command('{"type":"event","request_id":"req-4","id":"spawn_zombies","parameters":{"count":4}}')
tick(6)
check("event executed after reload", outbox():find('"request_id":"req-4"', 1, true) ~= nil)
check("parameter honoured", (function()
	for i = #HARNESS.spawned, 1, -1 do
		if HARNESS.spawned[i].section:find("zombie") then return true end
	end
	return false
end)())

print("")
if failures == 0 then
	print("all checks passed")
else
	print(failures .. " check(s) failed")
	print("")
	print("log:")
	HARNESS.dump_log()
end
HARNESS.failures = failures
