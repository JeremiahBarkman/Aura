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
const { execFileSync, spawnSync } = require('child_process');
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
// getProcessInfos below returns a Map of PID -> { name, commandLine } for
// every requested PID that is alive, via one of these two backends. The
// batch is one query on purpose: the Windows backend launches PowerShell,
// which costs on the order of a second per launch, and startup cleanup has
// up to six PIDs to look at.
//
// The Windows one uses PowerShell/WMI rather than tasklist.exe because
// tasklist does not expose the command line, which is needed to tell apart
// Aura's own python.exe/node.exe children from unrelated ones.
function getWindowsProcessInfos(numericPids) {
    const filter = numericPids.map(pid => `ProcessId=${pid}`).join(' OR ');

    let output;

    try {
        output = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                // -InputObject with an explicit array: piping into
                // ConvertTo-Json would unwrap a single result into a bare
                // object, and the parser below wants one shape.
                `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,CommandLine)`
            ],
            {
                encoding: 'utf8',
                windowsHide: true
            }
        );
    } catch (error) {
        console.warn(
            '[SESSION TRACKER] Could not query processes:',
            error.message
        );

        return new Map();
    }

    const infos = new Map();
    const trimmed = output.trim();

    if (!trimmed) {
        return infos;
    }

    let parsed;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return infos;
    }

    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (row && row.ProcessId !== undefined && row.ProcessId !== null) {
            infos.set(Number(row.ProcessId), {
                name: row.Name || '',
                commandLine: row.CommandLine || ''
            });
        }
    }

    return infos;
}

// POSIX equivalent. `ps -o pid=,comm=,args=` gives the same facts the WMI
// query does: the executable name and the full command line. ps exits
// non-zero when any requested PID is gone, which is the normal case here
// (a recorded PID whose session already ended), so the exit status is
// ignored and whatever it printed is parsed.
function getPosixProcessInfos(numericPids) {
    const result = spawnSync(
        'ps',
        ['-p', numericPids.join(','), '-o', 'pid=,comm=,args='],
        { encoding: 'utf8' }
    );

    const infos = new Map();

    for (const line of String(result.stdout || '').split('\n')) {
        // ps pads each column, so whitespace runs separate pid, executable
        // name and the full command line.
        const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);

        if (match) {
            infos.set(Number(match[1]), {
                name: match[2],
                commandLine: match[3].trim()
            });
        }
    }

    return infos;
}

function getProcessInfos(pids) {
    const numericPids = [...new Set(
        pids
            .map(Number)
            .filter(pid => Number.isInteger(pid) && pid > 0)
    )];

    if (!numericPids.length) {
        return new Map();
    }

    return process.platform === 'win32'
        ? getWindowsProcessInfos(numericPids)
        : getPosixProcessInfos(numericPids);
}

function getProcessInfo(pid) {
    return getProcessInfos([pid]).get(Number(pid)) || null;
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

    const childRecords = Object.entries(previousSession.children || {})
        .filter(([, record]) => record && record.pid);

    // One query for the old main process and every child it recorded.
    const infos = getProcessInfos([
        previousSession.pid,
        ...childRecords.map(([, record]) => record.pid)
    ]);

    const previousMainProcess = infos.get(Number(previousSession.pid));

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

    for (const [childKey, record] of childRecords) {
        const expected = expectedChildren[childKey];
        const info = infos.get(Number(record.pid));

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
    getProcessInfos,
    cleanupAbandonedSession
};
