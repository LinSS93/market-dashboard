# Contributing

1. Never commit credentials, account identifiers, holdings, raw provider payloads, deployment details, or private network addresses.
2. Preserve the boundary between research output and trade execution. Radar / 机会雷达 must not create trade instructions or weaken risk exits.
3. Historical backfills must never be presented as live evidence.
4. Run `npm run check:all` and `npm run verify:public` before opening a pull request.

New providers must be opt-in, rate-limited, documented in `docs/data-sources.md`, and covered by deterministic tests.
