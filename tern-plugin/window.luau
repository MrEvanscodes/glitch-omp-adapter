-- Glitch for Tern: palette commands. Press the palette key, type "glitch", pick one.
--
--   Glitch                   jump to your Glitch chat if one is already open, otherwise start one
--   New Glitch chat          always start a fresh Glitch chat (a second one beside the first)
--   Check Glitch is working  run the add-on's self-check and show the result
--
--   The + button         while you are IN a Glitch chat, + opens another Glitch chat (same folder);
--                        from any other tab, + works exactly as before. A switch turns this off/on.
--   Plain terminal tab    a normal shell tab, always (the escape hatch while + is taken over)
--   Stop/Make + ...       the switch for the + behaviour above
--
-- A "Glitch chat" is a tab running omp in your Glitch folder. omp loads the Glitch add-on
-- (glitch-omp-adapter) by itself in that folder, so identity, memory and the safety guards are on.

local HOME = tern.getenv("HOME") or ""
local GLITCH = HOME .. "/Glitch"
local ADAPTER = HOME .. "/glitch-omp-adapter"

-- Where the Glitch folder lives. Change this one line if yours is somewhere else.
local GLITCH_DIR = "~/Glitch"

local function in_glitch(cwd)
	if cwd == nil then
		return false
	end
	local c = string.gsub(tostring(cwd), "/+$", "")
	return c == GLITCH or c == GLITCH_DIR
end

-- Same as in_glitch, but a folder INSIDE Glitch (a workspace) counts too.
local function inside_glitch(cwd)
	if cwd == nil or cwd == "" then
		return false
	end
	local c = tostring(cwd)
	if string.sub(c, 1, 2) == "~/" then
		c = HOME .. string.sub(c, 2)
	end
	return c == GLITCH or string.sub(c, 1, #GLITCH + 1) == GLITCH .. "/"
end

local function absolute(cwd)
	local c = tostring(cwd)
	if string.sub(c, 1, 2) == "~/" then
		return HOME .. string.sub(c, 2)
	end
	return c
end

-- The pane of an open (not exited) agent in the Glitch folder, or nil.
local function open_glitch_pane(cx)
	local ok, rows = pcall(function()
		return cx.agents:list()
	end)
	if not ok or rows == nil then
		return nil
	end
	for _, a in ipairs(rows) do
		if in_glitch(a.cwd) and a.state ~= "exited" then
			return a.pane
		end
	end
	return nil
end

-- Opens a tab running omp in the Glitch folder. (Tern's own "start agent" call insists on a first
-- message, which would spend a model turn every time you open Glitch; a tab running omp does not.)
local function start_glitch(cx, folder)
	local ok, err = pcall(function()
		cx.layout:new_tab({ cwd = folder or GLITCH, command = "omp" }, { focus = true })
	end)
	if not ok then
		cx:toast("error", "Could not open Glitch", tostring(err))
	end
end

tern.command({
	id = "open",
	title = "Glitch",
	icon = "sparkle",
	run = function(cx)
		local pane = open_glitch_pane(cx)
		if pane ~= nil then
			cx.layout:focus(pane)
		else
			start_glitch(cx)
		end
	end,
})

tern.command({
	id = "new",
	title = "New Glitch chat",
	icon = "plus",
	run = function(cx)
		start_glitch(cx)
	end,
})

tern.command({
	id = "check",
	title = "Check Glitch is working",
	icon = "check",
	run = function(cx)
		cx.layout:new_tab({
			cwd = ADAPTER,
			command = 'node scripts/doctor.mjs; echo; echo "Press Enter to close this tab."; read',
		})
	end,
})

-- The switch for the + behaviour. On unless you turned it off (kept by Tern between restarts).
local function plus_on()
	local ok, v = pcall(function()
		return tern.kv.get("plus")
	end)
	if ok and v == false then
		return false
	end
	return true
end

-- The + button (and the new-tab chord, and the palette's "New tab"). Only while the switch is on AND the
-- tab you are in is an omp chat inside your Glitch folder: then you get another Glitch chat, in the same
-- folder. Anywhere else this returns false and Tern opens its normal new tab.
tern.override("new_tab", function(cx)
	if not plus_on() then
		return false
	end
	local id = cx.session:focused()
	for _, pane in cx.session:panes() do
		if pane.pane == id then
			if pane.program == "omp" and inside_glitch(pane.cwd) then
				start_glitch(cx, absolute(pane.cwd))
				return true
			end
			break
		end
	end
	return false
end)

tern.command({
	id = "plus-off",
	title = "Stop + opening Glitch chats",
	icon = "x",
	available = function(_cx)
		return plus_on()
	end,
	run = function(cx)
		tern.kv.set("plus", false)
		cx:toast("info", "+ is back to normal", "It opens a plain terminal tab again, even inside Glitch.")
	end,
})

tern.command({
	id = "plus-on",
	title = "Make + open another Glitch chat (inside Glitch)",
	icon = "sparkle",
	available = function(_cx)
		return not plus_on()
	end,
	run = function(cx)
		tern.kv.set("plus", true)
		cx:toast("info", "+ now opens another Glitch chat", "Only while you are inside a Glitch chat.")
	end,
})

-- A normal shell tab, whatever the + switch says. (A plugin opening a tab does not go through the
-- override above, so this always works.)
tern.command({
	id = "terminal",
	title = "Plain terminal tab (not Glitch)",
	icon = "terminal",
	run = function(cx)
		cx.layout:new_tab({ cwd = HOME }, { focus = true })
	end,
})
