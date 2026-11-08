"""MixDeck SQ web server. Stdlib only."""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import mixer
import sim
import sq

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
DATA = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_FILE = DATA / "config.json"
PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET = (os.environ.get("SESSION_SECRET") or secrets.token_hex(32)).encode()
PORT = int(os.environ.get("PORT", "8080"))
MOCK = os.environ.get("SQ_MOCK") == "1"
UDP_PORT = int(os.environ.get("SQ_UDP_PORT", "0"))
CAPTURE = DATA / "meter-capture.json"
SESSION_DAYS = 30
COOKIE = "mixdeck-sq"

if not PASSWORD:
    raise SystemExit("APP_PASSWORD is not set. Refusing to start without a password.")


def load_cfg():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {"console": {"ip": os.environ.get("SQ_IP", ""), "name": "SQ-5", "midiCh": 1, "native": True}, "select": None}


def save_cfg(c):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(c, indent=2))
    tmp.replace(CONFIG_FILE)


CFG = load_cfg()
CONS = {"A": None}
SIM = sim.SQSim() if MOCK else None


def setup_console():
    if CONS["A"]:
        CONS["A"].stop()
    c = CFG["console"]
    args = dict(midi_ch=max(0, min(15, int(c.get("midiCh", 1)) - 1)), native=bool(c.get("native", True)), select_pat=CFG.get("select"),
                meter_cfg=CFG.get("meter") or sq.METER_DEFAULT, udp_port=UDP_PORT)
    if SIM:
        CONS["A"] = sq.SQ("A", "127.0.0.1", c.get("name", ""), midi_port=SIM.mport, native_port=SIM.nport, **{**args, "midi_ch": 0})
    else:
        CONS["A"] = sq.SQ("A", c.get("ip", ""), c.get("name", ""), **args)


setup_console()


# ---------- auth ----------
def make_token():
    exp = str(int(time.time()) + SESSION_DAYS * 86400)
    return f"{exp}.{hmac.new(SECRET, exp.encode(), hashlib.sha256).hexdigest()}"


def check_token(tok):
    try:
        exp, sig = tok.split(".")
        good = hmac.new(SECRET, exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except Exception:
        return False


login_hits = {}


def rate_ok(ip):
    now = time.time()
    hits = [t for t in login_hits.get(ip, []) if now - t < 60]
    login_hits[ip] = hits
    if len(hits) >= 8:
        return False
    hits.append(now)
    return True


def statuses():
    return {s: (c.status() if c else None) for s, c in CONS.items()}


def strip_sources(c):
    """Each input has its own preamp here: /headamp/NNN is input NNN+1."""
    if not c or not c.use_native:
        return {}
    return {f"/ch/{i + 1:02d}": {"ha": i} for i in range(sq.N_IN)}


learn = {"caps": {}, "busy": False}


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def make_server(port):
    try:
        return DualStackServer(("::", port), H)
    except OSError:
        srv = ThreadingHTTPServer(("0.0.0.0", port), H)
        srv.daemon_threads = True
        return srv


class H(BaseHTTPRequestHandler):
    server_version = "MixDeck"
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    def log_message(self, *a):
        pass

    def _json(self, code, obj, headers=None):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        c = CONS["A"]

        def send(ev, obj):
            self.wfile.write(f"event: {ev}\ndata: {json.dumps(obj)}\n\n".encode())

        try:
            seq = c.seq
            send("full", {"values": c.snapshot(), "status": statuses(), "sources": strip_sources(c), "link": None})
            last_status = last_mtime = 0.0
            last_meter = last_rta = b""
            while True:
                time.sleep(0.04)
                now = time.time()
                if CONS["A"] is not c:  # console changed in settings
                    send("reload", {})
                    self.wfile.flush()
                    return
                d, seq2 = c.since(seq)
                if d is None:
                    send("full", {"values": c.snapshot(), "status": statuses(), "sources": strip_sources(c), "link": None})
                elif d:
                    send("d", d)
                seq = seq2
                if c.meter_bytes and now - c.meter_at < 1 and (c.meter_bytes != last_meter or now - last_mtime > .4):
                    last_meter, last_mtime = c.meter_bytes, now
                    self.wfile.write(b"event: m\ndata: " + base64.b64encode(last_meter) + b"\n\n")
                if c.rta_bytes and now - c.rta_at < 1 and c.rta_bytes != last_rta:
                    last_rta = c.rta_bytes
                    self.wfile.write(b"event: r\ndata: " + base64.b64encode(last_rta) + b"\n\n")
                if now - last_status > 1:
                    last_status = now
                    send("status", {"status": statuses(), "link": None})
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return

    def _authed(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE and check_token(v):
                return True
        return False

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 500_000:
            self.close_connection = True
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def _client_ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            if path == "/api/auth":
                return self._json(200, {"authed": self._authed(), "mock": MOCK})
            if not self._authed():
                return self._json(401, {"error": "Login required"})
            if path == "/api/events":
                return self._events()
            if path == "/api/meta":
                return self._json(200, {"mock": MOCK})
            if path == "/api/console":
                return self._json(200, {"config": CFG["console"], "status": statuses(), "select": CFG.get("select")})
            if path == "/api/meter":
                c = CONS["A"]
                return self._json(200, {"cfg": c.meter_cfg, "default": sq.METER_DEFAULT, "stats": c.udp_stats,
                                        "port": c.usock.getsockname()[1] if c.usock else None, "capture": CAPTURE.is_file()})
            if path == "/api/meter/capture":
                if not CAPTURE.is_file():
                    return self._json(404, {"error": "No recording yet"})
                b = CAPTURE.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Disposition", 'attachment; filename="sq-meter-capture.json"')
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            return self._json(404, {"error": "Not found"})
        self._static(path)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        f = (PUBLIC / path.lstrip("/")).resolve()
        if not str(f).startswith(str(PUBLIC.resolve())) or not f.is_file():
            f = PUBLIC / "index.html"
        b = f.read_bytes()
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        if f.suffix == ".js":
            ctype = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if self.headers.get("X-Requested-With") != "x32r":  # CSRF guard
            return self._json(403, {"error": "Bad request"})
        if path == "/api/login":
            if not rate_ok(self._client_ip()):
                return self._json(429, {"error": "Too many tries. Wait one minute."})
            if not hmac.compare_digest(str(body.get("password", "")).encode(), PASSWORD.encode()):
                return self._json(401, {"error": "Wrong password"})
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            ck = f"{COOKIE}={make_token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DAYS * 86400}{secure}"
            return self._json(200, {"ok": True}, {"Set-Cookie": ck})
        if path == "/api/logout":
            return self._json(200, {"ok": True}, {"Set-Cookie": f"{COOKIE}=; Path=/; Max-Age=0"})
        if not self._authed():
            return self._json(401, {"error": "Login required"})
        try:
            return self._post(path, body)
        except (ValueError, TypeError, KeyError):
            return self._json(400, {"error": "Bad request"})

    def _post(self, path, body):
        c = CONS["A"]
        if path == "/api/set":
            for p, v in body["sets"][:400]:
                if mixer.WRITE_OK.match(p) and isinstance(v, (int, float, str)):
                    c.write(p, v, "app")
            return self._json(200, {"ok": True})
        if path == "/api/refresh":
            c.refresh()
            return self._json(200, {"ok": True})
        if path == "/api/console":
            n = body.get("console") or {}
            old = CFG["console"]
            new = {"ip": str(n.get("ip", old.get("ip", ""))).strip()[:64], "name": str(n.get("name", old.get("name", "")))[:24],
                   "midiCh": max(1, min(16, int(n.get("midiCh", old.get("midiCh", 1))))), "native": bool(n.get("native", old.get("native", True)))}
            CFG["console"] = new
            if any(new[k] != old.get(k) for k in ("ip", "midiCh", "native")):
                setup_console()
            else:
                c.name = new["name"]
            save_cfg(CFG)
            return self._json(200, {"ok": True, "status": statuses()})
        if path == "/api/learn":
            return self._learn(c, body)
        if path == "/api/rta":  # the SQ RTA follows the channel selected on the console
            return self._json(200, {"ok": True})
        if path == "/api/meter":
            cfg = body.get("cfg")
            if cfg == "default":
                cfg = sq.METER_DEFAULT
            if not isinstance(cfg, dict) or not isinstance(cfg.get("map", []), list):
                return self._json(400, {"error": "Bad layout"})
            sq.decode_udp(b"\0" * 400, cfg, b"")  # raises on a bad layout
            CFG["meter"] = cfg
            save_cfg(CFG)
            c.meter_cfg = cfg
            return self._json(200, {"ok": True})
        if path == "/api/meter/record":
            secs = max(1.0, min(30.0, float(body.get("secs", 10))))
            pk = c.record(secs)
            DATA.mkdir(parents=True, exist_ok=True)
            CAPTURE.write_text(json.dumps({"note": str(body.get("note", ""))[:500], "time": time.time(), "secs": secs,
                                           "packets": pk}))
            return self._json(200, {"ok": True, "packets": len(pk)})
        if path == "/api/sim/desk" and SIM:
            if "sel" in body:
                SIM.press_sel(int(body["sel"]))
            else:
                SIM.desk(str(body["path"]), body["value"])
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "Not found"})

    def _learn(self, c, body):
        """Learn the console's select message: the user presses Sel on inputs 1, 2 and 3, one per step."""
        step = body.get("step")
        if step == "clear":
            CFG["select"] = None
            save_cfg(CFG)
            c.sel_pat, c.caps["selLearned"] = None, False
            return self._json(200, {"ok": True, "msg": "Select message cleared"})
        step = int(step)
        if not 1 <= step <= 3:
            return self._json(400, {"error": "Bad step"})
        if not c.native_ok:
            return self._json(409, {"error": "The native connection (TCP 51326) is not up."})
        if learn["busy"]:
            return self._json(409, {"error": "Learn is running"})
        learn["busy"] = True
        try:
            learn["caps"][step] = c.capture_for(float(body.get("secs", 3)))
        finally:
            learn["busy"] = False
        if step < 3:
            return self._json(200, {"ok": True, "frames": len(learn["caps"][step])})
        if len(learn["caps"]) < 3:
            return self._json(409, {"error": "Do steps 1 and 2 first"})
        pat = sq.learn_pattern([learn["caps"][i] for i in (1, 2, 3)])
        learn["caps"] = {}
        if not pat:
            return self._json(422, {"error": "No select message found. Press Sel once per step, on inputs 1, 2 and 3."})
        CFG["select"] = pat
        save_cfg(CFG)
        c.sel_pat, c.caps["selLearned"] = pat, True
        return self._json(200, {"ok": True, "msg": "Select learned", "pattern": pat})


if __name__ == "__main__":
    print(f"MixDeck SQ on :{PORT}  mock={MOCK}", flush=True)
    make_server(PORT).serve_forever()
