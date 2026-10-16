# videogen

Builds a vertical 9:16 (1080×1920) MP4 from a JSON spec using only `ffmpeg`.
No AI, no API keys, no Python packages: standard library only.

## Requirements

- `ffmpeg` with `drawtext` (libfreetype). Check with `ffmpeg -filters | grep drawtext`.
- DejaVu Sans Bold at `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`
  (or set `"font"` in the spec to another `.ttf`).

## Usage

```bash
python3 make_video.py example.json -o out.mp4
```

## Spec format

```json
{
  "font": "/path/to/font.ttf",
  "music": "assets/music.mp3",
  "scenes": [
    { "text": "Line one\nLine two", "color": "0x1e3a8a", "duration": 3 },
    { "text": "Over a picture", "image": "assets/bg.jpg", "zoom": 1.15, "duration": 4 }
  ]
}
```

| Key | Scene | Default | Meaning |
|---|---|---|---|
| `image` | yes | - | Background image, cropped to 9:16. If omitted, `color` is used. |
| `color` | yes | `0x1e3a8a` | Solid background color (any ffmpeg color value). |
| `zoom` | yes | `1.0` | Slow push-in up to this factor over the scene. `1.0` = static. |
| `text` | yes | - | Overlaid text. `\n` starts a new line; long lines wrap. |
| `wrap` | yes | `18` | Max characters per line before wrapping. |
| `font_size` | yes | `96` | Text size in pixels. |
| `duration` | yes | `4` | Seconds. |
| `music` | top level | - | Optional audio, mixed at 25% volume with a fade-out. Trimmed to the video length. |

Scenes get a 0.4s fade in and out and are joined without re-encoding.

## Notes

- Arabic text renders with DejaVu Sans. For a nicer Arabic font, point `font` at a Noto Naskh or Noto Kufi `.ttf`.
- `assets/` holds placeholder files used by `example.json` (a test pattern and a sine tone). Replace them with your own media.
