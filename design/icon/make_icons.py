"""网站图标：签名的第一笔（圈形的 l）加一个在线绿点

    python3 design/icon/make_icons.py

只依赖 rsvg-convert（brew install librsvg）。
笔画取自主页页脚手写签名 leo 的第一个字母，黑底圆角方块和主页上子站的小图标是同一套样子，
绿点就是子站图标旁边表示「在线」的那个点。
输出到 web/：favicon.svg、icon-180/192/512.png、icon-maskable-512.png
"""

import subprocess
from pathlib import Path

OUT = Path(__file__).parent.parent.parent / 'web'

INK = '#1a1a1a'     # 主页正文色
PAPER = '#fafafa'
INK_DARK = '#ededef'  # 深色模式下的正文色
GREEN = '#34d399'

# 签名（web/home.html 页脚 .sig，坐标系 84×42）里写 l 的那一段，到连向 e 的地方为止
L_PATH = 'M 8 30 C 14 23, 21 12, 23 6 C 24 3, 20 3, 18 8 C 16 14, 14 24, 17 29 C 19 32, 24 30, 28 25'
L_CENTER = (18, 17.5)


def mark(*, scale, center=(44, 50), stroke=4.2, dot=(75, 72), dot_r=7, ink='l', fg=PAPER):
    """圈 l 和绿点，坐标按 100×100 计；scale 是签名坐标放大的倍数"""
    cx, cy = center
    lx, ly = L_CENTER
    return (
        f'<path class="{ink}" transform="translate({cx} {cy}) scale({scale}) translate({-lx} {-ly})" d="{L_PATH}" '
        f'fill="none" stroke="{fg}" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>'
        f'<circle cx="{dot[0]}" cy="{dot[1]}" r="{dot_r}" fill="{GREEN}"/>'
    )


def favicon():
    """标签页图标：圆角方块，深色模式下反过来变成浅底深字，和主页的深色模式一致"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="64" height="64">'
        '<style>'
        f'.bg{{fill:{INK}}}.l{{stroke:{PAPER}}}'
        f'@media (prefers-color-scheme: dark){{.bg{{fill:{INK_DARK}}}.l{{stroke:{INK}}}}}'
        '</style>'
        '<rect class="bg" width="100" height="100" rx="24"/>'
        f'{mark(scale=2.1, stroke=3.9, dot=(76.5, 73.5), dot_r=6.8)}'
        '</svg>\n'
    )


def app_icon(*, scale, center, stroke, dot, dot_r):
    """App 图标：整块铺满（系统会自己切圆角）"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">'
        f'<rect width="100" height="100" fill="{INK}"/>'
        f'{mark(scale=scale, center=center, stroke=stroke, dot=dot, dot_r=dot_r)}'
        '</svg>\n'
    )


def render(svg, png, px):
    subprocess.run(['rsvg-convert', '-w', str(px), '-h', str(px), '-o', str(png)], input=svg.encode(), check=True)


def main():
    (OUT / 'favicon.svg').write_text(favicon())

    # 主屏幕图标：比标签页图标多留一点边，被切成圆角后不显得挤；
    # 尺寸大，笔画细一点，l 的圈才看得出来（标签页图标只有 16px，笔画要粗）
    app = app_icon(scale=1.75, center=(45, 49), stroke=2.9, dot=(73.5, 69.5), dot_r=5.2)
    for px in (180, 192, 512):
        render(app, OUT / f'icon-{px}.png', px)

    # 安卓可裁切图标：内容收进中间 80% 的安全区，被切成圆形也完整
    maskable = app_icon(scale=1.35, center=(46, 49), stroke=3.1, dot=(68, 64.5), dot_r=4.2)
    render(maskable, OUT / 'icon-maskable-512.png', 512)

    print('已生成：favicon.svg、icon-180/192/512.png、icon-maskable-512.png →', OUT)


if __name__ == '__main__':
    main()
