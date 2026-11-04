# Contributing to Hearer

Thanks for helping out. Hearer is pre-alpha, so the best first step is to open an issue or discussion before starting anything large.

## Setup

Requirements: **Node 24** (see `.nvmrc`) and **pnpm 10** (pinned in `package.json`; `corepack enable` will pick it up).

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check   # or `pnpm format` to fix
```

The repository is a pnpm workspace: `apps/server`, `apps/web`, `packages/shared` and `e2e`. Dependencies are pinned to exact versions; shared dev tooling versions live in the `catalog` section of `pnpm-workspace.yaml`.

## Ground rules

- TypeScript with `strict` on, ESM only. Avoid `any`; if you must, justify it in a comment.
- Read [docs/DECISIONS.md](docs/DECISIONS.md) before proposing architectural changes. Locked decisions win over the plan; amend them in a PR if you want to change one.
- Do not hard-code values specific to your own deployment.
- Tests must not touch the network. Use fixtures or mocks; put live tests behind an opt-in environment variable.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(server): ...`, `fix(web): ...`, `docs: ...`, `chore: ...`.
- Keep pull requests focused. Fill in the PR template.
- Every behavior change needs tests, including edge and error cases. Lint, typecheck and tests must pass.

## Batch workflow

Work is planned as numbered batches (H-01, H-02, ...) in [docs/PLAN.md](docs/PLAN.md). Each batch should be small (about 8 files, tests included), end green on its verify command, and append a handoff entry to [docs/STATUS.md](docs/STATUS.md) with what shipped, the verify output, deviations and open questions. If a batch grows too large, split it into a/b parts.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## End-to-end tests

`pnpm e2e` builds the server and web app, starts them on temp directories next to mock Jellyfin, MusicBrainz and Cover Art Archive, AcoustID and webhook services (`e2e/mocks/`), and drives a real Chromium with Playwright. It needs `ffmpeg` and, for uploads, `fpcalc` on the PATH. Install the browser once with `pnpm --filter e2e exec playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing Chromium. Write specs against `e2e/fixtures.ts` (the `api` client for set-up shortcuts, `generateAudio`, `mocks`); set `E2E_KEEP=1` to keep the temp directories and server log of a run.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). Use [conventional commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `feat!:` ...). release-please keeps a "chore: release X.Y.Z" pull request open on `main` that updates `CHANGELOG.md` and the version in the root, `apps/server`, `apps/web` and `packages/shared` `package.json` files and in `APP_VERSION` (`packages/shared/src/index.ts`, found by its `x-release-please-version` marker). Merging that pull request tags `vX.Y.Z`, creates the GitHub release and publishes the multi-arch image to `ghcr.io/<owner>/hearer` as `X.Y.Z`, `X.Y`, `X` (not for 0.x) and `latest`, with SBOM and provenance attestations.

- While the version is below 1.0, breaking changes and features both bump the minor version. The manifest starts at `0.0.0`, so the first release is `0.1.0`.
- To cut **1.0.0**: add `"release-as": "1.0.0"` to the `.` package in `release-please-config.json`, merge the resulting release PR, then remove the line again (and `bump-minor-pre-major` stops mattering).
- The release pull request is opened with the default token, which does not start CI on it. To get CI on release PRs, add a personal access token or a GitHub App token as the repository secret `RELEASE_PLEASE_TOKEN`.
