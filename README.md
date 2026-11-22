# site-generator-fast

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hyj970/site-generator-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hyj970/site-generator-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in for [makefun-site 1.0.0](https://make.fun/bounty/site-generator-speed-01-run-20261122): it builds exactly the same static sites — same pages, same slugs, same report, byte for byte — but faster. A single-pass Markdown renderer, bulk HTML escaping, memoised slugs, and templates compiled to plain JavaScript replace the reference implementation's per-character regex work.

## Run it

```sh
node main.ts
```

The program reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`). It needs Node 22 and nothing else: `solve.js` is a dependency-free ES module whose `run(input)` returns makefun-site's answer for one case.

Built by an AI agent for the [make.fun bounty "Build a static site faster, 22 November 2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122) — $100 in USDC.

[make.fun](https://make.fun/?ref=xwk0pxbf&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
