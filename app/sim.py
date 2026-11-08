"""SQ simulator for SQ_MOCK=1 and tests. It speaks the same two protocols as the driver (app/sq.py).
The select message here is made up: the real one is learned from the console."""
import math
import random
import socket
import struct
import threading
import time

import sq

NAMES = ["Kick", "Snare", "HiHat", "Tom 1", "Tom 2", "OH L", "OH R", "Bass", "Gtr 1", "Gtr 2", "Keys L", "Keys R",
         "Vox 1", "Vox 2", "Vox 3", "Acous", "Track", "Click"]


def select_frame(b3):  # simulated format
    return sq.wire(0x08, bytes([0x18, 0x18, 0x21, 0, b3, 0, 0]))


def native_frames(c):
    """Frames from a socket, as the driver splits them."""
    return sq.SQ._frames(type("X", (), {"stopped": False})(), c)


class SQSim:
    def __init__(self):
        self.midi = {}
        for path, (p, k) in sq.MAP.items():
            self.midi[p] = {"lvl": 0, "on": 0, "bool": 0 if path.startswith("/config/mute/") else 1, "pan": 8191}[k]
        for i in range(len(NAMES)):
            self.midi[sq.MAP[f"/ch/{i + 1:02d}/mix/fader"][0]] = sq.lvl_out(.6 + random.random() * .15)
        for p in ("/main/st/mix/fader", "/bus/01/mix/fader", "/bus/02/mix/fader"):
            self.midi[sq.MAP[p][0]] = sq.lvl_out(.75)
        self.native = {}
        self.names = {b3: "" for b3 in sq.B3}
        for i, n in enumerate(NAMES):
            self.names[i] = n[:6]
        self.names.update({0x58: "Wedge1", 0x59: "Wedge2", 0x5A: "IEM 1", 0x40: "Reverb", 0x68: "Main"})
        self.mclients, self.nclients = [], []
        self.received = []
        self.ms, self.mport = self._listen(self._midi_client)
        self.ns, self.nport = self._listen(self._native_client)
        self.udp_to = None
        self.env = [random.random() for _ in range(48)]
        threading.Thread(target=self._noise, daemon=True).start()
        threading.Thread(target=self._meters, daemon=True).start()

    def _meters(self):
        """Meter and RTA packets in the layout the driver guesses (METER_DEFAULT)."""
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        w = lambda vals: sq.wire(0x10, struct.pack(f"<{len(vals)}H", *(sq.db_w(max(-127, min(127, v))) for v in vals)))  # noqa: E731
        t = 0
        while True:
            time.sleep(0.05)
            t += 1
            if not self.udp_to:
                continue
            ins = []
            for i in range(48):
                self.env[i] = max(0.0, self.env[i] * 0.86)
                if i < len(NAMES) and random.random() < (0.15 if i < 8 else 0.05):
                    self.env[i] = random.random() * .9 + .1
                ins.append(-80 + 75 * self.env[i] if i < len(NAMES) else -90)
            fxr = [-30 + 5 * math.sin(t / 9)] * 8
            aux = [max(ins[:8]) - 6 - a for a in range(12)] + [-40] * 4
            mtx = [-90] * 3
            lr = [max(ins) - 4, max(ins) - 5]
            gate = [0 if v > -45 else -40 for v in ins]
            comp = [-max(0, v + 20) * .5 for v in ins] + [-max(0, a + 15) * .3 for a in aux[:12]] + [-max(0, lr[0] + 10) * .4]
            try:
                u.sendto(w(ins + fxr + aux + mtx + lr + gate + comp), self.udp_to)
                if t % 2 == 0:
                    bands = [-30 - abs(i - 12) * 1.5 - random.random() * 6 + (max(ins) + 30) * .5 for i in range(31)]
                    u.sendto(w(bands), self.udp_to)
            except OSError:
                pass

    def _listen(self, fn):
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        s.listen(4)

        def acc():
            while True:
                c, _ = s.accept()
                threading.Thread(target=fn, args=(c,), daemon=True).start()
        threading.Thread(target=acc, daemon=True).start()
        return s, s.getsockname()[1]

    # ---- MIDI ----
    def _midi_client(self, c):
        self.mclients.append(c)

        def ev(kind, p, v):
            if kind == "set":
                self.midi[p] = v
            elif kind == "get" and p in self.midi:
                c.sendall(sq.nrpn_set(0, p, self.midi[p]))
        parser = sq.NRPN(0, ev)
        while True:
            try:
                d = c.recv(65536)
            except OSError:
                break
            if not d:
                break
            parser.feed(d)
        self.mclients.remove(c)

    def desk_midi(self, path, value):
        """A move on the console surface."""
        p, k = sq.MAP[path]
        self.midi[p] = sq.ENC[k](value)
        for c in list(self.mclients):
            try:
                c.sendall(sq.nrpn_set(0, p, self.midi[p]))
            except OSError:
                pass

    # ---- native ----
    def _paramdata(self):
        d = bytearray(sq.PARAMDATA_LEN)
        for b3, n in self.names.items():
            o = sq.BLK(b3)
            d[o:o + 16] = n.encode()[:16].ljust(16, b"\0")
        for i in range(len(NAMES)):
            o = sq.BLK(i)
            struct.pack_into("<H", d, o + 84, sq.hz_w(80 + i * 5))
            d[o + 86], d[o + 87], d[o + 121], d[o + 173], d[o + 302] = 1, i > 0, i < 7, 1, i % 3 != 2
            struct.pack_into("<H", d, o + 98, sq.db_w(-40))
            struct.pack_into("<H", d, o + 100, sq.db_w(40))
            for off in (124, 130, 136, 142):
                struct.pack_into("<H", d, o + off, sq.db_w(random.choice((-4, -2, 0, 2, 3))))
            struct.pack_into("<H", d, o + 126, sq.hz_w(100))
            struct.pack_into("<H", d, o + 324, sq.db_w(0))
            struct.pack_into("<H", d, sq.GAIN_AT(i), sq.db_w(20 + i))
        return bytes(d)

    def _native_client(self, c):
        replies = {0x00: sq.wire(0x00, struct.pack("<H", 50000)), 0x01: sq.wire(0x02, bytes([5, 1, 6, 0, 0x34, 0x12])),
                   0x14: sq.wire(0x15, bytes(720)), 0x0B: sq.wire(0x0C, b"\x01\x00"), 0x0A: sq.wire(0x04, self._paramdata())}
        c.settimeout(5)
        self.nclients.append(c)
        try:
            for f in native_frames(c):
                if f is None:
                    continue
                self.received.append(f)
                if f[0] == 0x7F and f[1] == 0x00 and len(f) == 8:
                    self.udp_to = (c.getpeername()[0], struct.unpack_from("<H", f, 6)[0])
                if f[0] == 0x7F:
                    if f[1] in replies:
                        c.sendall(replies[f[1]])
                    if f[1] == 0x08 and len(f) == 20:
                        self.names[f[10]] = f[13:20].split(b"\0")[0].decode()
                else:
                    self.native[(f[2], f[3], f[4])] = f[6] | (f[7] << 8)
        except OSError:
            pass
        if c in self.nclients:
            self.nclients.remove(c)

    def _nsend(self, b):
        for c in list(self.nclients):
            try:
                c.sendall(b)
            except OSError:
                pass

    def desk_native(self, path, value):
        b1, cat, reg, b3, mod, to, _ = sq.NMAP[path]
        w = to(value)
        self.native[(cat, reg, b3)] = w
        self._nsend(bytes([0xF7, b1, cat, reg, b3, mod, w & 0xFF, w >> 8]))

    def desk(self, path, value):
        (self.desk_midi if path in sq.MAP else self.desk_native)(path, value)

    def press_sel(self, b3):
        """Sel key on the console."""
        self._nsend(select_frame(b3))

    def _noise(self):
        n = 0
        while True:  # the real console also sends frames nobody has decoded yet
            time.sleep(0.7)
            n = (n + 1) & 0xFF
            self._nsend(sq.wire(0x08, bytes([0x30, n, 0x02, 0, 0, 0, random.randrange(256), 0])))
