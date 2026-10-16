#!/usr/bin/env python3
"""Build a vertical (9:16) video from a JSON spec using only ffmpeg.

Each scene is a background (image or solid color) with a slow zoom and
centered, word-wrapped text. Scenes are joined with fades; an optional
music track is mixed underneath.

Usage:
    python3 make_video.py spec.json -o out.mp4
"""

import argparse
import json
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

WIDTH, HEIGHT, FPS = 1080, 1920, 30
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FADE = 0.4


def run(args):
    """Run ffmpeg with an argument list (no shell), failing loudly on error."""
    result = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.exit(f"ffmpeg failed:\n{result.stderr}")


def background_filter(scene):
    """Return the video filter chain that produces the scene background."""
    zoom = scene.get("zoom", 1.0)
    if zoom > 1.0:
        # Slow push-in: zoompan keeps the previous frame's zoom in `zoom`.
        step = (zoom - 1.0) / (scene["duration"] * FPS)
        return (
            f"scale=-2:{HEIGHT * 2},crop={WIDTH * 2}:{HEIGHT * 2}:"
            f"(iw-ow)/2:(ih-oh)/2,"
            f"zoompan=z='min(zoom+{step:.6f},{zoom})':d=1:"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"s={WIDTH}x{HEIGHT}:fps={FPS}"
        )
    return f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},fps={FPS}"


def render_scene(index, scene, workdir, font):
    """Render one scene to an MP4 clip and return its path."""
    out = workdir / f"scene_{index:03d}.mp4"
    duration = float(scene.get("duration", 4))
    scene["duration"] = duration
    image = scene.get("image")

    if image:
        src = ["-loop", "1", "-framerate", str(FPS), "-i", str(Path(image).resolve())]
        chain = background_filter(scene)
    else:
        color = scene.get("color", "0x1e3a8a")
        src = ["-f", "lavfi", "-i", f"color=c={color}:s={WIDTH}x{HEIGHT}:r={FPS}"]
        chain = "null"

    filters = [chain]

    text = scene.get("text", "").strip()
    if text:
        lines = []
        for paragraph in text.split("\n"):
            lines.extend(textwrap.wrap(paragraph, width=scene.get("wrap", 18)) or [""])
        text_file = workdir / f"text_{index:03d}.txt"
        text_file.write_text("\n".join(lines), encoding="utf-8")
        filters.append(
            f"drawtext=fontfile={font}:textfile={text_file}:"
            f"fontsize={scene.get('font_size', 96)}:fontcolor=white:"
            f"line_spacing=18:borderw=6:bordercolor=black@0.7:"
            f"box=1:boxcolor=black@0.35:boxborderw=40:"
            f"x=(w-text_w)/2:y=(h-text_h)/2"
        )

    filters.append(
        f"fade=t=in:st=0:d={FADE},fade=t=out:st={duration - FADE:.3f}:d={FADE},format=yuv420p"
    )

    run([
        *src,
        "-t", f"{duration:.3f}",
        "-vf", ",".join(filters),
        "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        str(out),
    ])
    return out


def build(spec, output):
    font = spec.get("font", FONT)
    scenes = spec["scenes"]
    if not scenes:
        sys.exit("spec has no scenes")

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        clips = [render_scene(i, s, workdir, font) for i, s in enumerate(scenes)]

        listing = workdir / "clips.txt"
        listing.write_text("".join(f"file '{c}'\n" for c in clips), encoding="utf-8")
        joined = workdir / "joined.mp4"
        run(["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])

        music = spec.get("music")
        if music:
            run([
                "-i", str(joined),
                "-i", str(Path(music).resolve()),
                "-filter_complex", "[1:a]volume=0.25,afade=t=out:st=0:d=1.5[a]",
                "-map", "0:v", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac", "-shortest",
                str(output),
            ])
        else:
            run(["-i", str(joined), "-c", "copy", str(output)])

    print(f"wrote {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec", help="path to the JSON spec")
    parser.add_argument("-o", "--output", default="out.mp4")
    args = parser.parse_args()

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    build(spec, Path(args.output))


if __name__ == "__main__":
    main()
