# Trajectory Inspector validation

## Review follow-up — 2026-09-12

Implementation `efcbef1` addresses provider-internal HTTP retries and incomplete
compaction attempts. `npm run check` passes 149 tests across 18 files, plus
typecheck and package validation. All seven SDK lifecycle cases pass, including
native compaction failure and cancellation, each followed by success. New
regressions verify 429 → 200 and 503 → 200 on a single logical request.

The same 50-pair benchmark passes with unchanged provider requests and expected
outputs. Mean elapsed: 7.81 ms disabled, 12.70 ms enabled. Paired overhead:
mean 4.89 ms, p50 4.47 ms, p95 12.34 ms. Mean ledger size is 9,583 B.
See [follow-up measurements](trajectory-review-50.csv). These are a fresh run,
not a controlled speed comparison against the earlier measurements below.
Request duration now includes retries and streaming; compactions use info
attempts and separate success events because failure callbacks are unavailable.

The original benchmark and live smoke below remain historical evidence for
`9f3185c`.

Measured on 2026-09-11, macOS arm64, Node 26.7.0, Pi 0.84.2, implementation
commit `9f3185c`. This measures observability overhead, not model quality or
token savings.

## Method

`scripts/benchmark-trajectory.mjs` runs the actual Pi SDK, extension loader,
HTTP/SSE model client, session persistence, and built-in `read` tool against a
deterministic loopback provider. It loads the normal SoL-Pi entry point with
only `trajectoryInspector` toggled. No other efficiency features are enabled.

After three warm-up pairs, 50 cases run both disabled and enabled, alternating
order. Cases vary from one to five file reads and roughly 0.1–5.9 KiB of file
content. Eight cases include a real missing-file tool failure in each arm.
This is 100 measured sessions and 300 tool executions. Every corresponding
HTTP request body hash must match, and each session must produce its expected
tool count, error count, and final answer.

The timed window starts at `session.prompt()` and ends after shutdown ledger
flush. Session creation and configuration are excluded. Enabled runs render
the actual widget at 120 columns on each render request using an SDK UI
adapter; terminal I/O is not timed. Resize and toggle assertions run outside
the timing window. A separate real interactive CLI smoke covers terminal I/O.
Latency includes local HTTP, tools, rendering, and buffered filesystem writes;
it does not include remote model inference. Flush awaits writes, not `fsync`.

## Results

All 50 pairs passed, with identical provider-request hashes and expected
outputs. See [every measured pair](trajectory-50.csv).

| Metric | Disabled | Enabled |
| --- | ---: | ---: |
| Mean elapsed | 14.81 ms | 24.45 ms |
| p50 elapsed | 13.15 ms | 22.09 ms |
| p95 elapsed | 25.72 ms | 45.49 ms |
| Mean process CPU time | 15.34 ms | 27.68 ms |
| Mean trajectory log size | 0 B | 8,816 B |

Paired added elapsed time: mean **9.65 ms**, p50 **8.99 ms**, p95 **19.15 ms**.
The ratio of mean elapsed times is **1.65×** on these short local workloads.
This is a single-machine measurement, not a production latency guarantee.

## Runtime and lifecycle checks

- A live `multiverse/glm-5-2` SDK session called the real `read` tool, returned
  the exact requested first line, rendered the widget, and flushed its log in
  **1.74 seconds**. This was one smoke test, not a live-model benchmark.
- The real Pi interactive CLI loaded the normal extension, displayed tool
  activity and completion, handled `/trajectory` hide/show, and exited normally.
- SDK lifecycle checks passed for 50 consecutive tool calls, reopening the
  saved session, recovery after HTTP 503, cancellation during a stream, and
  native compaction. Compaction used a small retained-tail setting to exercise
  the path with a small fixture.
- Render checks cover widths 1, 20, 40, 80, and 120; regression tests also cover
  wide Unicode and terminal control characters.
- Ledger assertions check omitted fixture content, nonzero result byte counts,
  completion records after UI eviction, unique run IDs on resume, valid update
  references, and closed running spans.
- `npm run check`: **145 tests in 18 files**, typecheck, and package dry run pass.
  The public-API compatibility script also passes. Runtime coverage here is
  Pi 0.84.2; no additional Pi-version validation is claimed.

These checks found and fixed zero tool-result byte counts, terminal overflow,
ambiguous restarted ledger IDs, and requests left running after transport
failure. Pending writes were batched to reduce filesystem overhead. An initial
compaction fixture was too small; lowering its retained-tail setting allowed
the real native compaction path to run.

## Reproduce

From a source checkout after `npm ci --ignore-scripts`:

```sh
node scripts/benchmark-trajectory.mjs /tmp/trajectory-50.json
node scripts/benchmark-trajectory.mjs /tmp/trajectory-lifecycle.json --lifecycle
node scripts/benchmark-trajectory.mjs /tmp/trajectory-tui.json --tui
```

The interactive command needs a terminal; toggle `/trajectory` twice and exit
with Ctrl-D. An optional `--live` mode uses the existing Pi authentication for
`multiverse/glm-5-2` and sends only the synthetic fixture task. It requires that
provider/model to be configured and can incur provider charges:

```sh
node scripts/benchmark-trajectory.mjs /tmp/trajectory-live.json --live
```

Each run preserves its isolated session directory and writes JSON measurements
to the specified output path. The benchmark does not modify user Pi settings.
No accuracy improvement, model-cost reduction, or zero-overhead claim is made.
