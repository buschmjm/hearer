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

The repository is a pnpm workspace: `apps/server`, `apps/web` and `packages/shared`. Dependencies are pinned to exact versions; shared dev tooling versions live in the `catalog` section of `pnpm-workspace.yaml`.

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
