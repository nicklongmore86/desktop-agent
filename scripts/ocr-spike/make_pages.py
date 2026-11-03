"""SPIKE: renders test page images with known text for the Windows OCR spike.

    python make_pages.py <out-dir>

Writes RGBA PNGs (what the PDF worker hands on: PDFium renders RGBA, encoded as PNG) at
several long edges, plus manifest.json with the expected text of each. Deterministic.
"""

import io
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

LONG_EDGES = [1568, 2200, 3300]
WIN_FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
FONT_CANDIDATES = {
    "serif": [os.path.join(WIN_FONTS, "times.ttf"),
              "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"],
    "sans": [os.path.join(WIN_FONTS, "arial.ttf"),
             "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"],
    "sans-bold": [os.path.join(WIN_FONTS, "arialbd.ttf"),
                  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"],
}


def font(kind, size):
    for path in FONT_CANDIDATES[kind]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit(f"no {kind} font found")


WORDS = (
    "the contractor shall provide all labour materials and equipment required to complete "
    "works described in this specification including concrete reinforcement formwork "
    "drainage insulation membrane screed blockwork cladding roofing joinery finishes "
    "existing structure must be surveyed before demolition starts any defects found shall "
    "be reported to the engineer within seven days submittals include shop drawings "
    "samples and method statements temporary works design remains the responsibility of "
    "the contractor tolerances for floor flatness are measured over three metres all "
    "fixings to be stainless steel grade unless otherwise noted fire stopping at every "
    "penetration through compartment walls warranty period of twelve months from practical "
    "completion retention released after defects liability period"
).split()


def prose(seed, paragraphs=9):
    rng = random.Random(seed)
    out = []
    for p in range(paragraphs):
        sentences = []
        for _ in range(rng.randint(3, 5)):
            n = rng.randint(8, 16)
            words = [rng.choice(WORDS) for _ in range(n)]
            if rng.random() < 0.5:
                words.insert(rng.randint(1, n - 1), rng.choice(
                    [f"{rng.randint(2, 950)} mm", f"clause {rng.randint(1, 30)}.{rng.randint(1, 9)}",
                     f"{rng.randint(10, 99)}.{rng.randint(0, 9)} kN", f"C{rng.choice([25, 32, 40])}/{rng.choice([30, 40, 50])}",
                     f"Section 0{rng.randint(1, 9)} {rng.randint(10, 90)} 00"]))
            s = " ".join(words)
            sentences.append(s[0].upper() + s[1:] + rng.choice([".", ".", ".", ";", ":"]))
        out.append(f"{p + 1}. " + " ".join(sentences))
    return out


def wrap(draw, text, f, width):
    lines, line = [], ""
    for word in text.split(" "):
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def text_page(seed):
    """US Letter at 300 dpi, 11 pt serif body, heading, footer. Returns image, lines."""
    w, h = 2550, 3300
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    margin = 225
    expected = []
    y = margin
    head = font("sans-bold", 58)
    title = f"SPECIFICATION PART {seed}: GENERAL REQUIREMENTS"
    d.text((margin, y), title, font=head, fill=0)
    expected.append(title)
    y += 110
    body = font("serif", 46)
    for para in prose(seed):
        for line in wrap(d, para, body, w - 2 * margin):
            if y > h - margin - 120:
                break
            d.text((margin, y), line, font=body, fill=0)
            expected.append(line)
            y += 58
        y += 30
    foot = f"Page {seed} of 12    Issued for tender    Rev B"
    d.text((margin, h - margin), foot, font=font("sans", 36), fill=0)
    expected.append(foot)
    return img, expected


def drawing():
    """A3 landscape at 300 dpi: plan-like linework, room labels, dimensions, title block."""
    w, h = 4961, 3508
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    words, vertical = [], []
    d.rectangle([60, 60, w - 60, h - 60], outline=0, width=6)
    # Grid lines with bubbles.
    for i, x in enumerate(range(400, 3800, 680)):
        d.line([x, 200, x, 2900], fill=110, width=2)
        d.ellipse([x - 45, 110, x + 45, 200], outline=0, width=3)
        label = "ABCDEF"[i]
        d.text((x - 16, 128), label, font=font("sans", 52), fill=0)
        words.append(label)
    # Rooms.
    rooms = [((400, 400, 1760, 1400), "KITCHEN"), ((1760, 400, 2780, 1400), "LIVING ROOM"),
             ((2780, 400, 3800, 1400), "BEDROOM 1"), ((400, 1400, 1080, 2400), "WC"),
             ((1080, 1400, 2440, 2400), "HALL"), ((2440, 1400, 3800, 2400), "BEDROOM 2")]
    rf = font("sans-bold", 60)
    af = font("sans", 40)
    for n, ((x0, y0, x1, y1), name) in enumerate(rooms):
        d.rectangle([x0, y0, x1, y1], outline=0, width=14)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        tw = d.textlength(name, font=rf)
        d.text((cx - tw / 2, cy - 60), name, font=rf, fill=0)
        words += name.split()
        area = f"{(x1 - x0) * (y1 - y0) / 250000:.1f} m2"
        aw = d.textlength(area, font=af)
        d.text((cx - aw / 2, cy + 20), area, font=af, fill=0)
        words += area.split()
        # Door swing.
        d.arc([x0 + 40, y1 - 260, x0 + 480, y1 + 180], 270, 360, fill=0, width=3)
    # Horizontal dimensions.
    df = font("sans", 38)
    for x0, x1 in [(400, 1760), (1760, 2780), (2780, 3800)]:
        y = 2700
        d.line([x0, y, x1, y], fill=0, width=2)
        for x in (x0, x1):
            d.line([x - 20, y + 20, x + 20, y - 20], fill=0, width=4)
        label = str((x1 - x0) * 3)
        tw = d.textlength(label, font=df)
        d.text(((x0 + x1) / 2 - tw / 2, y - 52), label, font=df, fill=0)
        words.append(label)
    # A vertical dimension: rotated text.
    label = "6000"
    tmp = Image.new("L", (200, 60), 255)
    ImageDraw.Draw(tmp).text((0, 0), label, font=df, fill=0)
    img.paste(tmp.rotate(90, expand=True), (4000, 1100))
    d.line([4070, 400, 4070, 2400], fill=0, width=2)
    vertical.append(label)
    # Notes.
    nf = font("sans", 30)
    notes = ["GENERAL NOTES:",
             "1. ALL DIMENSIONS ARE IN MILLIMETRES UNLESS NOTED OTHERWISE.",
             "2. DO NOT SCALE FROM THIS DRAWING.",
             "3. CONTRACTOR TO VERIFY ALL DIMENSIONS ON SITE BEFORE FABRICATION.",
             "4. REFER TO STRUCTURAL ENGINEER DRAWINGS S-201 TO S-214.",
             "5. FIRE RATED DOORS FD30S WHERE SHOWN HATCHED."]
    y = 2950
    for line in notes:
        d.text((400, y), line, font=nf, fill=0)
        y += 44
    title = [("PROJECT", "RIVERSIDE HOUSING PHASE 2"), ("DRAWING", "GROUND FLOOR PLAN"),
             ("DRAWING No.", "A-101"), ("REVISION", "C"), ("SCALE", "1:100 @ A3"),
             ("DRAWN", "JB"), ("CHECKED", "MK"), ("DATE", "14/08/2026")]
    tx, ty = 3850, 2550
    d.rectangle([tx, ty, w - 100, h - 100], outline=0, width=6)
    lf = font("sans", 28)
    vf = font("sans-bold", 40)
    for i, (k, v) in enumerate(title):
        row = ty + 20 + i * 100
        d.line([tx, row - 18, w - 100, row - 18], fill=0, width=2)
        d.text((tx + 20, row), k, font=lf, fill=0)
        d.text((tx + 280, row + 20), v, font=vf, fill=0)
        words += k.split() + v.split()
    return img, words, vertical, notes


def scan(img, seed, angle, noise, blur, contrast, speckle, jpeg):
    rng = random.Random(seed)
    if contrast < 1:
        img = img.point(lambda p: int(255 - (255 - p) * contrast))
    img = img.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=255)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        noise_img = Image.effect_noise(img.size, noise)
        img = Image.blend(img, noise_img, 0.12)
    if speckle:
        px = img.load()
        w, h = img.size
        for _ in range(int(w * h * speckle)):
            px[rng.randrange(w), rng.randrange(h)] = rng.choice([0, 255])
    # Off-white paper.
    img = img.point(lambda p: min(p, 238))
    if jpeg:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=jpeg)
        img = Image.open(io.BytesIO(buf.getvalue())).convert("L")
    return img


def save(img, out, name, long_edge):
    w, h = img.size
    s = long_edge / max(w, h)
    small = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
    path = os.path.join(out, f"{name}@{long_edge}.png")
    small.convert("RGBA").save(path, optimize=False)
    return path


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    manifest = []
    page, lines = text_page(3)
    variants = {
        "text-clean": page,
        "text-scan": scan(page, 1, 1.5, 40, 0.8, 0.9, 0, 70),
        "text-heavy": scan(page, 2, -4.0, 80, 1.3, 0.6, 0.002, 45),
        "text-rot90": page.rotate(90, expand=True),
    }
    for name, img in variants.items():
        for le in LONG_EDGES:
            manifest.append({"name": name, "file": save(img, out, name, le), "long_edge": le,
                             "kind": "prose", "lines": lines})
    dwg, words, vertical, notes = drawing()
    dvariants = {"drawing-clean": dwg, "drawing-scan": scan(dwg, 3, 0.7, 40, 0.7, 0.85, 0.0005, 70)}
    for name, img in dvariants.items():
        for le in LONG_EDGES:
            manifest.append({"name": name, "file": save(img, out, name, le), "long_edge": le,
                             "kind": "drawing", "words": words, "vertical": vertical,
                             "notes": notes})
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(f"{len(manifest)} pages in {out}")


if __name__ == "__main__":
    main()
