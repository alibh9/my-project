"""Generate anime-style images locally with an open Stable Diffusion XL model.

Runs entirely on your own machine. Needs an NVIDIA GPU with about 8 GB of VRAM.

Setup (once):
    pip install torch diffusers transformers accelerate safetensors

Usage:
    python anime_gen.py "1girl, silver hair, school uniform, cherry blossoms"
    python anime_gen.py "1boy, katana, night city" --out my_images --count 4
"""

import argparse
from pathlib import Path

import torch
from diffusers import StableDiffusionXLPipeline

MODEL_ID = "cagliostrolab/animagine-xl-3.1"
DEFAULT_NEGATIVE = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, "
    "extra digit, worst quality, low quality, jpeg artifacts, watermark, signature"
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate anime images locally.")
    parser.add_argument("prompt", help="Danbooru-style tags, e.g. '1girl, blue hair, smile'")
    parser.add_argument("--negative", default=DEFAULT_NEGATIVE, help="What to avoid")
    parser.add_argument("--out", default="outputs", help="Folder to save images in")
    parser.add_argument("--count", type=int, default=1, help="How many images to generate")
    parser.add_argument("--steps", type=int, default=28, help="Inference steps")
    parser.add_argument("--guidance", type=float, default=7.0, help="Prompt strength")
    parser.add_argument("--width", type=int, default=832)
    parser.add_argument("--height", type=int, default=1216)
    parser.add_argument("--seed", type=int, default=None, help="Fixed seed for repeatable results")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("No CUDA GPU found. This script needs an NVIDIA GPU.")

    pipe = StableDiffusionXLPipeline.from_pretrained(
        MODEL_ID, torch_dtype=torch.float16
    ).to("cuda")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    generator = None
    if args.seed is not None:
        generator = torch.Generator(device="cuda").manual_seed(args.seed)

    for i in range(args.count):
        image = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            width=args.width,
            height=args.height,
            generator=generator,
        ).images[0]
        path = out_dir / f"anime_{i + 1:03d}.png"
        image.save(path)
        print(f"Saved {path}")


if __name__ == "__main__":
    main()
