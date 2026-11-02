// cli/src/cli.cjs — argv/env handling for `sequential-release`, factored out of bin/sequential-release.cjs
// so it is testable without spawning a process: every effect (fetch, git, stdout, stderr) comes in
// through `deps`, and run() returns an exit code rather than calling process.exit() itself.
'use strict';

const { findingIdsFromLog } = require('./trailers.cjs');
const { findingScope } = require('./findings.cjs');
const { githubContext, releaseChanges } = require('./github.cjs');
const { postRelease } = require('./release.cjs');

/** `<40 or 64 zeros>..<head>` (or `...`): git's null object id as the base of a range. */
const ZERO_BASE_RE = /^(?:0{40}|0{64})\.\.\.?(.*)$/;

// The names follow @usesequential/node's `sequential releases record` (mgmt ruling 2026-11-02): the bin is
// `sequential-release` (both packages installing `sequential` collided), the token is SEQUENTIAL_RELEASES_TOKEN (never
// SEQUENTIAL_TOKEN, which holds the node CLI's changes:write token), --commit-sha (--sha an alias), --host (the API).
const USAGE = 'Usage: sequential-release --version <v> [--environment <e>] [--commit-sha <sha>] [--released-at <iso>] [--title <t>]\n'
    + '  [--range <prev..HEAD> | --github-changes [--base auto|<sha>]] [--project-key <key>] [--findings all|qualified] [--host <url>]';
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Sequential's hosted API: the host of every project's token (infra/aws variables.tf; the Node SDK's DEFAULT_HOST).
 *  SEQUENTIAL_API_URL overrides it for a self-hosted deployment. */
const DEFAULT_API_URL = 'https://api.usesequential.com';

/**
 * Strips a trailing slash and refuses a non-https URL unless the host is localhost or 127.0.0.1 —
 * SEQUENTIAL_API_URL carries a bearer secret in every request it's used for.
 * @param {string} raw
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
function normalizeApiUrl(raw) {
    const stripped = raw.replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(stripped);
    } catch {
        return { ok: false, message: `The API URL (--host or SEQUENTIAL_API_URL) is not a valid URL: ${raw}` };
    }
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocal) {
        return {
            ok: false,
            message: 'The API URL (--host or SEQUENTIAL_API_URL) must be https (localhost and 127.0.0.1 excepted) — the token it carries is a bearer secret.',
        };
    }
    return { ok: true, value: stripped };
}

/**
 * @param {string[]} argv - args AFTER the `release` subcommand.
 * @returns {{ ok: true, value: Record<string, string> } | { ok: false, message: string }}
 */
function parseReleaseArgs(argv) {
    const FLAGS = {
        '--version': 'version', '--environment': 'environment', '--commit-sha': 'sha', '--sha': 'sha', '--range': 'range', '--released-at': 'releasedAt',
        '--host': 'host',
        '--title': 'title', '--base': 'base', '--project-key': 'projectKey', '--findings': 'findings',
    };
    /** Flags that take no value. */
    const SWITCHES = { '--github-changes': 'githubChanges' };
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (SWITCHES[flag]) { args[SWITCHES[flag]] = 'true'; continue; }
        const key = FLAGS[flag];
        if (!key) return { ok: false, message: `Unknown option: ${flag}\n${USAGE}` };
        const value = argv[i + 1];
        if (value === undefined) return { ok: false, message: `${flag} needs a value.\n${USAGE}` };
        args[key] = value;
        i += 1;
    }
    return { ok: true, value: args };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fetchImpl: typeof fetch, execGit: (args: string[]) => string, stdout: { write(s: string): void }, stderr: { write(s: string): void } }} deps
 * @returns {Promise<number>}
 */
async function runRelease(argv, env, deps) {
    const { fetchImpl, execGit, stdout, stderr } = deps;
    const readFile = deps.readFile || (() => { throw new Error('no event file'); });

    const token = env.SEQUENTIAL_RELEASES_TOKEN;
    if (!token) {
        stderr.write('SEQUENTIAL_RELEASES_TOKEN is required: a personal access token (sq_pat_…) with the releases:write scope, made for one project.\n');
        return 1;
    }

    const parsedArgs = parseReleaseArgs(argv);
    if (!parsedArgs.ok) {
        stderr.write(`${parsedArgs.message}\n`);
        return 1;
    }
    const args = parsedArgs.value;

    // --host (as @usesequential/node names it), else SEQUENTIAL_API_URL; unset or empty (the Action's api-url left out):
    // the hosted API.
    const rawApiUrl = args.host || env.SEQUENTIAL_API_URL || DEFAULT_API_URL;
    const apiUrlResult = normalizeApiUrl(rawApiUrl);
    if (!apiUrlResult.ok) {
        stderr.write(`${apiUrlResult.message}\n`);
        return 1;
    }

    if (!args.version) {
        stderr.write(`--version is required.\n${USAGE}\n`);
        return 1;
    }

    const scopeResult = findingScope({ projectKey: args.projectKey, findings: args.findings });
    if (!scopeResult.ok) {
        stderr.write(`${scopeResult.message}\n`);
        return 1;
    }
    const scope = scopeResult.value;
    if (args.githubChanges && args.range !== undefined) {
        stderr.write('--range and --github-changes both name the commits: use one.\n');
        return 1;
    }
    if (args.base !== undefined && !args.githubChanges) {
        stderr.write('--base needs --github-changes.\n');
        return 1;
    }
    if (args.githubChanges && (args.sha === undefined || !SHA_RE.test(args.sha))) {
        stderr.write('--github-changes needs --commit-sha: the deployed commit (7-40 hex characters).\n');
        return 1;
    }
    const base = args.base === undefined ? 'auto' : args.base;
    if (base !== 'auto' && !SHA_RE.test(base)) {
        stderr.write('--base: auto, or a commit sha (7-40 hex characters).\n');
        return 1;
    }

    if (args.range !== undefined && args.range.startsWith('-')) {
        stderr.write(`--range must be a git revision range, not an option: ${args.range}\n`);
        return 1;
    }

    let findingIds;
    if (args.range !== undefined) {
        // An all-zero base (git's "no previous commit": a first push, or github.event.before on a tag push) is not a
        // revision git can read. Treat it as "no previous" and read only the head commit's message.
        const noPrevious = ZERO_BASE_RE.exec(args.range);
        const head = noPrevious ? (noPrevious[1] || 'HEAD') : null;
        if (head !== null && head.startsWith('-')) {
            stderr.write(`--range must be a git revision range, not an option: ${args.range}\n`);
            return 1;
        }
        let log;
        try {
            log = execGit(head !== null ? ['log', '-1', '--format=%B', head] : ['log', '--format=%B', args.range]);
        } catch (err) {
            stderr.write(`git log failed: ${err.message}\n`);
            return 1;
        }
        findingIds = findingIdsFromLog(log, scope);
    }

    // --github-changes: the merged pull requests and the findings they close, from the GitHub API. A GitHub failure
    // never stops the release: the marker is what the before/after measurement needs, so it is recorded without them.
    let changes;
    let changesNote = '';
    if (args.githubChanges) {
        const ctx = githubContext(env, readFile);
        if (!ctx.ok) {
            stderr.write(`GitHub: ${ctx.message}; the release is recorded without changes or finding ids from GitHub.\n`);
        } else {
            try {
                const read = await releaseChanges(ctx.value, { head: args.sha, base, scope }, fetchImpl);
                changes = read.changes;
                findingIds = read.findingIds;
                changesNote = read.base === null
                    ? `; ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} from ${args.sha.slice(0, 7)} alone (no earlier release found)`
                    : `; ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} since ${read.base.slice(0, 7)}`;
            } catch (err) {
                const what = err && err.name === 'GitHubError' ? err.message : 'request failed';
                stderr.write(`GitHub: could not ${what}; the release is recorded without changes or finding ids from GitHub.\n`);
            }
        }
    }

    let response;
    try {
        response = await postRelease({
            apiUrl: apiUrlResult.value,
            token,
            version: args.version,
            environment: args.environment,
            commitSha: args.sha,
            findingIds,
            releasedAt: args.releasedAt,
            title: args.title,
            changes,
            fetchImpl,
        });
    } catch (err) {
        stderr.write(`${err.message}\n`);
        return 1;
    }

    if (response.status < 200 || response.status >= 300) {
        const body = response.body;
        const message = (body && typeof body === 'object' && (body.message || body.error)) || `HTTP ${response.status}`;
        stderr.write(`${message}\n`);
        return 1;
    }

    const ids = findingIds || [];
    const summary = ids.length === 0 ? 'no findings named' : `${ids.length} ${ids.length === 1 ? 'finding' : 'findings'}: ${ids.join(', ')}`;
    stdout.write(`Recorded release ${args.version} (${summary}${changesNote})\n`);
    return 0;
}

/**
 * @param {string[]} argv - process.argv.slice(2).
 * @param {NodeJS.ProcessEnv} env
 * @param {{ fetchImpl: typeof fetch, execGit: (args: string[]) => string, stdout: { write(s: string): void }, stderr: { write(s: string): void } }} deps
 * @returns {Promise<number>} the process exit code.
 */
async function run(argv, env, deps) {
    return runRelease(argv, env, deps);
}

module.exports = { run, runRelease, normalizeApiUrl, parseReleaseArgs, DEFAULT_API_URL };
