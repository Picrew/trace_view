"""Matte the icon artwork off its gradient backdrop and lay it on the macOS icon grid.

The source preview renders the artwork over a vertical black->white gradient that
is uniform within each row (measured: <=5 levels of horizontal drift), so the
backdrop B is known exactly per pixel. With B known, alpha follows from
projecting the observed pixel onto the B->F line:

    p = a*F + (1-a)*B   =>   a = ((p-B).(F-B)) / |F-B|^2

Two details that each caused a visible halo on the first attempts:

* The opaque region cannot be picked by "distance from backdrop" — the source's
  single antialiased edge pixel sits 89 away from the backdrop (well past any
  threshold that still catches the near-iso-luminant dark bottom layer at 36.8).
  Thresholding alone therefore froze rim pixels at alpha=1 with their blended
  colour, i.e. a 1px grey outline. So the silhouette is thresholded loosely and
  the opaque interior is derived geometrically, by eroding it.
* F for the rim band comes from the nearest interior pixel, so un-premultiplying
  recovers the true rim colour instead of leaving the backdrop mixed in (a dark
  halo along the black top edge, a light one along the white bottom).

Usage: python3 scripts/extract-icon.py   (needs pillow + scipy; dev-only, not
part of the packaging pipeline — package-macos.sh consumes assets/icon-1024.png)
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'icon-source.png')
OUT = os.path.join(ROOT, 'assets', 'icon-1024.png')
FAVICON = os.path.join(ROOT, 'web', 'public', 'icon.png')
CANVAS = 1024
CONTENT = 824  # macOS app-icon content box (100px margin each side)
BAND = 2       # antialias band half-width, in source pixels

img = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float64)
h, w, _ = img.shape

# ── backdrop model: per-row median of the left/right strips (artwork-free) ──
strips = np.concatenate([img[:, :180, :], img[:, w - 180:, :]], axis=1)
bg = np.median(strips, axis=1)
B = np.repeat(bg[:, None, :], w, axis=1)

d = img - B
dist = np.linalg.norm(d, axis=2)

# ── silhouette: backdrop dither peaks at 16.4, darkest artwork layer at 36.8 ──
shape = dist > 25
shape = ndimage.binary_opening(shape, np.ones((3, 3)))
shape = ndimage.binary_closing(shape, np.ones((3, 3)))
shape = ndimage.binary_fill_holes(shape)
lbl, n = ndimage.label(shape)
if n > 1:                                            # keep the artwork only
    sizes = ndimage.sum(shape, lbl, range(1, n + 1))
    shape = lbl == (np.argmax(sizes) + 1)

disk = ndimage.generate_binary_structure(2, 2)
interior = ndimage.binary_erosion(shape, disk, iterations=BAND)
band = ndimage.binary_dilation(shape, disk, iterations=BAND) & ~interior

# ── F for every pixel = colour of the nearest interior pixel ──────────────
idx = ndimage.distance_transform_edt(~interior, return_distances=False, return_indices=True)
F = img[idx[0], idx[1]]

fb = F - B
denom = (fb * fb).sum(axis=2)
proj = np.where(denom > 1e-6, (d * fb).sum(axis=2) / np.maximum(denom, 1e-6), 0.0)

alpha = np.zeros((h, w))
alpha[band] = np.clip(proj[band], 0.0, 1.0)
alpha[interior] = 1.0
alpha[alpha < 0.02] = 0.0

# ── un-premultiply: recover F from p = a*F + (1-a)*B ──────────────────────
a3 = alpha[:, :, None]
fg = np.where(a3 >= 1.0, img,
              np.where(a3 > 0.02, (img - (1.0 - a3) * B) / np.maximum(a3, 0.02), F))
fg = np.clip(fg, 0, 255)

cut = Image.fromarray(np.dstack([fg, alpha * 255.0]).astype(np.uint8))

# ── crop to the artwork, scale onto the icon grid ─────────────────────────
box = cut.getbbox()
cut = cut.crop(box)
cw, ch = cut.size
scale = CONTENT / max(cw, ch)
cut = cut.resize((max(1, round(cw * scale)), max(1, round(ch * scale))), Image.LANCZOS)

# Plain paste (no mask): pasting with the cut-out as its own mask would
# composite it onto the transparent black canvas, i.e. premultiply the colour
# and bring the dark halo straight back.
canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
canvas.paste(cut, ((CANVAS - cut.size[0]) // 2, (CANVAS - cut.size[1]) // 2))
canvas.save(OUT)

canvas.resize((256, 256), Image.LANCZOS).save(FAVICON, optimize=True)

a = np.asarray(canvas)[:, :, 3]
print(f'bbox={box} cropped={cw}x{ch} scaled={cut.size}')
print('alpha: zero %.1f%% partial %.2f%% full %.1f%%'
      % (100 * (a == 0).mean(), 100 * ((a > 0) & (a < 255)).mean(), 100 * (a == 255).mean()))
print('->', OUT)
print('->', FAVICON)
