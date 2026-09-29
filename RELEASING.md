# Releasing `@wraith-protocol/sdk`

This is the release checklist for the SDK. A release is ready when three things
agree — the version in `package.json`, the `CHANGELOG.md` entry for that version,
and the API report in `etc/` — and when the tarball that reaches the registry is
the tarball this repository built. [CONTRIBUTING.md § Semver Policy](./CONTRIBUTING.md#semver-policy)
decides which bump a change needs, and § Release Process says who may publish.

## What CI does for you

`.github/workflows/publish.yml` runs on a push to `main` that touches
`package.json`, and on manual dispatch. It checks the three alignment rules
before it uploads anything, and refuses to finish a release whose attestation is
missing:

| Step             | Command                                                     | Guarantees                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API report       | `pnpm api:check`                                            | `etc/*.api.md` matches the declarations `pnpm build` produced, so the report and the release cannot drift apart                                                                                   |
| Packed file list | `pnpm pack:check` (`scripts/release/verify-pack.mjs`)       | `pnpm pack --dry-run` lists only files the `files` field intends, nothing from `test/`, `src/`, CI configuration, secrets, source maps or temp directories, and every `exports` target is present |
| Version          | `npm view <name>@<version> version`                         | a version that is already on the registry is skipped instead of republished                                                                                                                       |
| Publish          | `pnpm publish --access public --no-git-checks --provenance` | npm signs the tarball and stores its build provenance attestation                                                                                                                                 |
| Provenance       | `node scripts/release/verify-provenance.mjs`                | the registry advertises an SLSA v1 attestation, its subject digest is the published tarball, and it names this repository and commit                                                              |

`pnpm test:exports` and `pnpm test:compat` in `.github/workflows/ci.yml` cover
what the built package does at runtime; `pnpm pack:check` covers what ships.

## Checklist

### 1. Version

- [ ] Pick the bump with the semver table in [CONTRIBUTING.md](./CONTRIBUTING.md#semver-policy).
      When it is ambiguous, take the larger bump and say why in the changelog.
- [ ] Set the same version in `package.json`.
- [ ] Confirm the version is not already on the registry: `npm view @wraith-protocol/sdk@<version> version` must print nothing.

### 2. Changelog

- [ ] Add the entry to [`CHANGELOG.md`](./CHANGELOG.md) so the version there matches `package.json`,
      following the existing shape: an `### Added` / `### Changed` / `### Fixed`
      section, one bolded line per change, and the issue number the change came
      from.
- [ ] Every deprecation ships with a note here, plus `MIGRATING.md` steps when
      the replacement needs more than a one-line import change.

### 3. API report

- [ ] Run `pnpm build && pnpm api:check`. The API Extractor configs in
      `api-extractor*.json` refresh `etc/*.api.md`; commit the updated reports in
      the same pull request as the code that changed the API.
- [ ] Confirm the reports you changed cover every entry point you touched:
      `etc/sdk.api.md`, `etc/sdk-evm.api.md`, `etc/sdk-stellar.api.md`,
      `etc/sdk-solana.api.md`, `etc/sdk-ckb.api.md` and `etc/sdk-vault.api.md`.

### 4. Package contents

- [ ] Run `pnpm build && pnpm pack --dry-run` and read the file list. It should
      be `dist/` plus the metadata npm always ships (`package.json`, `README.md`,
      `LICENSE`).
- [ ] Run `pnpm pack:check` to assert the same thing, which is what the publish
      workflow gates on.
- [ ] If a genuinely intended new path is missing, add it to the `files` field of
      `package.json`; if an unintended path appears, fix the build or the
      `.npmignore`-style ignore rules rather than widening `files`.
- [ ] Source maps, tests, `src/`, CI configuration and dotfiles are rejected by
      the deny rules in `scripts/release/verify-pack.mjs`. Widening that list is a
      deliberate change and belongs in the same pull request.

### 5. Provenance

- [ ] Confirm `id-token: write` is still set on the `publish` job, because
      `--provenance` cannot sign without it.
- [ ] After the workflow publishes, read its **Verify the npm provenance
      attestation** step: it fails the release when the registry has no
      attestation for the version, when the attestation is for a different
      artifact, or when it names another repository or commit.
- [ ] To verify the signature itself, not just what was signed, install the
      released version in a scratch directory and run `npm audit signatures`:

      ```bash
      mkdir /tmp/wraith-release-check && cd /tmp/wraith-release-check
      npm init --yes
      npm install @wraith-protocol/sdk@<version>
      npm audit signatures
      ```

- [ ] The raw attestation is readable at
      `https://registry.npmjs.org/-/npm/v1/attestations/@wraith-protocol%2fsdk@<version>`
      and is linked from the version's `dist.attestations.url`.

### 6. Tag and announce

- [ ] Merge the release commit to `main` and tag it `vX.Y.Z`.
- [ ] Confirm the published version on npm shows the **Provenance** badge for the
      repository and workflow run.
- [ ] Announce the release with the changelog entry.

## When a check fails

- **`pnpm api:check` fails**: the built API and `etc/*.api.md` disagree. Run
  `pnpm build` again, inspect the diff in the reports, and either commit it (an
  intended API change) or fix the source (an unintended one).
- **`pnpm pack:check` fails**: the message names the offending path and why. Fix
  the build or the `files` field; do not publish around it.
- **Provenance verification fails**: the release did not gain a usable
  attestation. Re-run the workflow rather than publishing a second time — the
  version check skips the version that already exists, so bump the version for a
  new attempt.
