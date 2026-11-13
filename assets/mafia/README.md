# Mafia council — Blender operative library

Eleven council characters with an anime-cyberpunk direction inspired by Oni's
tactical clothing and restrained luminous technology. Eight use the seated
Blender rig; Vanguard, Liaison and Veteran use downloaded static operative GLBs.
Their fidelity comes from smooth anatomy, layered garment construction, modeled
trim and physically based materials rather than deliberately retro geometry. No
Oni meshes, textures or other third-party character assets are used.

## Repository tracking

Only `runtime/` is tracked in git. The editable `characters/` source library is
intentionally not tracked; keep it in external storage or Git LFS. A clean clone,
CI build and the Flatpak/AppImage use only `runtime/`. The Vite build fails with
a clear error if the runtime exports are missing.

## Art direction and geometry

`scripts/mafia/stylize-oni.py` refines the original council bases into detailed
operatives. It retains dense skin and garment surfaces, merges the original hair
tubes into continuous sculpted hair with strand shading, adds clean eyebrow
geometry, and preserves skin pores, fabric weave, leather grain and brushed metal.

Layered chest armour has rounded bevels and weighted normals. Metallic piping,
chevrons, recessed fasteners, sleeve seams, collar edging and fitted asymmetric
pauldrons are actual geometry. Sleeveless identities omit shoulder armour. Small
operative lights retain each seat's dynamic colour.

The eight Blender characters are approximately 350–450K triangles with lossless
2048 × 2048 PBR maps. The three static operative GLBs are budgeted at 450K
triangles with 2048 × 2048 maps, matching the Blender cast. Source projects retain denser editable surfaces and non-destructive
subdivision. Skin uses subsurface scattering; fabric uses sheen; hair uses
anisotropic strand shading; eyes retain a clear coat.

| Index | Character | Design |
|---|---|---|
| 0 | Vanguard | Navy uniform, dark swept hair, red seat accent |
| 1 | Liaison | Pale tailored uniform, violet bob |
| 2 | Veteran | Silver hair, stubble and pale long jacket |
| 3 | Ember | Red ponytail, sleeveless burgundy uniform |
| 4 | Analyst | Pale uniform, olive hair and glasses |
| 5 | Navigator | Purple/navy coat and swept blond hair |
| 6 | Nightfall | Blue ponytail, sleeveless blue uniform |
| 7 | Sentinel | Broad slate armour, cropped hair and stubble |
| 8 | Courier | Rose uniform and mauve layered hair |
| 9 | Envoy | Pale coat, braids and glasses |
| 10 | Silver | Blue uniform and silver bob |

These are visual identities, **not hidden game roles**.

## Files

Each numbered directory under `characters/` contains:

- **`<name>.blend`** — editable detailed source, named surfaces, packed 2K maps,
  vertex pigments, UVs, lighting, camera and presentation chair.
- **`<name>.glb`** — self-contained glTF 2.0 character with the head/eye hierarchy.
- **`portrait.png` / `full-body.png`** — actual Blender Cycles renders.
- **`manifest.json`** — identity, polygon count and file metadata.

Open **`characters/index.html`** for the local gallery, or
**`characters/character-sheet.jpg`** for an overview of the full cast.

## Editing and integration

GameTable loads all eleven identities from `runtime/mafia-characters/`. The
Blender exports contain geometry, normals, tangents, UVs and `COLOR_0` pigment;
the three static operative GLBs contain geometry, normals, UVs and individual
PBR maps. Shared fabric/hair/leather/metal maps and individual skin maps are
local PNGs. Vite serves/copies only `runtime/` into the renderer build.
Characters load concurrently with progress and retry UI. The scene owns their
geometry, materials and shared textures and discards late loading results after
unmount. Hidden-role projections continue to control sleeping poses; appearance
is independent of roles.

The eight Blender characters use metric dimensions and the existing seated pose.
The three operative GLBs are decimated to the runtime triangle budget,
normalized to 1.9 m with their feet on the floor, and stand at their seats with
the council chair hidden. Blender uses Z-up; GLBs export Y-up for Three.js. The
studio chair, floor, lights and camera are excluded from character exports.

### Operative GLB replacements

Vanguard, Liaison and Veteran come from `Vanguard_Operative.glb`,
`Liaison_Operative.glb` and `Veteran_Operative.glb`. Rebuild the three runtime
characters with:

```bash
flatpak run --filesystem="$PWD" --filesystem=/tmp/opencode \
  --filesystem=/path/to/downloaded/models org.blender.Blender \
  --background --factory-startup --python-exit-code 1 \
  --python "$PWD/scripts/mafia/import-operative-glb.py" -- \
  /path/to/downloaded/models /tmp/opencode/mafia-operative
python3 scripts/mafia/merge-operative-runtime.py \
  /tmp/opencode/mafia-operative assets/mafia/runtime/mafia-characters
```

`import-operative-glb.py` joins the static mesh, decimates it to 450K triangles,
normalizes the height and floor position and exports a GLB.
`merge-operative-runtime.py` extracts the embedded maps, resizes them to 2048,
splits geometry into `.gltf`/`.bin` and updates the manifest without touching
the other eight characters. Pass lower `--triangles`/`--texture-size` values
only when building for weaker hardware.

`HeadPivot` controls the head. Named open-eye and closed-eye surface objects stay
separate. Closed-eye parts have `default_visible: false`, scale zero and an
`open_scale` extra. To display them in Blender, enable rendering and restore scale
to one while hiding the open-eye parts. This is a head/eye hierarchy, not a
full-body skeletal animation rig.

## Rebuild

From the repository root, regenerate the Blender bases and apply the fidelity pass:

```bash
npx esbuild scripts/mafia/export-blender-source.ts --bundle --platform=node --format=esm --outfile=/tmp/opencode/export-blender-source.mjs
node /tmp/opencode/export-blender-source.mjs
flatpak run --filesystem="$PWD" --filesystem=/tmp/opencode org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/build-characters.py" -- --output "$PWD/assets/mafia/characters"
flatpak run --filesystem="$PWD" org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/stylize-oni.py" -- --source "$PWD/assets/mafia/characters"
python3 scripts/mafia/validate-characters.py assets/mafia/characters
flatpak run --filesystem="$PWD" org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/inspect-blender-files.py" -- "$PWD/assets/mafia/characters"
python3 scripts/mafia/create-catalog.py assets/mafia/characters
```

Pass `--only 1` through `--only 11`, or e.g. `--only 3 4`, to the Blender build
and stylization commands to rebuild selected characters. `--samples` controls
Cycles preview quality. `--no-render` on the stylization command skips previews.
Geometry generation is deterministic; reference images are not embedded or used
as texture maps.

### Rebuild the in-game exports

```bash
flatpak run --filesystem="$PWD" --filesystem=/tmp/opencode org.blender.Blender --background --factory-startup --python-exit-code 1 --python "$PWD/scripts/mafia/export-runtime.py" -- --source "$PWD/assets/mafia/characters" --output /tmp/opencode/mafia-runtime
python3 scripts/mafia/package-runtime.py /tmp/opencode/mafia-runtime assets/mafia/runtime/mafia-characters
npm run check
npm run build
```

The asset regression tests parse the shipped glTF/buffers, check geometry and 2K
PBR surfaces, exercise the eye/head rig and verify texture/material ownership and
late disposal.

## License

Original GameTable geometry, Blender stylization and generated textures/previews:
MIT, under the repository's `LICENSE`. No third-party character assets are included.
