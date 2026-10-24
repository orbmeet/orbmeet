"""
Orb Meet website imagery: one quiet room, seen from three cameras.

  blender -b --python scene.py -- <shot> <out.png> <width> <height> <samples>

build.sh renders every shot and exports them for the page.

Shots: orb, board, recap. (The hero is water.py.)
"""
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
SHOT, OUT, W, H, SAMPLES = argv[0], argv[1], int(argv[2]), int(argv[3]), int(argv[4])

# ── Reset ────────────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, color, roughness=0.6, **extra):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = roughness
    for key, value in extra.items():
        p.inputs[key].default_value = value
    return m


def box(name, size, location, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 4
        bpy.ops.object.shade_smooth()
    o.data.materials.append(mat)
    return o


def noise_bump(m, scale, strength):
    """A faint surface grain, so walls and wood are not CG-flat."""
    nt = m.node_tree
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = 8
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], nt.nodes["Principled BSDF"].inputs["Normal"])


def wood(name):
    """Pale oak: stretched noise for grain, mixed between two warm tones."""
    m = material(name, (0.55, 0.42, 0.30), roughness=0.45)
    nt = m.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0, 18.0, 1.0)
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 3.0
    tex.inputs["Detail"].default_value = 10
    tex.inputs["Distortion"].default_value = 0.6
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.46, 0.33, 0.22, 1)
    ramp.color_ramp.elements[1].color = (0.70, 0.56, 0.41, 1)
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    return m


# ── Materials ────────────────────────────────────────────────────────────────
plaster = material("plaster", (0.74, 0.70, 0.64), roughness=0.92)
noise_bump(plaster, 40, 0.04)
floor_mat = material("floor", (0.24, 0.23, 0.22), roughness=0.32)
noise_bump(floor_mat, 25, 0.03)
oak = wood("oak")
frame_mat = material("frame", (0.05, 0.05, 0.055), roughness=0.5)
paper = material("paper", (0.86, 0.85, 0.82), roughness=0.85)
ink = material("ink", (0.03, 0.03, 0.035), roughness=0.6)
violet_ink = material("violet_ink", (0.20, 0.10, 0.75), roughness=0.5)
graphite = material("graphite", (0.30, 0.30, 0.32), roughness=0.5)
pencil_mat = material("pencil", (0.10, 0.10, 0.11), roughness=0.4)

# The orb, as the mark draws it: a deep violet marble, lit by the window from
# the upper left. Light enters a little way (subsurface) so it glows at the
# edge of its shadow, and a clear coat catches the window. A faint inner glow
# keeps its colour alive in shade and tints the table beneath it.
glass = material(
    "orb",
    (0.11, 0.035, 0.72),
    roughness=0.16,
    **{
        "Subsurface Weight": 0.45,
        "Subsurface Radius": (0.6, 0.35, 1.0),
        "Subsurface Scale": 0.05,
        "Coat Weight": 1.0,
        "Coat Roughness": 0.02,
        "Coat IOR": 1.5,
        "Emission Color": (0.30, 0.16, 1.0, 1),
        "Emission Strength": 0.18,
    },
)

# ── Room ─────────────────────────────────────────────────────────────────────
# Floor at z=0, back wall at y=5, window wall at x=-4, ceiling at 3.4.
box("floor", (14, 14, 0.1), (0, 1, -0.05), floor_mat)
box("back_wall", (14, 0.2, 4), (0, 5.1, 2), plaster)
box("right_wall", (0.2, 14, 4), (4.6, 1, 2), plaster)
box("ceiling", (14, 14, 0.2), (0, 1, 3.5), plaster)

# Window wall: solid below and above the opening, mullions across it.
sill, head = 0.45, 3.1
box("win_below", (0.3, 14, sill), (-4.15, 1, sill / 2), plaster)
box("win_above", (0.3, 14, 3.4 - head), (-4.15, 1, (head + 3.4) / 2), plaster)
for i, y in enumerate([-5.0, -3.8, -2.6, -1.4, -0.2, 1.0, 2.2, 3.4]):
    box(f"mullion_{i}", (0.12, 0.07, head - sill), (-4.05, y, (sill + head) / 2), frame_mat)
box("transom", (0.12, 10.5, 0.06), (-4.05, -1.25, 2.35), frame_mat)
# Beyond the window range the wall continues.
box("win_wall_front", (0.3, 4, 3.4), (-4.15, -8.5, 1.7), plaster)
box("win_wall_back", (0.3, 2, 3.4), (-4.15, 5.0, 1.7), plaster)

# Table: a long low oak slab on two plinths.
box("table_top", (3.2, 1.1, 0.06), (0.4, 2.4, 0.74), oak, bevel=0.008)
box("leg_left", (0.12, 0.9, 0.71), (-0.9, 2.4, 0.355), oak, bevel=0.004)
box("leg_right", (0.12, 0.9, 0.71), (1.7, 2.4, 0.355), oak, bevel=0.004)

# The orb on the table.
ORB = Vector((1.15, 2.25, 0.77 + 0.13))
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.13, segments=96, ring_count=48, location=ORB)
bpy.ops.object.shade_smooth()
bpy.context.object.data.materials.append(glass)

# A recap on the table: two sheets, grey lines for text, and a pencil.
def sheet(name, loc, rot, lines):
    s = box(name, (0.21, 0.297, 0.002), loc, paper)
    s.rotation_euler[2] = rot
    c, sn = math.cos(rot), math.sin(rot)
    for i, width in enumerate(lines):
        if not width:
            continue
        lx, ly = -0.085 + width / 2, 0.11 - i * 0.022
        world = (loc[0] + lx * c - ly * sn, loc[1] + lx * sn + ly * c, loc[2] + 0.0012)
        bar = box(f"{name}_line{i}", (width, 0.0032, 0.0003), world, graphite)
        bar.rotation_euler[2] = rot
    return s

sheet("sheet_a", (0.0, 2.37, 0.7715), math.radians(-8),
      [0.12, 0.17, 0.16, 0.14, 0, 0.17, 0.15, 0.09, 0, 0.16, 0.13])
sheet("sheet_b", (0.17, 2.46, 0.7745), math.radians(11), [0.10, 0.16, 0.17, 0.12, 0.15, 0, 0.14, 0.16])
bpy.ops.mesh.primitive_cylinder_add(radius=0.0045, depth=0.17, location=(0.27, 2.27, 0.7765))
pencil = bpy.context.object
pencil.rotation_euler = (math.radians(90), 0, math.radians(68))
pencil.data.materials.append(pencil_mat)

# A board leaning on the back wall, with a sign-up flow drawn on it.
BOARD = Vector((-1.9, 4.85, 1.55))
board = box("board", (2.2, 0.03, 1.4), BOARD, paper, bevel=0.004)

import random
random.seed(7)

def wobble(points, step=0.03, amount=0.0035):
    """Marker strokes are never ruled: subdivide and nudge every point."""
    out = []
    for (x0, z0), (x1, z1) in zip(points, points[1:]):
        n = max(1, int(math.hypot(x1 - x0, z1 - z0) / step))
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t + random.uniform(-amount, amount),
                        z0 + (z1 - z0) * t + random.uniform(-amount, amount)))
    out.append(points[-1])
    return out

def stroke(points, mat, thickness=0.012):
    points = wobble(points)
    curve = bpy.data.curves.new("stroke", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = thickness / 2
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for p, (x, z) in zip(spline.points, points):
        p.co = (BOARD.x + x, BOARD.y - 0.02, BOARD.z + z, 1)
    o = bpy.data.objects.new("stroke", curve)
    scene.collection.objects.link(o)
    o.data.materials.append(mat)
    return o

def rect(cx, cz, w, h, mat):
    stroke([(cx - w / 2, cz - h / 2), (cx + w / 2, cz - h / 2), (cx + w / 2, cz + h / 2),
            (cx - w / 2, cz + h / 2), (cx - w / 2, cz - h / 2)], mat)

def arrow(x0, x1, z, mat):
    stroke([(x0, z), (x1, z)], mat)
    stroke([(x1 - 0.05, z + 0.035), (x1, z), (x1 - 0.05, z - 0.035)], mat)

for i, cx in enumerate([-0.7, 0.0, 0.7]):
    rect(cx, 0.25, 0.42, 0.22, ink)
    rect(cx, -0.25, 0.42, 0.22, violet_ink if i else ink)
arrow(-0.47, -0.23, 0.25, ink)
arrow(0.23, 0.47, 0.25, ink)
arrow(-0.47, -0.23, -0.25, violet_ink)
arrow(0.23, 0.47, -0.25, violet_ink)

# ── Light ────────────────────────────────────────────────────────────────────
world = bpy.data.worlds.new("world")
scene.world = world
world.use_nodes = True
sky = world.node_tree.nodes.new("ShaderNodeTexSky")
sky.sky_type = "MULTIPLE_SCATTERING"
sky.sun_elevation = math.radians(28)
sky.sun_rotation = math.radians(200)
bg = world.node_tree.nodes["Background"]
bg.inputs["Strength"].default_value = 0.12
world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])

bpy.ops.object.light_add(type="SUN", location=(-8, -2, 6))
sun = bpy.context.object
sun.data.energy = 7.0
sun.data.angle = math.radians(0.8)
sun.data.color = (1.0, 0.92, 0.80)
# From the window side, a little from the front, falling at ~28°: the mullions
# throw their shadows across the floor and up the back wall.
travel = Vector((0.55, 0.80, -0.20)).normalized()
sun.rotation_euler = travel.to_track_quat("-Z", "Y").to_euler()

# ── Cameras ──────────────────────────────────────────────────────────────────
SHOTS = {
    # Wide and calm: the room, the light, and the orb small on the table.
    # The orb close, the table soft behind it.
    "orb": dict(loc=(2.05, 1.25, 1.02), look=ORB, lens=85, focus=ORB, fstop=2.2),
    # The board on the wall, light across it.
    "board": dict(loc=(-1.2, 1.4, 1.6), look=(-1.9, 4.85, 1.5), lens=45, focus=(-1.9, 4.8, 1.5), fstop=5.6),
    # The recap on the table, from above, the orb's light at the edge.
    "recap": dict(loc=(0.09, 1.95, 1.32), look=(0.09, 2.42, 0.77), lens=40, focus=(0.09, 2.42, 0.77), fstop=4),
}
shot = SHOTS[SHOT]
bpy.ops.object.camera_add(location=shot["loc"])
cam = bpy.context.object
direction = Vector(shot["look"]) - Vector(shot["loc"])
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
cam.data.lens = shot["lens"]
cam.data.dof.use_dof = True
cam.data.dof.focus_distance = (Vector(shot["focus"]) - Vector(shot["loc"])).length
cam.data.dof.aperture_fstop = shot["fstop"]
scene.camera = cam

# ── Render ───────────────────────────────────────────────────────────────────
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 8
scene.cycles.transmission_bounces = 8
scene.render.resolution_x = W
scene.render.resolution_y = H
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = 0.0
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
