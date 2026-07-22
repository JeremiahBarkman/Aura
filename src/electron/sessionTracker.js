// ============================================================================
// Aura Session Tracker
// ============================================================================
// Tracks the PIDs of processes the current Electron main process has
// spawned (ComfyUI, the Aura web server, the speech service, and the two
// on-demand native camera processes) so that if this session ends
// uncleanly -- crash, force-kill, Task Manager -- the *next* launch can
// detect and clean up whatever was left running, instead of hitting port
// conflicts or duplicate processes.
//
// A PID alone is not a safe identity check: Windows recycles PIDs, so a
// recorded PID from a dead session can end up reassigned to an unrelated
// process by the time the next launch looks at it. Every cleanup check
// here verifies both the process image name and a command-line substring
// before touching anything.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('../config/paths');

const runDir = path.join(paths.dataDir, 'run');
const sessionPath = path.join(runDir, 'aura-session.json');

function ensureRunDir() {
    fs.mkdirSync(runDir, { recursive: true });
}

function readSession() {
    try {
        return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch {
        return null;
    }
}

function writeSession(session) {
    ensureRunDir();

    fs.writeFileSync(
        sessionPath,
        JSON.stringify(session, null, 2),
        'utf8'
    );
}

function clearSession() {
    try {
        fs.unlinkSync(sessionPath);
    } catch {}
}

function recordChildProcess(childKey, pid) {
    const session = readSession();

    if (!session) {
        return;
    }

    session.children[childKey] = pid ? { pid } : null;

    writeSession(session);
}

// -----------------------------------------------------------------------------
// Process Identity Check
// -----------------------------------------------------------------------------
// Returns { name, commandLine } for a live PID, or null if nothing is
// running at that PID. Uses PowerShell/WMI rather than tasklist.exe because
// tasklist does not expose the command line, which is needed to tell apart
// Aura's own python.exe/node.exe children from unrelated ones.
function getProcessInfo(pid) {
    const numericPid = Number(pid);

    if (!Number.isInteger(numericPid) || numericPid <= 0) {
        return null;
    }

    let output;

    try {
        output = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Get-CimInstance Win32_Process -Filter "ProcessId=${numericPid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`
            ],
            {
                encoding: 'utf8',
                windowsHide: true
            }
        );
    } catch (error) {
        console.warn(
            `[SESSION TRACKER] Could not query PID ${numericPid}:`,
            error.message
        );

        return null;
    }

    const trimmed = output.trim();

    if (!trimmed) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed);

        return {
            name: parsed.Name || '',
            commandLine: parsed.CommandLine || ''
        };
    } catch {
        return null;
    }
}

function matchesExpectedChild(processInfo, expected) {
    if (!processInfo || !expected) {
        return false;
    }

    // On Windows, spawn(..., {shell:true}) sometimes reports the cmd.exe
    // wrapper's PID and sometimes the real target executable's PID --
    // this is inconsistent between runs, not something to rely on. Accept
    // any of the plausible names instead of a single exact one.
    const acceptableNames = (
        Array.isArray(expected.names) ? expected.names : [expected.name]
    ).map(name => name.toLowerCase());

    if (!acceptableNames.includes(processInfo.name.toLowerCase())) {
        return false;
    }

    if (
        expected.commandLineIncludes &&
        !processInfo.commandLine.includes(expected.commandLineIncludes)
    ) {
        return false;
    }

    return true;
}

function killPid(pid) {
    try {
        // /T (tree-kill) matters here: several tracked children are
        // spawned with shell:true, so the recorded PID is the cmd.exe
        // wrapper, not the real process. Killing just the wrapper leaves
        // its child (the actual python.exe/node.exe) running as an orphan
        // of an orphan.
        execFileSync(
            'taskkill.exe',
            ['/F', '/T', '/PID', String(pid)],
            { windowsHide: true }
        );
    } catch (error) {
        console.warn(
            `[SESSION TRACKER] Could not kill PID ${pid}:`,
            error.message
        );
    }
}

// -----------------------------------------------------------------------------
// Startup Cleanup
// -----------------------------------------------------------------------------
// expectedChildren: { childKey: { name: 'python.exe', commandLineIncludes: 'main.py' }, ... }
async function cleanupAbandonedSession(expectedChildren) {
    const previousSession = readSession();

    if (!previousSession) {
        return;
    }

    const previousMainProcess = getProcessInfo(previousSession.pid);

    if (previousMainProcess) {
        console.warn(
            '[SESSION TRACKER] Previous Aura session PID',
            previousSession.pid,
            'is still running. Leaving its processes alone.'
        );

        return;
    }

    console.log(
        '[SESSION TRACKER] Previous Aura session',
        previousSession.pid,
        'ended without cleaning up. Checking for abandoned processes...'
    );

    for (const [childKey, record] of Object.entries(previousSession.children || {})) {
        if (!record || !record.pid) {
            continue;
        }

        const expected = expectedChildren[childKey];
        const info = getProcessInfo(record.pid);

        if (!info) {
            continue;
        }

        if (!matchesExpectedChild(info, expected)) {
            console.warn(
                `[SESSION TRACKER] PID ${record.pid} recorded for ${childKey} no longer matches (found "${info.name}"). Not touching it.`
            );

            continue;
        }

        console.log(
            `[SESSION TRACKER] Killing abandoned ${childKey} (PID ${record.pid}, ${info.name}).`
        );

        killPid(record.pid);
    }
}

module.exports = {
    sessionPath,
    readSession,
    writeSession,
    clearSession,
    recordChildProcess,
    getProcessInfo,
    cleanupAbandonedSession
};
