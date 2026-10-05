#!/usr/bin/env python3
"""
Trim logo.png to its glyph and emit it into public/.

Pure stdlib: no PIL in this environment. Decodes the PNG (colour type 6,
8-bit, all five filter types), crops to the alpha bounding box, then re-encodes
with filter 0 rows.

Why crop at all: the source is a 1536x1024 canvas holding a 405x333 glyph. Used
raw, ~74% of the box is transparent padding, so an <img> sized for the wordmark
renders the mark itself at roughly a third of the intended size — the logo looks
like it failed to load rather than merely small.
"""
import struct, zlib, sys

SRC = "logo.png"


def decode(path):
    d = open(path, "rb").read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a PNG")
    w, h = struct.unpack(">II", d[16:24])
    bitdepth, colortype = d[24], d[25]
    if bitdepth != 8 or colortype != 6:
        raise SystemExit(f"expected 8-bit RGBA, got depth={bitdepth} colortype={colortype}")

    idat = b""
    i = 8
    while i < len(d):
        ln = struct.unpack(">I", d[i:i + 4])[0]
        typ = d[i + 4:i + 8]
        if typ == b"IDAT":
            idat += d[i + 8:i + 8 + ln]
        i += 12 + ln

    raw = zlib.decompress(idat)
    stride, bpp = w * 4, 4
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(h):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) // 2)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        elif f != 0:
            raise SystemExit(f"unknown filter {f}")
        out += line
        prev = line
    return w, h, out


def encode(path, w, h, pixels):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter 0 — we re-encode, so keep it simple
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main():
    w, h, px = decode(SRC)

    # Alpha bounding box, ignoring near-zero alpha so the crop is set by the
    # glyph's real edge rather than by compression noise in the padding.
    thr = 8
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            if px[row + x * 4 + 3] > thr:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        raise SystemExit("image is fully transparent")

    # A few px of breathing room so antialiased edges are not clipped flat.
    pad = 6
    minx = max(0, minx - pad); miny = max(0, miny - pad)
    maxx = min(w - 1, maxx + pad); maxy = min(h - 1, maxy + pad)
    cw, ch = maxx - minx + 1, maxy - miny + 1

    stride = w * 4
    cropped = bytearray()
    for y in range(miny, maxy + 1):
        start = y * stride + minx * 4
        cropped += px[start:start + cw * 4]

    import os
    os.makedirs("public", exist_ok=True)
    encode("public/logo.png", cw, ch, cropped)
    print(f"source  {w}x{h}")
    print(f"glyph   x{minx}-{maxx} y{miny}-{maxy}")
    print(f"public/logo.png  {cw}x{ch}  ({100*cw*ch/(w*h):.1f}% of source area)")


if __name__ == "__main__":
    sys.exit(main())