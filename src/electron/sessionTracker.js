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
// A PID alone is not a safe identity check: both Windows and Linux recycle
// PIDs, so a recorded PID from a dead session can end up reassigned to an
// unrelated process by the time the next launch looks at it. Every cleanup
// check here verifies both the process image name and a command-line
// substring before touching anything.
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
// getProcessInfo below returns { name, commandLine } for a live PID, or
// null if nothing is running at that PID, via one of these two backends.
//
// The Windows one uses PowerShell/WMI rather than tasklist.exe because
// tasklist does not expose the command line, which is needed to tell apart
// Aura's own python.exe/node.exe children from unrelated ones.
function getWindowsProcessInfo(numericPid) {
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

// POSIX equivalent. `ps -o comm=,args=` gives the same two facts the WMI
// query does: the executable name and the full command line. A non-zero
// exit just means no such process, which is the normal case here (the
// recorded PID belongs to a session that already ended), so it is not
// warned about the way a genuine query failure on Windows is.
function getPosixProcessInfo(numericPid) {
    let output;

    try {
        output = execFileSync(
            'ps',
            ['-p', String(numericPid), '-o', 'comm=,args='],
            { encoding: 'utf8' }
        );
    } catch {
        return null;
    }

    const line = output.split('\n')[0].trim();

    if (!line) {
        return null;
    }

    // ps pads comm to a fixed column width, so the first whitespace run
    // separates the executable name from the full command line.
    const separator = line.search(/\s/);

    if (separator === -1) {
        return { name: line, commandLine: '' };
    }

    return {
        name: line.slice(0, separator),
        commandLine: line.slice(separator).trim()
    };
}

function getProcessInfo(pid) {
    const numericPid = Number(pid);

    if (!Number.isInteger(numericPid) || numericPid <= 0) {
        return null;
    }

    return process.platform === 'win32'
        ? getWindowsProcessInfo(numericPid)
        : getPosixProcessInfo(numericPid);
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
        if (process.platform === 'win32') {
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

            return;
        }

        // POSIX has no taskkill /T equivalent that is safe to use blind:
        // killing a process group would need the child to have been
        // spawned detached, which Aura's services deliberately are not.
        // Every tracked child is spawned with shell:false, so this PID is
        // the real process rather than a wrapper, and SIGKILL on it is
        // what /F /T was there to guarantee. Grandchildren an abandoned
        // ComfyUI left behind are not reaped on POSIX -- a known gap, not a
        // silent one.
        process.kill(Number(pid), 'SIGKILL');
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
