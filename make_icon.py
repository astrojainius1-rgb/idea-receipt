#!/usr/bin/env python3
"""Generate icon.png (512x512): a cream receipt with the Claude spark on a dark
gradient tile. Pure stdlib (no Pillow)."""
import math
import struct
import zlib

S = 512
buf = bytearray([0, 0, 0, 0] * (S * S))  # transparent RGBA


def blend(x, y, r, g, b, a):
    x = int(x); y = int(y)
    if not (0 <= x < S and 0 <= y < S):
        return
    a = max(0, min(255, int(a)))
    i = (y * S + x) * 4
    sa = a / 255.0
    buf[i]     = int(r * sa + buf[i]     * (1 - sa))
    buf[i + 1] = int(g * sa + buf[i + 1] * (1 - sa))
    buf[i + 2] = int(b * sa + buf[i + 2] * (1 - sa))
    buf[i + 3] = max(buf[i + 3], a)


def rrect(x0, y0, x1, y1, rad, col, alpha=255):
    r, g, b = col
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            dx = dy = 0
            if x < x0 + rad:       dx = (x0 + rad) - x
            elif x > x1 - 1 - rad:  dx = x - (x1 - 1 - rad)
            if y < y0 + rad:       dy = (y0 + rad) - y
            elif y > y1 - 1 - rad:  dy = y - (y1 - 1 - rad)
            if dx and dy:
                d = (dx * dx + dy * dy) ** 0.5
                if d > rad:
                    continue
                if d > rad - 1.3:
                    blend(x, y, r, g, b, alpha * (rad - d) / 1.3)
                    continue
            blend(x, y, r, g, b, alpha)


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
            if not (((d1 < 0) or (d2 < 0) or (d3 < 0)) and ((d1 > 0) or (d2 > 0) or (d3 > 0))):
                blend(x, y, r, g, b, 255)


def seg(x0, y0, x1, y1, w, col):
    """anti-aliased thick line via distance-to-segment"""
    r, g, b = col
    hw = w / 2.0
    minx, maxx = int(min(x0, x1) - hw - 1), int(max(x0, x1) + hw + 1)
    miny, maxy = int(min(y0, y1) - hw - 1), int(max(y0, y1) + hw + 1)
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy or 1
    for y in range(miny, maxy + 1):
        for x in range(minx, maxx + 1):
            t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2))
            px, py = x0 + t * dx, y0 + t * dy
            d = ((x - px) ** 2 + (y - py) ** 2) ** 0.5
            if d <= hw - 0.6:
                blend(x, y, r, g, b, 255)
            elif d <= hw + 0.6:
                blend(x, y, r, g, b, 255 * (hw + 0.6 - d) / 1.2)


# ---- palette ----
INK = (26, 28, 33)
PAPER = (248, 246, 239)
SOFT = (150, 150, 145)
ROSSO = (212, 0, 0)
SPARK = (217, 119, 87)   # Claude rust

# ---- background: rounded tile with a vertical gradient + soft top glow ----
RAD = 104
TOP, BOT = (48, 52, 60), (19, 21, 26)
gx, gy = S * 0.5, S * 0.34
for y in range(S):
    f = y / (S - 1)
    br = TOP[0] * (1 - f) + BOT[0] * f
    bg = TOP[1] * (1 - f) + BOT[1] * f
    bb = TOP[2] * (1 - f) + BOT[2] * f
    for x in range(S):
        dx = dy = 0
        if x < RAD:        dx = RAD - x
        elif x > S - 1 - RAD: dx = x - (S - 1 - RAD)
        if y < RAD:        dy = RAD - y
        elif y > S - 1 - RAD: dy = y - (S - 1 - RAD)
        a = 255
        if dx and dy:
            d = (dx * dx + dy * dy) ** 0.5
            if d > RAD:
                continue
            if d > RAD - 1.3:
                a = 255 * (RAD - d) / 1.3
        glow = max(0.0, 1 - (((x - gx) ** 2 + (y - gy) ** 2) ** 0.5) / (S * 0.62)) * 16
        blend(x, y, br + glow, bg + glow, bb + glow, a)

# ---- receipt ----
px0, px1, ptop, pbot = 150, 362, 122, 402
rrect(px0 + 6, ptop + 14, px1 + 8, pbot + 18, 16, (0, 0, 0), alpha=80)  # soft drop shadow
rrect(px0, ptop, px1, pbot, 10, PAPER)

# torn teeth, top + bottom
tooth = 24
x = px0
while x < px1:
    x2 = min(x + tooth, px1)
    tri(x, ptop + 1, x2, ptop + 1, (x + x2) / 2, ptop - 16, PAPER)  # top points up
    tri(x, pbot - 1, x2, pbot - 1, (x + x2) / 2, pbot + 16, PAPER)  # bottom points down
    x += tooth

# ---- Claude spark (11-ray burst) ----
scx, scy, R = 256, 178, 30
for i in range(11):
    a = i * 2 * math.pi / 11
    seg(scx, scy, scx + R * math.cos(a), scy + R * math.sin(a), 7, SPARK)

# ---- text lines ----
def bar(y0, y1, x0, x1, col):
    rrect(x0, y0, x1, y1, 4, col)

bar(224, 246, 172, 340, INK)    # title
bar(258, 266, 172, 312, SOFT)
bar(274, 282, 172, 332, SOFT)
bar(290, 298, 172, 300, SOFT)
bar(320, 342, 172, 340, ROSSO)  # total

# ---- mini barcode ----
bx, by0, by1 = 178, 360, 392
pattern = [6, 3, 4, 7, 3, 5, 3, 8, 4, 3, 6, 3, 4, 5, 7, 3, 4, 3, 6, 4, 3, 5]
i = 0
for w in pattern:
    if bx + w > 338:
        break
    if i % 2 == 0:
        bar(by0, by1, bx, bx + w, INK)
    bx += w
    i += 1

# ---- write PNG ----
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
