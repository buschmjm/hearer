# Hearer — status log

Append-only handoff log, one entry per batch (see [PLAN.md](./PLAN.md), "Handoff packet").

## H-01 — Monorepo skeleton + OSS files

**Status:** done

**Shipped:**

- Tooling: root `package.json` (private, ESM, `pnpm@10.34.9`, Node >=24), `pnpm-workspace.yaml` (`apps/*`, `packages/*`, plus a `catalog` that pins shared dev tool versions), `.npmrc` (`save-exact`, `engine-strict`), `tsconfig.base.json`, flat `eslint.config.js` (typescript-eslint strict + stylistic, type-aware via `projectService`), Prettier config/ignore, `.editorconfig`, `.gitignore`, `.nvmrc`.
- `packages/shared` (`@hearer/shared`): `APP_NAME`, `REPO_URL`, `APP_VERSION`, `userAgent()` (the MusicBrainz UA format), Vitest config and 2 tests.
- OSS files: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue forms (bug, feature, adapter, config), PR template, `renovate.json`.
- `docs/PLAN.md` and `docs/DECISIONS.md` copied with links fixed, homelab-only links removed, and plan §0 rewritten as "done, reference for forks" (H-23 noted as living in `homelab-infra`). Substance otherwise unchanged. Prettier re-flowed table whitespace only.

**Verify:** `pnpm i --frozen-lockfile && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm format:check`

```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
> hearer@0.0.0 format:check /home/user/hearer
> prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

typecheck and lint printed no errors.

**Design choices**

- `@hearer/shared` exports its **TypeScript source** (`"exports": "./src/index.ts"`), with no build step. Vite and Vitest consume TS directly. For the Node server, tsx/Node type stripping handles it in dev, and the production image (H-05) should bundle the server (for example tsdown/esbuild) so shared gets inlined. This avoids a build-order dependency and dist/src drift in a workspace. Consequence: relative imports inside packages use explicit `.ts` extensions (`allowImportingTsExtensions` + `noEmit`). If a package ever needs a published, compiled dist, switch to conditional exports then.
- Base tsconfig uses `NodeNext`; `apps/web` should override with `module: ESNext`, `moduleResolution: Bundler`, `lib: [ES2023, DOM, DOM.Iterable]`, `types: []` plus vite types.
- `exactOptionalPropertyTypes` is enabled and works. It may cause friction with some library types (Drizzle, zod inference); relax per package if needed, not globally.
- Each package declares its own `eslint`, `typescript` and `vitest` devDependencies (via `catalog:`) so `pnpm -r <script>` finds the binaries. Root holds the lint config deps and Prettier.
- pnpm 10 blocks dependency build scripts by default. H-02/H-03 must add `onlyBuiltDependencies` (or `pnpm approve-builds`) for `better-sqlite3`, `argon2` and `esbuild`.

**Pinned versions (checked with `pnpm view` on 2026-11-04)**

Only the "installed" rows are in the lockfile now; the rest are the versions later batches should pin.

| package                   | version  | notes                                                                                                                                                                                                        |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| typescript                | 6.0.3    | installed. **Latest is 7.0.2 (native port), but typescript-eslint 8.72.1 peers `typescript <6.1.0`, so 7.x is unsupported for type-aware lint. Pinned to 6.0.3. Revisit when typescript-eslint supports 7.** |
| typescript-eslint         | 8.72.1   | installed. Supports eslint 8/9/10.                                                                                                                                                                           |
| eslint                    | 10.14.0  | installed. Needs Node `^20.19 \|\| ^22.13 \|\| >=24`. Flat config only.                                                                                                                                      |
| @eslint/js                | 10.0.1   | installed. Peer eslint ^10.                                                                                                                                                                                  |
| globals                   | 17.14.0  | installed.                                                                                                                                                                                                   |
| prettier                  | 3.9.10   | installed.                                                                                                                                                                                                   |
| vitest                    | 5.1.0    | installed. Peer vite `^6.4 \|\| ^7 \|\| ^8`, so vite 8.3.5 is compatible. Node `^22.12 \|\| ^24 \|\| >=26`.                                                                                                  |
| @types/node               | 24.19.2  | installed, matching the Node 24 runtime. `latest` is 26.6.6, which is wrong for Node 24.                                                                                                                     |
| fastify                   | 5.12.8   | matches plan (Fastify 5).                                                                                                                                                                                    |
| fastify-type-provider-zod | 7.0.0    | **Major 7: peers `zod >=4.1.5`, `fastify ^5.5`, `@fastify/swagger >=9.5.1`, `openapi-types ^12`.** Zod 3 is not supported; use zod 4. Add `@fastify/swagger` for OpenAPI generation.                         |
| zod                       | 4.6.7    | Zod 4 API (for example `z.email()`, `z.treeifyError`, `error` param) differs from v3; the plan's "zod schemas everywhere" must be written for v4.                                                            |
| drizzle-orm               | 0.45.4   | `latest` dist-tag is 0.45.4; 1.0 is only beta/rc (`1.0.0-rc.5`). Use 0.45.4 and migrate later. `better-sqlite3 >=7` peer.                                                                                    |
| drizzle-kit               | 0.31.11  | matches drizzle-orm 0.45.x.                                                                                                                                                                                  |
| better-sqlite3            | 13.0.3   | native build script needs approval (see above). Node >=20.19. Major 13: check prebuilt binaries for node 24 alpine (musl, arm64) in H-05.                                                                    |
| vite                      | 8.3.5    | Vite 8 (rolldown-based). Node `^20.19 \|\| >=22.12`. Vitest 5 supports it.                                                                                                                                   |
| react / react-dom         | 19.3.1   | matches plan.                                                                                                                                                                                                |
| @tanstack/react-router    | 1.170.46 | peers react >=18.                                                                                                                                                                                            |
| @tanstack/react-query     | 5.105.3  |                                                                                                                                                                                                              |
| tailwindcss               | 4.3.4    | v4; use with `@tailwindcss/vite` (not yet looked up; pin at H-16).                                                                                                                                           |
| @tus/server               | 2.4.7    | Node >=22. `@tus/file-store` 2.1.2 is the matching store.                                                                                                                                                    |
| @tus/file-store           | 2.1.2    |                                                                                                                                                                                                              |
| tus-js-client             | 4.3.1    | not deprecated.                                                                                                                                                                                              |
| node-taglib-sharp         | 6.0.3    | Node >=22.                                                                                                                                                                                                   |
| openid-client             | 6.8.9    | v6 is a rewrite (functional API: `discovery()`, `authorizationCodeGrant()`), not the v5 `Issuer`/`Client` classes. H-08 must use v6.                                                                         |
| music-metadata            | 12.3.4   | ESM-only, Node >=22.                                                                                                                                                                                         |
| pino                      | 10.4.0   | Fastify 5 bundles its own pino use; pin if used directly.                                                                                                                                                    |
| argon2                    | 0.45.2   | native build script needs approval.                                                                                                                                                                          |

Nothing in the plan's stack is deprecated or missing. Incompatibilities to know about: TypeScript 7 vs typescript-eslint (handled by pinning 6.0.3) and the zod 4 requirement of fastify-type-provider-zod 7.

**Deviations:** none. DECISIONS.md was not amended (only link and wording fixes in the copied docs). The plan's Node pin is `>=24`, as specified. `apps/` is empty (git does not track empty directories), so the workspace glob has no app yet.

**Next:** H-02 (server bootstrap, config, health).

**Open questions:**

- The GitHub repo URL `https://github.com/buschmjm/hearer` is hard-coded in README, issue templates and `REPO_URL` (it is the real upstream, not a homelab value).
- `APP_VERSION` is a constant `0.0.0`; release tooling (H-22, release-please) should update it.
