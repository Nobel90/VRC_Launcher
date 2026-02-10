// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- Persistence & Versioning ---
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
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
    getFileSize: (url) => ipcRenderer.invoke('get-file-size', url),
    checkPrereqsStatus: () => ipcRenderer.invoke('check-prereqs-status'),
    installPrereqs: (installerPath) => ipcRenderer.invoke('install-prereqs', installerPath),

    // --- New Unified Download Controls ---
    handleDownloadAction: (action) => ipcRenderer.send('handle-download-action', action),
    onDownloadStateUpdate: (callback) => ipcRenderer.on('download-state-update', (event, state) => callback(state)),

    // --- Browser/OS Interaction ---
    openExternal: (url) => ipcRenderer.send('open-external', url),

    // --- Other Event Listeners ---
    onUninstallComplete: (callback) => ipcRenderer.on('uninstall-complete', () => callback()),
    onMoveProgress: (callback) => ipcRenderer.on('move-progress', (event, value) => callback(value)),
    onUninstallComplete: (callback) => ipcRenderer.on('uninstall-complete', () => callback()),
    onMoveProgress: (callback) => ipcRenderer.on('move-progress', (event, value) => callback(value)),
    onGameStateChanged: (callback) => ipcRenderer.on('game-state-changed', (event, state) => callback(state)),

    // --- Cleanup/Scan ---
    scanForInstallations: (rootPath) => ipcRenderer.invoke('scan-for-installations', rootPath),
    deleteInstallation: (path) => ipcRenderer.invoke('delete-installation', path),
    scanForInstallations: (rootPath) => ipcRenderer.invoke('scan-for-installations', rootPath),
    deleteInstallation: (path) => ipcRenderer.invoke('delete-installation', path),
    selectScanRoot: () => ipcRenderer.invoke('select-scan-root'),

    // --- Auto-Updater ---
    onAutoUpdaterEvent: (callback) => ipcRenderer.on('auto-updater-event', (event, data) => callback(data)),
    checkForLauncherUpdates: () => ipcRenderer.invoke('check-for-launcher-updates'),

    // --- Window Controls ---
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close')
});
