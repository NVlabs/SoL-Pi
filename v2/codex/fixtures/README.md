`v12.state` was written offline by the `new_conv()`, `mark()` and `save()` functions
from `git show f391b4b:experiments/sol-pi-v2-codex/ccsave.py` (the team's internal repository), loaded as a non-main
module in a temporary directory. No server or API request was started.

The history was the mock fixture `START + step(1)`, under key `k`, with calls=876,
judged=875, an active stint starting at item 4, and an old note for [4, 7).
The original code computed the tail and serialized the state. In particular the
file has no newer head or instruction fingerprint. The round-2 legacy-state test
copies this file into the proxy's state path before startup.
