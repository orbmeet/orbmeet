"""
Orb Meet website hero: deep violet water, seen from above.

  blender -b --python water.py -- <out.png> <width> <height> <samples>

A calm sea under a violet evening sky: fine ripples, no horizon, nothing to
read but the surface, so the page's words sit on it cleanly.
"""
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
OUT, W, H, SAMPLES = argv[0], int(argv[1]), int(argv[2]), int(argv[3])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ── The sea ──────────────────────────────────────────────────────────────────
bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 0, 0))
sea = bpy.context.object
ocean = sea.modifiers.new("ocean", "OCEAN")
ocean.geometry_mode = "GENERATE"
ocean.resolution = 20
ocean.spatial_size = 140
ocean.repeat_x = 4
ocean.repeat_y = 4
ocean.size = 1.0
ocean.wave_scale = 0.7
ocean.wave_scale_min = 0.0
ocean.choppiness = 1.3
ocean.wind_velocity = 9.0
ocean.wave_alignment = 0.35
ocean.wave_direction = math.radians(30)
ocean.random_seed = 11
ocean.time = 4.0
bpy.ops.object.shade_smooth()
sea.location = (-280, -140, 0)

water = bpy.data.materials.new("water")
water.use_nodes = True
p = water.node_tree.nodes["Principled BSDF"]
# Almost black violet: what you see is the sky it reflects.
p.inputs["Base Color"].default_value = (0.02, 0.01, 0.07, 1)
p.inputs["Roughness"].default_value = 0.04
p.inputs["IOR"].default_value = 1.33
p.inputs["Specular IOR Level"].default_value = 0.6
# Capillary ripples on top of the swell: fine, stretched noise as bump, the
# texture the eye reads as "water" from far above.
wnt = water.node_tree
w_coord = wnt.nodes.new("ShaderNodeTexCoord")
w_map = wnt.nodes.new("ShaderNodeMapping")
w_map.inputs["Rotation"].default_value = (0, 0, math.radians(30))
w_map.inputs["Scale"].default_value = (0.9, 2.6, 1.0)
w_noise = wnt.nodes.new("ShaderNodeTexNoise")
w_noise.inputs["Scale"].default_value = 1.6
w_noise.inputs["Detail"].default_value = 6
w_noise.inputs["Roughness"].default_value = 0.6
w_bump = wnt.nodes.new("ShaderNodeBump")
w_bump.inputs["Strength"].default_value = 0.5
w_bump.inputs["Distance"].default_value = 0.2
wnt.links.new(w_coord.outputs["Object"], w_map.inputs["Vector"])
wnt.links.new(w_map.outputs["Vector"], w_noise.inputs["Vector"])
wnt.links.new(w_noise.outputs["Fac"], w_bump.inputs["Height"])
wnt.links.new(w_bump.outputs["Normal"], p.inputs["Normal"])
sea.data.materials.append(water)

# ── The sky it reflects ──────────────────────────────────────────────────────
# Overhead deep indigo, towards the horizon the brand's violet: since the
# camera looks down, wave faces tilted away catch the brighter low sky.
world = bpy.data.worlds.new("sky")
scene.world = world
world.use_nodes = True
nt = world.node_tree
coord = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
ramp = nt.nodes.new("ShaderNodeValToRGB")
stops = ramp.color_ramp.elements
stops[0].position = 0.0
stops[0].color = (0.46, 0.26, 1.0, 1)    # horizon: violet
stops[1].position = 0.85
stops[1].color = (0.11, 0.04, 0.32, 1)   # overhead: indigo
nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
bg = nt.nodes["Background"]
bg.inputs["Strength"].default_value = 2.3
nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])

# ── Camera ───────────────────────────────────────────────────────────────────
# Aerial: high enough that the waves become a fine, even texture.
bpy.ops.object.camera_add(location=(0, -20, 42))
cam = bpy.context.object
cam.rotation_euler = (Vector((0, 40, -42))).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = 50
scene.camera = cam

# ── Render ───────────────────────────────────────────────────────────────────
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.resolution_x = W
scene.render.resolution_y = H
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
