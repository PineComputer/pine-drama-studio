#!/usr/bin/env python3
"""Builds extensions/pine-drama/media/pine-icons.woff, the icon font behind the contributed icon `pine-computer`.

Why a font: the Chat session-type chip is rendered from a ThemeIcon only
(vscode src/vs/workbench/contrib/chat/browser/widget/input/sessionTargetPickerActionItem.ts:469-481),
and the status bar text takes `$(id)` only, so a contributed icon (contributes.icons) is the one form all three places accept.

Source of the shape: Pine Computer's current "lit" mark, brand/system/mark/favicon-lit.svg in pine-computer-narrative
(brand/README.md, identity row: "the current mark is round 3's dot, lit"). A copy is media/pine-computer-lit.svg.
A font glyph has one colour, so the mint dot and the ink corners become one theme-coloured glyph.

Needs `pip install fonttools brotli` (only to regenerate; the .woff is committed). Run: python3 scripts/build-pine-icon-font.py
"""
import math
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

# Size and placement match the codicon the mark replaced. Measured with fontTools on
# Code-OSS's node_modules/@vscode/codicons/dist/codicon.ttf: unitsPerEm 300, hhea ascent 300 / descent 0
# (so the em box is y 0..300 with the baseline at its bottom), advance 300; `hubot` bbox x 38..263, y 23..281
# (225 wide, 258 tall, centre 150.5, 152). A full-em mark looked too large beside codicons, so ours is a
# 258-tall square centred on hubot's centre. Our font uses 10x those units (UPM 3000) so the rounding stays under 0.1%.
UPM, ASCENT, DESCENT = 3000, 3000, 0
SIZE = 2580  # hubot's height x10
S = SIZE / 16  # the SVG's 16x16 grid
X0, Y0 = 1505 - SIZE / 2, 1520 - SIZE / 2  # left and bottom edge so the centre is hubot's (150.5, 152) x10


def pt(x, y):
    return (round(X0 + x * S), round(Y0 + (16 - y) * S))  # SVG y points down


# The four corner brackets, from the path in favicon-lit.svg, as SVG-space polygons.
corners = [
    [(0, 0), (5, 0), (5, 2), (2, 2), (2, 5), (0, 5)],
    [(11, 0), (16, 0), (16, 5), (14, 5), (14, 2), (11, 2)],
    [(0, 11), (2, 11), (2, 14), (5, 14), (5, 16), (0, 16)],
    [(14, 11), (16, 11), (16, 16), (11, 16), (11, 14), (14, 14)],
]


def area(p):
    return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p))) / 2


pen = TTGlyphPen(None)
for poly in corners:
    p = [pt(x, y) for x, y in poly]
    if area(p) > 0:  # TrueType outer contours run clockwise (negative area, y up)
        p.reverse()
    pen.moveTo(p[0])
    for q in p[1:]:
        pen.lineTo(q)
    pen.closePath()

# The dot: circle r=3.25 at (8,8) as 8 quadratic arcs (on-curve every 45 deg, off-curve at the tangent intersections).
# Angles run counter-clockwise in SVG space (y down), which is clockwise after the flip in pt().
r, cx, cy = 3.25, 8, 8
on = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(0, 360, 45)]
ro = r / math.cos(math.radians(22.5))
off = [(cx + ro * math.cos(math.radians(a + 22.5)), cy + ro * math.sin(math.radians(a + 22.5))) for a in range(0, 360, 45)]
pen.moveTo(pt(*on[0]))
for i in range(8):
    pen.qCurveTo(pt(*off[i]), pt(*on[(i + 1) % 8]))
pen.closePath()

glyph = pen.glyph()
fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder([".notdef", "pine-computer"])
fb.setupCharacterMap({0xE000: "pine-computer"})
fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "pine-computer": glyph})
fb.setupHorizontalMetrics({".notdef": (UPM, 0), "pine-computer": (UPM, round(X0))})  # lsb must equal xMin or rasterisers shift the glyph
fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
fb.setupNameTable({"familyName": "pine-icons", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=-DESCENT, usWinAscent=3270, usWinDescent=70)  # win metrics as codicon.ttf
fb.setupPost()
fb.font.flavor = "woff"
out = Path(__file__).resolve().parent.parent / "extensions/pine-drama/media/pine-icons.woff"
fb.save(out)
print(f"wrote {out} ({out.stat().st_size} bytes)")
