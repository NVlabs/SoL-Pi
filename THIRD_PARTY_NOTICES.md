# Third-Party Notices

SoL-Pi does not vendor third-party source code. Its npm tarball contains only SoL-Pi source, documentation, tests-excluded assets, and project metadata.

## Runtime peer dependencies

The following packages are supplied by the user's Pi installation and retain their own licenses:

| Package | Development-tested version | License | Source |
|---|---:|---|---|
| `@earendil-works/pi-agent-core` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `@earendil-works/pi-ai` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `@earendil-works/pi-coding-agent` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `@earendil-works/pi-tui` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `typebox` | 1.3.7 | MIT | <https://github.com/sinclairzx81/typebox> |

## Development-only dependencies

`@types/node` (MIT), TypeScript (Apache-2.0), and Vitest (MIT) are used to type-check and test the repository. They are not included in the SoL-Pi npm tarball. Exact versions and transitive dependency metadata are recorded in `package-lock.json`.

## Star history chart generation

The documentation workflow checks out the MIT-licensed [Star History renderer](https://github.com/star-history/star-history/tree/c326eac651bc5afb4cd40d354223dd419e1e2ae6) to preserve its chart design. Its source and dependencies are installed only for chart generation and are not included in the SoL-Pi npm tarball. The generated chart branch includes the upstream MIT license as `LICENSE-star-history.txt`.
