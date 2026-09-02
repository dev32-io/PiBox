#!/usr/bin/env python3
"""Record the real Pi TUI demo and assemble the README GIF with FFmpeg."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence

ASSET_DIR = Path(__file__).resolve().parent
REPOSITORY = ASSET_DIR.parents[2]
BUILD = ASSET_DIR / ".build"
TAPE = ASSET_DIR / "capture.tape"
RAW_VIDEO = BUILD / "workflow-tui-raw.mp4"
MASTER_VIDEO = BUILD / "workflow-demo-master.mp4"
PRODUCT_CAPTURE = ASSET_DIR / "aero-todo-product.png"
GIF_OUTPUT = ASSET_DIR / "workflow-demo.gif"
POSTER_OUTPUT = ASSET_DIR / "workflow-demo-poster.png"
DEMO_AGENT_DIR = Path("/tmp/pibox-workflow-demo-agent")
EXPECTED_VHS_VERSION = "v0.11.0"
EXPECTED_TTYD_VERSION = "1.7.7"


def executable(name: str, override: str | None = None) -> str:
    candidate = override or shutil.which(name)
    if not candidate or not Path(candidate).is_file():
        variable = "VHS_BIN" if name == "vhs" else "PATH"
        raise RuntimeError(f"{name} was not found; provide it through {variable}")
    return str(Path(candidate).resolve())


def run(args: Sequence[str]) -> None:
    try:
        subprocess.run(list(args), cwd=REPOSITORY, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"{Path(args[0]).name} failed with exit status {exc.returncode}") from exc


def prepare_isolated_pi_settings() -> None:
    DEMO_AGENT_DIR.mkdir(parents=True, exist_ok=True)
    settings = {
        "quietStartup": True,
        "theme": "rattle",
        "showHardwareCursor": False,
        "analytics": {"enabled": False},
    }
    (DEMO_AGENT_DIR / "settings.json").write_text(json.dumps(settings, separators=(",", ":")) + "\n")


def record(vhs: str) -> None:
    version = subprocess.run([vhs, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if EXPECTED_VHS_VERSION not in version:
        raise RuntimeError(f"expected VHS {EXPECTED_VHS_VERSION}, got: {version}")
    ttyd = shutil.which("ttyd")
    if not ttyd:
        raise RuntimeError(f"ttyd {EXPECTED_TTYD_VERSION} is required on PATH by VHS")
    ttyd_version = subprocess.run([ttyd, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if EXPECTED_TTYD_VERSION not in ttyd_version:
        raise RuntimeError(f"expected ttyd {EXPECTED_TTYD_VERSION}, got: {ttyd_version}")
    prepare_isolated_pi_settings()
    BUILD.mkdir(parents=True, exist_ok=True)
    run((vhs, "validate", str(TAPE.relative_to(REPOSITORY))))
    run((vhs, str(TAPE.relative_to(REPOSITORY))))
    if not RAW_VIDEO.is_file():
        raise RuntimeError(f"VHS did not produce {RAW_VIDEO}")


def assemble(ffmpeg: str) -> None:
    # Zoom from 1.0x to 1.15x over one second after managed execution appears,
    # hold briefly on the active row, then restore the full metrics pane.
    filter_graph = (
        "[0:v]fps=20,"
        "scale=w='ceil(iw*(1+0.15*max(0,min(1,(t-5.8)/1.0))*(1-max(0,min(1,(t-7.5)/0.5))))/2)*2':"
        "h='ceil(ih*(1+0.15*max(0,min(1,(t-5.8)/1.0))*(1-max(0,min(1,(t-7.5)/0.5))))/2)*2':eval=frame,"
        "crop=1280:720:x='(in_w-out_w)/2':y='(in_h-out_h)*0.72',"
        "setsar=1,format=yuv420p[tui];"
        "[1:v]crop=1440:810:0:70,scale=1280:720:flags=lanczos,"
        "setsar=1,format=yuv420p,trim=duration=3,setpts=PTS-STARTPTS[product];"
        "[tui][product]xfade=transition=fade:duration=0.8:offset=14.5,format=yuv420p[out]"
    )
    run(
        (
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            str(RAW_VIDEO),
            "-loop",
            "1",
            "-framerate",
            "20",
            "-i",
            str(PRODUCT_CAPTURE),
            "-filter_complex",
            filter_graph,
            "-map",
            "[out]",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "18",
            "-movflags",
            "+faststart",
            str(MASTER_VIDEO),
        )
    )
    gif_filter = (
        "[0:v]fps=8,scale=960:540:flags=lanczos,split[v0][v1];"
        "[v0]palettegen=max_colors=160:stats_mode=diff[p];"
        "[v1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
    )
    run(
        (
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            str(MASTER_VIDEO),
            "-filter_complex",
            gif_filter,
            "-loop",
            "0",
            str(GIF_OUTPUT),
        )
    )
    run(
        (
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            "9.0",
            "-i",
            str(RAW_VIDEO),
            "-frames:v",
            "1",
            "-vf",
            "scale=960:540:flags=lanczos",
            str(POSTER_OUTPUT),
        )
    )


def main() -> int:
    try:
        vhs = executable("vhs", os.environ.get("VHS_BIN"))
        ffmpeg = executable("ffmpeg")
        record(vhs)
        assemble(ffmpeg)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"record.py: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {GIF_OUTPUT.name}")
    print(f"wrote {POSTER_OUTPUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
