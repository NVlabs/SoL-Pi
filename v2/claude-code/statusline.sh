#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
# Claude Code supplies JSON on stdin; the proxy's atomic file is authoritative.
exec python3 -I -c '
import json, os
log = os.environ.get("CCSAVE_LOG", "")
path = os.environ.get("CCSAVE_SAVED_FILE") or (log + ".saved.json" if log else "")
try:
    with open(path) as f:
        data = json.load(f)
except (OSError, ValueError):
    data = {}
model = str(data.get("current_model", "starting")).rsplit("/", 1)[-1]
model = "".join(c for c in model if c.isprintable())
amount = float(data.get("estimated_saved", 0))
ping = float(data.get("ping_cost", 0))
suffix = " (partial estimate)" if data.get("unpriced_models") or data.get("unpriced_pings") else ""
print(f"⚡ SoL-Pi · {model} · ~${amount:.2f} saved after ${ping:.2f} keep-warm{suffix}")
'
