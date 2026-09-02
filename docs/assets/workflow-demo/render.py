#!/usr/bin/env python3
"""Deterministically render the PiBox workflow lifecycle chart."""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - environment setup
    raise SystemExit("Pillow is required: python3 -m pip install Pillow") from exc

ROOT = Path(__file__).resolve().parent
CHART_OUTPUT = ROOT / "workflow-lifecycle.png"

# Rattle theme, sourced from themes/rattle.json.
P = {
    "page": "#0B1116",
    "card": "#101920",
    "info": "#172A33",
    "selected": "#172A33",
    "user": "#111C23",
    "ice": "#DCE7EC",
    "steel": "#91A3AE",
    "hull": "#536570",
    "mist": "#718894",
    "cyan": "#62B8D6",
    "heading": "#8FCBDD",
    "blue": "#478BC7",
    "teal": "#4FB7A7",
    "amber": "#D6A45F",
    "red": "#DF6B73",
    "separator": "#31505D",
    "violet": "#9B8EE8",
}

FONT_CANDIDATES = {
    "regular": (
        "Arial.ttf",
        "LiberationSans-Regular.ttf",
        "DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ),
    "bold": (
        "Arial Bold.ttf",
        "LiberationSans-Bold.ttf",
        "DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ),
    "mono": (
        "Menlo.ttc",
        "DejaVuSansMono.ttf",
        "LiberationMono-Regular.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
    ),
    "unicode": (
        "Arial Unicode.ttf",
        "DejaVuSans.ttf",
        "LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ),
}
FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    key = (kind, size)
    if key not in FONT_CACHE:
        for candidate in FONT_CANDIDATES[kind]:
            try:
                FONT_CACHE[key] = ImageFont.truetype(candidate, size=size)
                break
            except OSError:
                continue
        else:
            if size > 14:
                raise RuntimeError(
                    f"No scalable {kind} font found. Tried: {', '.join(FONT_CANDIDATES[kind])}"
                )
            FONT_CACHE[key] = ImageFont.load_default()
    return FONT_CACHE[key]


def measure(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=face)
    return box[2] - box[0], box[3] - box[1]


def wrap_text(
    draw: ImageDraw.ImageDraw, text: str, face: ImageFont.ImageFont, max_width: int
) -> list[str]:
    """Greedy measured wrapping, preserving explicit paragraph breaks."""
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            trial = f"{current} {word}"
            if measure(draw, trial, face)[0] <= max_width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def draw_wrapped(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    face: ImageFont.ImageFont,
    fill: str,
    max_width: int,
    spacing: int = 6,
    max_lines: int | None = None,
) -> int:
    lines = wrap_text(draw, text, face, max_width)
    if max_lines is not None:
        lines = lines[:max_lines]
    x, y = xy
    line_height = measure(draw, "Ag", face)[1] + spacing
    for line in lines:
        draw.text((x, y), line, font=face, fill=fill)
        y += line_height
    return y


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def blend_color(a: str, b: str, amount: float) -> tuple[int, int, int]:
    ca, cb = hex_rgb(a), hex_rgb(b)
    return tuple(round(ca[i] + (cb[i] - ca[i]) * amount) for i in range(3))


def vertical_gradient(size: tuple[int, int], top: str, bottom: str) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        draw.line((0, y, width, y), fill=blend_color(top, bottom, y / max(1, height - 1)))
    return image


def rounded_panel(
    image: Image.Image,
    box: tuple[int, int, int, int],
    fill: str,
    outline: str = P["separator"],
    radius: int = 18,
    shadow: int = 8,
    width: int = 2,
) -> None:
    x1, y1, x2, y2 = box
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    if shadow:
        ld.rounded_rectangle((x1 + shadow, y1 + shadow, x2 + shadow, y2 + shadow), radius=radius, fill=(0, 0, 0, 92))
    ld.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    image.alpha_composite(layer) if image.mode == "RGBA" else image.paste(layer, (0, 0), layer)


def arrow(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    color: str = P["cyan"],
    width: int = 6,
    head: int = 18,
) -> None:
    draw.line((*start, *end), fill=color, width=width)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    points = [
        end,
        (
            end[0] - head * math.cos(angle - math.pi / 6),
            end[1] - head * math.sin(angle - math.pi / 6),
        ),
        (
            end[0] - head * math.cos(angle + math.pi / 6),
            end[1] - head * math.sin(angle + math.pi / 6),
        ),
    ]
    draw.polygon(points, fill=color)


def centered_text(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    face: ImageFont.ImageFont,
    fill: str,
) -> None:
    width, height = measure(draw, text, face)
    x1, y1, x2, y2 = box
    draw.text((x1 + (x2 - x1 - width) / 2, y1 + (y2 - y1 - height) / 2), text, font=face, fill=fill)


# ---- Lifecycle chart -----------------------------------------------------

@dataclass(frozen=True)
class LifecycleNode:
    title: str
    kicker: str
    bullets: tuple[str, ...]
    box: tuple[int, int, int, int]
    accent: str


LIFECYCLE_NODES = (
    LifecycleNode("Idea", "DESIRED OUTCOME", ("A useful product change",), (90, 300, 365, 650), P["violet"]),
    LifecycleNode("Brainstorm", "DISCUSS", ("Explore needs", "Resolve ambiguity"), (425, 300, 775, 650), P["blue"]),
    LifecycleNode(
        "Shape Story",
        "PRODUCT CONTRACT",
        ("Specification", "Design", "E2E contract"),
        (835, 300, 1395, 650),
        P["cyan"],
    ),
    LifecycleNode(
        "Plan Implementation",
        "DELIVERY PLAN",
        ("Tasks", "Ordered / concurrent stages", "Deterministic checks"),
        (1455, 300, 2305, 650),
        P["amber"],
    ),
)


def lifecycle_card(image: Image.Image, node: LifecycleNode) -> None:
    draw = ImageDraw.Draw(image)
    rounded_panel(image, node.box, P["card"], P["separator"], radius=28, shadow=12, width=3)
    x1, y1, x2, y2 = node.box
    draw.rounded_rectangle((x1, y1, x1 + 16, y2), radius=8, fill=node.accent)
    draw.text((x1 + 48, y1 + 40), node.kicker, font=font("bold", 25), fill=node.accent)
    title_size = 55 if len(node.title) < 15 else 45
    title_y = draw_wrapped(draw, (x1 + 48, y1 + 88), node.title, font("bold", title_size), P["ice"], x2 - x1 - 90, spacing=4)
    bullet_y = max(y1 + 205, title_y + 20)
    for bullet in node.bullets:
        draw.ellipse((x1 + 50, bullet_y + 12, x1 + 64, bullet_y + 26), fill=node.accent)
        next_y = draw_wrapped(draw, (x1 + 82, bullet_y), bullet, font("regular", 30), P["steel"], x2 - x1 - 120, spacing=5)
        bullet_y = next_y + 18


def render_lifecycle() -> None:
    image = vertical_gradient((2400, 1500), P["page"], "#0D1820").convert("RGBA")
    draw = ImageDraw.Draw(image)

    # Restrained background grid and glow.
    for x in range(0, 2401, 120):
        draw.line((x, 0, x, 1500), fill=(49, 80, 93, 35), width=1)
    for y in range(0, 1501, 120):
        draw.line((0, y, 2400, y), fill=(49, 80, 93, 35), width=1)
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for radius, alpha in ((650, 8), (500, 12), (350, 16)):
        gd.ellipse((1200 - radius, 980 - radius // 2, 1200 + radius, 980 + radius // 2), fill=(*hex_rgb(P["cyan"]), alpha))
    image.alpha_composite(glow)

    draw.text((90, 82), "PIBOX WORKFLOW", font=font("bold", 28), fill=P["cyan"])
    draw.text((90, 128), "From idea to fully working product", font=font("bold", 76), fill=P["ice"])
    draw.text(
        (92, 220),
        "A deterministic path from product judgment to managed delivery.",
        font=font("regular", 35),
        fill=P["steel"],
    )

    for node in LIFECYCLE_NODES:
        lifecycle_card(image, node)
    for left, right in zip(LIFECYCLE_NODES, LIFECYCLE_NODES[1:]):
        arrow(draw, (left.box[2] + 14, 475), (right.box[0] - 20, 475), width=7, head=22)

    execution = (90, 775, 1900, 1380)
    rounded_panel(image, execution, P["info"], P["blue"], radius=34, shadow=15, width=4)
    ex1, ey1, ex2, ey2 = execution
    draw.rounded_rectangle((ex1, ey1, ex1 + 18, ey2), radius=9, fill=P["cyan"])
    draw.text((ex1 + 54, ey1 + 38), "MANAGED WORKFLOW EXECUTION", font=font("bold", 29), fill=P["cyan"])
    draw.text((ex1 + 54, ey1 + 83), "Unattended long-horizon execution", font=font("bold", 62), fill=P["ice"])
    draw.text((ex1 + 56, ey1 + 158), "within a live activation", font=font("regular", 37), fill=P["steel"])

    # The central execution rail.
    rail_y = ey1 + 300
    phases = (
        (ex1 + 75, 390, "Execute tasks", "ordered  →  concurrent ⇉", P["cyan"]),
        (ex1 + 520, 355, "Integrate", "combine stage work", P["blue"]),
        (ex1 + 930, 355, "Verify", "deterministic checks", P["teal"]),
    )
    for x, width, title, detail, accent in phases:
        box = (x, rail_y - 45, x + width, rail_y + 115)
        draw.rounded_rectangle(box, radius=18, fill=P["card"], outline=P["separator"], width=3)
        draw.text((x + 25, rail_y - 18), title, font=font("bold", 32), fill=accent)
        draw.text((x + 25, rail_y + 34), detail, font=font("unicode", 25), fill=P["steel"])
    arrow(draw, (ex1 + 465, rail_y + 34), (ex1 + 505, rail_y + 34), width=5, head=16)
    arrow(draw, (ex1 + 880, rail_y + 34), (ex1 + 920, rail_y + 34), width=5, head=16)

    guard_x = ex1 + 1345
    draw.text((guard_x, rail_y - 72), "QUALITY GUARDRAILS", font=font("bold", 23), fill=P["amber"])
    guardrails = (("Review", "Fix"), ("E2E", "Fix"))
    for index, (left, right) in enumerate(guardrails):
        y = rail_y - 35 + index * 92
        draw.rounded_rectangle((guard_x, y, guard_x + 315, y + 70), radius=15, fill=P["card"], outline=P["separator"], width=2)
        draw.text((guard_x + 22, y + 17), left, font=font("bold", 27), fill=P["ice"])
        draw.text((guard_x + 135, y + 14), "↔", font=font("unicode", 31), fill=P["amber"])
        draw.text((guard_x + 202, y + 11), right, font=font("bold", 27), fill=P["ice"])
        if index == 1:
            draw.text((guard_x + 202, y + 43), "when needed", font=font("regular", 15), fill=P["mist"])

    draw.text((ex1 + 58, ey2 - 88), "Harness-owned state  •  checks and integration  •  whole-branch review  •  final E2E  •  material decisions return to you", font=font("regular", 28), fill=P["mist"])

    # Product endpoint.
    product = (1970, 875, 2310, 1280)
    rounded_panel(image, product, "#10221F", P["teal"], radius=30, shadow=13, width=4)
    px1, py1, px2, py2 = product
    centered_text(draw, (px1 + 95, py1 + 42, px2 - 95, py1 + 142), "✓", font("unicode", 76), P["teal"])
    centered_text(draw, (px1 + 30, py1 + 160, px2 - 30, py1 + 230), "FULLY WORKING", font("bold", 29), P["teal"])
    centered_text(draw, (px1 + 25, py1 + 225, px2 - 25, py1 + 310), "Product", font("bold", 55), P["ice"])
    centered_text(draw, (px1 + 25, py1 + 320, px2 - 25, py1 + 370), "verified end to end", font("regular", 25), P["steel"])
    arrow(draw, (ex2 + 20, 1078), (px1 - 22, 1078), color=P["teal"], width=8, head=24)
    arrow(draw, (1880, 649), (1880, 750), color=P["amber"], width=7, head=22)

    image.convert("RGB").save(CHART_OUTPUT, format="PNG", optimize=False, compress_level=9)


def main() -> int:
    try:
        render_lifecycle()
    except (OSError, RuntimeError) as exc:
        print(f"render.py: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {CHART_OUTPUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
