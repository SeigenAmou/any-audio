"""Turn a manual that came as a file or a folder of files into one text.

Vendors ship manuals as anything from a single .txt to a folder of a thousand
HTML pages that each explain one knob. The job here is only extraction: find
the readable text, keep the order and the per-file headings, and say honestly
what could not be read. Understanding the manual is the agent's job, not this
script's.

Supported: .txt .md .html .htm .mhtml .mht .pdf .docx
Not supported: .doc (the old OLE format), images, .chm
"""
from __future__ import annotations

import argparse
import email
import html.parser
import io
import json
import os
import re
import sys
import zipfile

SUPPORTED = {".txt", ".md", ".markdown", ".html", ".htm", ".mhtml", ".mht", ".pdf", ".docx"}
UNSUPPORTED_HINT = {
    ".doc": "the old binary Word format cannot be read here; save it as .docx or .pdf",
    ".chm": "compiled HTML help cannot be read here; unpack it first",
    ".rtf": "save it as .txt or .docx",
}
MAX_FILE_BYTES = 40 * 1024 * 1024
BLOCK_TAGS = {
    "p", "div", "br", "li", "tr", "section", "article", "header", "footer",
    "table", "ul", "ol", "dl", "dt", "dd", "blockquote", "pre", "form", "nav",
}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
SKIP_TAGS = {"script", "style", "head", "noscript", "svg", "template"}


class HtmlText(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
            return
        if tag in HEADING_TAGS:
            self.parts.append("\n\n")
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
            return
        if tag in HEADING_TAGS or tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip:
            return
        text = data.strip() if data.strip() else ""
        if not text:
            return
        if self.parts and not self.parts[-1].endswith(("\n", " ")):
            self.parts.append(" ")
        self.parts.append(text)

    def text(self) -> str:
        return "".join(self.parts)


def tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def html_to_text(raw: bytes) -> str:
    parser = HtmlText()
    parser.feed(raw.decode("utf-8", errors="replace"))
    parser.close()
    return tidy(parser.text())


def mhtml_to_text(raw: bytes) -> str:
    message = email.message_from_bytes(raw)
    chunks: list[str] = []
    for part in message.walk():
        ctype = (part.get_content_type() or "").lower()
        if ctype not in ("text/html", "text/plain"):
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        if ctype == "text/html":
            chunks.append(html_to_text(payload))
        else:
            charset = part.get_content_charset() or "utf-8"
            chunks.append(tidy(payload.decode(charset, errors="replace")))
    return tidy("\n\n".join(chunk for chunk in chunks if chunk))


def pdf_to_text(raw: bytes, warnings: list[str], label: str) -> str:
    """pymupdf first: it reads CID-keyed Japanese fonts that pypdf turns into noise.

    The SD-20 MIDI implementation sheet is exactly that case — pypdf returns
    glyph indices (".*%*" for "MIDI"), pymupdf returns the text.
    """
    try:
        import pymupdf
    except Exception:
        pymupdf = None
    if pymupdf is not None:
        try:
            doc = pymupdf.open(stream=raw, filetype="pdf")
            try:
                pages = [page.get_text() for page in doc]
            finally:
                doc.close()
            text = tidy("\n\n".join(pages))
            if text:
                return text
        except Exception as error:
            warnings.append(f"{label}: pymupdf could not read the PDF ({error})")
    try:
        import pypdf
    except Exception:
        if pymupdf is None:
            warnings.append(f"{label}: no PDF reader is installed (pip install pymupdf)")
        return ""
    try:
        reader = pypdf.PdfReader(io.BytesIO(raw))
        pages = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pages.append("")
        text = tidy("\n\n".join(pages))
        if not text:
            warnings.append(f"{label}: the PDF has no text layer (it is a scan); reading it needs OCR")
        return text
    except Exception as error:
        warnings.append(f"{label}: the PDF could not be opened ({error})")
        return ""


def docx_to_text(raw: bytes, warnings: list[str], label: str) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", errors="replace")
    except Exception as error:
        warnings.append(f"{label}: the .docx could not be opened ({error})")
        return ""
    xml = re.sub(r"<w:p[ >]", "\n<w:p ", xml)
    xml = re.sub(r"<w:br[^>]*>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    return tidy(text)


def plain_to_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "gb18030", "cp1252"):
        try:
            return tidy(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
    return tidy(raw.decode("utf-8", errors="replace"))


def extract_one(path: str, warnings: list[str]) -> str:
    label = os.path.basename(path)
    ext = os.path.splitext(path)[1].lower()
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            warnings.append(f"{label}: larger than {MAX_FILE_BYTES // (1024 * 1024)} MB, skipped")
            return ""
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as error:
        warnings.append(f"{label}: could not be opened ({error})")
        return ""
    if ext in (".txt", ".md", ".markdown"):
        return plain_to_text(raw)
    if ext in (".html", ".htm"):
        return html_to_text(raw)
    if ext in (".mhtml", ".mht"):
        return mhtml_to_text(raw)
    if ext == ".pdf":
        return pdf_to_text(raw, warnings, label)
    if ext == ".docx":
        return docx_to_text(raw, warnings, label)
    return ""


def collect(root: str) -> tuple[list[str], list[str]]:
    files: list[str] = []
    skipped: list[str] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "node_modules")
        for name in sorted(names):
            if name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext in SUPPORTED:
                files.append(os.path.join(current, name))
            elif ext in UNSUPPORTED_HINT:
                skipped.append(f"{name}: {UNSUPPORTED_HINT[ext]}")
    return files, skipped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-chars", type=int, default=180000)
    args = parser.parse_args()

    source = os.path.abspath(args.path)
    warnings: list[str] = []
    if not os.path.exists(source):
        json.dump({"ok": False, "error": f"no such file or folder: {source}"}, sys.stdout)
        return 1

    if os.path.isdir(source):
        files, skipped = collect(source)
        warnings.extend(skipped)
        if not files:
            json.dump({"ok": False, "error": "no readable manual files in this folder", "warnings": warnings}, sys.stdout)
            return 1
        base = source
    else:
        ext = os.path.splitext(source)[1].lower()
        if ext in UNSUPPORTED_HINT:
            json.dump({"ok": False, "error": UNSUPPORTED_HINT[ext]}, sys.stdout)
            return 1
        if ext not in SUPPORTED:
            json.dump({"ok": False, "error": f"unsupported file type: {ext or '(none)'}"}, sys.stdout)
            return 1
        files, base = [source], os.path.dirname(source)

    sections: list[str] = []
    empty: list[str] = []
    for path in files:
        text = extract_one(path, warnings)
        if not text:
            empty.append(os.path.relpath(path, base).replace("\\", "/"))
            continue
        heading = os.path.relpath(path, base).replace("\\", "/")
        sections.append(f"## {heading}\n\n{text}")

    body = "\n\n".join(sections)
    truncated = False
    if len(body) > args.max_chars:
        truncated = True
        # Keep whole sections while they fit; for the rest keep each section's
        # opening lines instead of dropping it outright. A card that says
        # "section X exists but was not read" is useful; a card that silently
        # ends mid-sentence is not — the reader cannot tell whether the manual
        # is short or was cut, and the one parameter they needed may be the one
        # that fell off the end.
        sections = body.split("\n\n## ")
        kept = [sections[0]]
        used = len(sections[0])
        squeezed = []
        for section in sections[1:]:
            room = args.max_chars - used - 4
            if room <= 0:
                squeezed.append((section.split("\n", 1)[0].strip(), len(section)))
                continue
            if len(section) <= room:
                kept.append(section)
                used += len(section) + 4
                continue
            lines = section.split("\n")
            head = "\n".join(lines[:20])
            title = lines[0].strip()
            if room > 600 and len(head) > room - 200:
                head = head[: room - 220].rsplit("\n", 1)[0]
            if room > 600 and len(head) <= room - 200:
                kept.append(head)
                used += len(head) + 4
            squeezed.append((title, len(section)))
        body = "\n\n## ".join(kept).rstrip()
        if squeezed:
            names = ", ".join(title for title, _ in squeezed[:24])
            more = "" if len(squeezed) <= 24 else f" (+{len(squeezed) - 24} more)"
            body += (
                f"\n\n[truncated: {len(squeezed)} section(s) are listed below but only their opening"
                f" lines are kept — read the source file for the rest: {names}{more}]"
            )

    if empty:
        warnings.append(f"{len(empty)} file(s) held no readable text: " + ", ".join(empty[:8]))

    if not body:
        json.dump({"ok": False, "error": "nothing readable was found", "warnings": warnings}, sys.stdout)
        return 1

    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(body)

    json.dump(
        {
            "ok": True,
            "files": len(files),
            "read": len(sections),
            "chars": len(body),
            "truncated": truncated,
            "warnings": warnings,
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
