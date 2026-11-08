"""Draw the app icon (three faders) with the stdlib only. Run: python tools/make_icons.py"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).parent.parent / "app" / "public" / "icons"


def png(path, n):
    bg, track, cap, acc = (20, 23, 27), (58, 65, 74), (235, 239, 243), (82, 182, 255)
    rad = n * .2
    rows = []
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            c = bg
            for i, pos in enumerate((.32, .72, .5)):
                cx = n * (.25 + .25 * i)
                if abs(x - cx) < n * .022 and n * .16 < y < n * .84:
                    c = track
                if abs(x - cx) < n * .08 and abs(y - n * pos) < n * .055:
                    c = acc if i == 1 else cap
            row += bytes(c)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def ch(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)) + ch(b"IDAT", raw) + ch(b"IEND", b""))


OUT.mkdir(parents=True, exist_ok=True)
png(OUT / "icon-192.png", 192)
png(OUT / "icon-512.png", 512)
