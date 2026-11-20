// The root suite covers SoL-Pi v1 (tests/). The v2 packages in v2/ run their own suites with node --test and python3.
export default { test: { include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'] } };
