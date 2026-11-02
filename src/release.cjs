// cli/src/release.cjs — POSTs a release marker to POST /api/releases. Pure request/response
// plumbing: all validation of the fields lives server-side (src/releases/parse.ts) so the two
// never drift; this just shapes the body and never guesses at a field the server would reject.
'use strict';

const RELEASES_PATH = '/api/releases';

/**
 * @param {{
 *   apiUrl: string, token: string, version: string, environment?: string, commitSha?: string,
 *   findingIds?: string[], releasedAt?: string, title?: string,
 *   changes?: Array<{ title: string, url: string, number: number }>, fetchImpl: typeof fetch,
 * }} args
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function postRelease({ apiUrl, token, version, environment, commitSha, findingIds, releasedAt, title, changes, fetchImpl }) {
    const body = { version };
    if (environment) body.environment = environment;
    if (commitSha) body.commit_sha = commitSha;
    if (findingIds && findingIds.length > 0) body.finding_ids = findingIds;
    if (releasedAt) body.released_at = releasedAt;
    if (title) body.title = title;
    if (changes && changes.length > 0) body.changes = changes;

    const res = await fetchImpl(`${apiUrl}${RELEASES_PATH}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // Never follow a redirect: the bearer token must not be replayed toward another location, whatever this Node
        // version's rules for stripping Authorization on a cross-origin redirect are. A redirect is a failed request.
        redirect: 'error',
    });

    let parsedBody;
    try {
        parsedBody = await res.json();
    } catch {
        parsedBody = undefined;
    }
    return { status: res.status, body: parsedBody };
}

module.exports = { postRelease };
