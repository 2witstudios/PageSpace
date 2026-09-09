#!/usr/bin/env python3
"""Draw the PageSpace Coder app mark and emit its packaging assets.

PageSpace's mark is a white "P" page glyph on a full-bleed black field.
Coder is its sibling: a white terminal prompt — chevron plus caret bar — on the
same field, so the two read as one family in the dock while staying instantly
tellable apart at 16px.

Written by hand rather than exported from a design tool because the repo has no
raster toolchain: `generate-icon.sh` relies on macOS `sips`, which can resize
but cannot draw, and nothing in the repo could produce a `.ico` at all (the
PageSpace one has always been maintained by hand). Everything here is pure
stdlib, so the whole icon set is reproducible from source with `python3`.

Usage:  python3 scripts/draw-coder-mark.py <out-dir>
Emits:  icon.png (the 1024px master), icon.ico, tray-icon.png
        (`generate-icon.sh coder` turns icon.png into icon.icns)
"""

import struct
import sys
import zlib
from pathlib import Path

SIZE = 1024
BACKGROUND = (0, 0, 0)
FOREGROUND = (255, 255, 255)

# Stroke skeleton, in 1024-space. The chevron and the caret bar share a stroke
# width and round caps so they read as one drawn gesture.
# Sized and offset so the stroke extents — caps included — sit centred on the
# 1024 canvas, and so the mark fills about the same area as the PageSpace "P".
STROKE = 88.0
CHEVRON = [((240.0, 300.0), (528.0, 512.0)), ((528.0, 512.0), (240.0, 724.0))]
CARET = [((592.0, 724.0), (784.0, 724.0))]
SEGMENTS = CHEVRON + CARET


def distance_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else ((px - ax) * dx + (py - ay) * dy) / length_sq
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def render(size):
    """Return `size`x`size` RGB rows. Coverage is antialiased over one pixel."""
    scale = size / SIZE
    radius = (STROKE / 2.0) * scale
    segments = [
        (ax * scale, ay * scale, bx * scale, by * scale)
        for (ax, ay), (bx, by) in SEGMENTS
    ]

    # Only pixels near a stroke can be lit; everything else stays background.
    pad = radius + 2.0
    boxes = [
        (min(ax, bx) - pad, min(ay, by) - pad, max(ax, bx) + pad, max(ay, by) + pad)
        for ax, ay, bx, by in segments
    ]

    rows = []
    for y in range(size):
        cy = y + 0.5
        row = bytearray()
        active = [
            (seg, box)
            for seg, box in zip(segments, boxes)
            if box[1] <= cy <= box[3]
        ]
        for x in range(size):
            cx = x + 0.5
            coverage = 0.0
            for (ax, ay, bx, by), box in active:
                if not (box[0] <= cx <= box[2]):
                    continue
                dist = distance_to_segment(cx, cy, ax, ay, bx, by)
                # Linear ramp across the last pixel of the edge.
                edge = radius + 0.5 - dist
                coverage = max(coverage, min(1.0, max(0.0, edge)))
                if coverage >= 1.0:
                    break
            for channel in range(3):
                back, fore = BACKGROUND[channel], FOREGROUND[channel]
                row.append(int(round(back + (fore - back) * coverage)))
        rows.append(bytes(row))
    return rows


def encode_png(rows, size):
    def chunk(tag, payload):
        body = tag + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))

    # Filter type 0 (None) on every scanline: the art is flat, so the extra
    # filter search would buy nothing.
    raw = b''.join(b'\x00' + row for row in rows)
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', header)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def encode_ico(entries):
    """A PNG-compressed ICO. Windows has read these since Vista, and
    electron-builder requires a 256px entry."""
    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    directory, payloads = b'', b''
    for size, png in entries:
        directory += struct.pack(
            '<BBBBHHII',
            0 if size >= 256 else size,  # 0 means 256 in the ICO directory
            0 if size >= 256 else size,
            0, 0, 1, 32, len(png), offset,
        )
        payloads += png
        offset += len(png)
    return header + directory + payloads


def main():
    if len(sys.argv) != 2:
        sys.exit(f'usage: {sys.argv[0]} <out-dir>')
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)

    master_png = encode_png(render(SIZE), SIZE)
    (out / 'icon.png').write_bytes(master_png)
    print(f'wrote {out / "icon.png"} ({SIZE}px master)')

    # Redraw per size rather than downsampling: at 16px a resampled stroke goes
    # muddy, while redrawing keeps the prompt legible.
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    (out / 'icon.ico').write_bytes(
        encode_ico([(s, encode_png(render(s), s)) for s in ico_sizes])
    )
    print(f'wrote {out / "icon.ico"} ({", ".join(str(s) for s in ico_sizes)}px)')

    (out / 'tray-icon.png').write_bytes(encode_png(render(32), 32))
    print(f'wrote {out / "tray-icon.png"}')


if __name__ == '__main__':
    main()
