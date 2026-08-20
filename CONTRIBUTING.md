# Contributing

## Workflow

`main` is protected and its history is **linear** — one commit per change, each with a clear
purpose. Everything lands through a pull request; nothing is committed to `main` directly.

1. **Branch** off `main`, named for its purpose: `feat/…`, `fix/…`, `perf/…`, `refactor/…`,
   `test/…`, `docs/…`, `ci/…`, `chore/…`.
2. **Commit freely** on the branch — work-in-progress commits are fine, they never reach `main`.
3. **Open a PR** against `main`. The accuracy gate (`npm run bench`) must pass.
4. **Squash-merge.** The PR collapses to a single commit on `main`, its message = the PR title.
   Delete the branch afterwards.

The result: `main` reads as a straight list of purposeful commits, each linked to the PR that
explains it. Branch history keeps the messy steps, out of the way.

## Commit / PR titles

[Conventional Commits](https://www.conventionalcommits.org/) style — `type: imperative summary`,
kept under ~72 characters:

| type | for |
|---|---|
| `feat` | a new capability |
| `fix` | a bug fix |
| `perf` | a performance change |
| `refactor` | a behaviour-preserving change |
| `test` | tests only |
| `docs` | documentation only |
| `ci` | CI / workflow |
| `build` | build system or dependencies |
| `chore` | tooling / meta |

Keep one PR to one logical change. If a branch grows a second, unrelated idea, split it.

## Before opening a PR

- `npm test` and `npm run bench` (the golden accuracy gate) pass.
- No stray files: build output (`dist/`, `viz-dist/`), `results/`, and corpora stay gitignored.

## Maintainer: branch protection

GitHub → **Settings → Branches → add rule** for `main`:

- Require a pull request before merging.
- Require status checks to pass (the accuracy gate).
- Require linear history.
- Allow **squash** merging only — disable merge commits and rebase merging.
- Automatically delete head branches after merge.
