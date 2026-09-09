#!/usr/bin/env python3
"""Relay for Huntera Party Analyzer, suitable for Render or local use."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from threading import Lock
import hashlib
import json
import os
import secrets
import time

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8765"))
MAX_CHARS = 4
COMBAT_TIMEOUT = float(os.environ.get("COMBAT_TIMEOUT", "15"))
XP_TIMEOUT = float(os.environ.get("XP_TIMEOUT", "15"))
EVENT_RETENTION = 15 * 60  # keep 15 min of hit timestamps for rolling DPS / timer
MAX_PARTIES = int(os.environ.get("MAX_PARTIES", "500"))
PARTY_IDLE_TIMEOUT = float(os.environ.get("PARTY_IDLE_TIMEOUT", str(4 * 24 * 60 * 60)))
MAX_EVENTS_PER_PARTY = int(os.environ.get("MAX_EVENTS_PER_PARTY", "10000"))
MAX_EVENTS_PER_CHAR = int(os.environ.get("MAX_EVENTS_PER_CHAR", "3000"))
RATE_LIMIT_WINDOW = 60
CREATE_LIMIT_PER_IP = 5
CONNECT_LIMIT_PER_IP = 20

state_lock = Lock()
parties = {}
rate_limits = {"create": {}, "connect": {}}

def now_ms():
    return int(time.time() * 1000)

def new_party():
    timestamp = now_ms()
    return {
        "resetAt": timestamp,
        "lastActivity": timestamp,
        "fight_started_at": None,
        "chars": {},
        "events": [],
        "xp_events": [],
        "xp_active_ms": 0,
        "xp_latest_event_ts": None,
        "leader_client_id": None,
    }

def clean_events(party, now=None):
    if now is None:
        now = now_ms()
    cutoff = now - EVENT_RETENTION * 1000
    party["events"] = [e for e in party["events"] if e["ts"] >= cutoff and e["ts"] >= party["resetAt"]]
    party["xp_events"] = [e for e in party["xp_events"] if e["ts"] >= cutoff and e["ts"] >= party["resetAt"]]

def combat_metrics(party, now=None):
    if now is None:
        now = now_ms()
    events = sorted(party["events"], key=lambda e: e["ts"])
    if not events:
        return 0.0, False, None, None

    active_ms = 0.0
    prev = events[0]["ts"]
    for e in events[1:]:
        gap = max(0, e["ts"] - prev)
        active_ms += min(gap, COMBAT_TIMEOUT * 1000)
        prev = e["ts"]
    active_ms += min(max(0, now - prev), COMBAT_TIMEOUT * 1000)

    last = events[-1]["ts"]
    active = (now - last) <= COMBAT_TIMEOUT * 1000
    return active_ms / 1000.0, active, events[0]["ts"], last

def xp_active_seconds(party, now=None):
    if now is None:
        now = now_ms()
    last_event_ts = party.get("xp_latest_event_ts", party.get("xp_last_event_ts"))
    if last_event_ts is None:
        return 0.0

    current_ms = party.get("xp_active_ms", 0)
    current_ms += min(max(0, now - last_event_ts), XP_TIMEOUT * 1000)
    return current_ms / 1000.0

def build_state(party, now=None):
    if now is None:
        now = now_ms()
    clean_events(party, now)
    active_seconds, active, first_hit, last_hit = combat_metrics(party, now)
    fight_started_at = party.get("fight_started_at")
    fight_duration_seconds = (
        max(0, now - fight_started_at) / 1000.0
        if fight_started_at is not None
        else 0.0
    )
    chars = {}
    for cid, c in party["chars"].items():
        chars[cid] = {
            "name": c["name"],
            "voc": c["voc"],
            "damage": c["damage"],
            "maxHit": c["maxHit"],
            "lastSeen": c["lastSeen"],
            "lastHit": c.get("lastHit", 0),
            "xp": c.get("xp", 0),
            "isLeader": cid == party.get("leader_client_id"),
        }
    return {
        "resetAt": party["resetAt"],
        "chars": chars,
        "fightStartedAt": fight_started_at,
        "fightDurationSeconds": fight_duration_seconds,
        "lastHitAt": last_hit,
        "activeSeconds": active_seconds,
        "xpActiveSeconds": xp_active_seconds(party, now),
        "combatActive": active,
        "serverNow": now,
        "maxChars": MAX_CHARS,
    }

def rolling_damage(party, cid, now, window=10.0):
    cutoff = now - int(window * 1000)
    return sum(e["damage"] for e in party["events"] if e["cid"] == cid and e["ts"] >= cutoff)

def password_hash(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1).hex()

def cleanup_parties(now=None):
    if now is None:
        now = now_ms()
    cutoff = now - int(PARTY_IDLE_TIMEOUT * 1000)
    expired = [
        token for token, party in parties.items()
        if party.get("lastActivity", party["resetAt"]) < cutoff
    ]
    for token in expired:
        del parties[token]

def allow_rate(ip, action, limit, now=None):
    if now is None:
        now = time.time()
    entries = rate_limits[action].setdefault(ip, [])
    cutoff = now - RATE_LIMIT_WINDOW
    entries[:] = [timestamp for timestamp in entries if timestamp > cutoff]
    if len(entries) >= limit:
        return False
    entries.append(now)
    return True

def event_capacity_available(party, events, cid, limit):
    if len(events) >= MAX_EVENTS_PER_PARTY:
        return False
    return sum(1 for event in events if event["cid"] == cid) < limit

def matching_character_ids(party, name):
    """Return the IDs for the same game character, independent of its tab."""
    identity = name.casefold()
    return [
        cid for cid, character in party["chars"].items()
        if character["name"].casefold() == identity
    ]

def replace_client_id(party, old_cid, new_cid):
    """Move a character and its accumulated data to a new browser session."""
    party["chars"][new_cid] = party["chars"].pop(old_cid)
    for event in party["events"]:
        if event["cid"] == old_cid:
            event["cid"] = new_cid
    for event in party["xp_events"]:
        if event["cid"] == old_cid:
            event["cid"] = new_cid
    if party.get("leader_client_id") == old_cid:
        party["leader_client_id"] = new_cid

def auth_party(handler):
    token = handler.headers.get("X-Party-Token", "")
    party = parties.get(token)
    if not party:
        return None
    now = now_ms()
    if now - party.get("lastActivity", party["resetAt"]) > PARTY_IDLE_TIMEOUT * 1000:
        del parties[token]
        return None
    party["lastActivity"] = now
    return party

def party_payload(party):
    payload = build_state(party)
    now = payload["serverNow"]
    for cid, c in payload["chars"].items():
        rd = rolling_damage(party, cid, now, 10.0)
        c["rolling10sDamage"] = rd
        c["rolling10sDps"] = rd / 10.0
    return payload

def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Party-Token")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)

def read_json(handler):
    try:
        n = int(handler.headers.get("Content-Length", "0"))
        if n > 10000:
            return None
        return json.loads(handler.rfile.read(n).decode("utf-8"))
    except Exception:
        return None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Keep the console useful but quiet.
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}")

    def do_OPTIONS(self):
        send_json(self, 204, {})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            send_json(self, 200, {"ok": True, "service": "huntera-party-analyzer", "port": PORT})
            return
        if path == "/state":
            with state_lock:
                party = auth_party(self)
                if not party:
                    send_json(self, 401, {"error": "party_auth_required"})
                    return
                send_json(self, 200, party_payload(party))
            return
        send_json(self, 404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        data = read_json(self)
        if not isinstance(data, dict):
            send_json(self, 400, {"error": "invalid json"})
            return

        with state_lock:
            if path == "/party/create":
                cleanup_parties()
                if not allow_rate(self.client_address[0], "create", CREATE_LIMIT_PER_IP):
                    send_json(self, 429, {"error": "rate_limit"})
                    return
                name = str(data.get("party_name", "")).strip()[:40]
                password = str(data.get("password", ""))
                leader_client_id = str(data.get("client_id", ""))[:100]
                if len(name) < 2 or len(password) < 4:
                    send_json(self, 400, {"error": "party name and password are required"})
                    return
                if len(parties) >= MAX_PARTIES:
                    send_json(self, 503, {"error": "party_capacity"})
                    return
                for existing in parties.values():
                    if existing["name"].casefold() == name.casefold():
                        send_json(self, 409, {"error": "party_exists"})
                        return
                token = secrets.token_urlsafe(32)
                salt = secrets.token_bytes(16)
                party = new_party()
                party["name"] = name
                party["salt"] = salt.hex()
                party["password_hash"] = password_hash(password, salt)
                party["leader_client_id"] = leader_client_id or None
                parties[token] = party
                send_json(self, 201, {"party_name": name, "party_token": token})
                return

            if path == "/party/connect":
                cleanup_parties()
                if not allow_rate(self.client_address[0], "connect", CONNECT_LIMIT_PER_IP):
                    send_json(self, 429, {"error": "rate_limit"})
                    return
                name = str(data.get("party_name", "")).strip()
                password = str(data.get("password", ""))
                for token, party in parties.items():
                    if (party["name"].casefold() == name.casefold() and
                            secrets.compare_digest(
                                password_hash(password, bytes.fromhex(party["salt"])),
                                party["password_hash"])):
                        party["lastActivity"] = now_ms()
                        send_json(self, 200, {"party_name": party["name"], "party_token": token})
                        return
                send_json(self, 401, {"error": "invalid_party_credentials"})
                return

            party = auth_party(self)
            if not party:
                send_json(self, 401, {"error": "party_auth_required"})
                return

            if path == "/register":
                cid = str(data.get("client_id", ""))[:100]
                name = str(data.get("name", "")).strip()[:40]
                voc = str(data.get("voc", ""))[:3]
                if not cid or not name:
                    send_json(self, 400, {"error": "client_id and name are required"})
                    return
                # client_id belongs to a browser session, not to the game
                # character.  A reload/new tab must take over the existing
                # character instead of consuming a second slot in the party.
                same_character = matching_character_ids(party, name)
                other_same_character = [
                    existing_cid for existing_cid in same_character
                    if existing_cid != cid
                ]
                if cid not in party["chars"]:
                    if len(same_character) == 1:
                        replace_client_id(party, same_character[0], cid)
                    elif len(same_character) > 1:
                        # Do not guess which legacy duplicate owns this name.
                        send_json(self, 409, {"error": "ambiguous_character"})
                        return
                elif other_same_character:
                    # A live client ID cannot be reassigned to a character
                    # already owned by another client ID.
                    send_json(self, 409, {"error": "character_in_use"})
                    return
                if cid not in party["chars"] and len(party["chars"]) >= MAX_CHARS:
                    send_json(self, 409, {"error": "max_chars", "maxChars": MAX_CHARS})
                    return
                old = party["chars"].get(cid)
                party["chars"][cid] = {
                    "name": name,
                    "voc": voc,
                    "damage": old["damage"] if old else 0,
                    "maxHit": old["maxHit"] if old else 0,
                    "xp": old.get("xp", 0) if old else 0,
                    "lastSeen": now_ms(),
                    "lastHit": old.get("lastHit", 0) if old else 0,
                }
                send_json(self, 200, party_payload(party))
                return

            if path == "/hit":
                cid = str(data.get("client_id", ""))[:100]
                try:
                    damage = int(data.get("damage", 0))
                    ts = int(data.get("ts", now_ms()))
                except Exception:
                    damage, ts = 0, now_ms()
                now = now_ms()
                ts = max(party["resetAt"], min(ts, now + 1000))
                if cid not in party["chars"]:
                    send_json(self, 409, {"error": "not_registered"})
                    return
                if damage <= 0 or damage > 10**12:
                    send_json(self, 400, {"error": "invalid_damage"})
                    return
                clean_events(party, now)
                if not event_capacity_available(party, party["events"], cid, MAX_EVENTS_PER_CHAR):
                    send_json(self, 429, {"error": "event_capacity"})
                    return
                c = party["chars"][cid]
                if party.get("fight_started_at") is None:
                    party["fight_started_at"] = now
                c["damage"] += damage
                c["maxHit"] = max(c["maxHit"], damage)
                c["lastSeen"] = now
                c["lastHit"] = ts
                party["events"].append({"cid": cid, "damage": damage, "ts": ts})
                send_json(self, 200, {"ok": True})
                return

            if path == "/xp":
                cid = str(data.get("client_id", ""))[:100]
                try:
                    amount = int(data.get("amount", 0))
                    ts = int(data.get("ts", now_ms()))
                except Exception:
                    amount, ts = 0, now_ms()
                now = now_ms()
                ts = max(party["resetAt"], min(ts, now + 1000))
                if cid not in party["chars"]:
                    send_json(self, 409, {"error": "not_registered"})
                    return
                if amount <= 0 or amount > 10**9:
                    send_json(self, 400, {"error": "invalid_xp"})
                    return
                clean_events(party, now)
                if not event_capacity_available(party, party["xp_events"], cid, MAX_EVENTS_PER_CHAR):
                    send_json(self, 429, {"error": "event_capacity"})
                    return
                latest_xp_ts = party.get(
                    "xp_latest_event_ts",
                    party.get("xp_last_event_ts"),
                )
                if latest_xp_ts is None:
                    party["xp_latest_event_ts"] = ts
                elif ts > latest_xp_ts:
                    party["xp_active_ms"] = party.get("xp_active_ms", 0) + min(
                        ts - latest_xp_ts,
                        XP_TIMEOUT * 1000,
                    )
                    party["xp_latest_event_ts"] = ts
                party["chars"][cid]["xp"] = party["chars"][cid].get("xp", 0) + amount
                party["chars"][cid]["lastSeen"] = now
                party["xp_events"].append({"cid": cid, "amount": amount, "ts": ts})
                send_json(self, 200, {"ok": True})
                return

            if path == "/heartbeat":
                cid = str(data.get("client_id", ""))[:100]
                if cid in party["chars"]:
                    party["chars"][cid]["lastSeen"] = now_ms()
                send_json(self, 200, {"ok": True})
                return

            if path == "/reset":
                party["resetAt"] = now_ms()
                party["fight_started_at"] = None
                party["events"] = []
                party["xp_events"] = []
                party["xp_active_ms"] = 0
                party["xp_latest_event_ts"] = None
                # Preserve registered characters, but zero their fight stats.
                for c in party["chars"].values():
                    c["damage"] = 0
                    c["maxHit"] = 0
                    c["xp"] = 0
                    c["lastHit"] = 0
                    c["lastSeen"] = party["resetAt"]
                send_json(self, 200, party_payload(party))
                return

        send_json(self, 404, {"error": "not found"})

if __name__ == "__main__":
    print(f"Huntera Party Analyzer running at http://{HOST}:{PORT}")
    print("Party data is held in memory. Keep this process running while using the DPS meter.")
    print("Press Ctrl+C to stop.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
