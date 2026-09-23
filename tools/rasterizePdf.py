import sys
import fitz  # PyMuPDF


def rasterize(src_path: str, dst_path: str, dpi: int = 150) -> int:
    src = fitz.open(src_path)
    out = fitz.open()
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)

    for page in src:
        pix = page.get_pixmap(matrix=mat)
        new_page = out.new_page(width=pix.width, height=pix.height)
        new_page.insert_image(new_page.rect, pixmap=pix)

    out.save(dst_path)
    return len(out)


if __name__ == "__main__":
    src_path, dst_path = sys.argv[1], sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    try:
        n = rasterize(src_path, dst_path, dpi)
        print(f"rasterized {n} page(s)")
    except Exception as e:
        print(f"RASTERIZE_ERROR: {e}", file=sys.stderr)
        sys.exit(1)
