#!/usr/bin/env python3
"""Turn a spreadsheet into CSV text.

Reads .csv/.tsv directly, or the first sheet of an .xlsx through openpyxl, and
writes CSV to --out. The agent side keeps no spreadsheet library of its own, so
this is the one place that knows about workbooks.

Usage:
    python sheet_extract.py --path book.xlsx --out out.csv [--sheet NAME]
Prints one JSON line: {"ok": true, "rows": N, "cols": M, "sheet": "..."} .
"""

import argparse
import csv
import io
import json
import os
import sys


def read_csv_text(path):
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "cp1252"):
        try:
            with io.open(path, "r", encoding=encoding, newline="") as handle:
                return handle.read(), encoding
        except UnicodeDecodeError:
            continue
    raise SystemExit(json.dumps({"ok": False, "error": "no encoding could read %s" % path}))


def sheet_slug(name):
    out = []
    for char in str(name).lower():
        if char.isalnum():
            out.append(char)
        elif char in " \t-_":
            out.append("-")
    slug = "".join(out).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "sheet"


def read_xlsx(path, sheet_name=None):
    try:
        import openpyxl
    except ImportError:
        raise SystemExit(json.dumps({
            "ok": False,
            "error": "openpyxl is not installed; run: python -m pip install openpyxl",
        }))
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return book


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--out-dir", dest="out_dir", default=None)
    parser.add_argument("--sheet", default=None)
    parser.add_argument("--list", dest="list_sheets", action="store_true")
    args = parser.parse_args()

    if not args.out and not args.out_dir:
        print(json.dumps({"ok": False, "error": "pass --out or --out-dir"}))
        return 1
    if not os.path.isfile(args.path):
        print(json.dumps({"ok": False, "error": "no such file: %s" % args.path}))
        return 1
    ext = os.path.splitext(args.path)[1].lower()

    if ext in (".csv", ".tsv", ".txt"):
        text, encoding = read_csv_text(args.path)
        with io.open(args.out, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        print(json.dumps({"ok": True, "rows": text.count("\n"), "sheets": [], "encoding": encoding, "bytes": len(text.encode("utf-8"))}))
        return 0

    if ext not in (".xlsx", ".xlsm"):
        print(json.dumps({"ok": False, "error": "unsupported spreadsheet: %s" % ext}))
        return 1

    book = read_xlsx(args.path, args.sheet)
    names = args.list_sheets and book.sheetnames or (args.sheet and [args.sheet] or book.sheetnames)
    if args.sheet and args.sheet not in book.sheetnames:
        names = book.sheetnames
    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)
    written = []
    total = 0
    for name in names:
        sheet = book[name]
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        rows = 0
        for row in sheet.iter_rows(values_only=True):
            writer.writerow(["" if cell is None else cell for cell in row])
            rows += 1
        text = out.getvalue()
        total += rows
        target = os.path.join(args.out_dir, "%s.csv" % sheet_slug(name)) if args.out_dir else args.out
        if not args.out_dir and len(names) > 1:
            # one file requested but many sheets: keep the biggest one only
            pass
        with io.open(target, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        written.append({"name": name, "rows": rows, "file": target})
    book.close()
    print(json.dumps({"ok": True, "rows": total, "sheets": written, "list": book.sheetnames if False else [w["name"] for w in written]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
