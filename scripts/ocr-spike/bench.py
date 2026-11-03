"""SPIKE: runs ocr-text.exe over the pages from make_pages.py and reports what works under
which lockdown, speed, accuracy and memory.

    python bench.py <ocr-text.exe> <pages-dir> <out-dir>

Writes <out-dir>/results.json and <out-dir>/summary.md (also appended to
$GITHUB_STEP_SUMMARY when set). Exits 1 only if OCR fails under every configuration.
"""

import collections
import json
import os
import re
import subprocess
import sys
import time

try:
    from rapidfuzz.distance import Levenshtein

    def distance(a, b):
        return Levenshtein.distance(a, b)
except ImportError:  # Local runs without rapidfuzz.
    def distance(a, b):
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[-1]

MiB = 1024 * 1024
RELAX = [
    ("full lockdown", "none"),
    ("no job UI limits", "ui"),
    ("no Low integrity", "low"),
    ("no mitigations", "mitigations"),
    ("no DLL dir restriction", "dlldirs"),
    ("no Job Object", "job"),
    ("nothing", "job,low,mitigations,dlldirs"),
]


def run(exe, args, stdin=None, timeout=120):
    start = time.perf_counter()
    try:
        p = subprocess.run([exe, *args], input=stdin, capture_output=True, timeout=timeout)
        code, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        code, out, err = "timeout", b"", b""
    wall = (time.perf_counter() - start) * 1000
    err_text = err.decode("utf-8", "replace").strip()
    last = err_text.splitlines()[-1] if err_text else ""
    data = None
    if code == 0 and out:
        try:
            data = json.loads(out.decode("utf-8"))
        except ValueError:
            data = None
    metrics = dict(re.findall(r"(\w+)=(\S+)", last)) if last.startswith("ocr-text:1 ok") else {}
    return {"code": code, "wall_ms": round(wall, 1), "report": last, "data": data,
            "metrics": metrics, "stdout_bytes": len(out)}


def norm_ws(text):
    return " ".join(text.split())


def tokens(text):
    return [t for t in (w.strip(".,;:").lower() for w in text.split()) if t]


def recall(expected, got):
    want = collections.Counter(expected)
    have = collections.Counter(got)
    hit = sum(min(n, have[w]) for w, n in want.items())
    return hit / max(1, sum(want.values()))


def score(page, data):
    got_lines = [line["text"] for line in data["lines"]]
    got = norm_ws(" ".join(got_lines))
    if page["kind"] == "prose":
        exp = norm_ws(" ".join(page["lines"]))
        return {"cer": round(distance(exp, got) / len(exp), 4),
                "word_recall": round(recall(tokens(exp), tokens(got)), 4)}
    exp_words = tokens(" ".join(page["words"]))
    notes = norm_ws(" ".join(page["notes"]))
    got_tokens = tokens(got)
    return {"label_recall": round(recall(exp_words, got_tokens), 4),
            "notes_recall": round(recall(tokens(notes), got_tokens), 4),
            "vertical_found": all(v in got_tokens for v in page["vertical"])}


def main():
    exe, pages_dir, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(pages_dir, "manifest.json"), encoding="utf-8") as f:
        pages = json.load(f)
    results = {"exe_size": os.path.getsize(exe), "probe": [], "relax": [], "pages": [],
               "memory": [], "lang_forced": None}

    # 1. Probe and one real recognition per lockdown configuration, both decoders.
    sample = next(p for p in pages if p["name"] == "text-scan" and p["long_edge"] == 2200)
    with open(sample["file"], "rb") as f:
        sample_bytes = f.read()
    for label, relax in RELAX:
        probe = run(exe, ["--probe", "--relax", relax])
        results["probe"].append({"config": label, "relax": relax, **probe})
        for decoder in ("wic", "winrt"):
            r = run(exe, ["--recognize", "--relax", relax, "--decoder", decoder], sample_bytes)
            entry = {"config": label, "relax": relax, "decoder": decoder, "code": r["code"],
                     "report": r["report"], "wall_ms": r["wall_ms"]}
            if r["data"]:
                entry.update(score(sample, r["data"]))
            results["relax"].append(entry)

    working = [e for e in results["relax"] if e["code"] == 0]
    if not working:
        write(results, out_dir)
        sys.exit(1)
    full_ok = [e for e in working if e["relax"] == "none"]
    chosen = (full_ok or working)[0]
    relax, decoder = chosen["relax"], chosen["decoder"]
    results["chosen"] = {"relax": relax, "decoder": decoder}

    # 2. Every page, process per page (cold), plus two warm re-runs in the same process.
    for page in pages:
        with open(page["file"], "rb") as f:
            data = f.read()
        r = run(exe, ["--recognize", "--relax", relax, "--decoder", decoder, "--repeat", "3"],
                data)
        entry = {"name": page["name"], "long_edge": page["long_edge"], "png_bytes": len(data),
                 "code": r["code"], "report": r["report"], "wall_ms": r["wall_ms"],
                 "stdout_bytes": r["stdout_bytes"], **r["metrics"]}
        if r["data"]:
            entry.update(score(page, r["data"]))
            entry["angle"] = r["data"].get("angle")
            entry["lines"] = len(r["data"]["lines"])
            entry["lang"] = r["data"]["lang"]
            entry["text"] = [line["text"] for line in r["data"]["lines"]]
        results["pages"].append(entry)

    # 3. The smallest job memory limit that still works, on the largest pages.
    for name in ("text-scan", "drawing-scan"):
        page = next(p for p in pages if p["name"] == name and p["long_edge"] == 3300)
        if name == "drawing-scan":
            page = next(p for p in pages if p["name"] == name and p["long_edge"] == 4961)
        with open(page["file"], "rb") as f:
            data = f.read()
        for mib in (96, 128, 192, 256, 384):
            r = run(exe, ["--recognize", "--relax", relax, "--decoder", decoder,
                          "--max-memory", str(mib * MiB)], data)
            results["memory"].append({"name": name, "long_edge": page["long_edge"], "limit_mib": mib,
                                      "code": r["code"], "report": r["report"]})

    # 4. Output bound: a tiny --max-output must truncate, not fail.
    r = run(exe, ["--recognize", "--relax", relax, "--decoder", decoder, "--max-output",
                  "2048"], sample_bytes)
    results["truncation"] = {"code": r["code"], "stdout_bytes": r["stdout_bytes"],
                             "truncated": (r["data"] or {}).get("truncated")}
    # 5. Explicit language that is not installed.
    r = run(exe, ["--recognize", "--relax", relax, "--lang", "ja-JP"], sample_bytes)
    results["lang_forced"] = {"lang": "ja-JP", "code": r["code"], "report": r["report"]}
    write(results, out_dir)


def mb(value):
    return f"{int(value) / MiB:.0f}" if value else "?"


def write(results, out_dir):
    with open(os.path.join(out_dir, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)
    md = [f"## Windows OCR spike\n", f"ocr-text.exe: {results['exe_size']} bytes\n"]
    md.append("### Probe per lockdown configuration\n")
    md.append("| config | exit | integrity | in job | available | user langs | profile engine | engine ms | report |")
    md.append("|---|---|---|---|---|---|---|---|---|")
    for p in results["probe"]:
        d = p["data"] or {}
        md.append(f"| {p['config']} | {p['code']} | {hex(d['integrity']) if 'integrity' in d else ''} | "
                  f"{d.get('in_job', '')} | {', '.join(d.get('available', []))} | "
                  f"{', '.join(d.get('user_languages', []))} | {d.get('user_profile_engine', '')} | "
                  f"{d.get('engine_ms', '')} | `{p['report']}` |")
    md.append("\n### Recognition per lockdown configuration (text-scan@2200)\n")
    md.append("| config | decoder | exit | wall ms | CER | report |")
    md.append("|---|---|---|---|---|---|")
    for e in results["relax"]:
        md.append(f"| {e['config']} | {e['decoder']} | {e['code']} | {e['wall_ms']} | "
                  f"{e.get('cer', '')} | `{e['report'][:120]}` |")
    if results["pages"]:
        md.append(f"\n### Pages ({results['chosen']})\n")
        md.append("| page | long edge | exit | wall ms (process) | engine ms | decode ms | OCR ms cold | OCR ms warm | peak commit MiB | lines | CER | word recall | labels | notes | vertical | angle |")
        md.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for e in results["pages"]:
            md.append(f"| {e['name']} | {e['long_edge']} | {e['code']} | {e['wall_ms']} | "
                      f"{e.get('engine_ms', '')} | {e.get('decode_ms', '')} | {e.get('ocr_ms', '')} | "
                      f"{e.get('ocr_warm_ms', '')} | {mb(e.get('peak_commit'))} | {e.get('lines', '')} | "
                      f"{e.get('cer', '')} | {e.get('word_recall', '')} | {e.get('label_recall', '')} | "
                      f"{e.get('notes_recall', '')} | {e.get('vertical_found', '')} | {e.get('angle', '')} |")
        md.append("\n### Job memory limit\n")
        md.append("| page | limit MiB | exit | report |")
        md.append("|---|---|---|---|")
        for e in results["memory"]:
            md.append(f"| {e['name']}@{e['long_edge']} | {e['limit_mib']} | {e['code']} | `{e['report'][:100]}` |")
        md.append(f"\nTruncation (--max-output 2048): `{results.get('truncation')}`\n")
        md.append(f"Forced missing language: `{results.get('lang_forced')}`\n")
    text = "\n".join(md) + "\n"
    with open(os.path.join(out_dir, "summary.md"), "w", encoding="utf-8") as f:
        f.write(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text)
    print(text)


if __name__ == "__main__":
    main()
