# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""Exit estimate from this process's JSONL records; prices are USD per million tokens."""
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from records import open_record

# Standard list prices recorded on 2026-11-15 (gpt-6.2-sol: 2026-11-18), an offline snapshot; limits and CCSAVE_PRICES in README.md.
# Each row: input, cached input, output; second row applies above 272k input tokens.
PRICES = {
    "gpt-6.1-sol": [[2, 0.1, 10], [4, 0.2, 15]],
    "gpt-6.2-sol": [[2, 0.1, 10], [4, 0.2, 15]],
    "gpt-6-luna": [[0.1, 0.01, 0.5], [0.2, 0.01, 0.75]],
}


def prices():
    table = dict(PRICES)
    for model, rows in json.loads(os.environ.get("CCSAVE_PRICES", "{}")).items():
        if len(rows) == 3 and all(isinstance(x, (int, float)) for x in rows):
            rows = [rows, rows]
        if (len(rows) != 2 or any(len(row) != 3 for row in rows)
                or any(not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0 for row in rows for x in row)):
            raise ValueError("CCSAVE_PRICES needs [input, cached_input, output] or two such rows per model")
        table[model] = rows
    return table


def cost(model, usage, table):
    rows = table.get(model) or table[model.rsplit("/", 1)[-1]]
    tokens, output = usage["input_tokens"], usage["output_tokens"]
    cached = (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
    if any(not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0 for x in (tokens, output, cached)) or cached > tokens:
        raise ValueError("invalid usage")
    inp, hit, out = rows[tokens > 272000]
    return ((tokens - cached) * inp + cached * hit + output * out) / 1e6


def estimate(records, table):
    saving = 0.0
    for rec in records:
        cheap = rec.get("kind") == "request" and rec.get("cheap")
        side = rec.get("kind") == "side"
        if not (cheap or side):
            continue
        success = rec.get("completed") is True and rec.get("status") == 200 and not rec.get("error")
        if not success and rec.get("usage") is None:
            continue
        actual = cost(rec["model"], rec["usage"], table)
        saving -= actual
        if cheap and success:
            saving += cost(rec["strong_model"], rec["usage"], table)
    return saving


def summary(path, offset=0):
    try:
        with (os.fdopen(os.dup(path), 'rb') if isinstance(path, int) else open_record(path, 'rb')) as f:
            f.seek(offset)
            records = [json.loads(line) for line in f if line.strip()]
            total = estimate(records, prices())
        cheap = ", ".join(sorted({r["model"] for r in records if r.get("cheap") or r.get("kind") == "side"}))
        strong = ", ".join(sorted({r["strong_model"] for r in records if r.get("strong_model")}))
        label = f"{cheap} work at {strong or 'configured strong model'} prices minus {cheap}, judges and notes" if cheap else "no cheap-model work recorded"
        return f"SoL-Pi estimated saving: ${total:.6f} ({label})."
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return "SoL-Pi estimated saving: unavailable (missing/invalid log, usage or model prices)."


if __name__ == "__main__":
    print(summary(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0))
