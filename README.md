# tokenhud

A live terminal heads-up display for your coding-agent usage: Claude Code and Codex
subscription limits per account, cost history, and an MCP server so agents can check
their own limits and wait for a reset instead of failing mid-task.

> **Status: early development.** Nothing is usable yet. tokenhud is the TypeScript (Bun)
> successor to [cc-usage](https://github.com/ZhuoQiuMcgill/cc-usage), which is now frozen.
> When tokenhud ships, it will import cc-usage's usage history.

## Development

Prerequisite: [Bun](https://bun.com) 1.4.2 or later. CI pins 1.4.2; Bun 1.3.12 and 1.4.0
produced macOS binaries with broken signatures.

```sh
bun install      # dev tooling only; tokenhud has no runtime dependencies yet
bun run check    # typecheck (tsc), lint and format check (Biome), tests (bun test)
bun run build    # standalone binary for this machine at dist/tokenhud
```

`tokenhud json` output for scripts and agents is documented in
[docs-public/JSON.md](docs-public/JSON.md) (schema 1).

`bun run format` rewrites files in the project style. `bun run build --target=<bun target>`
cross-compiles; for example, `--target=bun-windows-x64` writes `dist/tokenhud.exe`.

Repository layout:

```
src/cli.ts         entry point: parses arguments and dispatches commands
src/version.ts     the version, taken from package.json at build time
src/commands/      one module per subcommand: json, doctor, import-cc-usage
src/query/         the query layer: periods, totals and groupings, priced to the cent
src/store/         the SQLite usage store and its hourly rollup
src/pricing/       the dated price table and the cost engine
test/              bun test suites; they run the CLI in a subprocess
scripts/build.ts   wrapper around bun build --compile
```

## License

[MIT](LICENSE)
