// cli/src/trailers.cjs — reads `Sequential-Finding: F-12` commit trailers out of a git log body
// (`git log --format=%B <range>`), the way `sequential-release --range` names findings without a
// human typing ids by hand. CommonJS by controller ruling: the BE unit suite is ts-jest/CommonJS and
// cannot import an ESM `.mjs` file without extra machinery this repo doesn't have configured.
'use strict';

const { addIds, DEFAULT_SCOPE, idInScope } = require('./findings.cjs');

// Anchored per LINE (not per commit message), case-insensitive, so `sequential-finding:` and
// `Sequential-Finding:` both count and a mid-line mention ("see also Sequential-Finding: F-1")
// does not. /g + /m walks every matching line in one log covering many commits.
// `[ \t]*`, not `\s*`: \s matches a newline, so a bare `Sequential-Finding:` line would capture the NEXT line.
const TRAILER_LINE_RE = /^Sequential-Finding:[ \t]*(.+)$/gim;

/**
 * @param {string} log
 * @param {{ projectKey: string | null, unqualified: boolean }} [scope] - which ids count (./findings.cjs): `F-12`, or
 *   `web#F-12` for the project key `web`. Default: unqualified ids only, as before project keys existed.
 * @returns {string[]} finding ids, deduplicated in first-seen order, capped at 50.
 */
function findingIdsFromLog(log, scope = DEFAULT_SCOPE) {
    const ids = [];
    const seen = new Set();
    // A fresh RegExp per call: a module-level /g regex keeps `lastIndex` between calls, which
    // would silently skip matches on the second and later invocations in the same process.
    const re = new RegExp(TRAILER_LINE_RE.source, TRAILER_LINE_RE.flags);
    let match;
    while ((match = re.exec(log)) !== null) {
        const tokens = match[1].split(/[\s,]+/).filter(Boolean);
        if (!addIds(ids, seen, tokens.map((t) => idInScope(t, scope)))) return ids;
    }
    return ids;
}

module.exports = { findingIdsFromLog };
