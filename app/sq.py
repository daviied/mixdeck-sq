"""Allen & Heath SQ-5 / SQ-6 / SQ-7 driver.

Two connections, both mapped onto the X32-shaped paths the UI uses:
- MIDI over TCP 51325. Source: Allen & Heath "SQ MIDI Protocol Issue 5" (firmware 1.5.0 or later).
  Levels, mutes, pan/balance, assigns. Set "NRPN Fader Law" on the SQ to Linear Taper (the default).
- Native TCP 51326 ("MixPad protocol"). Not published by Allen & Heath. The frames come from
  github.com/hrueger/allen-heath-sq-tools (MIT), reverse engineered from SQ-5 firmware 1.6 traffic.
  Names, preamp, HPF, gate, PEQ, compressor, delay, insert, and the console channel select (learned).
Not yet tested on hardware.
"""
import math
import socket
import struct
import threading
import time

from console import Console, db_to_fader, fader_to_db

MIDI_PORT = 51325
NATIVE_PORT = 51326
N_IN, N_AUX, N_FXS, N_FXR, N_MTX, N_DCA, N_MG = 48, 12, 4, 8, 3, 8, 8


def P(msb, lsb):
    return (msb << 7) | lsb


def _c(n):
    return max(0.0, min(1.0, n))


def lin(a, b):
    return (lambda n: a + (b - a) * n), (lambda v: _c((v - a) / (b - a)))


def log(a, b):
    r = math.log(b / a)
    return (lambda n: a * math.exp(r * n)), (lambda v: _c(math.log(max(v, 1e-9) / a) / r))


# Value scales. They must match SCL in public/js/core.js.
SC = {"ha": lin(0, 60), "trim": lin(-24, 24), "hpf": log(20, 2000), "delay": lin(0, 341), "gthr": lin(-72, 18),
      "grange": lin(0, 60), "att": log(.05, 300), "hold": log(10, 5000), "rel": log(10, 1000), "thr": lin(-46, 18),
      "mgain": lin(0, 18), "f": log(20, 20000), "g": lin(-15, 15), "q": log(14.4, .67)}
RATIO_CODES = [11, 12, 13, 14, 17, 18, 19, 20, 22, 24, 26, 27, 29, 30, 32, 33, 35, 36, 38, 39]  # 1.5:1 ... 40:1


# ---------------- MIDI (official) ----------------
def lvl_out(f):
    return 0 if f <= 0 else max(1, min(16383, round(15196 + 118.7 * fader_to_db(f))))  # linear taper: 0 dB = 76 5C


def lvl_in(v):
    return 0.0 if v <= 0 else db_to_fader((v - 15196) / 118.7)


ENC = {"lvl": lvl_out, "on": lambda v: 0 if v else 1, "bool": lambda v: 1 if v else 0, "pan": lambda p: round(_c(p) * 16383)}
DEC = {"lvl": lvl_in, "on": lambda v: 0 if v else 1, "bool": lambda v: 1 if v else 0, "pan": lambda v: v / 16383}


def build_midi_map():
    """path -> (parameter number, kind). From the reference tables of the protocol document."""
    m = {}
    for i in range(N_IN):
        b = f"/ch/{i + 1:02d}"
        m[f"{b}/mix/fader"] = (P(0x40, 0) + i, "lvl")
        m[f"{b}/mix/on"] = (P(0, 0) + i, "on")
        m[f"{b}/mix/pan"] = (P(0x50, 0) + i, "pan")
        m[f"{b}/mix/st"] = (P(0x60, 0) + i, "bool")
        for a in range(N_AUX):
            s = f"{b}/mix/{a + 1:02d}"
            m[s + "/level"] = (P(0x40, 0x44) + i * 12 + a, "lvl")
            m[s + "/on"] = (P(0x60, 0x44) + i * 12 + a, "bool")
            m[s + "/pan"] = (P(0x50, 0x44) + i * 12 + a, "pan")
        for x in range(N_FXS):  # FX sends 1-4 are "buses" 13-16 here
            s = f"{b}/mix/{13 + x:02d}"
            m[s + "/level"] = (P(0x4C, 0x14) + i * 4 + x, "lvl")
            m[s + "/on"] = (P(0x6C, 0x14) + i * 4 + x, "bool")
    for f in range(N_FXR):
        b = f"/fxrtn/{f + 1:02d}"
        m[f"{b}/mix/fader"] = (P(0x40, 0x3C) + f, "lvl")
        m[f"{b}/mix/on"] = (P(0, 0x3C) + f, "on")
        m[f"{b}/mix/pan"] = (P(0x50, 0x3C) + f, "pan")
        m[f"{b}/mix/st"] = (P(0x60, 0x3C) + f, "bool")
        for a in range(N_AUX):
            s = f"{b}/mix/{a + 1:02d}"
            m[s + "/level"] = (P(0x46, 0x14) + f * 12 + a, "lvl")
            m[s + "/on"] = (P(0x66, 0x14) + f * 12 + a, "bool")
            m[s + "/pan"] = (P(0x56, 0x14) + f * 12 + a, "pan")
        for x in range(N_FXS):
            s = f"{b}/mix/{13 + x:02d}"
            m[s + "/level"] = (P(0x4E, 0x04) + f * 4 + x, "lvl")
            m[s + "/on"] = (P(0x6E, 0x04) + f * 4 + x, "bool")
    for a in range(N_AUX):
        b = f"/bus/{a + 1:02d}"
        m[f"{b}/mix/fader"] = (P(0x4F, 0x01) + a, "lvl")
        m[f"{b}/mix/on"] = (P(0, 0x45) + a, "on")
        m[f"{b}/mix/pan"] = (P(0x5F, 0x01) + a, "pan")
        for t in range(N_MTX):
            s = f"{b}/mix/{t + 1:02d}"
            m[s + "/level"] = (P(0x4E, 0x27) + a * 3 + t, "lvl")
            m[s + "/on"] = (P(0x6E, 0x27) + a * 3 + t, "bool")
            m[s + "/pan"] = (P(0x5E, 0x27) + a * 3 + t, "pan")
    for x in range(N_FXS):
        b = f"/bus/{13 + x:02d}"
        m[f"{b}/mix/fader"] = (P(0x4F, 0x0D) + x, "lvl")
        m[f"{b}/mix/on"] = (P(0, 0x51) + x, "on")
    for t in range(N_MTX):
        b = f"/mtx/{t + 1:02d}"
        m[f"{b}/mix/fader"] = (P(0x4F, 0x11) + t, "lvl")
        m[f"{b}/mix/on"] = (P(0, 0x55) + t, "on")
        m[f"{b}/mix/pan"] = (P(0x5F, 0x11) + t, "pan")
    b = "/main/st"
    m[f"{b}/mix/fader"] = (P(0x4F, 0), "lvl")
    m[f"{b}/mix/on"] = (P(0, 0x44), "on")
    m[f"{b}/mix/pan"] = (P(0x5F, 0), "pan")
    for t in range(N_MTX):
        s = f"{b}/mix/{t + 1:02d}"
        m[s + "/level"] = (P(0x4E, 0x24) + t, "lvl")
        m[s + "/on"] = (P(0x6E, 0x24) + t, "bool")
        m[s + "/pan"] = (P(0x5E, 0x24) + t, "pan")
    for d in range(N_DCA):
        m[f"/dca/{d + 1}/fader"] = (P(0x4F, 0x20) + d, "lvl")
        m[f"/dca/{d + 1}/on"] = (P(2, 0) + d, "on")
    for g in range(N_MG):
        m[f"/config/mute/{g + 1}"] = (P(4, 0) + g, "bool")
    return m


MAP = build_midi_map()
REV = {p: (path, k) for path, (p, k) in MAP.items()}


class NRPN:
    """MIDI byte stream -> ("set", param, value) / ("get", param) / ("inc"|"dec", param). Running status is allowed."""

    def __init__(self, ch, fn):
        self.ch, self.fn = ch, fn
        self.status = None
        self.data = []
        self.sysex = False
        self.msb = self.lsb = self.vc = None

    def feed(self, data):
        for b in data:
            if b & 0x80:
                if b >= 0xF8:
                    continue
                self.sysex = b == 0xF0
                self.status = None if b >= 0xF0 else b
                self.data = []
                continue
            if self.sysex or self.status is None:
                continue
            self.data.append(b)
            hi = self.status & 0xF0
            if len(self.data) < (1 if hi in (0xC0, 0xD0) else 2):
                continue
            d, self.data = self.data, []
            if hi == 0xB0 and (self.status & 0x0F) == self.ch:
                self._cc(d[0], d[1])

    def _cc(self, cc, v):
        if cc == 0x63:
            self.msb, self.vc = v, None
        elif cc == 0x62:
            self.lsb, self.vc = v, None
        elif self.msb is None or self.lsb is None:
            return
        elif cc == 0x06:
            self.vc = v
        elif cc == 0x26 and self.vc is not None:
            self.fn("set", P(self.msb, self.lsb), (self.vc << 7) | v)
            self.vc = None
        elif cc == 0x60:
            self.fn("get" if v == 0x7F else "inc", P(self.msb, self.lsb), 0)
        elif cc == 0x61:
            self.fn("dec", P(self.msb, self.lsb), 0)


def nrpn_set(ch, param, v):
    s = 0xB0 | ch
    return bytes([s, 0x63, param >> 7, s, 0x62, param & 0x7F, s, 0x06, (v >> 7) & 0x7F, s, 0x26, v & 0x7F])


def nrpn_get(ch, param):
    s = 0xB0 | ch
    return bytes([s, 0x63, param >> 7, s, 0x62, param & 0x7F, s, 0x60, 0x7F])


# ---------------- native (reverse engineered) ----------------
def wire(sub, payload=b""):
    return bytes([0x7F, sub]) + struct.pack("<I", len(payload)) + payload


def db_w(d):
    return round(0x8000 + d * 256) & 0xFFFF


def w_db(w):
    return (w - 0x8000) / 256


def hz_w(f):
    return max(0, min(0xFFFF, round(-9206 + 15308 * math.log10(max(f, 1)))))


def w_hz(w):
    return 10 ** ((w + 9206) / 15308)


def ms_w(ms):
    return max(0, min(0xFFFF, round(2604.3 * math.log(max(.001, ms)) + 17917)))


def w_ms(w):
    return math.exp((w - 17917) / 2604.3)


def q_w(q):  # Q -> PEQ width in octaves, sent as width * 8
    width = 2 / math.log(2) * math.asinh(1 / (2 * q))
    return max(1, min(16, round(width * 8)))


def w_q(w):
    return 1 / (2 * math.sinh(math.log(2) * max(1, w) / 16))


def ratio_in(w):
    return min(range(len(RATIO_CODES)), key=lambda i: abs(RATIO_CODES[i] - w))


SHAPES = {1: {0: 2, 6: 1, 11: 0}, 4: {0: 2, 6: 4, 11: 5}}  # raw PEQ shape -> X32 EQ type. HF values are a guess.


def enc(kind, key=None, band=None):
    """(to wire, from wire) for a UI value 0..1 or an index."""
    if kind == "bool":
        return (lambda v: 1 if v else 0), (lambda w: 1 if w else 0)
    if kind == "db":
        f, i = SC[key]
        return (lambda n: db_w(f(n))), (lambda w: i(w_db(w)))
    if kind == "hz":
        f, i = SC[key]
        return (lambda n: hz_w(f(n))), (lambda w: i(w_hz(w)))
    if kind == "ms":
        f, i = SC[key]
        return (lambda n: ms_w(f(n))), (lambda w: i(w_ms(w)))
    if kind == "q":
        f, i = SC["q"]
        return (lambda n: q_w(f(n))), (lambda w: i(w_q(w)))
    if kind == "slope":
        return (lambda v: max(1, min(3, int(v) + 1))), (lambda w: max(0, min(2, w - 1)))
    if kind == "delay":
        f, i = SC["delay"]
        return (lambda n: round(f(n) * 96)), (lambda w: i(w / 96))
    if kind == "ratio":
        return (lambda v: RATIO_CODES[max(0, min(len(RATIO_CODES) - 1, int(v)))]), ratio_in
    if kind == "shape":
        fw = SHAPES[band]
        back = {t: r for r, t in fw.items()}
        return (lambda t: back.get(int(t), 0)), (lambda w: fw.get(w, 2))
    raise ValueError(kind)


# (path suffix, write byte 1, category, register, modifier, kind, scale key / band)
CH_PARAMS = [
    ("/preamp/trim", 0x38, 0x0C, 0x0F, 0x00, "db", "trim"),
    ("/preamp/invert", 0x38, 0x0C, 0x10, 0x00, "bool", None),
    ("/preamp/hpon", 0x08, 0x0E, 0x0C, 0x00, "bool", None),
    ("/preamp/hpf", 0x08, 0x0E, 0x0D, 0x00, "hz", "hpf"),
    ("/preamp/hpslope", 0x38, 0x0E, 0x0E, 0x00, "slope", None),
    ("/gate/on", 0x08, 0x0F, 0x0C, 0x00, "bool", None),
    ("/gate/thr", 0x08, 0x0F, 0x0E, 0x00, "db", "gthr"),
    ("/gate/range", 0x38, 0x0F, 0x0F, 0x00, "db", "grange"),
    ("/gate/attack", 0x38, 0x0F, 0x10, 0x00, "ms", "att"),
    ("/gate/release", 0x38, 0x0F, 0x11, 0x00, "ms", "rel"),
    ("/gate/hold", 0x38, 0x0F, 0x12, 0x00, "ms", "hold"),
    ("/delay/on", 0x38, 0x14, 0x0C, 0x00, "bool", None),
    ("/delay/time", 0x38, 0x14, 0x0D, 0x00, "delay", None),
    ("/insert/on", 0x38, 0x10, 0x0C, 0x00, "bool", None),
]
PROC_PARAMS = [  # inputs, and (not confirmed) mixes and LR
    ("/dyn/on", 0x08, 0x13, 0x0C, 0x00, "bool", None),
    ("/dyn/thr", 0x38, 0x13, 0x0E, 0x00, "db", "thr"),
    ("/dyn/ratio", 0x38, 0x13, 0x0F, 0x00, "ratio", None),
    ("/dyn/mgain", 0x38, 0x13, 0x10, 0x00, "db", "mgain"),
    ("/eq/on", 0x38, 0x11, 0x1A, 0x00, "bool", None),
]
for _b, _r in enumerate((0x0C, 0x10, 0x13, 0x16), 1):
    PROC_PARAMS += [(f"/eq/{_b}/g", 0x38, 0x11, _r, 0x00, "db", "g"), (f"/eq/{_b}/f", 0x38, 0x11, _r + 1, 0x00, "hz", "f"),
                    (f"/eq/{_b}/q", 0x38, 0x11, _r + 2, 0x00, "q", None)]
PROC_PARAMS += [("/eq/1/type", 0x38, 0x11, 0x0F, 0x00, "shape", 1), ("/eq/4/type", 0x38, 0x11, 0x19, 0x00, "shape", 4)]
HA_PARAMS = [("gain", 0x08, 0x0C, 0x0C, 0x01, "db", "ha"), ("phantom", 0x38, 0x0C, 0x0D, 0x01, "bool", None)]


def strips_b3():
    """(native channel address, base path, kind)."""
    out = [(i, f"/ch/{i + 1:02d}", "ch") for i in range(N_IN)]
    out += [(0x40 + f, f"/fxrtn/{f + 1:02d}", "fx") for f in range(N_FXR)]
    out += [(0x58 + a, f"/bus/{a + 1:02d}", "bus") for a in range(N_AUX)]
    return out + [(0x68, "/main/st", "st")]


B3 = {b3: base for b3, base, _ in strips_b3()}


def build_native_map():
    """path -> (b1, cat, reg, b3, mod, to wire, from wire)."""
    m = {}
    for b3, base, k in strips_b3():
        rows = (CH_PARAMS + PROC_PARAMS) if k == "ch" else PROC_PARAMS if k in ("bus", "st") else []
        for suf, b1, cat, reg, mod, kind, key in rows:
            to, frm = enc(kind, key if kind != "shape" else None, key if kind == "shape" else None)
            m[base + suf] = (b1, cat, reg, b3, mod, to, frm)
        if k == "ch":
            for suf, b1, cat, reg, mod, kind, key in HA_PARAMS:
                to, frm = enc(kind, key)
                m[f"/headamp/{b3:03d}/{suf}"] = (b1, cat, reg, b3, mod, to, frm)
    return m


NMAP = build_native_map()
NREV = {(cat, reg, b3): (p, frm) for p, (_, cat, reg, b3, _, _, frm) in NMAP.items()}

PARAMDATA_LEN = 97376  # SQ-5 firmware 1.6 layout
BLK = lambda b3: 884 + b3 * 336  # noqa: E731
# Offsets in a channel block (from hrueger/allen-heath-sq-tools). (path suffix, offset, size, from wire)
INIT = [("/preamp/hpf", 84, 2, NMAP["/ch/01/preamp/hpf"][6]), ("/preamp/hpslope", 86, 1, enc("slope")[1]),
        ("/preamp/hpon", 87, 1, enc("bool")[1]), ("/gate/attack", 92, 2, NMAP["/ch/01/gate/attack"][6]),
        ("/gate/release", 94, 2, NMAP["/ch/01/gate/release"][6]), ("/gate/hold", 96, 2, NMAP["/ch/01/gate/hold"][6]),
        ("/gate/thr", 98, 2, NMAP["/ch/01/gate/thr"][6]), ("/gate/range", 100, 2, NMAP["/ch/01/gate/range"][6]),
        ("/gate/on", 121, 1, enc("bool")[1]), ("/eq/on", 173, 1, enc("bool")[1]),
        ("/eq/1/g", 124, 2, NMAP["/ch/01/eq/1/g"][6]), ("/eq/1/f", 126, 2, NMAP["/ch/01/eq/1/f"][6]),
        ("/eq/2/g", 130, 2, NMAP["/ch/01/eq/2/g"][6]), ("/eq/3/g", 136, 2, NMAP["/ch/01/eq/3/g"][6]),
        ("/eq/4/g", 142, 2, NMAP["/ch/01/eq/4/g"][6]), ("/dyn/on", 302, 1, enc("bool")[1]),
        ("/delay/time", 304, 2, NMAP["/ch/01/delay/time"][6]), ("/delay/on", 306, 1, enc("bool")[1]),
        ("/preamp/trim", 324, 2, NMAP["/ch/01/preamp/trim"][6])]
GAIN_AT = lambda b3: 80028 + b3 * 336  # noqa: E731


def parse_paramdata(d):
    """Full state dump -> {path: value}."""
    out = {}
    if len(d) != PARAMDATA_LEN:
        return out
    for b3, base, k in strips_b3():
        o = BLK(b3)
        out[base + "/config/name"] = d[o:o + 16].split(b"\0")[0].decode("latin-1", "replace").strip()
        if k != "ch":
            continue
        for suf, off, size, frm in INIT:
            w = d[o + off] if size == 1 else struct.unpack_from("<H", d, o + off)[0]
            out[base + suf] = frm(w)
        out[base + "/preamp/invert"] = d[o + 332] & 1
        out[f"/headamp/{b3:03d}/gain"] = NMAP["/headamp/000/gain"][6](struct.unpack_from("<H", d, GAIN_AT(b3))[0])
    return out


def name_frames(b3, name):
    nm = name.encode("ascii", "replace")[:6].ljust(7, b"\0")
    return [wire(0x08, bytes([0x18, 0x18, msg, 0, b3, 0, 0]) + nm) for msg in (0x0C, 0x07)]


# ---------------- channel select: learned from the console ----------------
def learn_pattern(caps):
    """caps: frames captured while Sel was pressed on inputs 1, 2 and 3. A frame where one byte steps 1, 2, 3
    and the rest stays the same (a few bytes may change) is the select message."""
    def groups(c):
        g = {}
        for f in set(c):
            if 6 <= len(f) <= 96:
                g.setdefault((len(f), f[:2]), []).append(f)
        return g
    g1, g2, g3 = (groups(c) for c in caps)
    best = None
    for key, l1 in g1.items():
        for f1 in l1:
            for f2 in g2.get(key, []):
                steps = [p for p in range(len(f1)) if f2[p] == f1[p] + 1]
                if not steps:
                    continue
                for f3 in g3.get(key, []):
                    st = [p for p in steps if f3[p] == f1[p] + 2]
                    if len(st) != 1:
                        continue
                    p = st[0]
                    wild = [q for q in range(len(f1)) if q != p and not f1[q] == f2[q] == f3[q]]
                    if len(wild) > 4 or (best and len(wild) >= best[0]):
                        continue
                    fixed = [[q, f1[q]] for q in range(len(f1)) if q != p and q not in wild]
                    pat = {"len": len(f1), "idx": p, "base": f1[p], "fixed": fixed}
                    # A counter also steps. One press gives one value in each capture.
                    if all(len({f[p] for f in c if _fits(pat, f)}) == 1 for c in caps):
                        best = (len(wild), pat)
    return best[1] if best else None


def _fits(pat, f):
    return len(f) == pat["len"] and all(f[q] == v for q, v in pat["fixed"])


def match_select(pat, f):
    if not pat or not _fits(pat, f):
        return None
    n = f[pat["idx"]] - pat["base"]
    if pat["base"] == 0:  # the byte is the native channel address
        return B3.get(f[pat["idx"]])
    return f"/ch/{n + 1:02d}" if 0 <= n < N_IN else None


# ---------------- meters and RTA (UDP) ----------------
# The SQ sends meters over UDP to the port the client gives in the handshake. The layout is NOT known:
# the default below is a guess. Settings has a JSON editor for it and a recorder for raw packets.
# Our meter byte layout (what the UI reads; byte = (dB + 80) * 2.55):
#   0-47 inputs, 48-55 FX returns, 56-67 aux 1-12, 68-71 FX sends, 72-74 matrix, 75-76 LR,
#   77-124 input gate gain, 125-172 input comp gain, 173-184 aux comp gain, 185 LR comp gain.
METER_LEN = 186
METER_DEFAULT = {
    "header": "auto",      # auto: drop a 6-byte 7F header when there is one; or a number of bytes to drop
    "enc": "le16db",       # le16db: (w - 0x8000) / 256 dB | be16db | u8 (byte = (dB + 80) * 2.55) | f32 (linear)
    "minValues": 77,       # a packet with at least this many values is the meter packet
    "map": [[0, 0, 77, "lvl"], [77, 77, 48, "gain"], [125, 125, 61, "gain"]],  # [from, to, count, lvl|gain|gr]
    "rtaMin": 20, "rtaMax": 70,  # a packet with this many values is the RTA (dB per band, low to high)
}


def _values(pkt, cfg):
    h = cfg.get("header", "auto")
    if h == "auto":
        h = 6 if len(pkt) >= 6 and pkt[0] == 0x7F and struct.unpack_from("<I", pkt, 2)[0] == len(pkt) - 6 else 0
    d = pkt[int(h):]
    e = cfg.get("enc", "le16db")
    if e == "u8":
        return [b / 2.55 - 80 for b in d]
    if e == "f32":
        return [20 * math.log10(max(v, 1e-6)) for v in struct.unpack(f"<{len(d) // 4}f", d[:len(d) // 4 * 4])]
    fmt = "<" if e == "le16db" else ">"
    return [(w - 0x8000) / 256 for w in struct.unpack(f"{fmt}{len(d) // 2}H", d[:len(d) // 2 * 2])]


def _byte(db):
    return max(0, min(255, round((db + 80) * 2.55)))


def decode_udp(pkt, cfg, old):
    """-> ("m", meter bytes) | ("r", 100 RTA bytes) | None"""
    try:
        v = _values(pkt, cfg)
    except (struct.error, ValueError, TypeError):
        return None
    if len(v) >= cfg.get("minValues", 77):
        out = bytearray(old if len(old) == METER_LEN else bytes(METER_LEN))
        for src, dst, n, kind in cfg.get("map", []):
            for i in range(int(n)):
                if src + i < len(v) and 0 <= dst + i < METER_LEN:
                    x = v[src + i]
                    out[dst + i] = _byte(-abs(x) if kind == "gr" else x)
        return "m", bytes(out)
    if cfg.get("rtaMin", 20) <= len(v) <= cfg.get("rtaMax", 70):
        n = len(v)  # resample to the 100 bands the UI draws
        return "r", bytes(max(0, min(255, round((v[min(n - 1, i * n // 100)] + 96) / 96 * 255))) for i in range(100))
    return None


class SQ(Console):
    kind = "sq"

    def __init__(self, slot, ip, name="", midi_ch=0, native=True, select_pat=None, midi_port=MIDI_PORT, native_port=NATIVE_PORT,
                 meter_cfg=None, udp_port=0):
        super().__init__(slot, ip, name)
        self.meter_cfg = meter_cfg or METER_DEFAULT
        self.udp_port = udp_port
        self.rec = None
        self.udp_stats = {"packets": 0, "sizes": {}, "last": "", "meters": 0, "rta": 0}
        self.meter_at = self.rta_at = 0.0
        self.midi_ch, self.use_native, self.sel_pat = midi_ch, native, select_pat
        self.midi_port, self.native_port = midi_port, native_port
        self.msock = self.nsock = self.usock = None
        self.mtx_lock, self.ntx_lock = threading.Lock(), threading.Lock()
        self.midi_ok = self.native_ok = False
        self.got = set()
        self.capture = None
        self.native_note = ""
        self.caps = {"type": "sq", "ch": N_IN, "aux": 0, "fx": N_FXR, "bus": N_AUX + N_FXS, "auxN": N_AUX, "mtx": N_MTX,
                     "dca": N_DCA, "mgrp": N_MG, "mono": False, "full": False, "proc": native, "meters": native, "rta": native, "solo": False,
                     "nameLen": 6, "selLearned": bool(select_pat)}
        self._defaults()
        self.total_reads = len(MAP)
        threading.Thread(target=self._midi_run, daemon=True).start()
        if native:
            threading.Thread(target=self._native_run, daemon=True).start()

    def _defaults(self):
        s = self.state
        for p, (_, k) in MAP.items():
            s[p] = {"lvl": .0, "on": 1, "bool": 1 if p.endswith("/st") or "/mix/" in p else 0, "pan": .5}[k]
        for p in MAP:
            if p.endswith("/mix/fader") or p.endswith("/fader"):
                s[p] = .0
        for _, base, _ in strips_b3():
            s[base + "/config/name"] = ""
        for i in range(N_DCA):
            s[f"/dca/{i + 1}/config/name"] = ""
        for i in range(N_MTX):
            s[f"/mtx/{i + 1:02d}/config/name"] = ""
        if self.use_native:
            for p in NMAP:
                last = p.rsplit("/", 1)[1]
                if last == "f":
                    s[p] = (.2, .45, .65, .85)[int(p.split("/")[-2]) - 1]
                else:
                    s[p] = {"g": .5, "trim": .5, "q": .5, "type": 2, "hpf": .3, "thr": .7, "ratio": 7}.get(last, 0)
        s["/-stat/sel"] = "/ch/01"

    @property
    def connected(self):
        return self.midi_ok

    def progress(self):
        return 1.0 if not self.reading else min(1.0, len(self.got) / max(1, self.total_reads))

    def status(self):
        st = super().status()
        st["info"] = f"SQ at {self.ip} · MIDI {'ok' if self.midi_ok else 'not connected'} · " + (
            f"native {'ok' if self.native_ok else 'not connected'}{self.native_note}" if self.use_native else "native off")
        return st

    def stop(self):
        self.stopped = True
        for s in (self.msock, self.nsock, self.usock):
            try:
                s and s.close()
            except OSError:
                pass

    # ---- writes ----
    def write(self, path, value, origin="app"):
        e = MAP.get(path)
        if e:
            self._mtx(nrpn_set(self.midi_ch, e[0], ENC[e[1]](value)))
        elif path.endswith("/config/name") and isinstance(value, str):
            b3 = next((k for k, v in B3.items() if path == v + "/config/name"), None)
            if b3 is None or not self.native_ok:
                return
            value = value[:6]
            for f in name_frames(b3, value):
                self._ntx(f)
        else:
            n = NMAP.get(path)
            if not n or not self.native_ok:
                return
            b1, cat, reg, b3, mod, to, _ = n
            w = to(value) & 0xFFFF
            self._ntx(bytes([0xF7, b1, cat, reg, b3, mod, w & 0xFF, w >> 8]))
        self._store(path, value, origin)

    def scene(self, action, slot=0, name="", note=""):
        if action != "recall" or not 0 <= slot < 300:
            return False, "Not supported"
        c = self.midi_ch
        self._mtx(bytes([0xB0 | c, 0x00, slot // 128, 0xC0 | c, slot % 128]))
        threading.Timer(1.0, self.refresh).start()
        return True, f"Scene {slot + 1} recalled"

    def refresh(self):
        threading.Thread(target=self._read_all, daemon=True).start()

    # ---- MIDI connection ----
    def _mtx(self, b):
        s = self.msock
        if not s:
            return
        try:
            with self.mtx_lock:
                s.sendall(b)
        except OSError:
            self.midi_ok = False

    def _read_all(self):
        order = sorted(MAP, key=lambda p: ("/mix/0" in p or "/mix/1" in p))  # faders, mutes, pans first
        self.reading, self.got = True, set()
        try:
            for i, p in enumerate(order):
                if not self.midi_ok:
                    return
                self._mtx(nrpn_get(self.midi_ch, MAP[p][0]))
                if i % 8 == 7:
                    time.sleep(0.004)
            time.sleep(0.5)  # late replies are still part of the read
        finally:
            self.reading = False

    def _midi_ev(self, ev, param, val):
        if ev != "set":
            return
        e = REV.get(param)
        if not e:
            return
        path, k = e
        if self.reading:
            self.got.add(path)
        self._store(path, DEC[k](val), "desk")

    def _midi_run(self):
        while not self.stopped:
            if not self.ip:
                time.sleep(1)
                continue
            try:
                s = socket.create_connection((self.ip, self.midi_port), timeout=3)
                s.settimeout(1.0)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.msock, self.midi_ok = s, True
                parser = NRPN(self.midi_ch, self._midi_ev)
                self.refresh()
                while not self.stopped and self.midi_ok:
                    try:
                        d = s.recv(65536)
                    except socket.timeout:
                        continue
                    if not d:
                        break
                    parser.feed(d)
            except OSError:
                pass
            self.midi_ok = False
            try:
                self.msock and self.msock.close()
            except OSError:
                pass
            self.msock = None
            time.sleep(2)

    # ---- native connection ----
    def _ntx(self, b):
        s = self.nsock
        if not s:
            return
        try:
            with self.ntx_lock:
                s.sendall(b)
        except OSError:
            self.native_ok = False

    def _frames(self, s):
        buf = b""
        while not self.stopped:
            try:
                d = s.recv(262144)
            except socket.timeout:
                yield None
                continue
            if not d:
                return
            buf += d
            while buf:
                if buf[0] == 0xF7:
                    if len(buf) < 8:
                        break
                    yield buf[:8]
                    buf = buf[8:]
                elif buf[0] == 0x7F:
                    if len(buf) < 6:
                        break
                    n = struct.unpack_from("<I", buf, 2)[0]
                    if len(buf) < 6 + n:
                        break
                    yield buf[:6 + n]
                    buf = buf[6 + n:]
                else:  # lost sync: skip to the next frame marker
                    i = min([x for x in (buf.find(b"\x7f"), buf.find(b"\xf7")) if x > 0] or [len(buf)])
                    buf = buf[i:]

    def _handshake(self, s, frames):
        self.usock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.usock.bind(("0.0.0.0", self.udp_port))
        threading.Thread(target=self._udp_rx, args=(self.usock,), daemon=True).start()
        s.sendall(wire(0x00, struct.pack("<H", self.usock.getsockname()[1])))
        steps = [(0x00, wire(0x01)), (0x02, wire(0x14)), (0x15, wire(0x0B, b"\x02\x00")),
                 (0x0C, wire(0x0A, b"\xff" * 0x2000))]
        until = time.time() + 10
        for want, reply in steps:
            for f in frames:
                if time.time() > until:
                    raise OSError("handshake timeout")
                if f is not None and f[0] == 0x7F and f[1] == want:
                    s.sendall(reply)
                    break
            else:
                raise OSError("closed")
        for f in (wire(0x0D), wire(0x11), wire(0x0F), bytes([0xF7, 0x02, 0x02, 0x20, 0xFF, 0xFF, 0xFF, 0xFF])):
            time.sleep(0.04)
            s.sendall(f)

    def _udp_rx(self, u):
        st = self.udp_stats
        while not self.stopped and u is self.usock:
            try:
                pkt = u.recv(65536)
            except OSError:
                return
            st["packets"] += 1
            st["sizes"][len(pkt)] = st["sizes"].get(len(pkt), 0) + 1
            st["last"] = pkt[:16].hex(" ")
            if self.rec is not None and len(self.rec) < 5000:
                self.rec.append([round(time.time(), 3), pkt.hex()])
            r = decode_udp(pkt, self.meter_cfg, self.meter_bytes)
            if r and r[0] == "m":
                self.meter_bytes, self.meter_at = r[1], time.time()
                st["meters"] += 1
            elif r:
                self.rta_bytes, self.rta_at = r[1], time.time()
                st["rta"] += 1

    def record(self, secs):
        """Raw UDP packets for working out the real layout."""
        self.rec = []
        time.sleep(secs)
        r, self.rec = self.rec, None
        return r

    def _keepalive(self, s):
        while not self.stopped and self.nsock is s:
            self._ntx(wire(0x03))
            time.sleep(1.0)

    def _native_run(self):
        while not self.stopped:
            if not self.ip:
                time.sleep(1)
                continue
            try:
                s = socket.create_connection((self.ip, self.native_port), timeout=3)
                s.settimeout(1.0)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                frames = self._frames(s)
                self._handshake(s, frames)
                self.nsock, self.native_ok, self.native_note = s, True, ""
                threading.Thread(target=self._keepalive, args=(s,), daemon=True).start()
                for f in frames:
                    if f is not None:
                        self._native_in(f)
                    if not self.native_ok:
                        break
            except OSError as e:
                self.native_note = f" ({e})" if str(e) else ""
            self.native_ok = False
            for x in (self.nsock, self.usock):
                try:
                    x and x.close()
                except OSError:
                    pass
            self.nsock = self.usock = None
            time.sleep(3)

    def _native_in(self, f):
        if f[0] == 0xF7:
            cat, reg, b3, w = f[2], f[3], f[4], f[6] | (f[7] << 8)
            e = NREV.get((cat, reg, b3))
            if e:
                self._store(e[0], e[1](w), "desk")
                return
        elif f[1] == 0x04 and len(f) - 6 == PARAMDATA_LEN:
            for p, v in parse_paramdata(f[6:]).items():
                self._store(p, v, "read")
            return
        elif f[1] in (0x01, 0x03):
            return
        if self.capture is not None:
            self.capture.append(bytes(f))
        b = match_select(self.sel_pat, f)
        if b:
            self._store("/-stat/sel", b, "desk")

    # ---- learn the select message ----
    def capture_for(self, secs):
        self.capture = []
        time.sleep(secs)
        c, self.capture = self.capture, None
        return c
