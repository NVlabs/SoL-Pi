# SoL-Pi v2

SoL-Pi v2 hands routine work from a strong model to a cheaper model on the same API. A judge approves each hand-off
and decides when the strong model takes the work back, and a short note replaces the cheap model's stint in the strong
model's context. The same design ships for three hosts:

| Folder | Host | Strong → cheap | Start here |
|---|---|---|---|
| [pi](pi/README.md) | Pi 1.2.0, as an extension | GPT-6.1 Sol → GPT-6 Luna; Claude Opus 5.5 → Claude Haiku 5.5 | `pi install /path/to/SoL-Pi/v2/pi` |
| [codex](codex/README.md) | Codex CLI, through a local proxy | GPT-6.1 Sol → GPT-6 Luna | `v2/codex/codex-solpi` |
| [claude-code](claude-code/README.md) | Claude Code, through a local proxy | Claude Opus 5.5 → Claude Haiku 5.5 and Claude Sonnet 5.5 | `v2/claude-code/claude-solpi` |

Each README gives the configuration, the measured results with their basis and limits, and the known limitations.
The measured savings reflect the gateway rates used in the evaluation. End-to-end testing on the official OpenAI and
Anthropic APIs is still outstanding. The code here includes review fixes made after the measured versions; they have
not been re-measured.

## Tests

The tests use mocks and make no model calls.

```sh
(cd v2/pi && node --test test/*.test.js)
(cd v2/codex && python3 -m unittest discover -v)
(cd v2/claude-code && python3 test_ccsave.py)
```
