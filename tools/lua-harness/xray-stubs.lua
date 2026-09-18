--[[
	Headless X-Ray stand-in.

	Enough of Anomaly's Lua API to load the chaos_* scripts, run their
	callbacks, and see what they do -- without launching the game. Every stub
	records what it was asked to do so the scenario can assert on it.

	This is not an emulator. It will not catch engine-level crashes. It does
	catch what actually bites in practice: load order, nil references, wrong
	argument counts, and logic that silently returns early.
--]]

HARNESS = {
	log = {},          -- every printf line
	notifications = {},
	hud_events = {},
	spawned = {},
	items = {},
	hits = {},
	dialogs = {},      -- windows added to the HUD render list
	files = {},        -- in-memory filesystem: path -> string
	dirs = {},         -- directories the engine writer created
	errors = {},
	time_changes = {},
}

local clock = 10000

function HARNESS.advance(ms)
	clock = clock + (ms or 100)
end

function HARNESS.now()
	return clock
end

--------------------------------------------------------------------------------
-- core globals
--------------------------------------------------------------------------------

function printf(fmt, ...)
	local ok, line = pcall(string.format, fmt, ...)
	HARNESS.log[#HARNESS.log + 1] = ok and line or tostring(fmt)
end

function printe(fmt, ...)
	printf(fmt, ...)
end

function callstack() end

function time_global()
	return clock
end

function GetARGB(a, r, g, b)
	return { a = a, r = r, g = g, b = b }
end

function vector()
	local v = { x = 0, y = 0, z = 0 }
	function v:set(x, y, z) self.x, self.y, self.z = x, y, z; return self end
	function v:add(o) return self end
	function v:mul(n) return self end
	function v:normalize() return self end
	-- Positions carry how far from the actor they ended up, so the spawn
	-- placement logic can actually be exercised. See level.vertex_in_direction.
	v.dist_from_actor = 0
	function v:distance_to(o) return (o and o.dist_from_actor) or 0 end
	return v
end

function vector2()
	local v = { x = 0, y = 0 }
	function v:set(x, y) self.x, self.y = x, y; return self end
	return v
end

function device()
	return { width = 1920, height = 1080, cam_pos = vector(), cam_dir = vector() }
end

--------------------------------------------------------------------------------
-- filesystem
--------------------------------------------------------------------------------

local APPDATA = "D:\\Games\\Anomaly\\appdata\\"
local SEP = string.char(92)

local function dir_of(path)
	return path:match("^(.*)" .. SEP .. "[^" .. SEP .. "]*$")
end

local function dir_exists(path)
	if not path then return true end
	if path == APPDATA:sub(1, #APPDATA - 1) then return true end
	return HARNESS.dirs[path .. SEP] == true or HARNESS.dirs[path] == true
end

-- Mimics Lua's io just closely enough, on an in-memory filesystem, and
-- crucially refuses to create a file whose directory does not exist -- which is
-- exactly how the real io.open behaves and where this mod went wrong.
io = {
	open = function(path, mode)
		mode = mode or "r"
		local parent = dir_of(path)
		local exists = HARNESS.files[path] ~= nil

		if mode:find("r") then
			if not exists then return nil, path .. ": No such file or directory" end
		else
			if not exists and not dir_exists(parent) then
				return nil, path .. ": No such file or directory"
			end
			if mode:find("w") then HARNESS.files[path] = "" end
			if not HARNESS.files[path] then HARNESS.files[path] = "" end
		end

		local pos = 0
		local handle = {}
		function handle:write(...)
			local parts = { ... }
			for i = 1, #parts do
				HARNESS.files[path] = HARNESS.files[path] .. tostring(parts[i])
			end
			return self
		end
		function handle:read(what)
			local content = HARNESS.files[path] or ""
			if what == "*a" or what == "a" then
				local out = content:sub(pos + 1)
				pos = #content
				return out
			end
			return nil
		end
		function handle:seek(whence, offset)
			local content = HARNESS.files[path] or ""
			whence = whence or "cur"
			offset = offset or 0
			if whence == "set" then pos = offset
			elseif whence == "end" then pos = #content + offset
			else pos = pos + offset end
			return pos
		end
		function handle:close() return true end
		return handle
	end,
}

local FS = {}
function FS:update_path(alias, tail)
	if alias == "$app_data_root$" then return APPDATA .. (tail or "") end
	if alias == "$game_saves$" then return APPDATA .. "savedgames" .. SEP end
	return APPDATA .. (tail or "")
end

function FS:w_open(path)
	-- The engine's writer creates every missing directory on the way.
	local parent = dir_of(path)
	if parent then HARNESS.dirs[parent .. SEP] = true end
	HARNESS.files[path] = ""
	return { __writer = path }
end

function FS:w_close(w) return true end
function FS:file_list_open_ex() return { Size = function() return 0 end } end
function FS:exist(path) return HARNESS.files[path] ~= nil end

function getFS() return FS end

--------------------------------------------------------------------------------
-- callbacks (mirrors axr_main)
--------------------------------------------------------------------------------

local intercepts = {}

function RegisterScriptCallback(name, fn)
	intercepts[name] = intercepts[name] or {}
	intercepts[name][fn] = true
end

function UnregisterScriptCallback(name, fn)
	if intercepts[name] then intercepts[name][fn] = nil end
end

function SendScriptCallback(name, ...)
	if not intercepts[name] then return end
	for fn in pairs(intercepts[name]) do
		local ok, err = pcall(fn, ...)
		if not ok then
			HARNESS.errors[#HARNESS.errors + 1] = string.format("%s: %s", name, tostring(err))
		end
	end
end

function HARNESS.callback_count(name)
	local n = 0
	for _ in pairs(intercepts[name] or {}) do n = n + 1 end
	return n
end

--------------------------------------------------------------------------------
-- UI
--------------------------------------------------------------------------------

CGameFont = { alLeft = 0, alRight = 1, alCenter = 2 }

function GetFontGraffiti22Russian() return { name = "graffiti22" } end
function GetFontGraffiti32Russian() return { name = "graffiti32" } end
function GetFontLetterica16Russian() return { name = "letterica16" } end
function GetFontLetterica18Russian() return { name = "letterica18" } end

function super() end

function class(name)
	return function(base)
		local c = { __name = name, __base = base }
		c.__index = c
		setmetatable(c, {
			__index = base,
			__call = function(cls, ...)
				local obj = setmetatable({ __class = cls }, cls)
				if cls.__init then cls.__init(obj, ...) end
				return obj
			end,
		})
		_G[name] = c
		return c
	end
end

local function ui_widget()
	local w = { children = {}, shown = false, text = "" }
	function w:SetAutoDelete() end
	function w:SetWndPos() end
	function w:SetWndSize() end
	function w:SetFont() end
	function w:SetTextColor() end
	function w:SetTextAlignment() end
	function w:SetText(t) self.text = tostring(t) end
	function w:SetTextST(t) self.text = tostring(t) end
	function w:Show(v) self.shown = v and true or false end
	function w:AttachChild(c) self.children[#self.children + 1] = c end
	return w
end

function CUITextWnd() return ui_widget() end
function CUIStatic() return ui_widget() end

CUIScriptWnd = { __name = "CUIScriptWnd" }
CUIScriptWnd.__index = CUIScriptWnd
function CUIScriptWnd.Update() end
function CUIScriptWnd:SetWndPos() end
function CUIScriptWnd:SetWndSize() end
function CUIScriptWnd:AttachChild(c) end

local HUD_OBJ = {}
function HUD_OBJ:AddDialogToRender(d)
	HARNESS.dialogs[#HARNESS.dialogs + 1] = { action = "add", dialog = d }
end
function HUD_OBJ:RemoveDialogToRender(d)
	HARNESS.dialogs[#HARNESS.dialogs + 1] = { action = "remove", dialog = d }
end
function HUD_OBJ:AddCustomStatic() end
function HUD_OBJ:GetCustomStatic() return nil end

function get_hud() return HUD_OBJ end

actor_menu = {}
function actor_menu.set_msg(typ, msg, tm, clr)
	HARNESS.notifications[#HARNESS.notifications + 1] = { typ = typ, msg = msg, tm = tm }
end

--------------------------------------------------------------------------------
-- world / actor
--------------------------------------------------------------------------------

local actor = {
	health = 1.0,
	bleeding = 1.0,
	psy_health = 1.0,
	radiation = 0.0,
}
function actor:alive() return true end
function actor:position() return vector() end
function actor:level_vertex_id() return 1000 end
function actor:game_vertex_id() return 50 end
function actor:id() return 0 end
function actor:hit(h) HARNESS.hits[#HARNESS.hits + 1] = h end

db = { actor = actor }

level = {}

--[[
	The AI-grid walk, modelled honestly.

	level.vertex_in_direction() does not teleport `dist` metres away: it walks
	the navigation mesh and stops where the walk stops. Indoors, in a corridor,
	against a cliff, it returns a vertex barely off the starting point -- which
	is how the first version of this mod put bloodsuckers in the player's face.

	HARNESS.block_rate is the fraction of directions that come back short.
--]]
HARNESS.block_rate = 0.0

local vertex_dist = {}
local next_vid = 2000

function level.vertex_in_direction(lvid, dir, dist)
	next_vid = next_vid + 1
	local achieved = dist
	if math.random() < HARNESS.block_rate then
		achieved = math.random() * 5    -- the walk was blocked almost immediately
	end
	vertex_dist[next_vid] = achieved
	return next_vid
end

function level.vertex_position(vid)
	local v = vector()
	v.dist_from_actor = vertex_dist[vid] or 0
	return v
end

function level.vertex_id(v) return 1000 end
function level.name() return "l01_escape" end

local game_hour = 12
function level.get_time_hours() return game_hour end
function level.get_time_minutes() return 0 end

function level.change_game_time(h, m, s)
	game_hour = (game_hour + (h or 0)) % 24
	HARNESS.time_changes[#HARNESS.time_changes + 1] = { hours = h, minutes = m, seconds = s }
end

function HARNESS.set_hour(h) game_hour = h end
function HARNESS.hour() return game_hour end

local next_se_id = 5000
function alife_create(section, pos, lvid, gvid)
	next_se_id = next_se_id + 1
	HARNESS.spawned[#HARNESS.spawned + 1] = {
		section = section, lvid = lvid, gvid = gvid,
		distance = pos and pos.dist_from_actor or 0,
	}
	return { id = next_se_id, section_name = function() return section end }
end

function alife_create_item(section, owner, t)
	HARNESS.items[#HARNESS.items + 1] = { section = section, opts = t }
	return { id = 9999 }
end

function alife_release() end
function alife() return { object = function() return nil end } end

hit = setmetatable({
	burn = 0, shock = 1, chemical_burn = 2, radiation = 3, telepatic = 4,
	strike = 5, wound = 6, explosion = 7, fire_wound = 8,
}, {
	__call = function()
		local h = { power = 0, impulse = 0 }
		function h:bone(name) self.bone_name = name end
		return h
	end,
})

surge_manager = {
	started = false,
	is_started = function() return surge_manager.started end,
	start_surge = function() surge_manager.started = true end,
}

psi_storm_manager = {
	started = false,
	is_started = function() return psi_storm_manager.started end,
	get_psi_storm_manager = function()
		return { start = function() psi_storm_manager.started = true end }
	end,
}

-- Deferred work queue, as _g.script provides it.
HARNESS.time_events = {}
function CreateTimeEvent(ev_id, act_id, timer, f, ...)
	HARNESS.time_events[#HARNESS.time_events + 1] = { ev = ev_id, act = act_id, f = f, args = { ... } }
end

--- Run every queued time event once, as the engine would on its next tick.
function HARNESS.run_time_events()
	local queued = HARNESS.time_events
	HARNESS.time_events = {}
	for i = 1, #queued do pcall(queued[i].f, table.unpack(queued[i].args)) end
end

axr_companions = {
	recruited = {},
	add_to_actor_squad = function(npc)
		axr_companions.recruited[#axr_companions.recruited + 1] = npc:id()
	end,
}

-- No NPC is online until the harness says so.
HARNESS.online_objects = {}
function level.object_by_id(id)
	if not HARNESS.online_objects[id] then return nil end
	return {
		id = function() return id end,
		name = function() return "npc_" .. id end,
		character_name = function() return "Stranger" end,
	}
end

DIK_keys = { DIK_F8 = 66, DIK_F9 = 67, DIK_F10 = 68, DIK_F11 = 87, DIK_F12 = 88 }

--------------------------------------------------------------------------------
-- script loader (mirrors how X-Ray namespaces .script files)
--------------------------------------------------------------------------------

local SOURCES, ORDER

function HARNESS.script_uses(name, text)
	local src = SOURCES and SOURCES[name]
	if not src then error("no source for " .. tostring(name)) end
	return src:find(text, 1, true) ~= nil
end

--- Model a quick load: X-Ray tears the whole Lua VM down and rebuilds it, so
--- every module-level value in the mod starts out fresh. The spool files on
--- disk survive, which is the point of the transport.
function HARNESS.reset_vm()
	intercepts = {}
	for i = 1, #ORDER do _G[ORDER[i]] = nil end
	HARNESS.log = {}
	HARNESS.errors = {}
	HARNESS.notifications = {}
	HARNESS.dialogs = {}
end

function HARNESS.reload_scripts()
	HARNESS.load_scripts(SOURCES, ORDER)
end

function HARNESS.load_scripts(sources, order)
	SOURCES, ORDER = sources, order
	for i = 1, #order do
		local name = order[i]
		local src = sources[name]
		if not src then error("no source for " .. name) end
		local env = setmetatable({}, { __index = _G })
		local chunk, err = load(src, "@" .. name .. ".script", "t", env)
		if not chunk then error(name .. ": " .. tostring(err)) end
		local ok, rerr = pcall(chunk)
		if not ok then error(name .. ": " .. tostring(rerr)) end
		_G[name] = env
	end
end

function HARNESS.start_game()
	for _, name in ipairs({
		"chaos_rt_json", "chaos_rt_log", "chaos_rt_manager",
		"chaos_rt_ui", "chaos_rt_ipc", "chaos_game_events", "chaos_boot",
	}) do
		local ns = _G[name]
		if ns and rawget(ns, "on_game_start") then ns.on_game_start() end
	end
end

function HARNESS.has_log(pattern)
	for i = 1, #HARNESS.log do
		if HARNESS.log[i]:find(pattern, 1, true) then return true end
	end
	return false
end

function HARNESS.dump_log()
	for i = 1, #HARNESS.log do print("  " .. HARNESS.log[i]) end
end
