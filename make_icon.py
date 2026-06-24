#!/usr/bin/env python3
"""Generate icon.png (512x512) — a tiny receipt on a dark tile. Pure stdlib, no Pillow."""
import struct, zlib

S = 512
buf = bytearray([0, 0, 0, 0] * (S * S))  # transparent RGBA


def blend(x, y, r, g, b, a):
    if not (0 <= x < S and 0 <= y < S):
        return
    i = (y * S + x) * 4
    sa = a / 255.0
    buf[i]     = int(r * sa + buf[i]     * (1 - sa))
    buf[i + 1] = int(g * sa + buf[i + 1] * (1 - sa))
    buf[i + 2] = int(b * sa + buf[i + 2] * (1 - sa))
    buf[i + 3] = max(buf[i + 3], a)


def rrect(x0, y0, x1, y1, rad, col):
    r, g, b = col
    for y in range(y0, y1):
        for x in range(x0, x1):
            dx = dy = 0
            if x < x0 + rad:      dx = (x0 + rad) - x
            elif x > x1 - 1 - rad: dx = x - (x1 - 1 - rad)
            if y < y0 + rad:      dy = (y0 + rad) - y
            elif y > y1 - 1 - rad: dy = y - (y1 - 1 - rad)
            if dx and dy:
                d = (dx * dx + dy * dy) ** 0.5
                if d > rad:
                    continue
                if d > rad - 1.3:          # cheap edge anti-alias
                    blend(x, y, r, g, b, int(255 * (rad - d) / 1.3))
                    continue
            blend(x, y, r, g, b, 255)


def tri(ax, ay, bx, by, cx, cy, col):
    r, g, b = col
    minx, maxx = int(min(ax, bx, cx)), int(max(ax, bx, cx))
    miny, maxy = int(min(ay, by, cy)), int(max(ay, by, cy))

    def sign(px, py, qx, qy, rx, ry):
        return (px - rx) * (qy - ry) - (qx - rx) * (py - ry)

    for y in range(miny, maxy + 1):
        for x in range(minx, maxx + 1):
            d1 = sign(x, y, ax, ay, bx, by)
            d2 = sign(x, y, bx, by, cx, cy)
            d3 = sign(x, y, cx, cy, ax, ay)
            neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
            pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
            if not (neg and pos):
                blend(x, y, r, g, b, 255)


INK = (24, 26, 31)
PAPER = (247, 245, 238)
ACCENT = (192, 57, 43)
SOFT = (150, 150, 145)

# dark rounded tile (full bleed)
rrect(0, 0, S, S, 96, INK)

# receipt paper
px0, px1 = 150, 362
ptop, pbot = 110, 372
rrect(px0, ptop, px1, pbot, 12, PAPER)

# zig-zag teeth along the bottom of the paper
tooth = 22
x = px0
while x < px1:
    tri(x, pbot - 1, min(x + tooth, px1), pbot - 1, x + tooth / 2, pbot + 16, PAPER)
    x += tooth

# ink "text" lines
def bar(y0, y1, x0, x1, col):
    rrect(x0, y0, x1, y1, 3, col)

bar(140, 158, 168, 332, INK)     # title
bar(176, 184, 168, 300, SOFT)
bar(196, 204, 168, 344, SOFT)
bar(216, 224, 168, 286, SOFT)
bar(236, 244, 168, 330, SOFT)
bar(286, 304, 168, 344, ACCENT)  # "total" highlight
bar(322, 330, 168, 260, SOFT)
bar(342, 350, 168, 320, SOFT)

# write PNG
def chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data +
            struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))

raw = bytearray()
for y in range(S):
    raw.append(0)
    raw.extend(buf[y * S * 4:(y + 1) * S * 4])

png = (b"\x89PNG\r\n\x1a\n" +
       chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) +
       chunk(b"IDAT", zlib.compress(bytes(raw), 9)) +
       chunk(b"IEND", b""))

with open("icon.png", "wb") as f:
    f.write(png)
print("wrote icon.png", len(png), "bytes")
