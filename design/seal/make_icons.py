"""朱红小印：生成全套图标

    python3 design/seal/make_icons.py

依赖 fontTools 和 rsvg-convert（brew install librsvg）。
字母用 Playfair Display Bold Italic（SIL OFL）转成路径，图标不依赖字体。
输出到 home/：favicon.svg、icon-180/192/512.png、icon-maskable-512.png
"""

import re
import subprocess
import urllib.request
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).parent
OUT = HERE.parent.parent / 'home'
CACHE = HERE / '.cache'
FONT = CACHE / 'PlayfairDisplay-BoldItalic.ttf'

VERMILION = '#b8361d'
PAPER = '#f3efe6'
TEXT = 'leo'
TRACKING = -10  # 字距（字体单位，1000/em），斜体字母靠紧一点更像一个整体


def ensure_font():
    if FONT.exists():
        return
    CACHE.mkdir(exist_ok=True)
    css = urllib.request.urlopen('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,700').read().decode()
    url = re.search(r'url\((https://fonts\.gstatic\.com[^)]+\.ttf)\)', css).group(1)
    FONT.write_bytes(urllib.request.urlopen(url).read())


def text_path(font, text, box):
    """把文字转成 SVG 路径，等比缩放后居中放进 box=(x, y, w, h)"""
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    names = [cmap[ord(ch)] for ch in text]

    # 先在字体坐标里排好字，翻转 y 轴，量出整体边界
    placed, x = [], 0
    for name in names:
        placed.append((name, x))
        x += font['hmtx'][name][0] + TRACKING
    bounds = BoundsPen(glyphs)
    for name, dx in placed:
        glyphs[name].draw(TransformPen(bounds, (1, 0, 0, -1, dx, 0)))
    x0, y0, x1, y1 = bounds.bounds

    bx, by, bw, bh = box
    scale = min(bw / (x1 - x0), bh / (y1 - y0))
    ox = bx + (bw - (x1 - x0) * scale) / 2 - x0 * scale
    oy = by + (bh - (y1 - y0) * scale) / 2 - y0 * scale

    pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}'.rstrip('0').rstrip('.'))
    for name, dx in placed:
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, ox + dx * scale, oy)))
    return pen.getCommands()


def seal(font, *, size, inset, radius, frame, frame_radius, stroke, text_box, full_bleed):
    """一方印：朱红底、纸色内框、纸色字母。坐标都按 100×100 计"""
    bg = (f'<rect width="100" height="100" fill="{VERMILION}"/>' if full_bleed
          else f'<rect x="{inset}" y="{inset}" width="{100 - 2 * inset}" height="{100 - 2 * inset}" rx="{radius}" fill="{VERMILION}"/>')
    f = frame
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="{size}" height="{size}">'
        f'{bg}'
        f'<rect x="{f}" y="{f}" width="{100 - 2 * f}" height="{100 - 2 * f}" rx="{frame_radius}" '
        f'fill="none" stroke="{PAPER}" stroke-width="{stroke}"/>'
        f'<path fill="{PAPER}" d="{text_path(font, TEXT, text_box)}"/>'
        f'</svg>\n'
    )


def render(svg, png, px):
    subprocess.run(['rsvg-convert', '-w', str(px), '-h', str(px), '-o', str(png)], input=svg.encode(), check=True)


def main():
    ensure_font()
    font = TTFont(FONT)

    # 标签页图标：透明底上的一方圆角印，内框和字都放粗，16px 下也认得出
    favicon = seal(font, size=64, inset=2, radius=12, frame=11, frame_radius=5, stroke=3.2,
                   text_box=(22, 30, 56, 40), full_bleed=False)
    (OUT / 'favicon.svg').write_text(favicon)

    # App 图标：整块朱红铺满（系统会自己切圆角），内框留出边距
    app = seal(font, size=512, inset=0, radius=14, frame=12, frame_radius=4, stroke=2.6,
               text_box=(24, 32, 52, 36), full_bleed=True)
    for px in (180, 192, 512):
        render(app, OUT / f'icon-{px}.png', px)

    # 安卓可裁切图标：内容收进中间 80% 的安全区，被切成圆形也不会伤到内框
    maskable = seal(font, size=512, inset=0, radius=8, frame=23, frame_radius=3, stroke=2.2,
                    text_box=(32, 39, 36, 22), full_bleed=True)
    render(maskable, OUT / 'icon-maskable-512.png', 512)

    print('已生成：favicon.svg、icon-180/192/512.png、icon-maskable-512.png →', OUT)


if __name__ == '__main__':
    main()
