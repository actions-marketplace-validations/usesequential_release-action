# Sequential release (CLI and GitHub Action)

`sequential-release` records a release in Sequential: its version, the pull requests it merged, and the findings it
fixes. Sequential then compares the sessions before and after the release for each finding that the release names.
The release only records what changed. It does not say what caused a result.

You can use it in two ways:

- **GitHub Action:** `uses: usesequential/release-action@v0` (see [GitHub Actions](#github-actions)).
- **CLI:** `npx @usesequential/release-cli --version <v> …`, the `sequential-release` command (Node.js 18 or later; no
  dependencies).

`@usesequential/node` also records a release, with `sequential releases record`, from any deploy step. This package adds
what GitHub knows: the merged pull requests and the findings they close, read from the GitHub API, and the GitHub Action.

**The token:** both read it from `SEQUENTIAL_RELEASES_TOKEN`: a personal access token (`sq_pat_…`) with the
`releases:write` scope, made for one project. The release goes to that project. An organization-wide token and an agent
connection cannot record a release.

## The release version must match your SDK's release

Sequential compares a finding before and after a release. To count a session as "after", Sequential reads the release
that the session's browser events carry (the browser SDK's `release` option, `data-release` on the script tag, or
`$release` that the page registers). The backend SDK's release is not used. Each such session must carry **the same
string** as the `version` that you record here:

- Record `version: <full commit sha>` and set the browser SDK's release to the same full sha. On Vercel with Next.js, that is
  `process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` (turn on "Automatically expose System Environment Variables").
- A short sha in one place and a full sha in the other do not match.
- When no session carries the recorded version, Sequential compares by time: every session that started from 2 hours
  after the release is "after". That works, but it can count sessions on an older build.

## Vercel (Git integration): record each production deployment

Vercel deploys from its own GitHub App, so no workflow of yours runs the deploy. Vercel reports each deployment to
GitHub, and a workflow on `deployment_status` can record the release when Vercel reports success.

Vercel names each GitHub environment `Production – <vercel project>` (and `Preview – <vercel project>`). Each
Sequential project has its own access token. So the workflow maps each Vercel project's environment to the secret that
holds that Sequential project's token.

```yaml
# .github/workflows/sequential-release.yml
name: Sequential release
on: deployment_status

permissions:
  deployments: read     # find the previous successful deployment
  contents: read        # compare the two commits
  pull-requests: read   # the merged pull requests and their text

jobs:
  record:
    # Only a successful production deployment.
    if: github.event.deployment_status.state == 'success' && startsWith(github.event.deployment.environment, 'Production')
    runs-on: ubuntu-latest
    env:
      # Vercel environment -> the secret with that Sequential project's token (scope releases:write).
      SEQUENTIAL_TOKENS: '{"Production – web": "SEQUENTIAL_RELEASES_TOKEN_WEB", "Production – app": "SEQUENTIAL_RELEASES_TOKEN_APP"}'
      # Vercel environment -> the project key that pull requests use in "Fixes web#F-12".
      SEQUENTIAL_KEYS: '{"Production – web": "web", "Production – app": "app"}'
    steps:
      - name: Skip a Vercel project that has no Sequential project
        id: map
        run: echo "mapped=${{ fromJSON(env.SEQUENTIAL_TOKENS)[github.event.deployment.environment] != null }}" >> "$GITHUB_OUTPUT"

      - if: steps.map.outputs.mapped == 'true'
        uses: usesequential/release-action@v0
        with:
          version: ${{ github.event.deployment.sha }}
          sha: ${{ github.event.deployment.sha }}
          environment: production
          released-at: ${{ github.event.deployment_status.created_at }}
          github-changes: 'true'
          project-key: ${{ fromJSON(env.SEQUENTIAL_KEYS)[github.event.deployment.environment] }}
          token: ${{ secrets[fromJSON(env.SEQUENTIAL_TOKENS)[github.event.deployment.environment]] }}
```

With **one** Vercel project, you can use `token: ${{ secrets.SEQUENTIAL_RELEASES_TOKEN }}` and leave out `project-key` and the
two maps.

### What `github-changes` reads

With `github-changes: 'true'`, the Action reads the GitHub API with the workflow's token. It does not need a checkout.

1. **The previous release:** the newest earlier deployment in the same GitHub environment whose newest status is
   `success`. (On a `push` event, it is the push's `before` commit.) You can give a commit with `base: <sha>`.
2. **The commits** from the previous release to this one (GitHub lists at most 250).
3. **The merged pull requests** of these commits, newest first: each one once, at most 50. They go to the release as
   its changes (title, link and number).
4. **The findings:** `Sequential-Finding: F-12` trailers in the commit messages, and "Fixes F-12" in pull request titles
   and bodies (also fix, fixed, close, closes, closed, resolve, resolves, resolved; lists such as "Fixes F-3, F-4 and
   F-5"). At most 50.

The job needs the three read permissions above. Without them, GitHub refuses the calls, and the release is recorded
without changes and without finding ids from GitHub.

**When a GitHub read fails** (for example, the previous release is not an ancestor of this commit after a rollback, so
GitHub cannot compare them), the job prints one line and still records the release:

```
GitHub: could not compare bbbbbbb...aaaaaaa (HTTP 404); the release is recorded without changes or finding ids from GitHub.
```

When there is no earlier successful deployment, the job reads only this commit, and prints for example:

```
Recorded release 3f2a… (1 finding: F-12; 1 change from 3f2a9c1 alone (no earlier release found))
```

### Monorepos: which findings belong to which project

A finding number belongs to one Sequential project: `F-12` can exist in each of your projects. When one pull request
changes several apps, write the project key before the number:

```
Fixes web#F-12, app#F-3
```

- With `project-key: web`, only `web#…` ids count for this release. An unqualified `F-12` does not count, because it
  could be another project's finding. To count unqualified ids too, set `findings: all`.
- Without `project-key` (one repository, one Sequential project), unqualified ids count, and qualified ids do not.
- The same rule applies to trailers: `Sequential-Finding: web#F-12`.

## GitHub Actions on a tag push

```yaml
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  pull-requests: read
jobs:
  record:
    runs-on: ubuntu-latest
    steps:
      - uses: usesequential/release-action@v0
        with:
          version: ${{ github.ref_name }}
          sha: ${{ github.sha }}
          environment: production
          github-changes: 'true'
          base: <the previous tag's commit sha>   # a tag push has no useful `before`
          token: ${{ secrets.SEQUENTIAL_RELEASES_TOKEN }}
```

You can also read the trailers from a local checkout with `range: v1.2.0..HEAD` instead of `github-changes` (this needs
`actions/checkout` with `fetch-depth: 0`). Use `range` or `github-changes`, not both.

## Inputs

| Input | Required | What it does |
|---|---|---|
| `version` | yes | The release version, 1 to 64 printable ASCII characters. Use the same string as your browser SDK's release. |
| `token` | yes | A personal access token (`sq_pat_…`) with the `releases:write` scope, made for one project. Always from a secret. |
| `api-url` | no | The Sequential API. Default: `https://api.usesequential.com` (Sequential's hosted API). Set it only for a self-hosted deployment; it must be `https://`. |
| `sha` | with `github-changes` | The deployed commit. |
| `environment` | no | The environment label in Sequential (lowercase, for example `production`). Default: the project's setting. |
| `released-at` | no | When the release went live, an ISO date-time with a timezone. Default: now. |
| `title` | no | A short title (up to 120 characters). |
| `github-changes` | no | `'true'`: read changes and findings from the GitHub API (see above). |
| `base` | no | With `github-changes`: `auto` (default) or the previous release's commit sha. |
| `project-key` | no | The key in "Fixes `<key>`#F-12" for this project (monorepos). |
| `findings` | no | `all` (unqualified ids count) or `qualified`. Default: `all` without `project-key`, else `qualified`. |
| `range` | no | A git range to read trailers from a checkout. Not with `github-changes`. |
| `github-token` | no | The token for the GitHub reads. Default: the workflow token. |

## The CLI

```
sequential-release --version <v> [--environment <e>] [--commit-sha <sha>] [--released-at <iso>] [--title <t>]
  [--range <prev..HEAD> | --github-changes [--base auto|<sha>]] [--project-key <key>] [--findings all|qualified] [--host <url>]
```

`--commit-sha` has the alias `--sha`. `--host` is the Sequential API (default `https://api.usesequential.com`; `https://`
except for `localhost` and `127.0.0.1`); the environment variable `SEQUENTIAL_API_URL` sets it too.

Environment variables: `SEQUENTIAL_RELEASES_TOKEN` (required, from a secret; see **The token** above). `SEQUENTIAL_TOKEN`
is not read: that is `@usesequential/node`'s changes token. With `--github-changes`: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and optionally
`GITHUB_API_URL` (GitHub Enterprise) and `GITHUB_EVENT_PATH` (set by GitHub Actions).

- On success, it prints `Recorded release <version> (<n> findings: F-1, F-4; <m> changes since <base>)` and exits 0.
- When Sequential refuses the release, it prints the reason and exits 1.
- It never prints a token, and it never follows a redirect (a token is never sent to another address).

## The API

The Action and the CLI send one request: `POST https://api.usesequential.com/api/releases` (or your `api-url`) with the
token as a bearer credential.

```bash
curl -sS -X POST "https://api.usesequential.com/api/releases" \
  -H "Authorization: Bearer $SEQUENTIAL_RELEASES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"3f2a9c1e…","environment":"production","commit_sha":"3f2a9c1e…","finding_ids":["F-12"],
       "changes":[{"title":"Fix the menu","url":"https://github.com/acme/web/pull/4","number":4}]}'
```

`finding_ids`: up to 50 ids like `F-12` (no leading zero). `changes`: up to 50 items, each `{ title, url, number }`.
Sequential cuts a text that is too long, and reports it in `adjusted`. A recorded release answers `201`.

## Development

Plain CommonJS with no dependencies (`bin/`, `src/`), so that the backend's Jest suite (`tests/cli/`) can `require()`
it. `src/cli.cjs` holds all the argument and environment handling as `run(argv, env, deps)`; `bin/sequential-release.cjs`
gives it the real `fetch`, `git`, files and output. `src/github.cjs` does the GitHub reads, `src/findings.cjs` the
finding ids and the project scope.
