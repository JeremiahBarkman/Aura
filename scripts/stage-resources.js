/*
    Stage the binaries the installer ships into native/runtime/.

    Runs automatically before `npm run dist` (see the "predist" script).

    WHY THIS EXISTS
    ---------------
    build.extraResources used to point straight into the Visual Studio output
    folders (x64/Release, x64/Debug) and at an absolute path for node.exe.
    That caused three problems:

      1. Those folders are correctly .gitignored as build output, and the
         vendored VCamSample project's own .gitignore excludes x64/ in a way
         the root .gitignore cannot override - so the shipped binaries could
         not be tracked normally.
      2. node.exe was hardcoded to C:/Program Files/nodejs/node.exe, which
         does not exist on a teammate's machine or on CI.
      3. We were shipping VCamSample out of a *Debug* folder, which is how
         AuraFrameBridge ended up shipping debug-CRT binaries that could not
         load on any machine without Visual Studio installed.

    native/runtime/ is a curated staging area: it is NOT a build output
    directory, so it is tracked normally and always contains exactly what we
    ship.

    NON-DESTRUCTIVE: this only ever COPIES. The Visual Studio build tree is
    never modified or cleaned.

    STALE-COPY BEHAVIOUR: if a freshly built binary exists it is copied over
    the staged one. If it does not (e.g. a clean clone that has not built the
    native projects yet), the already-tracked staged copy is kept and a note
    is printed - so a fresh clone can still produce a working installer.
*/

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const stageDir = path.join(root, 'native', 'runtime');

const IS_WINDOWS = process.platform === 'win32';

// The three native binaries below are Windows Media Foundation components
// (see VIRTUAL_CAMERA.md) with no Linux counterpart, so a Linux build stages
// only the Node runtime. Everything else Aura ships is portable JavaScript.
//
// node comes from the interpreter running this script. That is the same
// standalone runtime whose ABI the prebuilt native modules (better-sqlite3)
// already match, and it works on any machine regardless of install location.
// It is staged under the name the target platform's launcher expects, which
// electron-main.js resolves the same way.
const windowsNativeItems = [
    {
        label: 'AuraFrameBridge.exe',
        source: path.join(root, 'native/AuraFrameBridge/AuraFrameBridge/x64/Release/AuraFrameBridge.exe'),
        hint: 'Build AuraFrameBridge.vcxproj in the x64/Release configuration.'
    },
    // Release, never Debug: the Debug DLL runs unoptimized inside the Windows
    // camera frame-server process on every delivered frame, and shipping it
    // measurably halved the virtual-camera frame rate whenever a consumer
    // (Teams/OBS) attached. fallback lets a clean clone that has only ever
    // built Debug still produce an installer -- with a warning.
    {
        label: 'VCamSample.exe',
        source: path.join(root, 'native/external/VCamSample/x64/Release/VCamSample.exe'),
        fallback: path.join(root, 'native/external/VCamSample/x64/Debug/VCamSample.exe'),
        hint: 'Build VCamSample.sln (x64 Release).'
    },
    {
        label: 'VCamSampleSource.dll',
        source: path.join(root, 'native/external/VCamSample/x64/Release/VCamSampleSource.dll'),
        fallback: path.join(root, 'native/external/VCamSample/x64/Debug/VCamSampleSource.dll'),
        hint: 'Build VCamSample.sln (x64 Release).'
    },
];

const nodeRuntimeItem = {
    label: IS_WINDOWS ? 'node.exe' : 'node',
    source: process.execPath,
    hint: 'Should be impossible - this script is running under node.'
};

const items = IS_WINDOWS
    ? [...windowsNativeItems, nodeRuntimeItem]
    : [nodeRuntimeItem];

function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

fs.mkdirSync(stageDir, { recursive: true });

let missing = 0;
console.log(`Staging shipped binaries -> ${path.relative(root, stageDir)}`);

if (!IS_WINDOWS) {
    console.log(
        `  skip    ${'virtual camera'.padEnd(22)} ` +
        `${windowsNativeItems.length} Windows-only binaries (no ${process.platform} build exists)`
    );
}

for (const item of items) {
    const dest = path.join(stageDir, item.label);
    let haveSource = fs.existsSync(item.source);
    const haveStaged = fs.existsSync(dest);

    if (!haveSource && item.fallback && fs.existsSync(item.fallback)) {
        console.warn(`  WARN    ${item.label.padEnd(22)} Release build not found - falling back to DEBUG build (slower!)`);
        console.warn(`          build the Release configuration: ${item.hint}`);
        item.source = item.fallback;
        haveSource = true;
    }

    if (!haveSource) {
        if (haveStaged) {
            console.log(`  keep    ${item.label.padEnd(22)} (no fresh build; using staged copy)`);
        } else {
            missing++;
            console.error(`  MISSING ${item.label.padEnd(22)} not found and nothing staged`);
            console.error(`          expected: ${item.source}`);
            console.error(`          fix:      ${item.hint}`);
        }
        continue;
    }

    // Skip identical copies so the git working tree stays clean on rebuilds.
    if (haveStaged) {
        const a = fs.statSync(item.source);
        const b = fs.statSync(dest);
        if (a.size === b.size && Buffer.compare(fs.readFileSync(item.source), fs.readFileSync(dest)) === 0) {
            console.log(`  same    ${item.label.padEnd(22)} ${mb(b.size)}`);
            continue;
        }
    }

    fs.copyFileSync(item.source, dest);
    console.log(`  copied  ${item.label.padEnd(22)} ${mb(fs.statSync(dest).size)}`);
}

if (missing > 0) {
    console.error(`\n${missing} required binar${missing === 1 ? 'y is' : 'ies are'} missing - the installer would be broken. Aborting.`);
    process.exit(1);
}

console.log('Staging complete.');
