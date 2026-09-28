"""Render a reviewed training PowerPoint into one web image per slide.

Usage: python3 training/scripts/render_ppt.py training/ppt/pp-trn-wld-001
Requires LibreOffice, PyMuPDF and Pillow. The PPTX remains the source of record.
"""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import fitz
from PIL import Image, ImageStat


def render(folder: Path) -> None:
    source = folder / "source.pptx"
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    slides = manifest["slides"]
    if not source.is_file() or not slides:
        raise ValueError("The deck and manifest are required")
    if any(slide.get("id") != index or not slide.get("title") or not slide.get("bullets") or not slide.get("check") for index, slide in enumerate(slides, 1)):
        raise ValueError("Every PowerPoint slide needs a matching manifest entry and knowledge check")
    def valid_question(question: dict) -> bool:
        return (isinstance(question, dict) and bool(question.get("question"))
                and isinstance(question.get("options"), list) and len(question["options"]) >= 2
                and all(isinstance(option, str) and option.strip() for option in question["options"])
                and isinstance(question.get("answer"), int)
                and 0 <= question["answer"] < len(question["options"]))

    if any(not valid_question(slide["check"]) or not slide["check"].get("feedback") for slide in slides[:-1]):
        raise ValueError("Every lesson slide needs a complete question, answer and feedback")
    if slides[-1]["check"] != "final" or not manifest.get("exam") or any(not valid_question(q) for q in manifest["exam"]):
        raise ValueError("The final slide needs a final assessment")
    with tempfile.TemporaryDirectory(prefix="panalo-ppt-") as work:
        temp = Path(work)
        profile = (temp / "lo-profile").as_uri()
        subprocess.run(
            ["soffice", f"-env:UserInstallation={profile}", "--headless", "--convert-to", "pdf", "--outdir", str(temp), str(source)],
            check=True, capture_output=True, text=True, timeout=180,
        )
        pdf = temp / "source.pdf"
        if not pdf.is_file():
            raise RuntimeError("LibreOffice did not create the PDF")
        output = temp / "images"
        output.mkdir()
        with fitz.open(pdf) as document:
            if len(document) != len(slides):
                raise ValueError(f"Deck has {len(document)} slides; manifest has {len(slides)}")
            for number, page in enumerate(document, 1):
                bitmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                image = Image.frombytes("RGB", (bitmap.width, bitmap.height), bitmap.samples)
                if sum(ImageStat.Stat(image.resize((120, 68))).stddev) / 3 < 8:
                    raise ValueError(f"Slide {number} appears blank; check the PowerPoint layout")
                image.save(output / f"slide-{number:02d}.webp", "WEBP", quality=84, method=6)
        for generated in output.glob("slide-*.webp"):
            shutil.copyfile(generated, folder / generated.name)
        for stale in folder.glob("slide-*.webp"):
            if not (output / stale.name).exists():
                stale.unlink()
    print(f"Rendered {len(slides)} slides in {folder}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("module_folder", type=Path)
    render(parser.parse_args().module_folder.resolve())
