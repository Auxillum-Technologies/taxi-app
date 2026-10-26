"""Turn the taxi pixel-art views into a coloured voxel model (GLB).

The front, driver-side and top silhouettes carve a visual hull; every exposed
voxel face then takes its colour from the view it faces.  Views are cleaned
by snapping to a shared palette and taking the dominant colour per voxel cell,
which removes the soft anti-aliased edges in the source art.
"""

from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"

LENGTH_VOXELS = 112
LENGTH_M = 0.070  # matches GLB/taxi.glb
PALETTE_SIZE = 24
NORMAL_SIGMA = 1.5
UNDERSIDE = (38, 42, 48)

# Top view is a longer-hood sprite; line its windshield/roof/hatch up with the
# side view.  Pairs are (side-view fraction from front, top-view fraction).
TOP_REMAP = [(0.0, 0.0), (0.25, 0.28), (0.39, 0.41), (0.60, 0.51), (0.86, 0.73), (0.95, 0.88), (1.0, 1.0)]


def load(name):
    rgba = np.array(Image.open(ASSETS / f"{name}.png").convert("RGBA"))
    mask = rgba[..., 3] > 128
    labels, count = nd.label(mask)
    areas = nd.sum(mask, labels, range(1, count + 1))
    mask = labels == (int(np.argmax(areas)) + 1)  # drop neighbouring-sprite scraps
    rgba[~mask] = 0
    return rgba


def bbox(rgba):
    rows, cols = np.nonzero(rgba[..., 3])
    return rows.min(), rows.max() + 1, cols.min(), cols.max() + 1


def body_center(rgba, band):
    """Horizontal centre from a band of rows that holds no mirrors."""
    _, _, c0, c1 = bbox(rgba)
    h = rgba.shape[0]
    cols = np.nonzero(rgba[int(band[0] * h): int(band[1] * h), :, 3].any(axis=0))[0]
    return (cols.min() + cols.max() + 1) / 2


def window(rgba, r0, r1, c0, c1):
    """Crop to a frame, padding with transparency where the sprite was clipped."""
    h, w = rgba.shape[:2]
    pad = max(0, -r0, -c0, r1 - h, c1 - w)
    padded = np.pad(rgba, ((pad, pad), (pad, pad), (0, 0)))
    return padded[r0 + pad: r1 + pad, c0 + pad: c1 + pad]


views = {name: load(name) for name in ("front", "driver-side", "rear", "passenger-side", "top")}


def trim_between(rgba, above, below):
    """Cut what pokes past the body edges between two rows (the mirrors)."""
    edges = []
    for row in (above, below):
        cols = np.nonzero(rgba[row, :, 3] > 128)[0]
        edges.append((cols.min(), cols.max()))
    for row in range(above + 1, below):
        t = (row - above) / (below - above)
        left = round(edges[0][0] + t * (edges[1][0] - edges[0][0]))
        right = round(edges[0][1] + t * (edges[1][1] - edges[0][1]))
        rgba[row, :left] = 0
        rgba[row, right + 1:] = 0


def paint_over(rgba, rows, cols, shift):
    """Cover a feature with the paintwork `shift` columns along the car."""
    r0, r1 = rows
    c0, c1 = cols
    rgba[r0:r1, c0:c1] = rgba[r0:r1, c0 + shift: c1 + shift]


# No side mirrors: in the front, rear and top views they stick out past the
# body (and would be extruded along the whole car); on the side views they
# are painted over with the window and door just behind them.
trim_between(views["front"], 125, 185)
trim_between(views["rear"], 125, 185)
views["top"][198:254, 22:76] = views["top"][256:257, 22:76]
views["top"][198:254, 324:] = views["top"][256:257, 324:]
paint_over(views["driver-side"], (135, 178), (163, 217), 54)
paint_over(views["passenger-side"], (138, 177), (365, 414), -49)

# Frame each view on the car's extents.
r0, r1, c0, c1 = bbox(views["driver-side"])
side_len = c1 - c0
frames = {"driver-side": window(views["driver-side"], r0, r1, c0, c1)}
pr0, pr1, pc0, _ = bbox(views["passenger-side"])
frames["passenger-side"] = window(views["passenger-side"], pr0, pr1, pc0, pc0 + side_len)

fr0, fr1, fc0, fc1 = bbox(views["front"])
frames["front"] = window(views["front"], fr0, fr1, fc0, fc1)
# Frame the rear symmetric about the bumper.
rr0, rr1, rc0, _ = bbox(views["rear"])
centre = body_center(views["rear"], (0.65, 0.8))
half = centre - rc0
frames["rear"] = window(views["rear"], rr0, rr1, rc0, int(round(centre + half)))
# The top crop clips the right side: frame it symmetric about the hood.
tr0, tr1, tc0, _ = bbox(views["top"])
centre = body_center(views["top"], (0.1, 0.2))
frames["top"] = window(views["top"], tr0, tr1, tc0, int(round(centre + (centre - tc0))))

L = LENGTH_VOXELS
H = round(L * (r1 - r0) / side_len)
W = round(H * (fc1 - fc0) / (fr1 - fr0))

def cells(frame, nx, ny, remap=None):
    """Mask and dominant palette colour per cell of an nx-by-ny grid."""
    alpha = frame[..., 3] > 128
    # Each view gets its own small palette so accents (sign, lamps) survive.
    opaque = Image.fromarray(frame[..., :3][alpha][None])
    palette_img = opaque.quantize(PALETTE_SIZE, method=Image.Quantize.MEDIANCUT, kmeans=3)
    palette = np.array(palette_img.getpalette()[: PALETTE_SIZE * 3]).reshape(-1, 3)
    rgb = Image.fromarray(frame[..., :3]).quantize(palette=palette_img, dither=Image.Dither.NONE)
    index = np.array(rgb)
    h, w = alpha.shape
    mask = np.zeros((ny, nx), bool)
    color = np.zeros((ny, nx, 3), np.uint8)
    for j in range(ny):
        for i in range(nx):
            v0, v1 = j / ny, (j + 1) / ny
            if remap:  # remaps image rows (the top view's length axis)
                v0, v1 = remap(v0), remap(v1)
            y0, y1 = int(v0 * h), max(int(v1 * h), int(v0 * h) + 1)
            x0, x1 = int(i / nx * w), max(int((i + 1) / nx * w), int(i / nx * w) + 1)
            a = alpha[y0:y1, x0:x1]
            if a.mean() < 0.5:
                continue
            mask[j, i] = True
            color[j, i] = palette[np.bincount(index[y0:y1, x0:x1][a]).argmax()]
    return mask, color


def top_remap(u):
    side, top = zip(*TOP_REMAP)
    return float(np.interp(u, side, top))


# Image grids are row = down the image, column = across it.
side_m, side_c = cells(frames["driver-side"], L, H)          # col: front->rear (+X..-X)
pass_m, pass_c = cells(frames["passenger-side"], L, H)       # col: rear->front
front_m, front_c = cells(frames["front"], W, H)              # col: -Y..+Y
rear_m, rear_c = cells(frames["rear"], W, H)                 # col: +Y..-Y
top_m, top_c = cells(frames["top"], W, L, top_remap)         # row: front->rear, col: +Y..-Y

# Voxel grid indexed [x, y, z]: x 0 = rear, y 0 = passenger (-Y), z 0 = ground.
S = side_m[::-1, ::-1].T            # [x, z]
F = front_m[::-1, :].T              # [y, z]
T = top_m[::-1, ::-1]               # [x, y]
solid = S[:, None, :] & F[None, :, :] & T[:, :, None]
labels, count = nd.label(solid)
solid = labels == (np.argmax(np.bincount(labels.ravel())[1:]) + 1)

# Pick one view per voxel from the smoothed surface normal, so stair-stepped
# slopes read as one painted surface instead of alternating stripes.
views_by_dir = {
    (1, 0, 0): (lambda x, y, z: (H - 1 - z, y), front_m, front_c),
    (-1, 0, 0): (lambda x, y, z: (H - 1 - z, W - 1 - y), rear_m, rear_c),
    (0, 1, 0): (lambda x, y, z: (H - 1 - z, L - 1 - x), side_m, side_c),
    (0, -1, 0): (lambda x, y, z: (H - 1 - z, x), pass_m, pass_c),
    (0, 0, 1): (lambda x, y, z: (L - 1 - x, W - 1 - y), top_m, top_c),
}
directions = np.array(list(views_by_dir) + [(0, 0, -1)], float)
smooth = nd.gaussian_filter(solid.astype(float), NORMAL_SIGMA)
normals = -np.stack(np.gradient(smooth), axis=-1)


# The roof sign: rows of the side view much shorter than the car.
SIGN_Z = min(z for z in range(int(S.sum(axis=0).argmax()), H) if S[:, z].sum() < 0.3 * L)


def voxel_color(x, y, z):
    if z >= SIGN_Z and normals[x, y, z, 2] > abs(normals[x, y, z]).max() * 0.7:
        # The top view paints the sign smaller than the side/front views
        # build it, so colour its lid from the side view, just under the outline.
        row = min(H - 1, H - z)
        if side_m[row, L - 1 - x]:
            return side_c[row, L - 1 - x]
    for k in np.argsort(-(directions @ normals[x, y, z])):
        d = tuple(int(c) for c in directions[k])
        if d == (0, 0, -1):
            return UNDERSIDE
        pixel, mask, color = views_by_dir[d]
        if mask[pixel(x, y, z)]:
            return color[pixel(x, y, z)]
    return UNDERSIDE


def greedy_rects(grid):
    """Split a 2D grid of colour ids (-1 = empty) into same-colour rectangles."""
    grid = grid.copy()
    nu, nv = grid.shape
    for i in range(nu):
        for j in range(nv):
            c = grid[i, j]
            if c < 0:
                continue
            dj = 1
            while j + dj < nv and grid[i, j + dj] == c:
                dj += 1
            di = 1
            while i + di < nu and (grid[i + di, j: j + dj] == c).all():
                di += 1
            grid[i: i + di, j: j + dj] = -1
            yield i, j, di, dj, c


padded = np.pad(solid, 1)
vertices, faces, colors = [], [], []
size = LENGTH_M / L
origin = np.array([-L / 2, -W / 2, 0.0])
dims = np.array([L, W, H])
cache = {}
palette_ids = {}
for normal in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]:
    n = np.array(normal)
    neighbour = padded[1 + n[0]: 1 + n[0] + L, 1 + n[1]: 1 + n[1] + W, 1 + n[2]: 1 + n[2] + H]
    axis = int(np.nonzero(n)[0][0])
    u, v = [a for a in range(3) if a != axis]
    # Colour-id grid per slice, so coplanar same-colour faces merge into one quad.
    slices = np.full((dims[axis], dims[u], dims[v]), -1)
    for voxel in np.argwhere(solid & ~neighbour):
        key = tuple(voxel)
        if key not in cache:
            cache[key] = tuple(int(c) for c in voxel_color(*key))
        cid = palette_ids.setdefault(cache[key], len(palette_ids))
        slices[voxel[axis], voxel[u], voxel[v]] = cid
    du, dv = np.eye(3)[u], np.eye(3)[v]
    flip = np.dot(np.cross(du, dv), n) < 0
    for layer, grid in enumerate(slices):
        for i, j, di, dj, cid in greedy_rects(grid):
            corner = np.zeros(3)
            corner[axis] = layer + (n[axis] > 0)
            corner[u], corner[v] = i, j
            quad = [corner, corner + di * du, corner + di * du + dj * dv, corner + dj * dv]
            base = len(vertices)
            vertices.extend((np.array(quad) + origin) * size)
            # Wind counter-clockwise when seen from outside.
            faces.extend([(base, base + 2, base + 1), (base, base + 3, base + 2)] if flip
                         else [(base, base + 1, base + 2), (base, base + 2, base + 3)])
            colors.extend([(*list(palette_ids)[cid], 255)] * 2)

vertices = np.array(vertices)
mesh = trimesh.Trimesh(
    vertices=vertices[:, [0, 2, 1]] * [1, 1, -1],  # CAD Z-up -> glTF Y-up
    faces=np.array(faces),
    face_colors=np.array(colors, np.uint8),
    process=False,
)
out = ROOT / "GLB" / "taxi-voxel.glb"
trimesh.Scene({"voxel_taxi": mesh}).export(out, file_type="glb")
# The web app's fleet map loads the same model.
(ROOT.parent / "public" / out.name).write_bytes(out.read_bytes())
print(f"Wrote {out.relative_to(ROOT)}: {L}x{W}x{H} voxels, {int(solid.sum())} filled, {len(faces)} triangles")
