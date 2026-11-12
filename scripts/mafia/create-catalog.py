"""Build a local preview gallery and contact sheet from the actual Cycles renders."""
import html
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

root = Path(sys.argv[1])
manifests = sorted(root.glob('*/manifest.json'))
assert len(manifests) == 11
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
try:
    title_font = ImageFont.truetype(font_path, 52)
    label_font = ImageFont.truetype(font_path, 28)
    small_font = ImageFont.truetype(font_path, 20)
except OSError:
    title_font, label_font, small_font = (ImageFont.load_default(size=s) for s in [52, 28, 20])
sheet = Image.new('RGB', (2048, 2048), '#111824')
draw = ImageDraw.Draw(sheet)
draw.text((48, 35), 'MAFIA / CHARACTER LIBRARY', fill='#edf3fb', font=title_font)
draw.text((50, 108), 'BLENDER 5.2  /  HIGH FIDELITY  /  2K PBR', fill='#99b5d4', font=small_font)
cards = []
for i, path in enumerate(manifests):
    manifest = json.loads(path.read_text())
    x = (i % 4) * 512 + 24
    y = (i // 4) * 610 + 175
    portrait = Image.open(path.parent / 'portrait.png').convert('RGB')
    thumb = ImageOps.fit(portrait, (464, 510), centering=(0.5, 0.3))
    sheet.paste(thumb, (x, y))
    title = f'{i + 1:02d}  {manifest["name"].title()}'
    draw.text((x, y + 520), title, fill='#edf3fb', font=label_font)
    draw.text((x, y + 558), f'{manifest["triangles"]:,} triangles', fill='#99b5d4', font=small_font)
    folder = path.parent.name
    cards.append(f'''<article><a href="{folder}/portrait.png"><img src="{folder}/portrait.png" alt="{html.escape(title)} — Blender Cycles render" loading="lazy"></a>
      <h2>{html.escape(title)}</h2><p>{manifest['triangles']:,} triangles · 2K PBR</p><nav>
      <a href="{folder}/{manifest['blend']}" download>Blender source</a>
      <a href="{folder}/{manifest['glb']}" download>GLB export</a>
      <a href="{folder}/full-body.png">Full body</a></nav></article>''')
sheet.save(root / 'character-sheet.jpg', quality=94)
(root / 'index.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mafia — Blender character library</title><style>
body{margin:0;padding:36px;background:#111824;color:#edf3fb;font:16px system-ui,sans-serif}header{max-width:900px;margin-bottom:36px}h1{font-size:36px;letter-spacing:.02em}p{color:#a8bdd3;line-height:1.6}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}article{background:#1a2534;border:1px solid #304158;border-radius:12px;overflow:hidden;padding-bottom:22px}img{width:100%;display:block}h2,article p,nav{margin-left:18px;margin-right:18px}h2{font-size:21px}nav{display:flex;gap:12px;flex-wrap:wrap}a{color:#9ed2ff}footer{margin-top:32px;color:#a8bdd3}
</style><header><h1>MAFIA / CHARACTER LIBRARY</h1><p>Eleven editable high-fidelity Blender operatives with sculpted hair, layered cyberpunk tailoring, modeled trim and packed 2K PBR materials. The images below are actual Cycles renders.</p><a href="character-sheet.jpg">Character sheet</a> · <a href="../README.md">Asset documentation</a></header><main>'''
    + '\n'.join(cards) + '</main><footer>Original models · MIT license · Visual identities are independent of hidden game roles.</footer></html>')
print(f'Gallery: {root / "index.html"}')
print(f'Contact sheet: {root / "character-sheet.jpg"}')
