// Verifies the end-user documentation set is identical in both places it lives.
//
//   npm run check:docs        # fail if they differ
//   npm run sync:docs         # copy docs/ over installer/, then verify
//
// The four user documents are maintained as byte-identical copies under
// docs/Aura Documentation vX.Y/ and installer/Aura Documentation vX.Y/. Both
// are tracked; the installer/ copy is what reaches testers, so a stale one
// ships wrong instructions with a correct-looking build.
//
// speech_server.py has the same duplicate-copy problem and is guarded by a
// hard failure in build-prereq-bundle.js. Nothing guarded these, and they had
// already drifted once: both Install Guides still named v0.6.6 while
// package.json was on 0.6.7.
//
// docs/ is the source of truth -- INSTALLER.md points at that copy as the
// end-user install walkthrough.

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

const SOURCE_PARENT = path.join(projectRoot, 'docs');
const TARGET_PARENT = path.join(projectRoot, 'installer');

const FOLDER_PREFIX = 'Aura Documentation';

const shouldFix = process.argv.includes('--fix');

/**
 * Finds the documentation folder inside a parent directory.
 *
 * Discovered by prefix rather than hardcoded to a version, so a release bump
 * that renames the folder does not silently start passing against a directory
 * that no longer exists.
 */
function findDocsFolder(parent) {
    if (!fs.existsSync(parent)) {
        throw new Error(`Missing directory: ${path.relative(projectRoot, parent)}`);
    }

    const matches = fs.readdirSync(parent)
        .filter(name => name.startsWith(FOLDER_PREFIX))
        .filter(name => fs.statSync(path.join(parent, name)).isDirectory());

    if (matches.length === 0) {
        throw new Error(
            `No "${FOLDER_PREFIX} ..." folder in ${path.relative(projectRoot, parent)}.`
        );
    }

    if (matches.length > 1) {
        throw new Error(
            `Multiple "${FOLDER_PREFIX} ..." folders in ` +
            `${path.relative(projectRoot, parent)}: ${matches.join(', ')}. ` +
            'A version bump probably renamed one copy and left the other behind.'
        );
    }

    return matches[0];
}

function listFiles(dir) {
    return fs.readdirSync(dir)
        .filter(name => fs.statSync(path.join(dir, name)).isFile())
        .sort();
}

function check() {
    const sourceName = findDocsFolder(SOURCE_PARENT);
    const targetName = findDocsFolder(TARGET_PARENT);

    // A version bump that renames only one side is drift too, and the more
    // confusing kind: every file inside can still match.
    if (sourceName !== targetName) {
        throw new Error(
            `Documentation folders are named differently:\n` +
            `  docs/${sourceName}\n` +
            `  installer/${targetName}\n` +
            'Rename both when bumping the version.'
        );
    }

    const sourceDir = path.join(SOURCE_PARENT, sourceName);
    const targetDir = path.join(TARGET_PARENT, targetName);

    const sourceFiles = listFiles(sourceDir);
    const targetFiles = listFiles(targetDir);

    const problems = [];

    for (const name of sourceFiles) {
        if (!targetFiles.includes(name)) {
            problems.push(`missing from installer/: ${name}`);
            continue;
        }

        const a = fs.readFileSync(path.join(sourceDir, name));
        const b = fs.readFileSync(path.join(targetDir, name));

        if (!a.equals(b)) {
            problems.push(`differs: ${name}`);
        }
    }

    for (const name of targetFiles) {
        if (!sourceFiles.includes(name)) {
            problems.push(`only in installer/, not in docs/: ${name}`);
        }
    }

    if (problems.length === 0) {
        console.log(
            `Documentation in sync: ${sourceFiles.length} file(s) identical ` +
            `in docs/${sourceName} and installer/${targetName}`
        );
        return;
    }

    if (!shouldFix) {
        throw new Error(
            `Documentation copies have drifted:\n` +
            problems.map(p => `  - ${p}`).join('\n') +
            `\n\nRun "npm run sync:docs" to copy docs/${sourceName} over ` +
            `installer/${targetName}, or reconcile them by hand if the ` +
            'installer copy is the one with the wanted edits.'
        );
    }

    // --fix is one-directional on purpose. Merging would need to guess which
    // side is correct, and guessing wrong silently discards someone's edit.
    for (const name of targetFiles) {
        if (!sourceFiles.includes(name)) {
            fs.unlinkSync(path.join(targetDir, name));
            console.log(`  remove  ${name}`);
        }
    }

    for (const name of sourceFiles) {
        fs.copyFileSync(
            path.join(sourceDir, name),
            path.join(targetDir, name)
        );
        console.log(`  copy    ${name}`);
    }

    console.log(`\nSynced installer/${targetName} from docs/${sourceName}.`);

    // Re-verify rather than trusting the copy loop.
    const stillDifferent = listFiles(sourceDir).filter(name =>
        !fs.readFileSync(path.join(sourceDir, name))
            .equals(fs.readFileSync(path.join(targetDir, name)))
    );

    if (stillDifferent.length > 0) {
        throw new Error(
            `Still different after sync: ${stillDifferent.join(', ')}`
        );
    }
}

try {
    check();
} catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
}
