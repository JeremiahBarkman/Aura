// Builds installer/prerequisites.zip from installer/prerequisites/.
//
// The bundle used to be zipped by hand, and it drifted: 4 of its 9 files were
// stale against the folder by the time anyone noticed, and one hand-built copy
// shipped a stray __pycache__/*.pyc. This makes it reproducible.
//
//   npm run build:prereq
//
// Uses adm-zip, the same zip library server.js already uses for the DB Manager
// export/import routes.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const projectRoot = path.join(__dirname, '..');
const sourceDir = path.join(projectRoot, 'installer', 'prerequisites');
const outputPath = path.join(projectRoot, 'installer', 'prerequisites.zip');

// Build artifacts that must never reach a tester's machine.
const SKIP_DIRS = new Set(['__pycache__', '.vs', 'obj', 'bin']);
const SKIP_EXTENSIONS = new Set(['.pyc', '.pyo']);

function collectFiles() {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source directory missing: ${sourceDir}`);
    }

    return fs.readdirSync(sourceDir)
        .filter(name => {
            const full = path.join(sourceDir, name);

            if (fs.statSync(full).isDirectory()) {
                if (!SKIP_DIRS.has(name)) {
                    console.warn(`  ! skipping unexpected subdirectory: ${name}`);
                }
                return false;
            }

            if (SKIP_EXTENSIONS.has(path.extname(name).toLowerCase())) {
                console.log(`  skip  ${name}`);
                return false;
            }

            return true;
        })
        .sort();
}

// speech_server.py is maintained as a duplicate of the one Aura runs in dev.
// Shipping a stale copy is exactly the failure this bundle is prone to, so
// treat a mismatch as a hard error rather than a warning.
function verifySpeechServerInSync() {
    const bundled = path.join(sourceDir, 'speech_server.py');
    const dev = path.join(projectRoot, 'services', 'speech', 'speech_server.py');

    if (!fs.existsSync(bundled) || !fs.existsSync(dev)) {
        return;
    }

    if (!fs.readFileSync(bundled).equals(fs.readFileSync(dev))) {
        throw new Error(
            'installer/prerequisites/speech_server.py differs from ' +
            'services/speech/speech_server.py. They are maintained as ' +
            'duplicates -- sync them before building the bundle.'
        );
    }

    console.log('  speech_server.py matches services/speech copy');
}

function build() {
    verifySpeechServerInSync();

    const files = collectFiles();

    if (!files.length) {
        throw new Error('No files to bundle.');
    }

    const zip = new AdmZip();

    // Everything sits under a prerequisites/ root, matching what testers have
    // been extracting all along.
    for (const name of files) {
        zip.addLocalFile(path.join(sourceDir, name), 'prerequisites');
        console.log(`  add   ${name}`);
    }

    zip.writeZip(outputPath);

    console.log(
        `\nWrote ${path.relative(projectRoot, outputPath)} ` +
        `(${fs.statSync(outputPath).size} bytes, ${files.length} files)`
    );
}

build();
