<p align="center">
  <img src="assets/sol-pi-hero.png" width="100%" alt="SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses" />
</p>

# ⚡ SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses

<p align="center">
  <a href="#getting-started"><img src="https://img.shields.io/badge/Getting%20Started-Install-76B900" alt="Getting Started" /></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Docs-Configuration-555555" alt="Configuration" /></a>
  <a href="https://nvlabs.github.io/SoL-Pi/"><img src="https://img.shields.io/badge/Blog-SoL--Pi-76B900" alt="SoL-Pi Blog" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

> [!NOTE]
> This repository contains the open-source version of SoL-Pi, a standalone extension for [Pi](https://github.com/earendil-works/pi). It is not an official distribution of Pi.

## 💡 TL;DR

**Spend less without making the agent do less useful work.**

SoL-Pi is a standalone extension for Pi that packages four reusable efficiency mechanisms discovered through scaled auto-research loops. It reduces repeated model turns, context replay, oversized observations, and unnecessary long-log reading while preserving the work and evidence an agent needs to finish a task.

SoL-Pi installs on top of an unmodified Pi release. Every mechanism is opt-in and disabled by default.

## Introduction

Long-running coding agents accumulate repeated work. A file edit is often followed by a predictable validation command. Large tool results are replayed long after their first use. Completed subtasks remain in active context, and a frontier model may spend a full request reading a log when only a few lines affect the next decision.

SoL-Pi grew out of a broader question from our auto-research work: before scaling agent loops, can agents first make the harness itself more efficient? The search focused on constrained efficiency: reducing token traffic, inference work, and agent turns without stopping early, skipping verification, or hiding evidence.

The standalone release contains four mechanisms that survived that process. They operate at different parts of the harness and compose through Pi's public extension APIs.

## What SoL-Pi Adds

| Area | Mechanism | What changes |
|---|---|---|
| Tools | **Action Fusion** | An edit or write can run its follow-up validation command in the same tool call. |
| Observations | **ObservationPack** | Repeated large text results become stable handles with exact paged recall. |
| Delegation | **Evidence-Preserving Reducer** | Long diagnostic logs become compact receipts only when every retained quotation matches the archived source. |
| Context | **Online Context Compact** | Completed plan steps become candidate points for Pi's native compaction, subject to economic and window-pressure checks; after a successful compaction, Pi continues the task in a new turn. |

The mechanisms share four rules:

- **No Pi patches.** SoL-Pi imports public Pi APIs and does not vendor the Pi source tree.
- **Explicit opt-in.** A missing configuration leaves every mechanism disabled.
- **Preserve evidence.** Original observations remain available locally, and reducer failures leave the original result unchanged.
- **Use Pi's runtime choices.** Authentication, provider URLs, the main model, and shell behavior remain under Pi's control.

## Technical Details and Core Insights

Read the [SoL-Pi blog](https://nvlabs.github.io/SoL-Pi/) for a deeper look at the technical details, design rationale, and core insights behind SoL-Pi, including how auto-research led to the four efficiency mechanisms and how they work.

## Getting Started

### Requirements

- Node.js 22.19 or newer
- npm
- `@earendil-works/pi-coding-agent` 0.84.2

### Install

Install the tested Pi release:

```bash
npm install --global @earendil-works/pi-coding-agent@0.84.2
```

Then install SoL-Pi directly from [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi):

```bash
pi install git:github.com/NVlabs/SoL-Pi
```

To install it only for the current project, use the project-local scope:

```bash
pi install git:github.com/NVlabs/SoL-Pi --local --approve
```

### Configure

SoL-Pi uses a single effective configuration. With the official Pi distribution, it looks for a `sol-pi.json` file in the following locations, in order:

1. `.pi/sol-pi.json` in the current project, if the project is trusted and the file exists;
2. `~/.pi/agent/sol-pi.json` otherwise.

If neither file exists, SoL-Pi uses its built-in defaults. The project-level configuration takes precedence over the user-level configuration; the two files are not merged.

The following conservative configuration enables only the two local mechanisms that make no additional model calls and do not stop an active run:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Enable additional mechanisms only after reviewing their configuration and security implications. SoL-Pi uses no dedicated environment variables; feature flags, the reducer provider/model route, and the compaction ratio are configured in `sol-pi.json`.

For the complete schema, see [Configuration](docs/configuration.md). Coding agents and automated environments should follow the canonical [agent installation and configuration protocol](agents-install.md). Its all-enabled profile is checked with `scripts/check-sol-pi-config.mjs --require-all-enabled`.

## Storage and Security

ObservationPack and Evidence-Preserving Reducer store session-specific archives under:

```text
<session-directory>/sol-pi/<session-id>/
├── observation-pack/
└── evidence-preserving-reducer/
```

They archive eligible source material in this directory. The archived copies remain local and are not automatically deleted when the Pi session ends.

Online Context Compact stores its state in Pi's session log. After a successful compaction, it starts a new turn and automatically continues the active task. Cancelling the run or exiting Pi does not trigger automatic continuation.

Evidence-Preserving Reducer may send eligible diagnostic-log content to its configured reducer model using Pi-managed authentication. Review [SECURITY.md](SECURITY.md) before enabling it. Do not enable remote reduction for logs that must remain local.

## Documentation

| Document | Purpose |
|---|---|
| [Configuration](docs/configuration.md) | Config search order, schema, defaults, and trust behavior |
| [Compatibility](docs/compatibility.md) | Supported Pi APIs and standalone integration details |
| [Security](SECURITY.md) | Local storage, remote reduction, and sensitive behavior |
| [Agent installation](agents-install.md) | Reproducible installation and all-enabled validation procedure |

## Development

Install from the lockfile and run the complete source checks:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
node scripts/check-pi-compat.mjs
```

`npm run check` covers TypeScript, the complete test suite, and package inspection. The development dependency set is pinned to Pi 0.84.2; runtime Pi packages remain peer dependencies so Pi owns their installation and upgrades.

## Fixed Issues

SoL-Pi has identified and resolved several issues through systematic testing, cross-platform validation, and user feedback. Below is a comprehensive record of each issue, how it was discovered, and the solution implemented.

### 1. Action Fusion mishandled `file://` URLs

**Issue:** When Pi passed a `file://` URL as the target for an edit or write operation, Action Fusion treated it as a relative file path. This caused the per-file queue key and the pre-`then_run` hash guard to mismatch, so the validation command would not run or would run against the wrong file.

**How it was found:** Discovered through automated testing when Action Fusion tests failed with percent-encoded filenames and Pi's optional `@` prefix on file URLs. The issue was specific to how Node's path resolution handled URL-encoded strings.

**Solution:** Added `fileURLToPath()` decoding in `resolveToolPath()` for targets starting with `file://` after stripping Pi's optional `@` prefix. This ensures file URLs, including percent-encoded filenames, align with the file handled by the built-in mutation tool.

**Files changed:**
- `src/sol-pi/extensions/action-fusion/file-queue.ts`
- `tests/action-fusion-paths.test.ts` (new test file)
- `docs/compatibility.md` (documentation)

**Reference:** PR #4, commit `6f74efc`

### 2. Action Fusion renderer test was path-dependent

**Issue:** The Action Fusion renderer test asserted that non-fused renders never contain "SoL-Pi", but the checkout directory name or an OSC 8 hyperlink in the path could contain the repo name, causing false test failures.

**How it was found:** Tests failed when the repository was cloned into a directory named "SoL-Pi" or when the path contained hyperlink metadata with the repo name.

**Solution:** Changed assertions to specifically check for the badge text (`⚡ SoL-Pi · Action Fusion` / `Money saved · 1 model round-trip avoided`) rather than the string "SoL-Pi" anywhere in the output. Added parameterized tests for different checkout names and paths.

**Files changed:**
- `tests/action-fusion.test.ts`

**Reference:** PR #3, commit `c0f7521`

### 3. ObservationPack failed without persistent session directory

**Issue:** When Pi ran without a persistent session directory, ObservationPack threw an exception when trying to create the storage root, breaking context projection entirely.

**How it was found:** Encountered when testing SoL-Pi in environments where Pi doesn't provide a persistent session directory (e.g., temporary sessions or certain containerized environments).

**Solution:** Wrapped `runtimeRoot(ctx)` in try/catch and implemented fail-open behavior. When no persistent session directory exists, ObservationPack returns the context unchanged with an `[observationpack] fail-open:` log message, rather than throwing an exception.

**Files changed:**
- `src/sol-pi/extensions/observation-pack/index.ts`

### 4. ObservationPack symlink protection didn't work on Windows

**Issue:** The `O_NOFOLLOW` constant used for symlink protection is undefined on Windows, causing the observation file reading to fail or behave unexpectedly on Windows systems.

**How it was found:** Cross-platform testing on Windows revealed that `O_NOFOLLOW` is platform-specific and not available on Windows.

**Solution:** Implemented portable symlink protection using:
- `constants.O_NOFOLLOW ?? 0` (fallback to 0 on Windows)
- Added `regularNonSymlinkFile()` lstat checks
- Synthesized `ELOOP` error for parity with Unix behavior
- Symlink-dependent tests marked with `it.skipIf(isWindows)`

**Files changed:**
- `src/sol-pi/extensions/observation-pack/observation.ts`
- `tests/observation-pack.test.ts`

### 5. npm pack test broke with npm ≥ 12

**Issue:** npm version 12 changed the output format of `npm pack --dry-run` from an array to a single object keyed by package name, causing test assertions to fail.

**How it was found:** Tests passed on npm 10/11 but failed on npm 12+ due to the changed JSON structure.

**Solution:** Updated test to handle both array and object report shapes. Also added `npm.cmd` support for Windows compatibility.

**Files changed:**
- `tests/package.test.ts`

### 6. No CI validation on Windows/macOS

**Issue:** The repository only had CI configured for Linux, so platform-specific issues (like the Windows symlink problem and npm.cmd handling) weren't caught until manual testing.

**How it was found:** When fixing the Windows-specific issues, it became clear that cross-platform validation wasn't automated.

**Solution:** Added `.github/workflows/ci.yml` that runs the full validation suite on ubuntu, macOS, and Windows with Node 22. The workflow runs:
- `npm ci --ignore-scripts`
- `npm run check` (typecheck + tests + package inspection)
- `npm audit --audit-level=high`
- `scripts/check-pi-compat.mjs`

**Files changed:**
- `.github/workflows/ci.yml`

### 7. Dependency security vulnerabilities

**Issue:** Transitive dependencies had known vulnerabilities (CVEs) that needed to be pinned to safe versions.

**How it was found:** `npm audit --audit-level=high` flagged vulnerabilities in `nanoid`, `postcss`, and `protobufjs`.

**Solution:** Added overrides in `package.json` to pin safe versions:
- `nanoid`: `3.3.18`
- `postcss`: `8.5.26`
- `protobufjs`: `7.6.5`

Also updated `vitest` from pinned `4.1.9` to range `^4.1.11` for compatibility.

**Files changed:**
- `package.json`
- `package-lock.json`

## Issue Discovery Process

Issues were discovered through multiple channels:

1. **Automated testing** - Running `npm run check` and `npx vitest run` across different environments
2. **Cross-platform validation** - Testing on Linux, macOS, and Windows
3. **npm version compatibility** - Testing with different npm versions (10, 11, 12+)
4. **Security auditing** - Running `npm audit --audit-level=high` to catch dependency vulnerabilities
5. **User feedback** - Reports from users running SoL-Pi in various environments
6. **Edge case analysis** - Examining how Pi passes file URLs and handles different session types

## Issue Resolution Process

For each issue discovered:

1. **Reproduction** - Created minimal test cases to reproduce the issue
2. **Root cause analysis** - Identified the specific code path causing the failure
3. **Fix implementation** - Made the minimum necessary changes to resolve the issue
4. **Regression testing** - Added test cases to prevent future regressions
5. **Documentation** - Updated relevant docs (compatibility.md, agents-install.md)
6. **Cross-platform verification** - Ensured the fix works on all supported platforms

## Project Status

SoL-Pi is developed and maintained by NVIDIA as a standalone extension for Pi.

We welcome tested, Pi-compatible extension PRs that improve token efficiency and reduce token cost. Our team will help benchmark contributions, publish results on a regular reporting cycle, and credit authors of accepted PRs as Contributors. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Acknowledgements

SoL-Pi builds on the public extension interfaces provided by [Pi](https://github.com/earendil-works/pi). Pi remains an independent upstream project and is not vendored into this repository.

## License

SoL-Pi is released under the [MIT License](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=NVlabs%2FSoL-Pi&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" />
    <img alt="SoL-Pi star history chart" src="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" width="100%" />
  </picture>
</a>
