// main.js - VRC Game Uploader

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const log = require('electron-log');

// Services
const { ChunkManager } = require('./src/services/chunkManager');
const { R2Uploader } = require('./src/services/r2Uploader');
const { UploadManager } = require('./src/services/uploadManager');
const { generateManifest } = require('./src/services/packagePrep');
const { detectDelta } = require('./src/services/deltaDetector');

let mainWindow = null;
let uploadManager = null;

// Config paths
const configDir = path.join(app.getPath('userData'), 'config');
const r2ConfigPath = path.join(configDir, 'r2-config.json');
const chunkSettingsPath = path.join(configDir, 'chunk-settings.json');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 850,
        title: 'VRC Game Uploader',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.loadFile('src/index.html');

    log.transports.file.level = 'info';
    log.info('VRC Uploader starting...');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// =====================
// FOLDER OPERATIONS
// =====================

ipcMain.handle('select-folder', async (event, title = 'Select Folder') => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: title
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

ipcMain.handle('scan-folder', async (event, folderPath) => {
    try {
        const { getAllFiles, shouldIncludeFile } = require('./src/services/packagePrep');
        const files = await getAllFiles(folderPath);
        const filtered = files.filter(f => shouldIncludeFile(f.relativePath));

        let totalSize = 0;
        for (const file of filtered) {
            const stats = await fs.stat(file.fullPath);
            totalSize += stats.size;
        }

        return { files: filtered, totalFiles: filtered.length, totalSize };
    } catch (error) {
        log.error('Scan folder error:', error);
        return { error: error.message };
    }
});

// =====================
// R2 CONFIGURATION
// =====================

ipcMain.handle('load-r2-config', async () => {
    try {
        await fs.mkdir(configDir, { recursive: true });
        const data = await fs.readFile(r2ConfigPath, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { accountId: '', accessKeyId: '', secretAccessKey: '', bucketName: 'vrcentre' };
    }
});

ipcMain.handle('save-r2-config', async (event, config) => {
    try {
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(r2ConfigPath, JSON.stringify(config, null, 2));
        return { success: true };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('test-r2-connection', async (event, config) => {
    try {
        const uploader = new R2Uploader(config);
        return await uploader.testConnection();
    } catch (error) {
        return { success: false, message: error.message };
    }
});

// =====================
// CHUNK SETTINGS
// =====================

ipcMain.handle('get-chunk-settings', async () => {
    try {
        const data = await fs.readFile(chunkSettingsPath, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {
            minSize: 5 * 1024 * 1024,
            avgSize: 10 * 1024 * 1024,
            maxSize: 20 * 1024 * 1024
        };
    }
});

ipcMain.handle('save-chunk-settings', async (event, settings) => {
    try {
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(chunkSettingsPath, JSON.stringify(settings, null, 2));
        return { success: true };
    } catch (error) {
        return { error: error.message };
    }
});

// =====================
// STEP 1: GENERATE MANIFEST (Chunk files)
// =====================

ipcMain.handle('generate-manifest', async (event, options) => {
    try {
        log.info('Generating manifest:', options);

        const result = await generateManifest({
            sourceDir: options.sourceDir,
            outputDir: options.outputDir,
            gameName: options.gameName,
            version: options.version,
            buildType: options.buildType || 'release',
            chunkSizes: options.chunkSizes
        }, (progress) => {
            mainWindow.webContents.send('generate-progress', progress);
        });

        log.info('Manifest generated:', result.stats);
        return result;
    } catch (error) {
        log.error('Generate manifest error:', error);
        return { error: error.message };
    }
});

// =====================
// STEP 2: UPLOAD TO R2
// =====================

ipcMain.handle('upload-to-r2', async (event, options) => {
    try {
        log.info('Starting upload:', options);

        // Get R2 config
        const r2Config = await fs.readFile(r2ConfigPath, 'utf-8').then(JSON.parse);

        // Create upload manager
        uploadManager = new UploadManager(r2Config);

        const result = await uploadManager.upload({
            manifestPath: options.manifestPath,
            oldManifestPath: options.oldManifestPath || null,
            chunksDir: options.chunksDir,
            gameName: options.gameName,
            version: options.version,
            buildType: options.buildType || 'release',
            mode: options.mode || 'full'
        }, (progress) => {
            mainWindow.webContents.send('upload-progress', progress);
        });

        log.info('Upload complete:', result.stats);
        return result;
    } catch (error) {
        log.error('Upload error:', error);
        return { error: error.message };
    }
});

ipcMain.on('pause-upload', () => {
    if (uploadManager) uploadManager.pause();
});

ipcMain.on('resume-upload', () => {
    if (uploadManager) uploadManager.resume();
});

ipcMain.on('cancel-upload', () => {
    if (uploadManager) uploadManager.cancel();
});

// =====================
// DELTA DETECTION
// =====================

ipcMain.handle('detect-delta', async (event, { oldManifestPath, newManifestPath }) => {
    try {
        const oldData = await fs.readFile(oldManifestPath, 'utf-8');
        const newData = await fs.readFile(newManifestPath, 'utf-8');
        return detectDelta(oldData, newData);
    } catch (error) {
        return { error: error.message };
    }
});

// =====================
// MANIFEST OPERATIONS
// =====================

ipcMain.handle('load-manifest', async (event, manifestPath) => {
    try {
        const data = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return { error: 'Invalid manifest file' };
    }
});

ipcMain.handle('list-r2-versions', async (event, { gameName, buildType }) => {
    try {
        const r2Config = await fs.readFile(r2ConfigPath, 'utf-8').then(JSON.parse);
        const uploader = new R2Uploader(r2Config);
        return await uploader.listVersions(gameName, buildType);
    } catch (error) {
        return [];
    }
});

ipcMain.handle('get-r2-manifest', async (event, { gameName, version, buildType }) => {
    try {
        const r2Config = await fs.readFile(r2ConfigPath, 'utf-8').then(JSON.parse);
        const uploader = new R2Uploader(r2Config);
        return await uploader.getManifest(gameName, version, buildType);
    } catch (error) {
        return null;
    }
});

ipcMain.handle('promote-version', async (event, { gameName, version, buildType }) => {
    try {
        const r2Config = await fs.readFile(r2ConfigPath, 'utf-8').then(JSON.parse);
        const uploader = new R2Uploader(r2Config);
        return await uploader.promoteVersion(gameName, version, buildType, (progress) => {
            mainWindow.webContents.send('promote-progress', progress);
        });
    } catch (error) {
        return { error: error.message };
    }
});
