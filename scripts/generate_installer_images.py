#!/usr/bin/env python3
"""Generate Windows installer bitmaps for Tauri NSIS / WiX bundles."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC_ICON = ROOT / "apps/desktop/app-icon.png"
TAURI_CONF = ROOT / "apps/desktop/src-tauri/tauri.conf.json"
OUT_DIR = ROOT / "apps/desktop/src-tauri/icons"

PRODUCT_NAME = "oh-my-md"
SIDEBAR_W, SIDEBAR_H = 164, 314
WIX_BANNER_W, WIX_BANNER_H = 493, 58
WIX_DIALOG_W, WIX_DIALOG_H = 493, 312

# WixUI paints a transparent black page title ("Installing oh-my-md", …) over
# X=15..215 dialog units of the banner on every inner page, at any DPI. Keep
# this strip flat background — no baked-in logo or text. Drift-guarded by
# WIX_BANNER_TITLE_SAFE_W / WIX_BANNER_BG in apps/desktop/test/tauriConfig.test.ts.
WIX_BANNER_TITLE_SAFE_W = 220

BRAND_TOP = (59, 130, 246)  # #3B82F6
BRAND_BOT = (29, 78, 216)  # #1D4ED8
BANNER_BG = (243, 244, 246)  # #F3F4F6
PANEL_TEXT = (255, 255, 255)
LOGO_SIZE = 72
LOGO_TOP = 48


def read_version() -> str:
    data = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    version = data.get("version")
    if not isinstance(version, str) or not version:
        raise SystemExit(f"missing version in {TAURI_CONF}")
    return version


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    img = Image.new("RGB", size)
    draw = ImageDraw.Draw(img)
    for y in range(height):
        ratio = y / max(height - 1, 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)
    return img


def paste_logo(canvas: Image.Image, logo: Image.Image, top: int) -> None:
    logo_fit = logo.convert("RGBA")
    logo_fit.thumbnail((LOGO_SIZE, LOGO_SIZE), Image.Resampling.LANCZOS)
    x = (canvas.width - logo_fit.width) // 2
    canvas.paste(logo_fit, (x, top), logo_fit)


def draw_centered_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    y: int,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    fill: tuple[int, int, int],
    width: int,
) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    x = (width - text_w) // 2
    draw.text((x, y), text, font=font, fill=fill)


def render_brand_panel(width: int, height: int, logo: Image.Image, version: str) -> Image.Image:
    panel = vertical_gradient((width, height), BRAND_TOP, BRAND_BOT)
    paste_logo(panel, logo, LOGO_TOP)
    draw = ImageDraw.Draw(panel)
    name_font = load_font(18, bold=True)
    version_font = load_font(12)
    draw_centered_text(draw, PRODUCT_NAME, LOGO_TOP + LOGO_SIZE + 20, name_font, PANEL_TEXT, width)
    version_text = f"v{version}"
    version_color = (int(PANEL_TEXT[0] * 0.85), int(PANEL_TEXT[1] * 0.85), int(PANEL_TEXT[2] * 0.85))
    draw_centered_text(draw, version_text, LOGO_TOP + LOGO_SIZE + 46, version_font, version_color, width)
    return panel


def render_sidebar(logo: Image.Image, version: str) -> Image.Image:
    return render_brand_panel(SIDEBAR_W, SIDEBAR_H, logo, version)


def render_wix_dialog(sidebar: Image.Image) -> Image.Image:
    dialog = Image.new("RGB", (WIX_DIALOG_W, WIX_DIALOG_H), BANNER_BG)
    dialog.paste(sidebar, (0, 0))
    return dialog


def strip_white_background(logo: Image.Image) -> Image.Image:
    """Turn the icon's baked white backdrop into alpha.

    The master icon is dark art on opaque white; pasting it as-is leaves a
    white tile on any non-white surface. Feathering around a near-white floor
    keeps anti-aliased edges smooth (harmless on the light banner background).
    """
    rgb = logo.convert("RGB")
    darkest = ImageChops.darker(
        ImageChops.darker(rgb.getchannel("R"), rgb.getchannel("G")),
        rgb.getchannel("B"),
    )
    alpha = darkest.point(lambda v: max(0, min(255, (245 - v) * 255 // 45)))
    rgba = rgb.copy()
    rgba.putalpha(alpha)
    return rgba


def render_wix_banner(logo: Image.Image) -> Image.Image:
    banner = Image.new("RGB", (WIX_BANNER_W, WIX_BANNER_H), BANNER_BG)
    assert WIX_BANNER_W - 16 - 36 > WIX_BANNER_TITLE_SAFE_W
    logo_fit = strip_white_background(logo)
    logo_fit.thumbnail((36, 36), Image.Resampling.LANCZOS)
    x = WIX_BANNER_W - logo_fit.width - 16
    banner.paste(logo_fit, (x, (WIX_BANNER_H - logo_fit.height) // 2), logo_fit)
    return banner


def save_bmp(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="BMP")


def main() -> None:
    if not SRC_ICON.exists():
        raise SystemExit(f"missing source icon: {SRC_ICON}")

    version = read_version()
    logo = Image.open(SRC_ICON)
    sidebar = render_sidebar(logo, version)
    save_bmp(sidebar, OUT_DIR / "nsis-sidebar.bmp")
    save_bmp(render_wix_dialog(sidebar), OUT_DIR / "wix-dialog.bmp")
    save_bmp(render_wix_banner(logo), OUT_DIR / "wix-banner.bmp")
    print(f"Wrote installer bitmaps to {OUT_DIR} (version {version})")


if __name__ == "__main__":
    main()
