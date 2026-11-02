#!/usr/bin/env node
// cli/bin/sequential-release.cjs — the `sequential-release` bin: a thin process wrapper over cli/src/cli.cjs's run(). Everything with a
// decision in it (argv parsing, env validation, exit codes, the success/refusal message text)
// lives in cli/src, tested there without spawning a process; this file only wires real
// fetch/git/stdio to it and turns the returned exit code into process.exitCode.
'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { run } = require('../src/cli.cjs');

function execGit(args) {
    return execFileSync('git', args, { encoding: 'utf8' });
}

async function main() {
    const argv = process.argv.slice(2);
    const deps = {
        fetchImpl: fetch,
        execGit,
        readFile: (path) => readFileSync(path, 'utf8'),
        stdout: process.stdout,
        stderr: process.stderr,
    };
    process.exitCode = await run(argv, process.env, deps);
}

main().catch((err) => {
    // Never let a bug here dump a stack trace that might echo request internals; keep it to a message.
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
});
