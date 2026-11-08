"""Shared console base. All drivers expose the same X32-shaped parameter paths, so the UI and link engine are generic."""
import collections
import threading


def fader_to_db(f):
    if f <= 0:
        return -999.0
    if f >= 0.5:
        return f * 40 - 30
    if f >= 0.25:
        return f * 80 - 50
    if f >= 0.0625:
        return f * 160 - 70
    return f * 480 - 90


def db_to_fader(d):
    if d <= -90:
        return 0.0
    if d >= -10:
        f = (d + 30) / 40
    elif d >= -30:
        f = (d + 50) / 80
    elif d >= -60:
        f = (d + 70) / 160
    else:
        f = (d + 90) / 480
    return max(0.0, min(1.0, f))


class Console:
    kind = ""
    caps = {}

    def __init__(self, slot, ip, name=""):
        self.slot = slot
        self.ip = ip
        self.name = name
        self.state = {}
        self.lock = threading.Lock()
        self.seq = 0
        self.log = collections.deque(maxlen=30000)
        self.listeners = []          # fn(console, path, value, origin)
        self.info = ""
        self.routing_paths = set()
        self.routing_version = 0
        self.total_reads = 0
        self.stopped = False
        self.reading = False
        self.meter_clients = 0
        self.meter_bytes = b""
        self.rta_bytes = b""

    # -- to implement --
    connected = False

    def write(self, path, value, origin="app"):
        raise NotImplementedError

    def refresh(self):
        pass

    def read_paths(self, paths):
        pass

    def scene(self, action, slot=0, name="", note=""):
        return False, "Not supported"

    def stop(self):
        self.stopped = True

    # -- shared --
    def _store(self, path, value, origin="desk"):
        with self.lock:
            old = self.state.get(path)
            changed = old != value
            self.state[path] = value
            if origin == "desk" and (old is None or self.reading):
                origin = "read"  # a console read is not a move on the surface: the link must not copy it
            if changed:
                self.seq += 1
                self.log.append((self.seq, path, value))
                if path in self.routing_paths:
                    self.routing_version += 1
        if changed:
            for fn in list(self.listeners):
                try:
                    fn(self, path, value, origin)
                except Exception as e:
                    print("listener error", e, flush=True)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def since(self, seq):
        """Changes after seq as {path: value}, and the new seq. None if the log no longer reaches back."""
        with self.lock:
            if self.log and seq < self.log[0][0] - 1:
                return None, self.seq
            out = {}
            for s, p, v in reversed(self.log):
                if s <= seq:
                    break
                out.setdefault(p, v)
            return out, self.seq

    def bump(self):
        self.routing_version += 1

    def progress(self):
        if not self.total_reads:
            return 1.0
        return min(1.0, len(self.state) / self.total_reads)

    def status(self):
        return {"slot": self.slot, "kind": self.kind, "name": self.name, "ip": self.ip, "connected": self.connected,
                "info": self.info, "progress": round(self.progress(), 3), "caps": self.caps}
