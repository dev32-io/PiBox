#!/usr/bin/env python3
"""Deterministically render the PiBox workflow lifecycle and demo media."""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - environment setup
    raise SystemExit("Pillow is required: python3 -m pip install Pillow") from exc

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / ".build"
PRODUCT_CAPTURE = ROOT / "aero-todo-product.png"
CHART_OUTPUT = ROOT / "workflow-lifecycle.png"
POSTER_OUTPUT = ROOT / "workflow-demo-poster.png"
GIF_OUTPUT = ROOT / "workflow-demo.gif"

GIF_WIDTH, GIF_HEIGHT = 960, 540
CONTENT_HEIGHT = 500
FPS = 12
DURATION = 18
FRAME_COUNT = FPS * DURATION

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


def ease_in_out(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def progress(t: float, start: float, end: float) -> float:
    return max(0.0, min(1.0, (t - start) / (end - start)))


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


def draw_status_icon(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    value: str,
    fill: str,
    size: int = 15,
) -> None:
    """Draw dashboard symbols portably; braille task spinners use their dot mask."""
    if len(value) == 1 and 0x2800 <= ord(value) <= 0x28FF:
        mask = ord(value) - 0x2800
        x, y = xy
        radius = max(1, size // 8)
        positions = ((0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3))
        for bit, (column, row) in enumerate(positions):
            if mask & (1 << bit):
                cx = x + 3 + column * (radius * 3 + 1)
                cy = y + 3 + row * (radius * 3)
                draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill)
        return
    draw.text(xy, value, font=font("unicode", size), fill=fill)


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


# ---- Animated workflow demo --------------------------------------------

@dataclass(frozen=True)
class Scene:
    name: str
    start: float
    end: float
    renderer: Callable[[float, int], Image.Image]


@dataclass(frozen=True)
class StorySection:
    label: str
    title: str
    lines: tuple[str, ...]
    accent: str


STORY_SECTIONS = (
    StorySection("SPECIFICATION", "Todo list behavior", ("Create, complete, edit, delete", "Filter and clear completed", "Validation and local persistence"), P["cyan"]),
    StorySection("DESIGN", "Aero product slice", ("Single focused workspace", "Clear active / completed states", "Accessible interaction feedback"), P["violet"]),
    StorySection("E2E CONTRACT", "Real user journey", ("Add and complete todos", "Filter the list", "Reload and retain state"), P["teal"]),
)

PLAN_STAGES = (
    ("→", "Stage 1", "workspace-foundation", "1 task"),
    ("⇉", "Stage 2", "independent-foundations", "6 tasks"),
    ("⇉", "Stage 3", "independent-feature-slices", "5 tasks"),
    ("→", "Stage 4", "application-integration", "1 task"),
)

SPINNER = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")


def base_frame(active_step: int) -> Image.Image:
    image = vertical_gradient((GIF_WIDTH, CONTENT_HEIGHT), P["page"], "#0D1820").convert("RGBA")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, GIF_WIDTH, 58), fill=P["card"])
    draw.text((28, 17), "PiBox", font=font("bold", 22), fill=P["ice"])
    draw.text((92, 19), "WORKFLOW DEMO", font=font("bold", 14), fill=P["cyan"])
    steps = ("DISCUSS", "SHAPE", "PLAN", "EXECUTE", "DELIVER")
    x = 520
    for index, label in enumerate(steps):
        color = P["cyan"] if index == active_step else P["hull"]
        draw.text((x, 21), label, font=font("bold", 12), fill=color)
        if index < len(steps) - 1:
            draw.text((x + 64, 19), "›", font=font("bold", 17), fill=P["hull"])
        x += 88
    draw.line((0, 58, GIF_WIDTH, 58), fill=P["separator"], width=1)
    return image


def add_disclosure(content: Image.Image) -> Image.Image:
    output = Image.new("RGB", (GIF_WIDTH, GIF_HEIGHT), P["page"])
    output.paste(content.convert("RGB"), (0, 0))
    draw = ImageDraw.Draw(output)
    draw.rectangle((0, CONTENT_HEIGHT, GIF_WIDTH, GIF_HEIGHT), fill="#111C23")
    draw.line((0, CONTENT_HEIGHT, GIF_WIDTH, CONTENT_HEIGHT), fill=P["separator"], width=1)
    draw.ellipse((28, 515, 36, 523), fill=P["amber"])
    draw.text(
        (48, 511),
        "Accelerated reenactment based on a real PiBox workflow run.",
        font=font("regular", 14),
        fill=P["ice"],
    )
    return output


def terminal_panel(image: Image.Image, box: tuple[int, int, int, int]) -> ImageDraw.ImageDraw:
    rounded_panel(image, box, P["card"], P["separator"], radius=15, shadow=8, width=2)
    draw = ImageDraw.Draw(image)
    x1, y1, x2, _ = box
    draw.rectangle((x1, y1, x2, y1 + 38), fill=P["info"])
    draw.text((x1 + 18, y1 + 10), ">_", font=font("mono", 14), fill=P["cyan"])
    draw.text((x1 + 58, y1 + 11), "product discussion", font=font("mono", 13), fill=P["steel"])
    return draw


def render_prompt(local: float, frame_index: int) -> Image.Image:
    del frame_index
    image = base_frame(0)
    draw = terminal_panel(image, (70, 100, 890, 430))
    prompt = "Let's make a todo list app."
    count = min(len(prompt), int(progress(local, 0.15, 1.65) * (len(prompt) + 1)))
    shown = prompt[:count]
    draw.text((105, 168), "›", font=font("bold", 24), fill=P["cyan"])
    draw.text((137, 167), shown, font=font("mono", 21), fill=P["ice"])
    if local < 1.85 and int(local * 4) % 2 == 0:
        cursor_x = 137 + measure(draw, shown, font("mono", 21))[0] + 2
        draw.rectangle((cursor_x, 170, cursor_x + 10, 193), fill=P["cyan"])
    if local > 1.65:
        alpha = progress(local, 1.65, 2.2)
        color = blend_color(P["card"], P["steel"], alpha)
        draw.text((105, 226), "Let's clarify the outcome, behavior, and proof.", font=font("regular", 18), fill=color)
        draw.text((105, 274), "Free-form discussion first. The workflow starts only after review.", font=font("regular", 15), fill=blend_color(P["card"], P["mist"], alpha))
    return image


def render_brainstorm(local: float, frame_index: int) -> Image.Image:
    del frame_index
    image = base_frame(0)
    draw = ImageDraw.Draw(image)
    draw.text((58, 91), "Brainstorm the product", font=font("bold", 31), fill=P["ice"])
    draw.text((59, 132), "Turn a broad idea into a shared, bounded outcome.", font=font("regular", 17), fill=P["steel"])
    cards = (
        ("USER NEED", "Capture everyday tasks quickly", P["cyan"]),
        ("CORE BEHAVIOR", "Add • complete • filter • retain", P["violet"]),
        ("PROOF", "A real journey through the finished UI", P["teal"]),
    )
    for index, (label, body, accent) in enumerate(cards):
        x = 58 + index * 300
        y = 198
        reveal = progress(local, 0.12 + index * 0.18, 0.48 + index * 0.18)
        y += round((1 - ease_in_out(reveal)) * 20)
        rounded_panel(image, (x, y, x + 270, y + 170), P["card"], P["separator"], radius=15, shadow=6, width=2)
        draw.text((x + 22, y + 23), label, font=font("bold", 13), fill=accent)
        draw_wrapped(draw, (x + 22, y + 62), body, font("bold", 21), P["ice"], 226, spacing=5)
    draw.text((58, 414), "Outcome: a focused, truthful example — not a claim about every product.", font=font("regular", 15), fill=P["mist"])
    return image


def render_story(local: float, frame_index: int) -> Image.Image:
    del frame_index
    image = base_frame(1)
    draw = ImageDraw.Draw(image)
    draw.text((48, 82), "Shape the story", font=font("bold", 29), fill=P["ice"])
    draw.text((48, 119), "The reviewed product contract", font=font("regular", 16), fill=P["steel"])
    for index, section in enumerate(STORY_SECTIONS):
        x = 48 + index * 303
        reveal = ease_in_out(progress(local, 0.08 + index * 0.18, 0.42 + index * 0.18))
        y = 163 + round((1 - reveal) * 18)
        rounded_panel(image, (x, y, x + 278, 425), P["card"], P["separator"], radius=15, shadow=6, width=2)
        draw.text((x + 21, y + 20), section.label, font=font("bold", 12), fill=section.accent)
        draw_wrapped(draw, (x + 21, y + 51), section.title, font("bold", 20), P["ice"], 232, spacing=3)
        for line_index, line in enumerate(section.lines):
            ly = y + 118 + line_index * 42
            draw.ellipse((x + 22, ly + 7, x + 29, ly + 14), fill=section.accent)
            draw.text((x + 39, ly), line, font=font("regular", 14), fill=P["steel"])
    return image


def render_plan(local: float, frame_index: int) -> Image.Image:
    del frame_index
    image = base_frame(2)
    draw = ImageDraw.Draw(image)
    draw.text((48, 81), "Plan implementation", font=font("bold", 29), fill=P["ice"])
    draw.text((48, 118), "Self-contained tasks, staged delivery, deterministic checks", font=font("regular", 16), fill=P["steel"])
    for index, (symbol, stage, title, task_count) in enumerate(PLAN_STAGES):
        y = 164 + index * 66
        reveal = ease_in_out(progress(local, 0.04 + index * 0.12, 0.30 + index * 0.12))
        x = 48 + round((1 - reveal) * 24)
        rounded_panel(image, (x, y, 650, y + 52), P["card"], P["separator"], radius=11, shadow=3, width=1)
        draw.text((x + 18, y + 14), symbol, font=font("unicode", 19), fill=P["cyan"])
        draw.text((x + 56, y + 15), stage, font=font("bold", 16), fill=P["ice"])
        draw.text((x + 142, y + 16), f"· {title}", font=font("regular", 15), fill=P["steel"])
        draw.text((554, y + 16), task_count, font=font("bold", 14), fill=P["teal"])
    rounded_panel(image, (688, 164, 912, 415), P["info"], P["blue"], radius=15, shadow=6, width=2)
    draw.text((710, 188), "CHECKS", font=font("bold", 13), fill=P["cyan"])
    checks = ("typecheck", "unit tests", "build", "E2E proof")
    for index, check in enumerate(checks):
        y = 229 + index * 43
        draw.text((712, y), "✓", font=font("unicode", 16), fill=P["teal"])
        draw.text((741, y + 1), check, font=font("mono", 14), fill=P["ice"])
    return image


@dataclass(frozen=True)
class WorkflowMoment:
    completed: int
    title: str
    rows: tuple[tuple[str, str, str], ...]  # icon, text, tone
    current_loop: str
    active_category: str
    guardrail: str


def workflow_moment(t: float, frame_index: int) -> WorkflowMoment:
    spin = SPINNER[frame_index % len(SPINNER)]
    if t < 8.8:
        return WorkflowMoment(
            0,
            "Workspace foundation",
            (
                (spin, "→ Stage 1 · workspace-foundation · Implementing · 0/1 task", "cyan"),
                (spin, "  Implementing · bootstrap-react-workspace", "cyan"),
                ("·", "⇉ Stage 2 · independent-foundations · Queued · 0/6 tasks", "steel"),
                ("·", "⇉ Stage 3 · independent-feature-slices · Queued · 0/5 tasks", "steel"),
                ("·", "→ Stage 4 · application-integration · Queued · 0/1 task", "steel"),
                ("·", "→ Final validation · Queued", "steel"),
            ),
            "—",
            "Implementation",
            "checks",
        )
    if t < 9.65:
        return WorkflowMoment(
            3,
            "Independent foundations",
            (
                ("✓", "→ Stage 1 · workspace-foundation · Completed · 1/1 task", "teal"),
                (spin, "⇉ Stage 2 · independent-foundations · Implementing · 2/6 tasks", "cyan"),
                (spin, "  Implementing · build-aero-theme", "cyan"),
                ("·", "⇉ Stage 3 · independent-feature-slices · Queued · 0/5 tasks", "steel"),
                ("·", "→ Stage 4 · application-integration · Queued · 0/1 task", "steel"),
                ("·", "→ Final validation · Queued", "steel"),
            ),
            "—",
            "Implementation",
            "checks",
        )
    if t < 10.35:
        return WorkflowMoment(
            7,
            "Checks and integration",
            (
                ("✓", "→ Stage 1 · workspace-foundation · Completed · 1/1 task", "teal"),
                ("◐", "⇉ Stage 2 · independent-foundations · Verifying · 6/6 tasks", "cyan"),
                ("✓", "  Integrated", "teal"),
                ("◐", "  Verifying · deterministic checks", "cyan"),
                ("·", "⇉ Stage 3 · independent-feature-slices · Queued · 0/5 tasks", "steel"),
                ("·", "→ Stage 4 · application-integration · Queued · 0/1 task", "steel"),
            ),
            "—",
            "Verification",
            "checks",
        )
    if t < 10.9:
        return WorkflowMoment(
            9,
            "Independent feature slices",
            (
                ("✓", "→ Stage 1 · workspace-foundation · Completed · 1/1 task", "teal"),
                ("✓", "⇉ Stage 2 · independent-foundations · Completed · 6/6 tasks", "teal"),
                (spin, "⇉ Stage 3 · independent-feature-slices · Implementing · 2/5 tasks", "cyan"),
                (spin, "  Implementing · build-todo-toolbar", "cyan"),
                ("·", "→ Stage 4 · application-integration · Queued · 0/1 task", "steel"),
                ("·", "→ Final validation · Queued", "steel"),
            ),
            "—",
            "Implementation",
            "checks",
        )
    if t < 11.4:
        return WorkflowMoment(
            11,
            "Feature checks",
            (
                ("✓", "→ Stage 1 · workspace-foundation · Completed · 1/1 task", "teal"),
                ("✓", "⇉ Stage 2 · independent-foundations · Completed · 6/6 tasks", "teal"),
                ("◐", "⇉ Stage 3 · independent-feature-slices · Checking · 4/5 tasks", "cyan"),
                ("◐", "  Checking · build-todo-toolbar", "cyan"),
                ("·", "→ Stage 4 · application-integration · Queued · 0/1 task", "steel"),
                ("·", "→ Final validation · Queued", "steel"),
            ),
            "—",
            "Verification",
            "checks",
        )
    if t < 12.35:
        return WorkflowMoment(
            12,
            "Application integration",
            (
                ("✓", "→ Stage 1 · workspace-foundation · Completed · 1/1 task", "teal"),
                ("✓", "⇉ Stage 2 · independent-foundations · Completed · 6/6 tasks", "teal"),
                ("✓", "⇉ Stage 3 · independent-feature-slices · Completed · 5/5 tasks", "teal"),
                (spin, "→ Stage 4 · application-integration · Implementing · 0/1 task", "cyan"),
                (spin, "  Implementing · assemble-aero-todo-app", "cyan"),
                ("·", "→ Final validation · Queued", "steel"),
            ),
            "—",
            "Integration",
            "checks",
        )
    completed_stages = (
        ("✓", "→ Stage 1 · workspace-foundation · Completed · 1/1 task", "teal"),
        ("✓", "⇉ Stage 2 · independent-foundations · Completed · 6/6 tasks", "teal"),
        ("✓", "⇉ Stage 3 · independent-feature-slices · Completed · 5/5 tasks", "teal"),
        ("✓", "→ Stage 4 · application-integration · Completed · 1/1 task", "teal"),
    )
    if t < 12.95:
        return WorkflowMoment(
            13,
            "Whole-branch review",
            completed_stages
            + (
                (spin, "→ Final validation · Whole-branch review", "cyan"),
                (spin, "  Whole-branch review #1", "cyan"),
            ),
            "Final · review #1",
            "Review",
            "review",
        )
    if t < 13.35:
        return WorkflowMoment(
            13,
            "Whole-branch fix",
            completed_stages
            + (
                (spin, "→ Final validation · Whole-branch fix", "amber"),
                (spin, "  Whole-branch fix #1", "amber"),
            ),
            "Final · fix #1",
            "Review",
            "review",
        )
    if t < 14.2:
        return WorkflowMoment(
            13,
            "Final E2E",
            completed_stages
            + (
                (spin, "→ Final validation · E2E journey", "cyan"),
                (spin, "  E2E journey", "cyan"),
            ),
            "E2E · journey",
            "E2E",
            "e2e",
        )
    return WorkflowMoment(
        13,
        "Completed",
        completed_stages + (("✓", "→ Final validation · Completed", "teal"),),
        "—",
        "E2E",
        "done",
    )


def draw_workflow_world(t: float, frame_index: int) -> Image.Image:
    image = base_frame(3 if t < 14.2 else 4)
    draw = ImageDraw.Draw(image)
    moment = workflow_moment(t, frame_index)
    # The authentic dashboard projection sits within the terminal surface.
    rounded_panel(image, (58, 82, 902, 455), P["card"], P["blue"], radius=14, shadow=8, width=2)
    draw.rectangle((58, 82, 902, 120), fill=P["info"])
    draw.text((78, 94), "managed workflow · live activation", font=font("mono", 13), fill=P["steel"])
    draw.text((75, 137), f"Workflow · Aero Todo · {moment.completed}/13 tasks", font=font("bold", 19), fill=P["cyan"])

    # Left dashboard items.
    y = 178
    tone_map = {"teal": P["teal"], "cyan": P["cyan"], "amber": P["amber"], "steel": P["steel"]}
    for icon_text, text, tone in moment.rows:
        color = tone_map[tone]
        draw_status_icon(draw, (78, y), icon_text, color, size=15)
        draw.text((104, y), text, font=font("unicode", 13), fill=color)
        y += 34

    # Metrics pane follows dashboard vocabulary from dashboard.ts.
    draw.line((652, 132, 652, 384), fill=P["separator"], width=1)
    review_duration = "15s" if t >= 13.35 else (
        f"{max(1, int((t - 12.35) * 15))}s" if moment.active_category == "Review" else "—"
    )
    e2e_duration = "9s" if t >= 14.2 else (
        f"{max(1, int((t - 13.35) * 11))}s" if moment.active_category == "E2E" else "—"
    )
    metrics = (
        ("Workflow time", f"{max(1, int((t - 7.0) * 11))}s"),
        ("Implementation", "41s" if t >= 12.35 else f"{max(1, int((t - 7.0) * 8))}s"),
        ("Integration", "7s" if t >= 10.35 else "—"),
        ("Verification", "12s" if t >= 12.35 else ("6s" if t >= 10.35 else "—")),
        ("Review", review_duration),
        ("E2E", e2e_duration),
        ("Current loop", moment.current_loop),
    )
    my = 142
    for label, value in metrics:
        draw.text((672, my), label, font=font("regular", 12), fill=P["mist"])
        value_width = measure(draw, value, font("mono", 12))[0]
        draw.text((880 - value_width, my), value, font=font("mono", 12), fill=P["ice"])
        my += 32

    # Explicitly identify guardrails while their authentic statuses animate above.
    draw.line((75, 393, 884, 393), fill=P["separator"], width=1)
    guardrails = (("checks", "Deterministic checks"), ("review", "Review ↔ Fix"), ("e2e", "E2E ↔ Fix · when needed"))
    gx = 76
    widths = (218, 180, 205)
    for (key, label), width in zip(guardrails, widths):
        active = moment.guardrail == key
        fill = P["info"] if active else P["user"]
        outline = P["amber"] if active and key != "checks" else (P["cyan"] if active else P["separator"])
        draw.rounded_rectangle((gx, 408, gx + width, 439), radius=9, fill=fill, outline=outline, width=2 if active else 1)
        draw.text((gx + 12, 416), ("◆ " if active else "· ") + label, font=font("unicode", 12), fill=outline if active else P["steel"])
        gx += width + 14
    return image


def render_workflow(local: float, frame_index: int) -> Image.Image:
    t = local + 7.0
    world = draw_workflow_world(t, frame_index)
    # Exactly one second of frame-index-driven smooth camera movement after execution starts.
    zoom_start, zoom_end = 0.45, 1.45
    z = ease_in_out(progress(local, zoom_start, zoom_end))
    if z <= 0:
        return world
    target = (52, 54, 908, 500)  # Same aspect as the 960x500 content viewport.
    crop = (
        round(target[0] * z),
        round(target[1] * z),
        round(GIF_WIDTH - (GIF_WIDTH - target[2]) * z),
        round(CONTENT_HEIGHT - (CONTENT_HEIGHT - target[3]) * z),
    )
    # Clamp target bottom to source while retaining deterministic interpolation.
    crop = (crop[0], crop[1], crop[2], min(CONTENT_HEIGHT, crop[3]))
    return world.crop(crop).resize((GIF_WIDTH, CONTENT_HEIGHT), Image.Resampling.LANCZOS)


def product_capture() -> Image.Image:
    if not PRODUCT_CAPTURE.exists():
        raise FileNotFoundError(f"Missing durable input: {PRODUCT_CAPTURE.name}")
    with Image.open(PRODUCT_CAPTURE) as source:
        return source.convert("RGB")


def render_poster() -> None:
    """Render the opt-in preview from an authentic, fully zoomed mid-run scene."""
    poster_time = 11.75
    content = render_workflow(poster_time - 7.0, int(poster_time * FPS))
    poster = add_disclosure(content).convert("RGBA")
    rounded_panel(poster, (282, 452, 678, 492), P["info"], P["cyan"], radius=20, shadow=4, width=2)
    draw = ImageDraw.Draw(poster)
    draw.ellipse((300, 459, 326, 485), fill=P["cyan"])
    draw.polygon(((310, 466), (310, 478), (320, 472)), fill=P["page"])
    draw.text((340, 463), "Watch the 18s accelerated demo", font=font("bold", 16), fill=P["ice"])
    poster.convert("RGB").save(POSTER_OUTPUT, format="PNG", optimize=False, compress_level=9)


def render_product(local: float, frame_index: int) -> Image.Image:
    del frame_index
    image = base_frame(4)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 58, GIF_WIDTH, CONTENT_HEIGHT), fill=P["page"])
    capture = product_capture()
    # Fit the complete real capture beside a concise result label.
    capture.thumbnail((700, 420), Image.Resampling.LANCZOS)
    screenshot = Image.new("RGB", (700, 420), P["page"])
    screenshot.paste(capture, ((700 - capture.width) // 2, (420 - capture.height) // 2))
    image.paste(screenshot, (260, 72))
    draw.rectangle((260, 72, 959, 491), outline=P["separator"], width=1)
    draw.text((30, 109), "13/13", font=font("bold", 54), fill=P["teal"])
    draw.text((31, 174), "tasks complete", font=font("bold", 18), fill=P["ice"])
    draw.line((31, 215, 216, 215), fill=P["separator"], width=1)
    draw.text((31, 250), "FULLY WORKING", font=font("bold", 13), fill=P["teal"])
    draw.text((31, 279), "Aero Todo", font=font("bold", 29), fill=P["ice"])
    draw_wrapped(draw, (31, 330), "Real sanitized product capture from the completed workflow.", font("regular", 15), P["steel"], 190, spacing=5)

    # Crossfade in from the completed dashboard.
    fade = ease_in_out(progress(local, 0.0, 0.55))
    if fade < 1:
        prior = draw_workflow_world(14.9, int((local + 15.3) * FPS)).convert("RGB")
        image = Image.blend(prior, image.convert("RGB"), fade).convert("RGBA")
    return image


SCENES: tuple[Scene, ...] = (
    Scene("prompt", 0.0, 2.25, render_prompt),
    Scene("brainstorm", 2.25, 3.75, render_brainstorm),
    Scene("story", 3.75, 5.25, render_story),
    Scene("plan", 5.25, 7.0, render_plan),
    Scene("workflow", 7.0, 15.3, render_workflow),
    Scene("product", 15.3, 18.0, render_product),
)


def scene_for_time(t: float) -> Scene:
    for scene in SCENES:
        if scene.start <= t < scene.end:
            return scene
    return SCENES[-1]


def render_frames() -> None:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)
    for frame_index in range(FRAME_COUNT):
        t = frame_index / FPS
        scene = scene_for_time(t)
        content = scene.renderer(t - scene.start, frame_index)
        output = add_disclosure(content)
        output.save(BUILD / f"frame-{frame_index:04d}.png", format="PNG", optimize=False, compress_level=6)


def require_ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise RuntimeError("ffmpeg was not found on PATH; install FFmpeg to encode workflow-demo.gif")
    return executable


def run_ffmpeg(args: Sequence[str]) -> None:
    try:
        subprocess.run(list(args), cwd=ROOT, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffmpeg failed with exit status {exc.returncode}") from exc


def encode_gif() -> None:
    ffmpeg = require_ffmpeg()
    palette = BUILD / "palette.png"
    frame_pattern = BUILD / "frame-%04d.png"
    # Generate one deterministic global palette, then apply ordered dithering for crisp UI text.
    run_ffmpeg(
        (
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-framerate",
            str(FPS),
            "-i",
            str(frame_pattern),
            "-vf",
            "palettegen=max_colors=192:stats_mode=full",
            "-frames:v",
            "1",
            "-y",
            str(palette),
        )
    )
    run_ffmpeg(
        (
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-framerate",
            str(FPS),
            "-i",
            str(frame_pattern),
            "-i",
            str(palette),
            "-lavfi",
            "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
            "-loop",
            "0",
            "-gifflags",
            "+transdiff",
            "-fflags",
            "+bitexact",
            "-y",
            str(GIF_OUTPUT),
        )
    )


def main() -> int:
    try:
        render_lifecycle()
        render_poster()
        render_frames()
        encode_gif()
    except (OSError, RuntimeError) as exc:
        print(f"render.py: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {CHART_OUTPUT.name}")
    print(f"wrote {POSTER_OUTPUT.name}")
    print(f"wrote {GIF_OUTPUT.name} ({FRAME_COUNT} frames at {FPS} fps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
