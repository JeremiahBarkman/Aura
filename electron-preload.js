const {
    contextBridge,
    ipcRenderer
} = require('electron');

contextBridge.exposeInMainWorld(
    'auraElectron',
    {
        ensureAuraNativeRunning: () =>
            ipcRenderer.invoke(
                'aura-native:ensure-running'
            ),

        openOutputWindow: () =>
            ipcRenderer.invoke(
                'open-output-window'
            ),

        getOutputWindowState: () =>
            ipcRenderer.invoke(
                'aura-output-window:get-state'
            ),

        onOutputWindowStateChanged: callback =>
            ipcRenderer.on(
                'aura-output-window:state',
                (event, state) => callback(state)
            ),

        sendAuraFrame: frame =>
            ipcRenderer.invoke(
                'aura-frame-export:send-frame',
                frame
            ),

        // Diagnostic logs (Settings -> Diagnostic Logs).
        listDiagnosticLogs: () =>
            ipcRenderer.invoke(
                'aura-logs:list'
            ),

        readDiagnosticLog: name =>
            ipcRenderer.invoke(
                'aura-logs:read',
                name
            ),

        openDiagnosticLogFolder: () =>
            ipcRenderer.invoke(
                'aura-logs:open-folder'
            )
    }
);