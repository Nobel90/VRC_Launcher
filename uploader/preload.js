// preload.js - VRC Uploader

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Folder operations
    selectFolder: (title) => ipcRenderer.invoke('select-folder', title),
    scanFolder: (path) => ipcRenderer.invoke('scan-folder', path),

    // R2 config
    loadR2Config: () => ipcRenderer.invoke('load-r2-config'),
    saveR2Config: (config) => ipcRenderer.invoke('save-r2-config', config),
    testR2Connection: (config) => ipcRenderer.invoke('test-r2-connection', config),

    // Chunk settings
    getChunkSettings: () => ipcRenderer.invoke('get-chunk-settings'),
    saveChunkSettings: (settings) => ipcRenderer.invoke('save-chunk-settings', settings),

    // Step 1: Generate manifest
    generateManifest: (options) => ipcRenderer.invoke('generate-manifest', options),
    onGenerateProgress: (callback) => ipcRenderer.on('generate-progress', (_, data) => callback(data)),

    // Step 2: Upload
    uploadToR2: (options) => ipcRenderer.invoke('upload-to-r2', options),
    onUploadProgress: (callback) => ipcRenderer.on('upload-progress', (_, data) => callback(data)),
    pauseUpload: () => ipcRenderer.send('pause-upload'),
    resumeUpload: () => ipcRenderer.send('resume-upload'),
    cancelUpload: () => ipcRenderer.send('cancel-upload'),

    // Delta detection
    detectDelta: (paths) => ipcRenderer.invoke('detect-delta', paths),

    // Manifest operations
    loadManifest: (path) => ipcRenderer.invoke('load-manifest', path),
    listR2Versions: (opts) => ipcRenderer.invoke('list-r2-versions', opts),
    getR2Manifest: (opts) => ipcRenderer.invoke('get-r2-manifest', opts),
    promoteVersion: (opts) => ipcRenderer.invoke('promote-version', opts),
    onPromoteProgress: (callback) => ipcRenderer.on('promote-progress', (_, data) => callback(data))
});
