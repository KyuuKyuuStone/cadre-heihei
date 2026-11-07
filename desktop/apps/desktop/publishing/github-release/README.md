---
description: "Publish one desktop prerelease on GitHub Releases with one operator and a proven three-point commit identity. The release script validates the packaged commit, the tag and the release target before it writes anything."
---

# Desktop GitHub release publication

English | [中文](README.zh.md)

## Summary

Publish one desktop prerelease on GitHub Releases with one operator and a proven three-point commit identity. The release script validates the packaged commit, the tag and the release target before it writes anything. The [publication reference](../README.md) and the [CI publication workflow](../ci/README.md) own the download-service and self-hosted channels; this reference owns the public prerelease channel the release operators publish directly on GitHub.

## Table of Contents

- [Release rules](#rules)
- [Before you publish](#before-you-publish)
- [Publish with the release script](#publish)
- [Failure messages and recovery](#recovery)
- [Incident reference: v1.5.3](#incident)

<a id="rules"></a>

## Release rules

1. One operator publishes a version. While a draft or an asset-carrying release for the version exists, the script refuses a second operator, so parallel publishes cannot double-upload.
2. The tag `v<version>`, the release `targetCommitish`, and the packaged commit must name one commit. The packaged commit comes from the `<target>-release.json` completion record that the packaging scripts write beside the installer, so no operator types a commit id.
3. The build must come from a clean checkout. A completion record that says `dirty` is refused, because the tag would not name the tree users received.
4. The script reads before it writes: every remote check runs first, the tag is never moved, assets are never clobbered, and every create passes `--target <commit>` explicitly.

<a id="before-you-publish"></a>

## Before you publish

Build the release artifacts and keep the completion record beside them. The Windows release path is `pnpm release:win --version <version>`, which produces the installer, the adjacent `.exe.blockmap`, and `win-x64-release.json` under `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`. A missing or stale record is a hard stop: rebuild with the current packaging scripts instead of hand-writing the record.

Prepare the release notes as a Markdown file; `--notes-file` is required. Push the packaged commit to GitHub before publishing, because the release must target a commit the remote knows. `gh` must be installed and authenticated (`gh auth login`); the script uses the operator's own GitHub identity and never retries on its own.

<a id="publish"></a>

## Publish with the release script

Run from `apps/desktop`. Validate first with `--dry-run`, which performs every local and remote check and writes nothing:

```sh
pnpm exec tsx scripts/desktop-github-release.ts \
  .desktop-build/targets/win-x64/unsigned-artifacts/cadre-heihei-1.5.4-win-x64-unsigned.exe \
  --notes-file <notes.md> --dry-run
```

Publish by dropping `--dry-run`. The script creates the prerelease with `gh release create v<version> --target <commit> --prerelease --title --notes-file`, uploads the installer and its blockmap without `--clobber`, reads the release back, and verifies the tag, the target commit, and every asset's state, size, and SHA-256 digest before it reports success. An existing empty release that targets the packaged commit is resumed; every other existing release state is refused.

<a id="recovery"></a>

## Failure messages and recovery

Every failure prints the rule that stopped the run and exits nonzero without further writes. `no completion record`, `names no version`, or `is not a full commit id`: rebuild with the packaging scripts. `with uncommitted changes`: rebuild from a clean checkout. `is not on <repository>`: push the release commit first.

`tag ... names X, not the packaged commit` or `is an annotated tag`: reconcile the tag manually; the script never moves it. `release ... targets X, not the packaged commit`: delete the release and publish again with the script. `already carries N asset(s)`: another operator published; verify the release instead of uploading. `is a draft`: another operator is preparing it; reconcile with them. `gh release upload ... failed` or `verification failed`: view the release, reconcile the partial state manually, and only then run the script again.

<a id="incident"></a>

## Incident reference: v1.5.3

v1.5.3 was published with a `gh release create` that omitted `--target`, so GitHub attached the release to the default branch head instead of the tag's commit: the tag named the build commit while the release targeted the master head, and a second operator uploading the same asset was rejected by the duplicate-asset guard. The script makes that flow impossible: the target is always explicit, a mismatching tag or release is refused before any write, and an asset-carrying release is never uploaded into.

## Dev Note

None.
