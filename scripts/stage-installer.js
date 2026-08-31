// Stages the built installer into installer/, the folder testers receive.
//
//   npm run dist          # runs this automatically via postdist
//   npm run stage:installer
//
// electron-builder writes to dist/. Nothing moved the result into installer/,
// so the tester package kept whatever .exe was copied there by hand last time.
// After the 0.7.0 build that meant installer/ held v0.6.7 while START HERE.txt
// told testers to run v0.7.0 -- a file that was not there, next to one the
// instructions did not mention.
//
// This is the same failure the documentation copies had, and it is fixed the
// same way: make the step reproducible instead of remembered.

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const packageJson = require(path.join(projectRoot, 'package.json'));

const distDir = path.join(projectRoot, 'dist');
const installerDir = path.join(projectRoot, 'installer');
const startHerePath = path.join(installerDir, 'START HERE.txt');

const version = packageJson.version;

/**
 * Builds the artifact filename from the same template electron-builder used,
 * rather than hardcoding it here. If build.artifactName is ever changed, this
 * follows instead of silently looking for a file that is no longer produced.
 */
function expectedArtifactName() {
    const template =
        (packageJson.build && packageJson.build.artifactName) ||
        '${productName} Setup ${version}.${ext}';

    return template
        .replace('${productName}', (packageJson.build && packageJson.build.productName) || packageJson.name)
        .replace('${version}', version)
        .replace('${ext}', 'exe');
}

/**
 * Fails if START HERE.txt names a different version than this build.
 *
 * Checked before anything is copied or removed, so a mismatch leaves the
 * existing tester package untouched rather than half-updated. This is the
 * specific mistake that reached testers: the instructions named v0.6.6 through
 * an entire 0.6.7 release.
 */
function verifyStartHereVersion(artifactName) {
    if (!fs.existsSync(startHerePath)) {
        throw new Error(`Missing ${path.relative(projectRoot, startHerePath)}.`);
    }

    const contents = fs.readFileSync(startHerePath, 'utf8');
    const named = contents.match(/Aura Installer v[\d.]+\.exe/g) || [];

    if (named.length === 0) {
        throw new Error(
            'START HERE.txt does not name an installer file. It should tell ' +
            `testers to run "${artifactName}".`
        );
    }

    const wrong = [...new Set(named)].filter(name => name !== artifactName);

    if (wrong.length > 0) {
        throw new Error(
            `START HERE.txt names ${wrong.join(', ')} but this build produced ` +
            `${artifactName}.\nUpdate installer/START HERE.txt to match ` +
            `package.json version ${version}.`
        );
    }

    console.log(`  START HERE.txt names ${artifactName}`);
}

function stage() {
    const artifactName = expectedArtifactName();
    const builtPath = path.join(distDir, artifactName);

    verifyStartHereVersion(artifactName);

    if (!fs.existsSync(builtPath)) {
        throw new Error(
            `Built installer not found: ${path.relative(projectRoot, builtPath)}\n` +
            'Run "npm run dist" first, or check that build.artifactName still ' +
            'matches what electron-builder produces.'
        );
    }

    // Remove superseded installers before copying, so a failed copy cannot
    // leave two versions side by side with the instructions naming one.
    // The build output stays in dist/, so nothing here is unrecoverable.
    for (const name of fs.readdirSync(installerDir)) {
        if (!name.endsWith('.exe') || name === artifactName) {
            continue;
        }

        fs.unlinkSync(path.join(installerDir, name));
        console.log(`  remove  ${name}`);
    }

    const stagedPath = path.join(installerDir, artifactName);

    fs.copyFileSync(builtPath, stagedPath);

    const builtSize = fs.statSync(builtPath).size;
    const stagedSize = fs.statSync(stagedPath).size;

    if (builtSize !== stagedSize) {
        throw new Error(
            `Copy is ${stagedSize} bytes but the source is ${builtSize}. ` +
            'The staged installer is incomplete.'
        );
    }

    console.log(`  copy    ${artifactName}  ${(stagedSize / 1048576).toFixed(1)} MB`);

    // The .blockmap is for differential auto-updates. Aura has no updater, and
    // shipping it would only invite testers to wonder what it is.
    console.log(`\nTester package staged in installer/ for v${version}.`);
}

try {
    stage();
} catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
}
