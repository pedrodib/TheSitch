"""Render a synthetic city tour using geometry exported from the production renderer.
Requires Python 3 + Pillow. Run: python3 scripts/demo/render-gif.py
"""
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
data = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/demo/export-city.cjs')], cwd=ROOT))
def font(size):
    for file in ['/System/Library/Fonts/Monaco.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:/Windows/Fonts/consola.ttf']:
        if Path(file).exists():
            return ImageFont.truetype(file, size)
    return ImageFont.load_default(size=size)
small, regular, title = font(11), font(14), font(25)
frames = []
for n, frame in enumerate(data['frames']):
    im = Image.new('RGB', (960, 640), '#111222')
    draw = ImageDraw.Draw(im)
    for y in range(640):
        draw.line((0,y,960,y), fill=(17 + int(y/95), 18 + int(y/180), 34 + int(y/40)))
    for x in range(-900, 1700, 48):
        draw.line((x,80,x+1000,580), fill='#28283f')
        draw.line((x,580,x+1000,80), fill='#28283f')
    for face in frame['faces']:
        draw.polygon([tuple(p) for p in face['points']], fill=face['color'])
    for x,y in frame['cars']:
        draw.rounded_rectangle((x-3,y-1,x+3,y+1), radius=1, fill='#a3f6ff')
    for label in frame['labels']:
        x,y = label['point']
        text = f"{label['name']}  /  {label['count']} PRs"
        box = draw.textbbox((0,0), text, font=small)
        width = box[2]+16
        draw.rounded_rectangle((x-width/2,y+3,x+width/2,y+25), radius=5, fill='#1c1e33', outline='#5c6284')
        draw.text((x-width/2+8,y+7), text, font=small, fill='#e0e5f5')
    # Presentation captions are intentionally outside the city; this is not a UI recording.
    draw.rectangle((0,0,960,80), fill='#131526')
    draw.text((30,18), 'THESITCH', font=title, fill='#9df1f5')
    draw.text((30,52), 'YOUR WORK, A LIVING CITY', font=small, fill='#b5b8d5')
    draw.text((655,23), 'SYNTHETIC CITY TOUR', font=regular, fill='#efa6e2')
    draw.text((655,48), f"6 repositories / {data['total']} merged PRs", font=small, fill='#bdc3db')
    draw.rectangle((0,580,960,640), fill='#131526')
    draw.text((30,594), 'ROTATE / ZOOM / EXPLORE', font=regular, fill='#e0e5f5')
    draw.text((30,617), 'Production city model. Fictitious contributions. Rendered preview.', font=small, fill='#9da6c5')
    draw.text((744,599), f"ZOOM {round(frame['zoom']*100)}%", font=regular, fill='#9df1f5')
    frames.append(im)
# A shared palette keeps neon colors stable during camera motion.
contact = Image.new('RGB', (960, 640 * 8))
for i in range(8): contact.paste(frames[i*12], (0,640*i))
palette = contact.quantize(colors=192)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
output = ROOT / 'artifacts/city-tour.gif'
indexed[0].save(output, save_all=True, append_images=indexed[1:], duration=125, loop=0, optimize=True, disposal=1)
frames[24].save(ROOT / 'artifacts/city-tour-poster.png')
print(f'{output}: {output.stat().st_size / 1024 / 1024:.2f} MiB, 96 frames, 12 seconds')
