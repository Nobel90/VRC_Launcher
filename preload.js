// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- Persistence & Versioning ---
    loadGameData: () => ipcRenderer.invoke('load-game-data'),
    saveGameData: (data) => ipcRenderer.send('save-game-data', data),
    getLocalVersion: (installPath) => ipcRenderer.invoke('get-local-version', installPath),

    // --- File Operations & Updates ---
    selectInstallDir: () => ipcRenderer.invoke('select-install-dir'),
    verifyInstallPath: (args) => ipcRenderer.invoke('verify-install-path', args),
    moveInstallPath: (currentPath) => ipcRenderer.invoke('move-install-path', currentPath),
    launchGame: (args) => ipcRenderer.send('launch-game', args),
    checkForUpdates: (args) => ipcRenderer.invoke('check-for-updates', args),
    openInstallFolder: (path) => ipcRenderer.send('open-install-folder', path),
    uninstallGame: (path) => ipcRenderer.send('uninstall-game', path),

    // --- New Unified Download Controls ---
    handleDownloadAction: (action) => ipcRenderer.send('handle-download-action', action),
    onDownloadStateUpdate: (callback) => ipcRenderer.on('download-state-update', (event, state) => callback(state)),
    
    // --- Other Event Listeners ---
    onUninstallComplete: (callback) => ipcRenderer.on('uninstall-complete', () => callback()),
    onMoveProgress: (callback) => ipcRenderer.on('move-progress', (event, value) => callback(value))
});
