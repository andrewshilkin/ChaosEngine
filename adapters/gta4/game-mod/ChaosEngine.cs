/*
 * Chaos Engine :: GTA IV adapter  (ScriptHookDotNet, plain C# script)
 *
 * Drop this single file into  <GTA IV>\scripts\  and the .NET Script Hook
 * compiles it at load time. No build step, no DLL to ship.
 *
 * It speaks exactly the same JSON-lines protocol as the S.T.A.L.K.E.R. adapter,
 * so the Discord bot and the CLI drive it without a single line of change:
 *
 *     <GTA IV>\scripts\chaos\chaos_in.jsonl    host -> game
 *     <GTA IV>\scripts\chaos\chaos_out.jsonl   game -> host
 *
 * Everything below the "GAME EVENTS" banner is the only part that knows what
 * GTA IV is. The rest mirrors the reusable runtime documented in
 * docs/adding-a-game.md.
 *
 * Written for C# 4 / .NET Framework 4, because that is what the Script Hook's
 * runtime compiler accepts: no string interpolation, no null-conditionals, no
 * LINQ.
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using GTA;

namespace ChaosEngine
{
    // =====================================================================
    // Logging
    // =====================================================================

    public static class ChaosLog
    {
        public const int Debug = 10;
        public const int Info = 20;
        public const int Warn = 30;
        public const int Error = 40;

        public static int MinLevel = Info;
        private static string _path;
        private static bool _failed;

        public static void SetPath(string path) { _path = path; }

        private static string LevelName(int level)
        {
            if (level >= Error) return "ERROR";
            if (level >= Warn) return "WARN";
            if (level >= Info) return "INFO";
            return "DEBUG";
        }

        public static void Write(int level, string message)
        {
            if (level < MinLevel) return;
            string line = "[ChaosEngine] " + LevelName(level) + " " + message;

            // The Script Hook's own log is the reliable one; ours is the
            // readable one. Neither is allowed to throw into a game tick.
            try { Game.Console.Print(line); }
            catch { }

            if (_failed || _path == null) return;
            try { File.AppendAllText(_path, line + Environment.NewLine); }
            catch { _failed = true; }
        }

        public static void Info_(string m) { Write(Info, m); }
        public static void Warn_(string m) { Write(Warn, m); }
        public static void Error_(string m) { Write(Error, m); }
        public static void Debug_(string m) { Write(Debug, m); }
    }

    // =====================================================================
    // JSON  (small, dependency-free: .NET 4 has no JSON in the BCL)
    // =====================================================================

    public static class ChaosJson
    {
        public static string Encode(object value)
        {
            StringBuilder sb = new StringBuilder();
            Write(value, sb, 0);
            return sb.ToString();
        }

        private static void Write(object v, StringBuilder sb, int depth)
        {
            if (depth > 32 || v == null) { sb.Append("null"); return; }

            if (v is string) { WriteString((string)v, sb); return; }
            if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }

            if (v is int || v is long)
            {
                sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (v is float || v is double)
            {
                double d = Convert.ToDouble(v);
                if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
                sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }

            Dictionary<string, object> map = v as Dictionary<string, object>;
            if (map != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (KeyValuePair<string, object> kv in map)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(kv.Key, sb);
                    sb.Append(':');
                    Write(kv.Value, sb, depth + 1);
                }
                sb.Append('}');
                return;
            }

            System.Collections.IEnumerable list = v as System.Collections.IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(item, sb, depth + 1);
                }
                sb.Append(']');
                return;
            }

            WriteString(v.ToString(), sb);
        }

        private static void WriteString(string s, StringBuilder sb)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>Parse one JSON document. Returns null if it is not valid.</summary>
        public static object Decode(string text)
        {
            if (text == null) return null;
            int i = 0;
            try
            {
                object value = ParseValue(text, ref i, 0);
                return value;
            }
            catch
            {
                return null;
            }
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        private static object ParseValue(string s, ref int i, int depth)
        {
            if (depth > 32) throw new FormatException("too deep");
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end");

            char c = s[i];
            if (c == '{') return ParseObject(s, ref i, depth);
            if (c == '[') return ParseArray(s, ref i, depth);
            if (c == '"') return ParseString(s, ref i);
            if (c == 't' && Match(s, i, "true")) { i += 4; return true; }
            if (c == 'f' && Match(s, i, "false")) { i += 5; return false; }
            if (c == 'n' && Match(s, i, "null")) { i += 4; return null; }
            return ParseNumber(s, ref i);
        }

        private static bool Match(string s, int i, string word)
        {
            return i + word.Length <= s.Length && string.CompareOrdinal(s, i, word, 0, word.Length) == 0;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i, int depth)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            i++; // {
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return map; }
            while (true)
            {
                SkipWs(s, ref i);
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':'");
                i++;
                map[key] = ParseValue(s, ref i, depth + 1);
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("unterminated object");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return map; }
                throw new FormatException("expected ',' or '}'");
            }
        }

        private static List<object> ParseArray(string s, ref int i, int depth)
        {
            List<object> list = new List<object>();
            i++; // [
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(ParseValue(s, ref i, depth + 1));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("unterminated array");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return list; }
                throw new FormatException("expected ',' or ']'");
            }
        }

        private static string ParseString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') throw new FormatException("expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new FormatException("unterminated string");
                char c = s[i];
                if (c == '"') { i++; return sb.ToString(); }
                if (c == '\\')
                {
                    i++;
                    if (i >= s.Length) throw new FormatException("bad escape");
                    char e = s[i];
                    if (e == 'n') sb.Append('\n');
                    else if (e == 't') sb.Append('\t');
                    else if (e == 'r') sb.Append('\r');
                    else if (e == 'b') sb.Append('\b');
                    else if (e == 'f') sb.Append('\f');
                    else if (e == 'u')
                    {
                        if (i + 4 >= s.Length) throw new FormatException("bad \\u");
                        sb.Append((char)int.Parse(s.Substring(i + 1, 4), NumberStyles.HexNumber,
                            CultureInfo.InvariantCulture));
                        i += 4;
                    }
                    else sb.Append(e);
                    i++;
                    continue;
                }
                sb.Append(c);
                i++;
            }
        }

        private static object ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "-+.eE0123456789".IndexOf(s[i]) >= 0) i++;
            string text = s.Substring(start, i - start);
            double d;
            if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                throw new FormatException("bad number");
            return d;
        }

        // -- typed readers, so callers never have to cast defensively --------

        public static Dictionary<string, object> AsMap(object v)
        {
            return v as Dictionary<string, object>;
        }

        public static string GetString(Dictionary<string, object> map, string key)
        {
            object v;
            if (map == null || !map.TryGetValue(key, out v) || v == null) return null;
            return v as string;
        }

        public static double? GetNumber(Dictionary<string, object> map, string key)
        {
            object v;
            if (map == null || !map.TryGetValue(key, out v) || v == null) return null;
            if (v is double) return (double)v;
            if (v is bool) return ((bool)v) ? 1.0 : 0.0;
            double d;
            string s = v as string;
            if (s != null && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                return d;
            return null;
        }
    }

    // =====================================================================
    // Event manager  (game-agnostic: the same contract as the Lua runtime)
    // =====================================================================

    public class ParamSpec
    {
        public string Type = "number";
        public double Min = double.NegativeInfinity;
        public double Max = double.PositiveInfinity;
        public object Default;

        public static ParamSpec Number(double min, double max, double def)
        {
            ParamSpec p = new ParamSpec();
            p.Type = "number";
            p.Min = min;
            p.Max = max;
            p.Default = def;
            return p;
        }
    }

    /// <summary>What an event returns: success, or a reason it refused.</summary>
    public class EventOutcome
    {
        public bool Success;
        public string Error;
        public string Message;
        /// <summary>Handed back to Cleanup when the duration expires.</summary>
        public object State;

        public static EventOutcome Ok() { EventOutcome o = new EventOutcome(); o.Success = true; return o; }

        public static EventOutcome OkWith(object state)
        {
            EventOutcome o = new EventOutcome();
            o.Success = true;
            o.State = state;
            return o;
        }

        public static EventOutcome Refuse(string why)
        {
            EventOutcome o = new EventOutcome();
            o.Success = false;
            o.Error = "refused";
            o.Message = why;
            return o;
        }
    }

    public delegate EventOutcome EventAction(Dictionary<string, double> parameters);
    public delegate void EventCleanup(object state);
    /// <summary>Called every tick while a timed event is still running.</summary>
    public delegate void EventUpdate(object state);
    public delegate bool EventGate();

    public class ChaosEvent
    {
        public string Id;
        public string Name;
        public string Category = "misc";
        /// <summary>Seconds the effect lasts. 0 means instant.</summary>
        public int Duration;
        public int Cooldown;
        public double Weight = 1.0;
        public Dictionary<string, ParamSpec> Params = new Dictionary<string, ParamSpec>();
        public EventGate Available;
        public EventAction Execute;
        public EventCleanup Cleanup;
        public EventUpdate Tick;
    }

    public class ChaosEventManager
    {
        private readonly List<string> _order = new List<string>();
        private readonly Dictionary<string, ChaosEvent> _events = new Dictionary<string, ChaosEvent>();
        private readonly Dictionary<string, int> _readyAt = new Dictionary<string, int>();

        private class Active
        {
            public ChaosEvent Event;
            public object State;
            public int ExpiresAt;
        }
        private readonly List<Active> _active = new List<Active>();

        public int Count { get { return _order.Count; } }

        private static int Now() { return Game.GameTime; }

        public void Register(ChaosEvent e)
        {
            if (e == null || string.IsNullOrEmpty(e.Id) || e.Execute == null)
            {
                ChaosLog.Error_("register: incomplete event definition");
                return;
            }
            if (_events.ContainsKey(e.Id))
            {
                ChaosLog.Warn_("register: " + e.Id + " registered twice, overwriting");
            }
            else
            {
                _order.Add(e.Id);
            }
            if (string.IsNullOrEmpty(e.Name)) e.Name = e.Id;
            _events[e.Id] = e;
        }

        public int CooldownRemaining(string id)
        {
            int at;
            if (!_readyAt.TryGetValue(id, out at)) return 0;
            int left = at - Now();
            if (left <= 0) { _readyAt.Remove(id); return 0; }
            return (int)Math.Ceiling(left / 1000.0);
        }

        public bool IsAvailable(string id)
        {
            ChaosEvent e;
            if (!_events.TryGetValue(id, out e)) return false;
            if (CooldownRemaining(id) > 0) return false;
            if (e.Available == null) return true;
            try { return e.Available(); }
            catch (Exception ex)
            {
                ChaosLog.Error_("available() for " + id + " threw: " + ex.Message);
                return false;
            }
        }

        /// <summary>The event list handed to the host, in protocol shape.</summary>
        public List<object> Describe()
        {
            List<object> list = new List<object>();
            for (int i = 0; i < _order.Count; i++)
            {
                ChaosEvent e = _events[_order[i]];
                Dictionary<string, object> parameters = new Dictionary<string, object>();
                foreach (KeyValuePair<string, ParamSpec> kv in e.Params)
                {
                    Dictionary<string, object> spec = new Dictionary<string, object>();
                    spec["type"] = kv.Value.Type;
                    if (!double.IsNegativeInfinity(kv.Value.Min)) spec["min"] = kv.Value.Min;
                    if (!double.IsPositiveInfinity(kv.Value.Max)) spec["max"] = kv.Value.Max;
                    if (kv.Value.Default != null) spec["default"] = kv.Value.Default;
                    parameters[kv.Key] = spec;
                }

                Dictionary<string, object> d = new Dictionary<string, object>();
                d["id"] = e.Id;
                d["name"] = e.Name;
                d["category"] = e.Category;
                d["duration"] = e.Duration;
                d["cooldown"] = e.Cooldown;
                d["weight"] = e.Weight;
                d["params"] = parameters;
                d["available"] = IsAvailable(e.Id);
                list.Add(d);
            }
            return list;
        }

        /// <summary>
        /// Coerce and clamp what the host asked for. This is where the game
        /// stops being polite about parameters: a value outside the declared
        /// range is clamped, never obeyed.
        /// </summary>
        private Dictionary<string, double> CleanParams(ChaosEvent e, Dictionary<string, object> raw)
        {
            Dictionary<string, double> clean = new Dictionary<string, double>();
            foreach (KeyValuePair<string, ParamSpec> kv in e.Params)
            {
                double value;
                double? given = ChaosJson.GetNumber(raw, kv.Key);
                if (given.HasValue) value = given.Value;
                else if (kv.Value.Default != null) value = Convert.ToDouble(kv.Value.Default, CultureInfo.InvariantCulture);
                else value = 0;

                if (value < kv.Value.Min) value = kv.Value.Min;
                if (value > kv.Value.Max) value = kv.Value.Max;
                clean[kv.Key] = value;
            }
            return clean;
        }

        public Dictionary<string, object> Execute(string id, Dictionary<string, object> rawParams, bool ignoreCooldown, string source)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["id"] = id;

            ChaosEvent e;
            if (id == null || !_events.TryGetValue(id, out e))
            {
                ChaosLog.Warn_("execute: unknown event id '" + (id == null ? "(null)" : id) + "'");
                result["success"] = false;
                result["error"] = "unknown_event";
                return result;
            }

            if (!ignoreCooldown)
            {
                int left = CooldownRemaining(id);
                if (left > 0)
                {
                    result["success"] = false;
                    result["error"] = "on_cooldown";
                    result["cooldown_remaining"] = left;
                    return result;
                }
                if (e.Available != null)
                {
                    bool ok;
                    try { ok = e.Available(); }
                    catch { ok = false; }
                    if (!ok)
                    {
                        result["success"] = false;
                        result["error"] = "unavailable";
                        return result;
                    }
                }
            }

            Dictionary<string, double> clean = CleanParams(e, rawParams);

            EventOutcome outcome;
            try
            {
                outcome = e.Execute(clean);
            }
            catch (Exception ex)
            {
                ChaosLog.Error_("execute: " + id + " threw: " + ex.Message);
                result["success"] = false;
                result["error"] = "exception";
                result["message"] = ex.Message;
                return result;
            }

            if (outcome == null || !outcome.Success)
            {
                string why = (outcome == null || outcome.Message == null) ? "failed" : outcome.Message;
                ChaosLog.Warn_("execute: " + id + " refused: " + why);
                result["success"] = false;
                result["error"] = (outcome == null || outcome.Error == null) ? "refused" : outcome.Error;
                result["message"] = why;
                return result;
            }

            if (e.Cooldown > 0) _readyAt[id] = Now() + e.Cooldown * 1000;

            if (e.Duration > 0)
            {
                Active a = new Active();
                a.Event = e;
                a.State = outcome.State;
                a.ExpiresAt = Now() + e.Duration * 1000;
                _active.Add(a);
            }

            ChaosLog.Info_("executed '" + e.Name + "' (" + id + ") source=" + source);
            result["success"] = true;
            result["name"] = e.Name;
            result["duration"] = e.Duration;
            return result;
        }

        public List<object> ActiveEvents()
        {
            List<object> list = new List<object>();
            for (int i = 0; i < _active.Count; i++)
            {
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["id"] = _active[i].Event.Id;
                d["name"] = _active[i].Event.Name;
                d["remaining"] = (int)Math.Max(0, Math.Ceiling((_active[i].ExpiresAt - Now()) / 1000.0));
                list.Add(d);
            }
            return list;
        }

        /// <summary>Expire timed events and run their cleanup. Called every tick.</summary>
        public void Update()
        {
            int now = Now();
            for (int i = _active.Count - 1; i >= 0; i--)
            {
                if (now < _active[i].ExpiresAt)
                {
                    // Events that keep working while they run: stumbling when
                    // drunk, re-boosting traffic, and so on.
                    if (_active[i].Event.Tick != null)
                    {
                        try { _active[i].Event.Tick(_active[i].State); }
                        catch (Exception ex)
                        {
                            ChaosLog.Error_("tick: " + _active[i].Event.Id + " threw: " + ex.Message);
                        }
                    }
                    continue;
                }
                Active a = _active[i];
                _active.RemoveAt(i);
                if (a.Event.Cleanup == null) continue;
                try { a.Event.Cleanup(a.State); }
                catch (Exception ex)
                {
                    ChaosLog.Error_("cleanup: " + a.Event.Id + " threw: " + ex.Message);
                }
            }
        }

        /// <summary>Drop everything, running cleanups first.</summary>
        public void Reset()
        {
            for (int i = _active.Count - 1; i >= 0; i--)
            {
                if (_active[i].Event.Cleanup == null) continue;
                try { _active[i].Event.Cleanup(_active[i].State); }
                catch { }
            }
            _active.Clear();
            _readyAt.Clear();
            ChaosLog.Info_("event manager reset");
        }

        public List<string> Ids() { return _order; }
    }

    // =====================================================================
    // On-screen feedback
    // =====================================================================

    public static class ChaosUi
    {
        private static string _voteLine;
        private static int _voteUntil;

        public static void Notify(string text)
        {
            try { Game.DisplayText(text, 4000); }
            catch (Exception ex) { ChaosLog.Warn_("ui: " + ex.Message); }
        }

        public static void ShowVote(List<object> options, int secondsLeft)
        {
            string leader = null;
            double best = -1;
            int count = 0;
            if (options != null)
            {
                for (int i = 0; i < options.Count; i++)
                {
                    Dictionary<string, object> o = ChaosJson.AsMap(options[i]);
                    if (o == null) continue;
                    count++;
                    double pct = 0;
                    double? p = ChaosJson.GetNumber(o, "percent");
                    if (p.HasValue) pct = p.Value;
                    if (pct > best) { best = pct; leader = ChaosJson.GetString(o, "label"); }
                }
            }

            if (count == 0) { _voteLine = "CHAOS - voting"; }
            else if (best <= 0)
            {
                _voteLine = "CHAOS - " + count + " options - " + secondsLeft + "s";
            }
            else
            {
                _voteLine = "CHAOS - " + leader + " " + (int)best + "% - " + secondsLeft + "s";
            }
            // Redrawn every tick until this runs out: DisplayText is a one-shot.
            _voteUntil = Game.GameTime + 2000;
        }

        public static void HideVote() { _voteLine = null; _voteUntil = 0; }

        private static string _activeLine;

        /// <summary>
        /// What is currently running, with a countdown. Without this a timed
        /// effect like slow motion just happens to you with no way to tell what
        /// it is or when it ends.
        /// </summary>
        public static void SetActive(List<object> active)
        {
            if (active == null || active.Count == 0) { _activeLine = null; return; }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < active.Count; i++)
            {
                Dictionary<string, object> a = ChaosJson.AsMap(active[i]);
                if (a == null) continue;
                if (sb.Length > 0) sb.Append("   ");
                object name, remaining;
                a.TryGetValue("name", out name);
                a.TryGetValue("remaining", out remaining);
                sb.Append(name).Append(' ').Append(remaining).Append('s');
            }
            _activeLine = sb.Length > 0 ? sb.ToString() : null;
        }

        /// <summary>Keeps the vote line and the effect timers on screen.</summary>
        public static void Update()
        {
            // DisplayText is a one-shot, so anything persistent is redrawn.
            if (_voteLine != null)
            {
                if (Game.GameTime > _voteUntil) _voteLine = null;
                else
                {
                    try { Game.DisplayText(_voteLine, 200); }
                    catch { }
                    return;
                }
            }
            if (_activeLine != null)
            {
                try { Game.DisplayText(_activeLine, 200); }
                catch { }
            }
        }
    }

    // =====================================================================
    // Transport: the same JSON-lines spool the STALKER adapter uses
    // =====================================================================

    public class ChaosIpc
    {
        public const int ProtocolVersion = 1;
        public const string GameId = "gta4";

        private readonly ChaosEventManager _events;
        private readonly string _dir;
        private readonly string _inPath;
        private readonly string _outPath;

        private long _readOffset;
        private string _carry = "";
        private int _nextPoll;
        private int _nextBeat;
        private bool _ready;
        private bool _warned;

        public int PollIntervalMs = 250;
        public int HeartbeatIntervalMs = 5000;

        public ChaosIpc(ChaosEventManager events, string dir)
        {
            _events = events;
            _dir = dir;
            _inPath = Path.Combine(dir, "chaos_in.jsonl");
            _outPath = Path.Combine(dir, "chaos_out.jsonl");
        }

        public string Directory_ { get { return _dir; } }
        public bool IsReady { get { return _ready; } }

        public void Start()
        {
            try
            {
                // Unlike the Lua side, .NET can create its own directory, which
                // removes a whole class of "nothing happened and nothing said
                // why" startup failures.
                Directory.CreateDirectory(_dir);

                // Skip whatever the host wrote before this session began.
                if (File.Exists(_inPath))
                {
                    FileInfo fi = new FileInfo(_inPath);
                    _readOffset = fi.Length;
                }
                else
                {
                    File.WriteAllText(_inPath, "");
                    _readOffset = 0;
                }

                // Fresh outbox per session, so the host never replays a dead one.
                File.WriteAllText(_outPath, "");

                _ready = true;
                _warned = false;
                ChaosLog.Info_("ipc: spool ready at " + _dir);
                SendHello();
            }
            catch (Exception ex)
            {
                _ready = false;
                if (!_warned)
                {
                    _warned = true;
                    ChaosLog.Error_("ipc: cannot use " + _dir + " (" + ex.Message + "). Retrying.");
                }
            }
        }

        public void Stop()
        {
            if (!_ready) return;
            Dictionary<string, object> bye = new Dictionary<string, object>();
            bye["type"] = "goodbye";
            Send(bye);
            _ready = false;
        }

        public void Send(Dictionary<string, object> message)
        {
            message["protocol"] = ProtocolVersion;
            message["game"] = GameId;
            try
            {
                File.AppendAllText(_outPath, ChaosJson.Encode(message) + "\n");
            }
            catch (Exception ex)
            {
                ChaosLog.Warn_("ipc: could not write: " + ex.Message);
                _ready = false;
            }
        }

        private void SendHello()
        {
            Dictionary<string, object> hello = new Dictionary<string, object>();
            hello["type"] = "hello";
            hello["events"] = _events.Describe();
            hello["ui"] = true;
            Send(hello);
        }

        public void Update()
        {
            int now = Game.GameTime;

            if (!_ready)
            {
                if (now >= _nextPoll)
                {
                    _nextPoll = now + 5000;
                    Start();
                }
                return;
            }

            if (now >= _nextPoll)
            {
                _nextPoll = now + PollIntervalMs;
                try { Poll(); }
                catch (Exception ex) { ChaosLog.Error_("ipc: poll failed: " + ex.Message); }
            }

            if (now >= _nextBeat)
            {
                _nextBeat = now + HeartbeatIntervalMs;
                Dictionary<string, object> beat = new Dictionary<string, object>();
                beat["type"] = "heartbeat";
                beat["active"] = _events.ActiveEvents();
                beat["online"] = GtaEvents.PlayerReady();
                Send(beat);
            }
        }

        private void Poll()
        {
            if (!File.Exists(_inPath)) return;

            long size;
            using (FileStream fs = new FileStream(_inPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                size = fs.Length;
                if (size < _readOffset)
                {
                    // Host restarted and truncated the command spool.
                    _readOffset = 0;
                    _carry = "";
                }
                if (size == _readOffset) return;

                fs.Seek(_readOffset, SeekOrigin.Begin);
                int length = (int)(size - _readOffset);
                byte[] buffer = new byte[length];
                int read = fs.Read(buffer, 0, length);
                _readOffset = size;

                string text = _carry + Encoding.UTF8.GetString(buffer, 0, read);
                string[] lines = text.Split('\n');
                // A trailing fragment with no newline waits for the next poll.
                _carry = lines[lines.Length - 1];

                for (int i = 0; i < lines.Length - 1; i++)
                {
                    string line = lines[i].Trim();
                    if (line.Length == 0) continue;
                    Dictionary<string, object> message = ChaosJson.AsMap(ChaosJson.Decode(line));
                    if (message == null)
                    {
                        // Bad JSON means we are misaligned, not that the host
                        // is broken: drop the tail and resync.
                        ChaosLog.Warn_("ipc: discarding malformed line, resyncing");
                        _carry = "";
                        continue;
                    }
                    Dispatch(message);
                }
            }
        }

        private void Dispatch(Dictionary<string, object> message)
        {
            string type = ChaosJson.GetString(message, "type");
            if (type == null) return;
            string requestId = ChaosJson.GetString(message, "request_id");

            try
            {
                if (type == "ping")
                {
                    Dictionary<string, object> pong = new Dictionary<string, object>();
                    pong["type"] = "pong";
                    pong["request_id"] = requestId;
                    Send(pong);
                }
                else if (type == "describe")
                {
                    Dictionary<string, object> reply = new Dictionary<string, object>();
                    reply["type"] = "events";
                    reply["request_id"] = requestId;
                    reply["events"] = _events.Describe();
                    Send(reply);
                }
                else if (type == "event")
                {
                    string id = ChaosJson.GetString(message, "id");
                    object rawParams;
                    message.TryGetValue("parameters", out rawParams);
                    Dictionary<string, object> result =
                        _events.Execute(id, ChaosJson.AsMap(rawParams), false, "ipc");
                    result["type"] = "event_result";
                    result["request_id"] = requestId;
                    Send(result);

                    object ok;
                    if (result.TryGetValue("success", out ok) && ok is bool && (bool)ok)
                    {
                        object name;
                        result.TryGetValue("name", out name);
                        ChaosUi.Notify(name == null ? id : name.ToString());
                    }
                }
                else if (type == "vote_start" || type == "vote_update")
                {
                    object opts;
                    message.TryGetValue("options", out opts);
                    double? left = ChaosJson.GetNumber(message, "seconds_left");
                    if (!left.HasValue) left = ChaosJson.GetNumber(message, "duration");
                    ChaosUi.ShowVote(opts as List<object>, left.HasValue ? (int)left.Value : 0);
                }
                else if (type == "vote_end")
                {
                    ChaosUi.HideVote();
                    Dictionary<string, object> winner = ChaosJson.AsMap(
                        message.ContainsKey("winner") ? message["winner"] : null);
                    string label = ChaosJson.GetString(winner, "label");
                    if (label != null) ChaosUi.Notify(label);
                }
                else if (type == "notify")
                {
                    string text = ChaosJson.GetString(message, "text");
                    if (text != null) ChaosUi.Notify(text);
                }
                else if (type == "reset")
                {
                    _events.Reset();
                    ChaosUi.HideVote();
                    Dictionary<string, object> ack = new Dictionary<string, object>();
                    ack["type"] = "ack";
                    ack["request_id"] = requestId;
                    Send(ack);
                }
                else
                {
                    ChaosLog.Warn_("ipc: unsupported message type '" + type + "'");
                    Dictionary<string, object> err = new Dictionary<string, object>();
                    err["type"] = "error";
                    err["request_id"] = requestId;
                    err["error"] = "unsupported_type";
                    Send(err);
                }
            }
            catch (Exception ex)
            {
                ChaosLog.Error_("ipc: handler '" + type + "' threw: " + ex.Message);
            }
        }
    }

    // =====================================================================
    // GAME EVENTS -- the only part that knows what GTA IV is
    // =====================================================================

    public static class GtaEvents
    {
        private static readonly Random Rng = new Random();

        // GTA IV model names. Every use falls back to something generic if the
        // model will not load, so a wrong name degrades instead of throwing.
        private static readonly string[] CopModels = { "M_Y_COP", "M_Y_SWAT", "M_Y_COP_TRAFFIC" };
        private static readonly string[] EnemyModels = { "M_Y_GRUS_LO_01", "M_Y_GBIK_LO_01", "M_Y_THIEF", "M_Y_DEALER" };
        private static readonly string[] FunCars = { "infernus", "banshee", "comet", "turismo", "sultan", "nrg900", "sanchez" };
        // Deliberately no "police" here: a police car made Car Chase look like
        // the police event, and the two should read differently.
        private static readonly string[] ChaseCars = { "sultan", "banshee", "cavalcade", "comet" };
        private static readonly string[] Helis = { "annihilator", "maverick", "polmav" };

        private static readonly Weapon[] GiveableWeapons =
        {
            Weapon.Handgun_Glock, Weapon.Handgun_DesertEagle, Weapon.Shotgun_Basic,
            Weapon.Shotgun_Baretta, Weapon.SMG_MP5, Weapon.SMG_Uzi,
            Weapon.Rifle_AK47, Weapon.Rifle_M4, Weapon.SniperRifle_Basic,
            Weapon.Thrown_Grenade, Weapon.Thrown_Molotov, Weapon.Melee_BaseballBat
        };

        public static bool PlayerReady()
        {
            try
            {
                Player p = Game.LocalPlayer;
                return p != null && p.Character != null && p.Character.isAliveAndWell;
            }
            catch
            {
                return false;
            }
        }

        private static Ped Me() { return Game.LocalPlayer.Character; }

        /// <summary>
        /// A spot on a street roughly `distance` metres away, in a random
        /// direction. Snapping to the street network is what keeps spawned
        /// vehicles out of walls and off rooftops.
        /// </summary>
        private static Vector3 NearbyStreet(float distance)
        {
            Vector3 origin = Me().Position;
            double angle = Rng.NextDouble() * Math.PI * 2;
            Vector3 target = new Vector3(
                origin.X + (float)(Math.Cos(angle) * distance),
                origin.Y + (float)(Math.Sin(angle) * distance),
                origin.Z);
            Vector3 street = World.GetNextPositionOnStreet(target);
            if (street.Equals(Vector3.Zero)) return target;
            return street;
        }

        private static Vector3 NearbyGround(float distance)
        {
            Vector3 origin = Me().Position;
            double angle = Rng.NextDouble() * Math.PI * 2;
            Vector3 target = new Vector3(
                origin.X + (float)(Math.Cos(angle) * distance),
                origin.Y + (float)(Math.Sin(angle) * distance),
                origin.Z);
            return World.GetGroundPosition(target);
        }

        /// <summary>Create a ped, falling back to a random one if the model fails.</summary>
        private static Ped SpawnPed(string[] models, Vector3 position)
        {
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    Model model = new Model(models[Rng.Next(models.Length)]);
                    Ped ped = World.CreatePed(model, position);
                    if (ped != null && ped.Exists()) return ped;
                }
                catch (Exception ex)
                {
                    ChaosLog.Debug_("spawn ped model failed: " + ex.Message);
                }
            }
            try { return World.CreatePed(position); }
            catch { return null; }
        }

        private static Vehicle SpawnVehicle(string[] models, Vector3 position)
        {
            try
            {
                Model model = new Model(models[Rng.Next(models.Length)]);
                Vehicle v = World.CreateVehicle(model, position);
                if (v != null && v.Exists()) return v;
            }
            catch (Exception ex)
            {
                ChaosLog.Debug_("spawn vehicle model failed: " + ex.Message);
            }
            try { return World.CreateVehicle(position); }
            catch { return null; }
        }

        /// <summary>A random point within `radius` of the player, at ground level.</summary>
        private static Vector3 PointAround(float radius)
        {
            Vector3 origin = Me().Position;
            double angle = Rng.NextDouble() * Math.PI * 2;
            // sqrt keeps the points evenly spread over the disc instead of
            // bunching them around the player.
            double distance = Math.Sqrt(Rng.NextDouble()) * radius;
            Vector3 target = new Vector3(
                origin.X + (float)(Math.Cos(angle) * distance),
                origin.Y + (float)(Math.Sin(angle) * distance),
                origin.Z);
            try { return World.GetGroundPosition(target); }
            catch { return target; }
        }

        /// <summary>Everyone nearby except the player.</summary>
        private static List<Ped> NearbyPeds(float radius)
        {
            List<Ped> found = new List<Ped>();
            try
            {
                Ped me = Me();
                Ped[] all = World.GetPeds(me.Position, radius);
                for (int i = 0; i < all.Length; i++)
                {
                    Ped p = all[i];
                    if (p == null || !p.Exists()) continue;
                    if (p.Equals(me)) continue;
                    if (!p.isAliveAndWell) continue;
                    found.Add(p);
                }
            }
            catch (Exception ex) { ChaosLog.Debug_("NearbyPeds: " + ex.Message); }
            return found;
        }

        /// <summary>Nearby vehicles, optionally skipping the one the player is in.</summary>
        private static List<Vehicle> NearbyVehicles(float radius, bool includeMine)
        {
            List<Vehicle> found = new List<Vehicle>();
            try
            {
                Ped me = Me();
                Vehicle mine = me.CurrentVehicle;
                Vehicle[] all = World.GetVehicles(me.Position, radius);
                for (int i = 0; i < all.Length; i++)
                {
                    Vehicle v = all[i];
                    if (v == null || !v.Exists()) continue;
                    if (!includeMine && mine != null && mine.Exists() && v.Equals(mine)) continue;
                    found.Add(v);
                }
            }
            catch (Exception ex) { ChaosLog.Debug_("NearbyVehicles: " + ex.Message); }
            return found;
        }

        /// <summary>Turn a spawned ped into something that actually comes for you.</summary>
        private static void MakeHostile(Ped ped, Weapon weapon, int accuracy)
        {
            try
            {
                GiveWeapon(ped, weapon, 250);
                ped.Accuracy = accuracy;
                ped.Enemy = true;
                ped.BlockPermanentEvents = true;   // do not wander off mid-fight
                ped.Task.AlwaysKeepTask = true;
                ped.Task.FightAgainst(Me());
            }
            catch (Exception ex) { ChaosLog.Debug_("MakeHostile: " + ex.Message); }
        }

        /// <summary>
        /// Hand someone a weapon. There is no Give(): in this API a weapon is
        /// issued by setting the ammo on its slot.
        /// </summary>
        private static void GiveWeapon(Ped ped, Weapon type, int ammo)
        {
            try { ped.Weapons.FromType(type).Ammo = ammo; }
            catch (Exception ex) { ChaosLog.Debug_("give weapon failed: " + ex.Message); }
        }

        /// <summary>Spawned things are marked disposable so the game can clean up.</summary>
        private static void Disown(Ped p) { try { p.NoLongerNeeded(); } catch { } }
        private static void Disown(Vehicle v) { try { v.NoLongerNeeded(); } catch { } }

        public static void RegisterAll(ChaosEventManager m)
        {
            // ---- police / wanted ------------------------------------------
            ChaosEvent wanted = new ChaosEvent();
            wanted.Id = "wanted";
            wanted.Name = "Wanted";
            wanted.Category = "police";
            wanted.Cooldown = 120;
            wanted.Weight = 1.0;
            wanted.Params["stars"] = ParamSpec.Number(1, 6, 3);
            wanted.Available = PlayerReady;
            wanted.Execute = delegate(Dictionary<string, double> p)
            {
                int stars = (int)p["stars"];
                Game.LocalPlayer.WantedLevel = stars;
                ChaosUi.Notify(stars + " star" + (stars == 1 ? "" : "s"));
                return EventOutcome.Ok();
            };
            m.Register(wanted);

            ChaosEvent clearWanted = new ChaosEvent();
            clearWanted.Id = "remove_wanted";
            clearWanted.Name = "Clean Record";
            clearWanted.Category = "police";
            clearWanted.Cooldown = 180;
            clearWanted.Weight = 0.8;
            clearWanted.Available = delegate { return PlayerReady() && Game.LocalPlayer.WantedLevel > 0; };
            clearWanted.Execute = delegate
            {
                Game.LocalPlayer.WantedLevel = 0;
                ChaosUi.Notify("Wanted level cleared");
                return EventOutcome.Ok();
            };
            m.Register(clearWanted);

            ChaosEvent police = new ChaosEvent();
            police.Id = "spawn_police";
            police.Name = "Police Response";
            police.Category = "police";
            police.Cooldown = 150;
            police.Weight = 1.0;
            police.Params["count"] = ParamSpec.Number(1, 6, 3);
            police.Available = PlayerReady;
            police.Execute = delegate(Dictionary<string, double> p)
            {
                int count = (int)p["count"];
                int made = 0;
                for (int i = 0; i < count; i++)
                {
                    // Close enough to be unmistakable. At 18m they were often
                    // behind a building and the event looked like nothing.
                    Ped cop = SpawnPed(CopModels, NearbyGround(14f));
                    if (cop == null) continue;
                    made++;
                    MakeHostile(cop, Weapon.Handgun_Glock, 40);
                    Disown(cop);
                }
                if (made == 0) return EventOutcome.Refuse("could not spawn anyone");
                ChaosUi.Notify("Police are on you x " + made);
                return EventOutcome.Ok();
            };
            m.Register(police);

            ChaosEvent heli = new ChaosEvent();
            heli.Id = "helicopter";
            heli.Name = "Helicopter";
            heli.Category = "police";
            heli.Cooldown = 300;
            heli.Weight = 0.4;
            heli.Available = PlayerReady;
            heli.Execute = delegate
            {
                // High above a nearby street, so it has somewhere to fly from.
                Vector3 spot = NearbyStreet(60f);
                spot = new Vector3(spot.X, spot.Y, spot.Z + 45f);
                Vehicle chopper = SpawnVehicle(Helis, spot);
                if (chopper == null) return EventOutcome.Refuse("could not spawn a helicopter");

                Ped pilot = null;
                try
                {
                    pilot = chopper.CreatePedOnSeat(VehicleSeat.Driver);
                    if (pilot != null)
                    {
                        GiveWeapon(pilot, Weapon.Rifle_M4, 300);
                        pilot.Task.DriveTo(Me(), 40f, false);
                    }
                }
                catch (Exception ex)
                {
                    ChaosLog.Warn_("helicopter pilot failed: " + ex.Message);
                }

                if (pilot != null) Disown(pilot);
                Disown(chopper);
                ChaosUi.Notify("Helicopter inbound");
                return EventOutcome.Ok();
            };
            m.Register(heli);

            // ---- hostiles --------------------------------------------------
            ChaosEvent enemies = new ChaosEvent();
            enemies.Id = "spawn_enemy";
            enemies.Name = "Ambush";
            enemies.Category = "hostiles";
            enemies.Cooldown = 120;
            enemies.Weight = 1.0;
            enemies.Params["count"] = ParamSpec.Number(1, 6, 3);
            enemies.Available = PlayerReady;
            enemies.Execute = delegate(Dictionary<string, double> p)
            {
                int count = (int)p["count"];
                int made = 0;
                for (int i = 0; i < count; i++)
                {
                    Ped thug = SpawnPed(EnemyModels, NearbyGround(16f));
                    if (thug == null) continue;
                    made++;
                    MakeHostile(thug, GiveableWeapons[Rng.Next(6)], 35);
                    Disown(thug);
                }
                if (made == 0) return EventOutcome.Refuse("could not spawn anyone");
                ChaosUi.Notify("Ambush! x " + made);
                return EventOutcome.Ok();
            };
            m.Register(enemies);

            ChaosEvent chasers = new ChaosEvent();
            chasers.Id = "vehicle_attack";
            chasers.Name = "Car Chase";
            chasers.Category = "hostiles";
            chasers.Cooldown = 180;
            chasers.Weight = 0.8;
            chasers.Params["count"] = ParamSpec.Number(1, 3, 2);
            chasers.Available = PlayerReady;
            chasers.Execute = delegate(Dictionary<string, double> p)
            {
                int count = (int)p["count"];
                int made = 0;
                for (int i = 0; i < count; i++)
                {
                    Vehicle car = SpawnVehicle(ChaseCars, NearbyStreet(55f));
                    if (car == null) continue;
                    try
                    {
                        Ped driver = car.CreatePedOnSeat(VehicleSeat.Driver);
                        if (driver != null)
                        {
                            GiveWeapon(driver, Weapon.SMG_MP5, 300);
                            driver.WillDoDrivebys = true;
                            driver.Enemy = true;
                            driver.BlockPermanentEvents = true;
                            driver.Task.AlwaysKeepTask = true;
                            driver.Task.DriveTo(Me(), 30f, false);
                            Disown(driver);
                            made++;

                            // A shooter in the passenger seat, so this reads as
                            // an attack rather than someone driving badly.
                            Ped shooter = car.CreatePedOnSeat(VehicleSeat.RightFront);
                            if (shooter != null)
                            {
                                MakeHostile(shooter, Weapon.Rifle_AK47, 30);
                                shooter.WillDoDrivebys = true;
                                Disown(shooter);
                            }
                        }
                    }
                    catch { }
                    Disown(car);
                }
                if (made == 0) return EventOutcome.Refuse("no room on the street");
                ChaosUi.Notify("Chasers on your tail x " + made);
                return EventOutcome.Ok();
            };
            m.Register(chasers);

            // ---- gifts -----------------------------------------------------
            ChaosEvent freeCar = new ChaosEvent();
            freeCar.Id = "spawn_vehicle";
            freeCar.Name = "Free Car";
            freeCar.Category = "gifts";
            freeCar.Cooldown = 120;
            freeCar.Weight = 1.0;
            freeCar.Available = PlayerReady;
            freeCar.Execute = delegate
            {
                Vehicle v = SpawnVehicle(FunCars, NearbyStreet(12f));
                if (v == null) return EventOutcome.Refuse("no room on the street");
                Disown(v);
                ChaosUi.Notify("Something arrived nearby");
                return EventOutcome.Ok();
            };
            m.Register(freeCar);

            ChaosEvent gun = new ChaosEvent();
            gun.Id = "random_weapon";
            gun.Name = "Random Weapon";
            gun.Category = "gifts";
            gun.Cooldown = 90;
            gun.Weight = 1.0;
            gun.Available = PlayerReady;
            gun.Execute = delegate
            {
                Weapon w = GiveableWeapons[Rng.Next(GiveableWeapons.Length)];
                GiveWeapon(Me(), w, 250);
                ChaosUi.Notify("Have a weapon");
                return EventOutcome.Ok();
            };
            m.Register(gun);

            ChaosEvent disarm = new ChaosEvent();
            disarm.Id = "remove_weapons";
            disarm.Name = "Disarmed";
            disarm.Category = "gifts";
            disarm.Cooldown = 240;
            disarm.Weight = 0.5;
            disarm.Available = PlayerReady;
            disarm.Execute = delegate
            {
                Me().Weapons.RemoveAll();
                ChaosUi.Notify("Your weapons are gone");
                return EventOutcome.Ok();
            };
            m.Register(disarm);

            // ---- the player ------------------------------------------------
            ChaosEvent heal = new ChaosEvent();
            heal.Id = "heal";
            heal.Name = "Patch Up";
            heal.Category = "player";
            heal.Cooldown = 120;
            heal.Weight = 1.0;
            heal.Available = PlayerReady;
            heal.Execute = delegate
            {
                Ped me = Me();
                me.Health = 100;
                me.Armor = 100;
                ChaosUi.Notify("Patched up");
                return EventOutcome.Ok();
            };
            m.Register(heal);

            ChaosEvent hurt = new ChaosEvent();
            hurt.Id = "damage";
            hurt.Name = "Pain";
            hurt.Category = "player";
            hurt.Cooldown = 120;
            hurt.Weight = 1.0;
            hurt.Params["amount"] = ParamSpec.Number(5, 60, 25);
            hurt.Available = PlayerReady;
            hurt.Execute = delegate(Dictionary<string, double> p)
            {
                Ped me = Me();
                int amount = (int)p["amount"];
                // Chaos should hurt, not end the run.
                if (me.Health <= amount + 10) return EventOutcome.Refuse("would be lethal");
                me.Health = me.Health - amount;
                ChaosUi.Notify("That hurt");
                return EventOutcome.Ok();
            };
            m.Register(hurt);

            ChaosEvent ragdoll = new ChaosEvent();
            ragdoll.Id = "ragdoll";
            ragdoll.Name = "Ragdoll";
            ragdoll.Category = "player";
            ragdoll.Cooldown = 90;
            ragdoll.Weight = 1.0;
            ragdoll.Params["seconds"] = ParamSpec.Number(1, 10, 4);
            ragdoll.Available = PlayerReady;
            ragdoll.Execute = delegate(Dictionary<string, double> p)
            {
                Me().ForceRagdoll((int)(p["seconds"] * 1000), false);
                ChaosUi.Notify("Whoops");
                return EventOutcome.Ok();
            };
            m.Register(ragdoll);

            ChaosEvent burn = new ChaosEvent();
            burn.Id = "burn";
            burn.Name = "On Fire";
            burn.Category = "player";
            burn.Cooldown = 240;
            burn.Weight = 0.6;
            burn.Available = delegate { return PlayerReady() && Me().Health > 40; };
            burn.Execute = delegate
            {
                ScriptedFire fire = World.StartFire(Me().Position);
                ChaosUi.Notify("You are on fire");
                return EventOutcome.OkWith(fire);
            };
            burn.Duration = 8;
            burn.Cleanup = delegate(object state)
            {
                ScriptedFire fire = state as ScriptedFire;
                if (fire == null) return;
                try { fire.Delete(); } catch { }
            };
            m.Register(burn);

            ChaosEvent moon = new ChaosEvent();
            moon.Id = "super_jump";
            moon.Name = "Low Gravity";
            moon.Category = "player";
            moon.Cooldown = 240;
            moon.Weight = 0.8;
            moon.Duration = 30;
            moon.Params["seconds"] = ParamSpec.Number(10, 120, 30);
            moon.Available = PlayerReady;
            moon.Execute = delegate(Dictionary<string, double> p)
            {
                // GTA IV has no super-jump switch, but low gravity gives the
                // same effect and uses an API that is certain to exist.
                Ped me = Me();
                // Write-only in this API, so normal gravity is assumed on the way out.
                me.GravityMultiplier = 0.35f;
                Game.LocalPlayer.NeverGetsTired = true;
                ChaosUi.Notify("Low gravity - try jumping");
                return EventOutcome.Ok();
            };
            moon.Cleanup = delegate(object state)
            {
                try
                {
                    Me().GravityMultiplier = 1.0f;
                    Game.LocalPlayer.NeverGetsTired = false;
                    ChaosUi.Notify("Gravity is back");
                }
                catch { }
            };
            m.Register(moon);

            ChaosEvent speed = new ChaosEvent();
            speed.Id = "speed";
            speed.Name = "Time Warp";
            speed.Category = "player";
            speed.Cooldown = 240;
            speed.Weight = 0.8;
            speed.Duration = 20;
            speed.Params["scale"] = ParamSpec.Number(0.3, 1.8, 0.5);
            speed.Available = PlayerReady;
            speed.Execute = delegate(Dictionary<string, double> p)
            {
                // Write-only in this API; normal speed is assumed on the way out.
                Game.TimeScale = (float)p["scale"];
                ChaosUi.Notify(p["scale"] < 1 ? "Everything slows down" : "Everything speeds up");
                return EventOutcome.Ok();
            };
            speed.Cleanup = delegate(object state)
            {
                try { Game.TimeScale = 1.0f; }
                catch { }
            };
            m.Register(speed);

            ChaosEvent teleport = new ChaosEvent();
            teleport.Id = "random_teleport";
            teleport.Name = "Somewhere Else";
            teleport.Category = "player";
            teleport.Cooldown = 300;
            teleport.Weight = 0.5;
            teleport.Available = PlayerReady;
            teleport.Execute = delegate
            {
                // Snapped to the street network rather than a hand-typed
                // landmark, so it cannot drop the player inside geometry.
                Vector3 spot = NearbyStreet(300f + (float)(Rng.NextDouble() * 700.0));
                if (spot.Equals(Vector3.Zero)) return EventOutcome.Refuse("nowhere to send you");
                Game.LocalPlayer.TeleportTo(World.GetGroundPosition(spot));
                ChaosUi.Notify("Somewhere else now");
                return EventOutcome.Ok();
            };
            m.Register(teleport);

            // ---- the world --------------------------------------------------
            ChaosEvent boom = new ChaosEvent();
            boom.Id = "explode";
            boom.Name = "Explosion";
            boom.Category = "world";
            boom.Cooldown = 180;
            boom.Weight = 0.7;
            boom.Params["count"] = ParamSpec.Number(1, 6, 2);
            boom.Available = PlayerReady;
            boom.Execute = delegate(Dictionary<string, double> p)
            {
                // Anywhere in a 100m circle with the player at the centre: it
                // might be next to you, it might be across the street. A blast
                // fixed to the player was just an instant death.
                int shots = (int)p["count"];
                for (int i = 0; i < shots; i++) World.AddExplosion(PointAround(100f));
                ChaosUi.Notify(shots > 1 ? "Explosions x " + shots : "Something exploded");
                return EventOutcome.Ok();
            };
            m.Register(boom);

            ChaosEvent weather = new ChaosEvent();
            weather.Id = "weather";
            weather.Name = "Weather";
            weather.Category = "world";
            weather.Cooldown = 300;
            weather.Weight = 0.8;
            weather.Available = PlayerReady;
            weather.Execute = delegate
            {
                Weather[] options = {
                    Weather.ThunderStorm, Weather.Raining, Weather.Foggy,
                    Weather.ExtraSunny, Weather.Cloudy, Weather.Drizzle
                };
                Weather pick = options[Rng.Next(options.Length)];
                World.Weather = pick;
                ChaosUi.Notify("Weather: " + pick.ToString());
                return EventOutcome.Ok();
            };
            m.Register(weather);

            ChaosEvent time = new ChaosEvent();
            time.Id = "time";
            time.Name = "Time Skip";
            time.Category = "world";
            time.Cooldown = 300;
            time.Weight = 0.8;
            time.Params["hour"] = ParamSpec.Number(0, 23, 23);
            time.Available = PlayerReady;
            time.Execute = delegate(Dictionary<string, double> p)
            {
                int hour = (int)p["hour"];
                World.CurrentDayTime = new TimeSpan(hour, 0, 0);
                ChaosUi.Notify("It is now " + hour.ToString("00") + ":00");
                return EventOutcome.Ok();
            };
            m.Register(time);

            // ---- mayhem in the street ----------------------------------------
            ChaosEvent boost = new ChaosEvent();
            boost.Id = "car_boost";
            boost.Name = "Traffic Goes Mad";
            boost.Category = "traffic";
            boost.Cooldown = 240;
            boost.Weight = 0.8;
            boost.Duration = 15;
            boost.Params["seconds"] = ParamSpec.Number(5, 60, 15);
            boost.Available = PlayerReady;
            boost.Execute = delegate
            {
                ChaosUi.Notify("Everyone forgot how to brake");
                return EventOutcome.Ok();
            };
            // Re-applied every tick: one shove and the cars just settle down
            // again, whereas sustained force is the pile-up people want.
            boost.Tick = delegate
            {
                List<Vehicle> cars = NearbyVehicles(90f, false);
                for (int i = 0; i < cars.Count; i++)
                {
                    try
                    {
                        if (!cars[i].isDriveable) continue;
                        cars[i].ApplyForceRelative(new Vector3(0f, 22f, 0f));
                    }
                    catch { }
                }
            };
            m.Register(boost);

            ChaosEvent blowCar = new ChaosEvent();
            blowCar.Id = "blow_car";
            blowCar.Name = "Car Bomb";
            blowCar.Category = "traffic";
            blowCar.Cooldown = 150;
            blowCar.Weight = 1.0;
            blowCar.Params["count"] = ParamSpec.Number(1, 5, 1);
            blowCar.Available = PlayerReady;
            blowCar.Execute = delegate(Dictionary<string, double> p)
            {
                List<Vehicle> cars = NearbyVehicles(100f, false);
                if (cars.Count == 0) return EventOutcome.Refuse("no cars nearby");
                int want = (int)p["count"];
                int done = 0;
                for (int i = 0; i < want && cars.Count > 0; i++)
                {
                    int index = Rng.Next(cars.Count);
                    try { cars[index].Explode(); done++; }
                    catch { }
                    cars.RemoveAt(index);
                }
                if (done == 0) return EventOutcome.Refuse("nothing would explode");
                ChaosUi.Notify(done > 1 ? "Cars exploding x " + done : "A car just went up");
                return EventOutcome.Ok();
            };
            m.Register(blowCar);

            ChaosEvent launchCar = new ChaosEvent();
            launchCar.Id = "launch_car";
            launchCar.Name = "Car Launch";
            launchCar.Category = "traffic";
            launchCar.Cooldown = 120;
            launchCar.Weight = 1.0;
            launchCar.Params["count"] = ParamSpec.Number(1, 8, 3);
            launchCar.Available = PlayerReady;
            launchCar.Execute = delegate(Dictionary<string, double> p)
            {
                List<Vehicle> cars = NearbyVehicles(70f, false);
                if (cars.Count == 0) return EventOutcome.Refuse("no cars nearby");
                int want = (int)p["count"];
                int done = 0;
                for (int i = 0; i < want && cars.Count > 0; i++)
                {
                    int index = Rng.Next(cars.Count);
                    try
                    {
                        cars[index].ApplyForce(new Vector3(
                            (float)(Rng.NextDouble() * 12.0 - 6.0),
                            (float)(Rng.NextDouble() * 12.0 - 6.0),
                            35f));
                        done++;
                    }
                    catch { }
                    cars.RemoveAt(index);
                }
                if (done == 0) return EventOutcome.Refuse("nothing would move");
                ChaosUi.Notify("Cars in the air x " + done);
                return EventOutcome.Ok();
            };
            m.Register(launchCar);

            // ---- the crowd ----------------------------------------------------
            ChaosEvent riot = new ChaosEvent();
            riot.Id = "riot";
            riot.Name = "Riot";
            riot.Category = "crowd";
            riot.Cooldown = 300;
            riot.Weight = 0.7;
            riot.Available = PlayerReady;
            riot.Execute = delegate
            {
                List<Ped> crowd = NearbyPeds(80f);
                if (crowd.Count == 0) return EventOutcome.Refuse("nobody around");
                int done = 0;
                for (int i = 0; i < crowd.Count; i++)
                {
                    try
                    {
                        // Everyone hates everyone, then goes looking for a fight.
                        crowd[i].ChangeRelationship(RelationshipGroup.Civillian_Male, Relationship.Hate);
                        crowd[i].ChangeRelationship(RelationshipGroup.Civillian_Female, Relationship.Hate);
                        crowd[i].BlockPermanentEvents = true;
                        crowd[i].StartKillingSpree(true);
                        done++;
                    }
                    catch { }
                }
                if (done == 0) return EventOutcome.Refuse("nobody would riot");
                ChaosUi.Notify("The street turns on itself (" + done + ")");
                return EventOutcome.Ok();
            };
            m.Register(riot);

            ChaosEvent armEveryone = new ChaosEvent();
            armEveryone.Id = "arm_everyone";
            armEveryone.Name = "Everyone Is Armed";
            armEveryone.Category = "crowd";
            armEveryone.Cooldown = 240;
            armEveryone.Weight = 0.8;
            armEveryone.Available = PlayerReady;
            armEveryone.Execute = delegate
            {
                List<Ped> crowd = NearbyPeds(70f);
                if (crowd.Count == 0) return EventOutcome.Refuse("nobody around");
                int done = 0;
                for (int i = 0; i < crowd.Count; i++)
                {
                    try
                    {
                        Weapon w = GiveableWeapons[Rng.Next(GiveableWeapons.Length)];
                        GiveWeapon(crowd[i], w, 150);
                        crowd[i].Weapons.Select(w);
                        done++;
                    }
                    catch { }
                }
                if (done == 0) return EventOutcome.Refuse("nobody took one");
                ChaosUi.Notify("Everyone is armed now (" + done + ")");
                return EventOutcome.Ok();
            };
            m.Register(armEveryone);

            ChaosEvent massRagdoll = new ChaosEvent();
            massRagdoll.Id = "mass_ragdoll";
            massRagdoll.Name = "Everybody Falls Over";
            massRagdoll.Category = "crowd";
            massRagdoll.Cooldown = 150;
            massRagdoll.Weight = 1.0;
            massRagdoll.Params["seconds"] = ParamSpec.Number(1, 15, 5);
            massRagdoll.Available = PlayerReady;
            massRagdoll.Execute = delegate(Dictionary<string, double> p)
            {
                List<Ped> crowd = NearbyPeds(60f);
                if (crowd.Count == 0) return EventOutcome.Refuse("nobody around");
                int ms = (int)(p["seconds"] * 1000);
                int done = 0;
                for (int i = 0; i < crowd.Count; i++)
                {
                    try { crowd[i].ForceRagdoll(ms, false); done++; }
                    catch { }
                }
                ChaosUi.Notify("Everybody falls over (" + done + ")");
                return EventOutcome.Ok();
            };
            m.Register(massRagdoll);

            ChaosEvent igniteCrowd = new ChaosEvent();
            igniteCrowd.Id = "ignite_random";
            igniteCrowd.Name = "Someone Is On Fire";
            igniteCrowd.Category = "crowd";
            igniteCrowd.Cooldown = 180;
            igniteCrowd.Weight = 0.7;
            igniteCrowd.Params["count"] = ParamSpec.Number(1, 6, 2);
            igniteCrowd.Available = PlayerReady;
            igniteCrowd.Execute = delegate(Dictionary<string, double> p)
            {
                List<Ped> crowd = NearbyPeds(60f);
                if (crowd.Count == 0) return EventOutcome.Refuse("nobody around");
                int want = (int)p["count"];
                int done = 0;
                for (int i = 0; i < want && crowd.Count > 0; i++)
                {
                    int index = Rng.Next(crowd.Count);
                    try { World.StartFire(crowd[index].Position); done++; }
                    catch { }
                    crowd.RemoveAt(index);
                }
                if (done == 0) return EventOutcome.Refuse("nothing caught");
                ChaosUi.Notify("Someone is on fire (" + done + ")");
                return EventOutcome.Ok();
            };
            m.Register(igniteCrowd);

            ChaosEvent rainingMen = new ChaosEvent();
            rainingMen.Id = "raining_men";
            rainingMen.Name = "Raining Men";
            rainingMen.Category = "crowd";
            rainingMen.Cooldown = 240;
            rainingMen.Weight = 0.7;
            rainingMen.Params["count"] = ParamSpec.Number(1, 12, 6);
            rainingMen.Available = PlayerReady;
            rainingMen.Execute = delegate(Dictionary<string, double> p)
            {
                int want = (int)p["count"];
                int done = 0;
                for (int i = 0; i < want; i++)
                {
                    Vector3 spot = PointAround(30f);
                    // High enough to be a fall, low enough to stay loaded.
                    spot = new Vector3(spot.X, spot.Y, spot.Z + 40f + (float)(Rng.NextDouble() * 25.0));
                    Ped faller = SpawnPed(EnemyModels, spot);
                    if (faller == null) continue;
                    done++;
                    try { faller.ForceRagdoll(20000, false); }
                    catch { }
                    Disown(faller);
                }
                if (done == 0) return EventOutcome.Refuse("nobody fell");
                ChaosUi.Notify("It is raining men (" + done + ")");
                return EventOutcome.Ok();
            };
            m.Register(rainingMen);

            // ---- fire and brimstone -------------------------------------------
            ChaosEvent fireArea = new ChaosEvent();
            fireArea.Id = "fire_area";
            fireArea.Name = "Firestorm";
            fireArea.Category = "world";
            fireArea.Cooldown = 240;
            fireArea.Weight = 0.7;
            fireArea.Params["count"] = ParamSpec.Number(1, 20, 8);
            fireArea.Available = PlayerReady;
            fireArea.Execute = delegate(Dictionary<string, double> p)
            {
                int want = (int)p["count"];
                int done = 0;
                for (int i = 0; i < want; i++)
                {
                    try { World.StartFire(PointAround(100f)); done++; }
                    catch { }
                }
                if (done == 0) return EventOutcome.Refuse("nothing would burn");
                ChaosUi.Notify("Fires breaking out (" + done + ")");
                return EventOutcome.Ok();
            };
            m.Register(fireArea);

            ChaosEvent gangWar = new ChaosEvent();
            gangWar.Id = "gang_war";
            gangWar.Name = "Gang War";
            gangWar.Category = "hostiles";
            gangWar.Cooldown = 420;
            gangWar.Weight = 0.5;
            gangWar.Params["count"] = ParamSpec.Number(2, 6, 4);
            gangWar.Available = PlayerReady;
            gangWar.Execute = delegate(Dictionary<string, double> p)
            {
                // Two sides that hate each other and ignore you -- a fight to
                // watch rather than another fight to be in.
                try
                {
                    World.SetGroupRelationship(RelationshipGroup.Gang_Russian1, Relationship.Hate, RelationshipGroup.Gang_Italian);
                    World.SetGroupRelationship(RelationshipGroup.Gang_Italian, Relationship.Hate, RelationshipGroup.Gang_Russian1);
                }
                catch { }

                int perSide = (int)p["count"];
                List<Ped> sideA = new List<Ped>();
                List<Ped> sideB = new List<Ped>();

                for (int i = 0; i < perSide; i++)
                {
                    Ped a = SpawnPed(EnemyModels, NearbyGround(25f));
                    if (a != null)
                    {
                        try
                        {
                            a.RelationshipGroup = RelationshipGroup.Gang_Russian1;
                            GiveWeapon(a, Weapon.SMG_Uzi, 200);
                            a.BlockPermanentEvents = true;
                        }
                        catch { }
                        sideA.Add(a);
                    }
                    Ped b = SpawnPed(EnemyModels, NearbyGround(35f));
                    if (b != null)
                    {
                        try
                        {
                            b.RelationshipGroup = RelationshipGroup.Gang_Italian;
                            GiveWeapon(b, Weapon.Rifle_AK47, 200);
                            b.BlockPermanentEvents = true;
                        }
                        catch { }
                        sideB.Add(b);
                    }
                }

                if (sideA.Count == 0 || sideB.Count == 0) return EventOutcome.Refuse("no room for a fight");

                for (int i = 0; i < sideA.Count; i++)
                {
                    try { sideA[i].Task.FightAgainst(sideB[Rng.Next(sideB.Count)]); } catch { }
                    Disown(sideA[i]);
                }
                for (int i = 0; i < sideB.Count; i++)
                {
                    try { sideB[i].Task.FightAgainst(sideA[Rng.Next(sideA.Count)]); } catch { }
                    Disown(sideB[i]);
                }

                ChaosUi.Notify("Gang war! " + sideA.Count + " v " + sideB.Count);
                return EventOutcome.Ok();
            };
            m.Register(gangWar);

            ChaosEvent drunk = new ChaosEvent();
            drunk.Id = "drunk";
            drunk.Name = "Drunk";
            drunk.Category = "player";
            drunk.Cooldown = 300;
            drunk.Weight = 0.8;
            drunk.Duration = 30;
            drunk.Params["seconds"] = ParamSpec.Number(10, 120, 30);
            drunk.Available = PlayerReady;
            drunk.Execute = delegate
            {
                ChaosUi.Notify("Niko has had a few");
                return EventOutcome.OkWith(new int[] { 0 });
            };
            // GTA IV's drunk state is not reachable through this API, so this is
            // built out of what is: a stumble every couple of seconds.
            drunk.Tick = delegate(object state)
            {
                int[] next = state as int[];
                if (next == null) return;
                if (Game.GameTime < next[0]) return;
                next[0] = Game.GameTime + 1500 + Rng.Next(1500);
                try
                {
                    Ped me = Me();
                    if (me.isInVehicle()) return;   // stumbling at the wheel is just a crash
                    me.ForceRagdoll(600, true);
                }
                catch { }
            };
            m.Register(drunk);

            // ---- the big one -------------------------------------------------
            ChaosEvent everything = new ChaosEvent();
            everything.Id = "chaos";
            everything.Name = "CHAOS";
            everything.Category = "world";
            everything.Cooldown = 600;
            everything.Weight = 0.15;
            everything.Params["count"] = ParamSpec.Number(2, 5, 3);
            everything.Available = PlayerReady;
            everything.Execute = delegate(Dictionary<string, double> p)
            {
                // Picks from whatever else is currently allowed, so it can never
                // do something the game would otherwise refuse -- and never
                // recurses into itself.
                List<string> pool = new List<string>();
                List<string> ids = Manager.Ids();
                for (int i = 0; i < ids.Count; i++)
                {
                    if (ids[i] == "chaos") continue;
                    if (Manager.IsAvailable(ids[i])) pool.Add(ids[i]);
                }
                if (pool.Count == 0) return EventOutcome.Refuse("nothing else is available");

                int want = (int)p["count"];
                if (want > pool.Count) want = pool.Count;

                List<string> chosen = new List<string>();
                for (int i = 0; i < want; i++)
                {
                    int index = Rng.Next(pool.Count);
                    chosen.Add(pool[index]);
                    pool.RemoveAt(index);
                }

                int ran = 0;
                for (int i = 0; i < chosen.Count; i++)
                {
                    Dictionary<string, object> r = Manager.Execute(chosen[i], null, true, "chaos");
                    object ok;
                    if (r.TryGetValue("success", out ok) && ok is bool && (bool)ok) ran++;
                }
                if (ran == 0) return EventOutcome.Refuse("everything it tried refused");
                ChaosUi.Notify("CHAOS x " + ran);
                return EventOutcome.Ok();
            };
            m.Register(everything);
        }

        /// <summary>Set by the script so "chaos" can reach its siblings.</summary>
        public static ChaosEventManager Manager;
    }

    // =====================================================================
    // Entry point
    // =====================================================================

    public class ChaosEngineScript : Script
    {
        private ChaosEventManager _events;
        private ChaosIpc _ipc;
        private bool _started;

        public ChaosEngineScript()
        {
            Interval = 100;
            Tick += new EventHandler(OnTick);
            KeyDown += new GTA.KeyEventHandler(OnKeyDown);
        }

        private void Boot()
        {
            if (_started) return;
            _started = true;

            string root = Path.Combine(Game.InstallFolder, "scripts");
            string dir = Path.Combine(root, "chaos");
            ChaosLog.SetPath(Path.Combine(root, "chaos.log"));
            ChaosLog.Info_("starting up");

            _events = new ChaosEventManager();
            GtaEvents.Manager = _events;
            GtaEvents.RegisterAll(_events);
            ChaosLog.Info_("registered " + _events.Count + " events");

            _ipc = new ChaosIpc(_events, dir);
            _ipc.Start();
            ChaosUi.Notify("CHAOS ready");
        }

        private void OnTick(object sender, EventArgs e)
        {
            try
            {
                if (!_started)
                {
                    // Wait for a playable session: spawning into a menu or a
                    // load screen is how adapters crash games.
                    if (!GtaEvents.PlayerReady()) return;
                    Boot();
                }

                _events.Update();
                _ipc.Update();
                ChaosUi.SetActive(_events.ActiveEvents());
                ChaosUi.Update();
            }
            catch (Exception ex)
            {
                ChaosLog.Error_("tick failed: " + ex.Message);
            }
        }

        /// <summary>
        /// Offline testing, no Discord needed. F8 lists the registry, F10 runs
        /// the next event, F11 fakes a vote line.
        /// </summary>
        private int _cycle;

        private void OnKeyDown(object sender, GTA.KeyEventArgs e)
        {
            if (!_started) return;
            try
            {
                if (e.Key == System.Windows.Forms.Keys.F8)
                {
                    List<string> ids = _events.Ids();
                    ChaosLog.Info_("--- " + ids.Count + " registered events ---");
                    for (int i = 0; i < ids.Count; i++)
                    {
                        ChaosLog.Info_("  " + ids[i] + " available=" + _events.IsAvailable(ids[i]));
                    }
                    ChaosLog.Info_("spool: " + _ipc.Directory_ + " ready=" + _ipc.IsReady);
                    ChaosUi.Notify("CHAOS: " + ids.Count + " events");
                }
                else if (e.Key == System.Windows.Forms.Keys.F10)
                {
                    List<string> ids = _events.Ids();
                    if (ids.Count == 0) return;
                    _cycle = (_cycle + 1) % ids.Count;
                    _events.Execute(ids[_cycle], null, true, "debug_key");
                }
                else if (e.Key == System.Windows.Forms.Keys.F11)
                {
                    List<object> fake = new List<object>();
                    Dictionary<string, object> a = new Dictionary<string, object>();
                    a["label"] = "Helicopter"; a["percent"] = 42;
                    Dictionary<string, object> b = new Dictionary<string, object>();
                    b["label"] = "Free Car"; b["percent"] = 31;
                    fake.Add(a); fake.Add(b);
                    ChaosUi.ShowVote(fake, 10);
                }
            }
            catch (Exception ex)
            {
                ChaosLog.Error_("key handler failed: " + ex.Message);
            }
        }
    }
}
