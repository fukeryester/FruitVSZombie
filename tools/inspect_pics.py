from PIL import Image
import os
from collections import Counter

p = r'e:\wx-minigame\Assets\pic'
for f in sorted(os.listdir(p)):
    path = os.path.join(p, f)
    im = Image.open(path)
    rgba = im.convert('RGBA')
    w, h = rgba.size
    pix = list(rgba.getdata())
    corners = [
        rgba.getpixel((0, 0)),
        rgba.getpixel((w - 1, 0)),
        rgba.getpixel((0, h - 1)),
        rgba.getpixel((w - 1, h - 1)),
        rgba.getpixel((w // 2, 0)),
        rgba.getpixel((0, h // 2)),
        rgba.getpixel((8, 8)),
        rgba.getpixel((16, 0)),
    ]
    alphas = [px[3] for px in pix]
    a_min, a_max = min(alphas), max(alphas)
    opaque = sum(1 for a in alphas if a > 250)
    trans = sum(1 for a in alphas if a < 10)
    print(f'{f:24} {w}x{h} mode={im.mode} opaque={opaque} trans={trans} a=[{a_min},{a_max}]')
    print(f'  corners={corners}')
    print(f'  center={rgba.getpixel((w // 2, h // 2))}')

    # Guess pixel scale: consecutive run of identical pixels on first opaque row
    def guess_scale(img):
        ww, hh = img.size
        for y in range(hh):
            row = [img.getpixel((x, y)) for x in range(ww)]
            runs = []
            run = 1
            for i in range(1, ww):
                if row[i] == row[i - 1]:
                    run += 1
                else:
                    if row[i - 1][3] > 200:
                        runs.append(run)
                    run = 1
            if runs:
                c = Counter(runs)
                return c.most_common(8)
        return []
    print(f'  run_lengths={guess_scale(rgba)}')
