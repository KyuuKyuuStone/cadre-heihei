# Upstream and third-party attribution

Cadre Heihei is an independent distribution built on the DeepSeek Harness codebase.

## DeepSeek Harness

- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- Baseline commit: `687f282e` (DeepSeek Harness `0.2.1-rc.2`)
- License: MIT. The upstream license text is preserved in [LICENSE](LICENSE).
- `desktop/` is a source copy of that baseline plus this distribution's changes. The vendored submodule was removed; compare against an external upstream checkout with:

```sh
node desktop/scripts/check-upstream-drift.mjs --upstream <upstream-checkout>
```

The drift checker's registry defaults to the private `.internal/UPSTREAM.md` when present, otherwise to this public file.

## Vendored packages

The Cordis framework and its foundation libraries are vendored under `desktop/vendor/`:

- `@deepseek-ai/cordis`, `cordis-plugin-loader`, `cordis-plugin-include`, `cordis-plugin-group`, `cordis-plugin-timer`, `cordis-plugin-hmr`, `cordis-plugin-logger-console`
- `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`

Each package directory preserves its upstream MIT `LICENSE`. Upstream repositories, versions, commits, and the local-modification log are recorded in [vendor/README.md](vendor/README.md).

## Third-party dependencies

Runtime and build dependencies remain on npm and are attributed through their package manifests and licenses. Third-party packages that are deliberately not vendored are listed in [vendor/README.md](vendor/README.md).
