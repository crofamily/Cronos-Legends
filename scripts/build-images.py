"""Builds the website's image derivatives from the originals in /Images into /assets/img.

Dev-only (not deployed). Re-run after replacing any original:  python scripts/build-images.py
Requires Pillow with WebP support.
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "Images")
OUT = os.path.join(ROOT, "assets", "img")


def load(rel):
    return Image.open(os.path.join(SRC, rel)).convert("RGBA")


def save_webp(img, rel, width=None, height=None, quality=80, crop=None):
    """Resize to `width` (keeping aspect) or cover-crop to width x height, then save WebP."""
    if crop:
        img = img.crop(crop)
    if width and height:
        src_ratio = img.width / img.height
        dst_ratio = width / height
        if src_ratio > dst_ratio:  # too wide: trim sides
            new_w = int(img.height * dst_ratio)
            x = (img.width - new_w) // 2
            img = img.crop((x, 0, x + new_w, img.height))
        else:  # too tall: trim from the top third, keeping faces
            new_h = int(img.width / dst_ratio)
            y = int((img.height - new_h) * 0.3)
            img = img.crop((0, y, img.width, y + new_h))
        img = img.resize((width, height), Image.LANCZOS)
    elif width and img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    has_alpha = img.mode == "RGBA" and img.getextrema()[3][0] < 255
    (img if has_alpha else img.convert("RGB")).save(path, "WEBP", quality=quality, method=6)
    return path


def variants(rel_src, name, widths, **kw):
    img = load(rel_src)
    for w in widths:
        save_webp(img, f"{name}-{w}.webp", width=w, **kw)


# --- Characters used across the site -----------------------------------------------------------
variants("LA2/G1.webp", "art/guardian-king", [480, 800])
variants("LA2/C3.webp", "art/chaos-archer", [480, 800])
variants("LA2/G3.webp", "art/guardian-crowned", [480, 800])
variants("LA2/C2.webp", "art/chaos-warrior", [480, 800])
variants("LA2/T1.png", "art/trinari-sprout", [480, 800])
variants("LA1/Chaos Legion (2).jpg", "art/chaos-legion", [480, 800, 1200])
variants("LA1/Cronos Titans (2).jpg", "art/cronos-titans", [480, 800, 1200])
variants("LA1/Horde Creatures (1).jpg", "art/horde-creatures", [480, 800, 1200])
variants("PreviewLAII/1.jpg", "art/la2-preview", [480, 800, 1200])
variants("trinarigame.jpg", "art/trinari-defense", [480, 800])
variants("trinari-logo.jpg", "art/trinari-forest", [480, 800])
variants("totem-collection.jpg", "art/totems-trio", [800, 1200])
variants("peace-collection.jpg", "art/totem-of-peace", [480, 800])
for f in ["guardiant.png", "chaost.png", "trinarit.png"]:
    variants(f, "art/" + {"guardiant.png": "totems-guardians", "chaost.png": "totems-chaos", "trinarit.png": "totems-trinari"}[f], [800, 1200])

# --- Trinari: Elderborn --------------------------------------------------------------------------
for i in range(1, 6):
    variants(f"TrinariElderborn/{i}.png", f"elderborn/elderborn-{i}", [360, 720])
variants("TrinariElderborn/T54.png", "elderborn/elderborn-t54", [360, 720, 960])

# --- Legends Awaken I divisions (16) -------------------------------------------------------------
LA1 = {
    "Abyss Beasts (1).jpg": "abyss-beasts", "Celeastial Beasts (4).jpg": "celestial-beasts",
    "Celestial Vanguard (2).jpg": "celestial-vanguard", "Chaos Legion (2).jpg": "chaos-legion",
    "Chaos Vanguard (3).jpg": "chaos-vanguard", "Cronos Titans (2).jpg": "cronos-titans",
    "Deathsworn (1).jpg": "deathsworn", "Empyrean Ascendants (1).jpg": "empyrean-ascendants",
    "Frostbound Horde (1).jpg": "frostbound-horde", "Horde Creatures (1).jpg": "horde-creatures",
    "Icelyn Frostguard (2).jpg": "icelyn-frostguard", "Nightshade Warden (1).jpg": "nightshade-warden",
    "Oceanic Guardians (1).jpg": "oceanic-guardians", "Shadowbark (1).jpg": "shadowbark",
    "Solar Vanguard (2).jpg": "solar-vanguard", "Verdant Guardians (2).jpg": "verdant-guardians",
}
for f, slug in LA1.items():
    save_webp(load(f"LA1/{f}"), f"la1/{slug}-320.webp", width=320, height=320)

# --- Legends Awaken II divisions (C1-C7, G1-G7, T1-T3) -------------------------------------------
for f in sorted(os.listdir(os.path.join(SRC, "LA2"))):
    base = os.path.splitext(f)[0].lower()
    save_webp(load(f"LA2/{f}"), f"la2/{base}-400.webp", width=400, height=400)

# --- Totems of Power (9) -------------------------------------------------------------------------
for f in sorted(os.listdir(os.path.join(SRC, "Totems"))):
    if f.lower().endswith(".png"):
        base = os.path.splitext(f)[0].lower()
        save_webp(load(f"Totems/{f}"), f"totems/{base}-400.webp", width=400, height=600)


# --- Social share images (1200x630) -------------------------------------------------------------
def font(size, bold=True):
    for name in (["georgiab.ttf", "timesbd.ttf"] if bold else ["georgia.ttf", "times.ttf"]):
        p = os.path.join(r"C:\Windows\Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def og(name, headline, sub, art, bg_top=(22, 20, 44), bg_bottom=(9, 10, 16)):
    W, H = 1200, 630
    canvas = Image.new("RGB", (W, H))
    top, bot = bg_top, bg_bottom
    for y in range(H):
        t = y / H
        ImageDraw.Draw(canvas).line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((680, 40, 1260, 620), fill=(242, 185, 59, 70))
    canvas.paste(glow.filter(ImageFilter.GaussianBlur(90)), (0, 0), glow.filter(ImageFilter.GaussianBlur(90)))
    # Art cards on the right: side cards first, the centre card last so it sits on top.
    slots = {3: [(640, 70), (880, 70), (740, 20)], 2: [(660, 60), (860, 90)], 1: [(760, 60)]}[len(art)]
    order = [0, 2, 1] if len(art) == 3 else list(range(len(art)))
    for slot, i in zip(slots, order):
        rel, angle, size, dy = art[i]
        im = load(rel)
        side = min(im.width, im.height)
        im = im.crop(((im.width - side) // 2, (im.height - side) // 2, (im.width + side) // 2, (im.height + side) // 2)).resize((size, size), Image.LANCZOS)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius=28, fill=255)
        card = Image.new("RGBA", (size + 8, size + 8), (0, 0, 0, 0))
        ImageDraw.Draw(card).rounded_rectangle((0, 0, size + 7, size + 7), radius=32, fill=(242, 185, 59, 255))
        card.paste(im, (4, 4), mask)
        card = card.rotate(angle, resample=Image.BICUBIC, expand=True)
        canvas.paste(card, (slot[0], slot[1] + dy), card)
    logo = load("clg-logo.png")
    logo.thumbnail((92, 92))
    canvas.paste(logo, (64, 64), logo)
    d = ImageDraw.Draw(canvas)
    d.text((172, 88), "CRONOS LEGENDS", font=font(34), fill=(242, 185, 59))
    y = 230
    for line in headline.split("\n"):
        d.text((64, y), line, font=font(64), fill=(244, 239, 230))
        y += 76
    d.text((64, y + 18), sub, font=font(28, bold=False), fill=(196, 191, 208))
    d.text((64, 560), "cronoslegends.com", font=font(24, bold=False), fill=(142, 138, 163))
    path = os.path.join(OUT, "og", f"{name}.jpg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    canvas.save(path, "JPEG", quality=84, optimize=True, progressive=True)


og("home", "Three factions.\nOne realm.", "Collect the legends. Hold $CLG.", [("LA2/G1.webp", 7, 270, 40), ("TrinariElderborn/T54.png", 0, 320, 0), ("LA2/C3.webp", -7, 270, 40)])
og("burn", "Burn a legend.\nReceive $CLG.", "One transaction. Priced on-chain.", [("LA1/Horde Creatures (1).jpg", 6, 320, 30), ("LA1/Cronos Titans (2).jpg", -6, 320, 60)])
og("clg", "500 $CLG.\nThat's all, ever.", "Fixed supply. Ownership renounced.", [("clg-logo.png", 0, 380, 0)])
og("elderborn", "Meet the\nElderborn.", "212 playable Trinari on crovia.app", [("TrinariElderborn/4.png", 7, 270, 40), ("TrinariElderborn/T54.png", 0, 320, 0), ("TrinariElderborn/2.png", -7, 270, 40)], bg_top=(46, 40, 20))

total = 0
for dirpath, _, files in os.walk(OUT):
    for f in files:
        total += os.path.getsize(os.path.join(dirpath, f))
print(f"assets/img: {total / 1024 / 1024:.2f} MB")
