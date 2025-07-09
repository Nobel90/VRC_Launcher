// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- Persistence & Versioning ---
    loadGameData: () => ipcRenderer.invoke('load-game-data'),
    saveGameData: (data) => ipcRenderer.send('save-game-data', data),
    getLocalVersion: (installPath) => ipcRenderer.invoke('get-local-version', installPath),

    // --- File Operations & Updates ---
    selectInstallDir: () => ipcRenderer.invoke('select-install-dir'),
    launchGame: (args) => ipcRenderer.send('launch-game', args),
    checkForUpdates: (args) => ipcRenderer.invoke('check-for-updates', args),
    checkForVersion: (args) => ipcRenderer.invoke('check-for-version', args),
    downloadFiles: (args) => ipcRenderer.send('download-files', args),
    openInstallFolder: (path) => ipcRenderer.send('open-install-folder', path),
    uninstallGame: (path) => ipcRenderer.send('uninstall-game', path),

    // --- Download Controls ---
    pauseDownload: () => ipcRenderer.send('pause-download'),
    resumeDownload: () => ipcRenderer.send('resume-download'),
    cancelDownload: () => ipcRenderer.send('cancel-download'),

    // --- Event Listeners from Main to Renderer ---
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, value) => callback(value)),
    onInstallComplete: (callback) => ipcRenderer.on('install-complete', (event, value) => callback(value)),
    onInstallError: (callback) => ipcRenderer.on('install-error', (event, value) => callback(value)),
    onDownloadCancelled: (callback) => ipcRenderer.on('download-cancelled', () => callback()),
    onUninstallComplete: (callback) => ipcRenderer.on('uninstall-complete', () => callback())
});
