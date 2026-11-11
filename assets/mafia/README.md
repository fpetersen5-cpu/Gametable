# Mafia council — Blender character library

Eleven original, seated security-council characters, developed from GameTable's
original blockouts in Blender 5.2. The visual direction is the supplied sci-fi
council reference pack in `Hentet/mafia_3d_visual_references`.

## Repository tracking

Only `runtime/` is tracked in git: 251 MB across 68 files, all below GitHub's
100 MB per-file limit. The editable `characters/` source library (1.9 GB of
`.blend`, `.glb`, portraits and texture maps) is intentionally **not** tracked;
keep it in external storage or Git LFS. A clean clone, CI build and the
Flatpak/AppImage use only `runtime/`. The Vite build fails with a clear error if
the runtime exports are missing.

## Files

Each numbered directory under `characters/` (the external source library)
contains:

- **`<name>.blend`** — editable high-poly source, packed textures, non-destructive
  subdivision, named surface objects, lighting, camera and presentation chair.
- **`<name>.glb`** — self-contained glTF 2.0 character with evaluated high-poly
  surfaces, UVs, vertex pigment, PBR textures and head/eye hierarchy.
- **`portrait.png` / `full-body.png`** — actual Blender Cycles renders.
- **`textures/`** — that identity's 2048 × 2048 skin maps.
- **`manifest.json`** — identity, polygon count and file metadata.

`characters/textures/` holds the shared 2K fabric, hair, leather and brushed-metal
maps. Every material has base colour, roughness and an OpenGL tangent-space normal
map. Pigment is stored as a named colour attribute, so uniform panels and skin
tones stay editable independently of their surface detail. The GLBs pack
roughness into the standard metallic/roughness texture and carry pigment as
`COLOR_0`.

All texture images are packed inside **each** `.blend` and `.glb`; individual
character files can be moved without breaking their materials.

In the external source library, open **`characters/index.html`** for the local
gallery and direct file links, or **`characters/character-sheet.jpg`** for an
overview of the full cast.

| Index | Character | Design |
|---|---|---|
| 0 | Vanguard | Broad navy armour, red trim, swept dark hair |
| 1 | Liaison | Pale tailored uniform, violet bob |
| 2 | Veteran | Silver hair, subtle stubble and pale long jacket |
| 3 | Ember | Red ponytail, sleeveless dark uniform |
| 4 | Analyst | Pale uniform, olive hair and glasses |
| 5 | Navigator | Purple/navy coat and swept blond hair |
| 6 | Nightfall | Blue ponytail, sleeveless blue uniform |
| 7 | Sentinel | Broad slate armour, cropped hair and stubble |
| 8 | Courier | Rose uniform and mauve layered hair |
| 9 | Envoy | Pale coat, braids and glasses |
| 10 | Silver | Blue uniform and silver bob |

These are visual identities, **not hidden game roles**.

## Editing and integration

GameTable loads all eleven Blender-derived identities from
`runtime/mafia-characters/`. These are separately budgeted game exports with
the Blender skin/shoulder/face refinements, vertex pigment, UVs and eye rig intact.
Source subdivision is evaluated before surface budgeting, preserving the smoothed
Blender contours instead of simplifying the coarse control cage. Faces retain up
to 120,000 triangles, hair 80,000 and the main garment/skin surfaces 100,000 each.
Runtime PBR maps are lossless 2048 × 2048; identical maps are content-addressed and
shared across seats. The editable high-poly sources retain their packed 2K maps.

`scripts/mafia/runtime-surfaces.py` authors the upgraded game textures: irregular
skin pores and individual pigmentation, woven fabric, fine hair strands, leather
grain and brushed metal. Each identity has its own skin base-colour, roughness
and normal maps. Shared clothing maps are multiplied by each model's original
vertex pigment. Exported tangents keep normal-map shading aligned to the UVs.

Vite serves/copies only `runtime/` into the renderer build. All runtime files are
local, including in Electron/Flatpak. Characters load sequentially with progress
and retry UI. The scene owns their geometry/materials and shared textures, and
discards late loading results after unmount. Hidden-role projections continue to
control sleeping poses; appearance is assigned independently of game roles.

Open a `.blend` in Blender and select objects by their surface names (`Skin`,
`Fabric`, `Hair`, etc.). Skin is voxel-unified and relaxed in Blender; it has a
new smart-unwrapped UV set. Garments and hair retain intentionally tiled surface
UVs. The `High-poly surface refinement` modifiers remain editable.

Models use metric dimensions and the existing seated pose: feet at zero,
hands near the 1.16 m tabletop. Blender uses Z-up; GLBs export Y-up for Three.js.
The studio chair, floor, lights and camera are excluded from GLB exports.

`HeadPivot` controls the head. Named open-eye and closed-eye surface objects stay
separate. Closed-eye parts have `default_visible: false`, scale zero and an
`open_scale` extra. To display them in Blender, enable rendering and restore
scale to one while hiding the open-eye parts. This is a head/eye hierarchy, not a
full-body skeletal animation rig.

## Rebuild

From the repository root:

```bash
npx esbuild scripts/mafia/export-blender-source.ts --bundle --platform=node --format=esm --outfile=/tmp/opencode/export-blender-source.mjs
node /tmp/opencode/export-blender-source.mjs
flatpak run --filesystem="$PWD" --filesystem=/tmp/opencode org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/build-characters.py" -- --output "$PWD/assets/mafia/characters"
python3 scripts/mafia/validate-characters.py assets/mafia/characters
flatpak run --filesystem="$PWD" org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/inspect-blender-files.py" -- "$PWD/assets/mafia/characters"
python3 scripts/mafia/create-catalog.py assets/mafia/characters
```

Pass `--only 1` through `--only 11` to build one character, or e.g. `--only 3 4`
to rebuild selected characters. `--samples` controls
the Cycles preview quality. `--render-only` refreshes the studio and previews from
the saved `.blend` sources without rebuilding geometry or GLB exports.
Geometry generation and textures are deterministic;
the reference images are not embedded or used as texture maps.
The catalogue generator uses Pillow; the Blender build uses Blender's bundled NumPy.
Install the non-Blender helpers with
`python3 -m pip install -r scripts/mafia/requirements.txt`.

### Rebuild the in-game exports

```bash
flatpak run --filesystem="$PWD" --filesystem=/tmp/opencode org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/export-runtime.py" -- --source "$PWD/assets/mafia/characters" --output /tmp/opencode/mafia-runtime
python3 scripts/mafia/package-runtime.py /tmp/opencode/mafia-runtime assets/mafia/runtime/mafia-characters
npm run check
npm run build
```

The asset regression tests parse the shipped glTF/buffers, check texture sizes,
exercise the eye/head rig and verify shared texture ownership and late disposal.

## License

Original GameTable geometry, Blender refinements and generated textures: MIT,
under the repository's `LICENSE`. No third-party character assets are included.
