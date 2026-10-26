"""Put the character sheet's matching views onto the taxi as GLB decals."""

from pathlib import Path

import trimesh
from PIL import Image
from trimesh.visual import TextureVisuals
from trimesh.visual.material import PBRMaterial


ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def crop(source, name, box):
    image = Image.open(source).convert("RGBA").crop(box)
    image.save(ASSETS / f"{name}.png")
    return image


sheet = ROOT.parent / "public" / "taxi-character-sheet.png"
sprite = ROOT.parent / "public" / "taxi-sprite.png"
front = crop(sheet, "front", (15, 195, 350, 545))
driver_side = crop(sheet, "driver-side", (340, 190, 855, 545))
rear = crop(sheet, "rear", (860, 190, 1195, 545))
passenger_side = crop(sheet, "passenger-side", (1200, 190, 1725, 545))
top = crop(sprite, "top", (130, 55, 490, 635))

scene = trimesh.load(ROOT / "GLB" / "taxi.glb", force="scene")


def decal(name, image, vertices, faces, uv):
    material = PBRMaterial(
        name=f"{name}_pixel_art",
        baseColorTexture=image,
        metallicFactor=0.0,
        roughnessFactor=1.0,
        alphaMode="BLEND",
        doubleSided=True,
    )
    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=faces,
        process=False,
    )
    mesh.visual = TextureVisuals(uv=uv, material=material)
    scene.add_geometry(mesh, geom_name=name, node_name=f"pixel_art_{name}")


# glTF's image origin is upper-left; flip V so the source art stays upright.
uv = [(0, 0), (1, 0), (1, 1), (0, 1)]

# The GLB uses metres and Y-up.  These planes sit just outside the matching
# exterior surfaces; alpha in the source art leaves the taxi visible around it.
x0, x1 = -0.0348, 0.0348
y0, y1 = 0.0020, 0.0308
z0, z1 = -0.0189, 0.0189
side_faces_plus = [(0, 2, 1), (0, 3, 2)]  # outward toward -Z
side_faces_minus = [(0, 1, 2), (0, 2, 3)]  # outward toward +Z

# Driver side is the +Y CAD side (GLB -Z); its source view faces left.
decal(
    "driver_side",
    driver_side,
    [(x0, y0, -0.0191), (x1, y0, -0.0191), (x1, y1, -0.0191), (x0, y1, -0.0191)],
    side_faces_plus,
    uv,
)
# Passenger side uses the opposing profile, oriented to the same forward end.
decal(
    "passenger_side",
    passenger_side,
    [(x0, y0, 0.0191), (x1, y0, 0.0191), (x1, y1, 0.0191), (x0, y1, 0.0191)],
    side_faces_minus,
    uv,
)

# Front and rear views are across vehicle width, with image top at vehicle roof.
decal(
    "front",
    front,
    [(0.0358, y0, z0), (0.0358, y0, z1), (0.0358, y1, z1), (0.0358, y1, z0)],
    [(0, 1, 2), (0, 2, 3)],
    uv,
)
decal(
    "rear",
    rear,
    [(-0.0356, y0, z1), (-0.0356, y0, z0), (-0.0356, y1, z0), (-0.0356, y1, z1)],
    [(0, 2, 1), (0, 3, 2)],
    uv,
)

# Top view front is at the top of the image, toward +X.
decal(
    "top",
    top,
    [(-0.0348, 0.0310, -0.0187), (-0.0348, 0.0310, 0.0187), (0.0348, 0.0310, 0.0187), (0.0348, 0.0310, -0.0187)],
    [(0, 1, 2), (0, 2, 3)],
    uv,
)

scene.export(ROOT / "GLB" / "taxi-pixel-views.glb", file_type="glb")
print("Wrote GLB/taxi-pixel-views.glb with front, rear, both side, and top views")
