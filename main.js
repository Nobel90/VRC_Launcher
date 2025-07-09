// main.js

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { session } = require('electron');

const dataPath = path.join(app.getPath('userData'), 'launcher-data.json');

let activeDownload = {
    request: null,
    writer: null,
    isPaused: false,
    filePath: null, // Keep track of the file being written
};
const browserHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' };

const textFileExtensions = ['.txt', '.ini', '.json'];

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 720,
        resizable: true,
        frame: true,
        title: 'VR Centre Apps Launcher',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '/assets/icon-white.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

function getFileChecksum(filePath) {
    return new Promise((resolve, reject) => {
        const extension = path.extname(filePath).toLowerCase();
        if (textFileExtensions.includes(extension)) {
            fs.readFile(filePath, 'utf-8', (err, textData) => {
                if (err) return reject(err);
                const normalizedText = textData.trim().replace(/\r\n/g, '\n');
                const hash = crypto.createHash('sha256').update(normalizedText).digest('hex');
                resolve(hash);
            });
        } else {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        }
    });
}

// --- IPC Handlers ---

ipcMain.on('open-install-folder', (event, installPath) => {
    if (installPath && fs.existsSync(installPath)) {
        shell.openPath(installPath);
    }
});

ipcMain.handle('get-local-version', async (event, installPath) => {
    const versionFilePath = path.join(installPath, 'version.json');
    try {
        if (fs.existsSync(versionFilePath)) {
            const data = fs.readFileSync(versionFilePath, 'utf-8');
            return JSON.parse(data).version || '0.0.0';
        }
    } catch (error) { console.error('Error reading local version file:', error); }
    return '0.0.0';
});

ipcMain.handle('get-app-path', () => {
    return app.getAppPath();
});

ipcMain.handle('load-game-data', async () => {
    try {
        if (fs.existsSync(dataPath)) {
            return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        }
    } catch (error) { console.error('Error loading game data:', error); }
    return {};
});

ipcMain.on('save-game-data', (event, data) => {
    try {
        fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    } catch (error) { console.error('Error saving game data:', error); }
});

ipcMain.handle('select-install-dir', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        properties: ['openDirectory'],
        title: 'Select Installation Directory'
    });
    return canceled ? null : filePaths[0];
});

ipcMain.on('launch-game', (event, { installPath, executable }) => {
    if (!installPath || !executable) return;
    const executablePath = path.join(installPath, executable);
    if (fs.existsSync(executablePath)) {
        const { spawn } = require('child_process');
        spawn(executablePath, [], { detached: true, cwd: installPath });
    } else {
        console.error(`Launch failed: Executable not found at: ${executablePath}`);
    }
});

ipcMain.on('uninstall-game', async (event, installPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Yes, Uninstall', 'Cancel'],
        defaultId: 1,
        title: 'Confirm Uninstall',
        message: `Are you sure you want to uninstall this game?`,
        detail: `This will move the folder at "${installPath}" to the trash.`
    });

    if (response === 0) {
        try {
            await shell.trashItem(installPath);
            event.sender.send('uninstall-complete');
        } catch (error) {
            console.error(`Failed to uninstall game at ${installPath}:`, error);
            dialog.showErrorBox('Uninstall Failed', `Could not move "${installPath}" to trash. You may need to remove it manually.`);
        }
    }
});

ipcMain.handle('check-for-version', async (event, { installPath, versionUrl }) => {
    try {
        const localVersion = await event.sender.invoke('get-local-version', installPath);

        const response = await axios.get(versionUrl, { headers: browserHeaders });
        const serverVersion = response.data.version;

        return {
            isUpdateAvailable: serverVersion !== localVersion,
            latestVersion: serverVersion
        };
    } catch (error) {
        console.error('Version check failed:', error.message);
        return { error: 'Could not check for new version.' };
    }
});

ipcMain.handle('check-for-updates', async (event, { gameId, installPath, manifestUrl }) => {
    try {
        const response = await axios.get(manifestUrl, { headers: browserHeaders });
        const serverManifest = response.data;
        const filesToUpdate = [];
        
        console.log(`--- Starting Update Check for ${gameId} v${serverManifest.version} ---`);

        if (!installPath || !fs.existsSync(installPath)) {
            console.log('No install path provided or path does not exist. Flagging all files for fresh installation.');
            return {
                isUpdateAvailable: true,
                filesToUpdate: serverManifest.files,
                latestVersion: serverManifest.version,
            };
        }

        for (const fileInfo of serverManifest.files) {
            if (path.basename(fileInfo.path) === 'version.json') continue;

            const localFilePath = path.join(installPath, fileInfo.path);
            if (fs.existsSync(localFilePath)) {
                const localChecksum = await getFileChecksum(localFilePath);
                const isMatch = localChecksum === fileInfo.checksum;
                console.log(`Checking: ${fileInfo.path} -> Match: ${isMatch}`);
                if (!isMatch) {
                    console.log(`   - Mismatch! Local: ${localChecksum}`);
                    console.log(`   - Mismatch! Server: ${fileInfo.checksum}`);
                    filesToUpdate.push({ ...fileInfo, localChecksum }); // Add local checksum for debugging
                }
            } else {
                console.log(`Checking: ${fileInfo.path} -> File not found locally. Adding to update list.`);
                filesToUpdate.push(fileInfo);
            }
        }
        
        console.log(`--- Update Check Complete. Found ${filesToUpdate.length} files to update. ---`);

        return {
            isUpdateAvailable: filesToUpdate.length > 0,
            filesToUpdate: filesToUpdate,
            latestVersion: serverManifest.version,
        };
    } catch (error) {
        let errorMessage = 'Update check failed.';
        if (error.response) {
            errorMessage = `Update check failed: Server error ${error.response.status}.`;
        } else if (error.request) {
            errorMessage = 'Update check failed: No response from server.';
        } else {
            errorMessage = `Update check failed: ${error.message}`;
        }
        return { error: errorMessage };
    }
});

// --- Download Control Handlers ---
ipcMain.on('pause-download', () => {
    if (activeDownload.request) {
        activeDownload.isPaused = true;
        activeDownload.request.pause();
    }
});

ipcMain.on('resume-download', () => {
    if (activeDownload.request) {
        activeDownload.isPaused = false;
        activeDownload.request.resume();
    }
});

ipcMain.on('cancel-download', (event) => {
    if (activeDownload.request) {
        activeDownload.request.destroy(); // Forcefully stop the stream
        if (activeDownload.writer) {
            activeDownload.writer.close(() => {
                if (activeDownload.filePath && fs.existsSync(activeDownload.filePath)) {
                    fs.unlinkSync(activeDownload.filePath); // Delete partial file
                }
                activeDownload = { request: null, writer: null, isPaused: false, filePath: null };
            });
        }
        event.sender.send('download-cancelled');
    }
});


ipcMain.on('download-files', async (event, { gameId, installPath, files, latestVersion }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    activeDownload.isPaused = false;

    try {
        const totalFiles = files.length;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const destinationPath = path.join(installPath, file.path);
            activeDownload.filePath = destinationPath;
            const destinationDir = path.dirname(destinationPath);

            if (!fs.existsSync(destinationDir)) {
                fs.mkdirSync(destinationDir, { recursive: true });
            }

            const response = await axios.get(file.url, {
                responseType: 'stream',
                headers: browserHeaders
            });
            activeDownload.request = response.data;

            const totalLength = parseInt(response.headers['content-length'], 10);
            let downloadedLength = 0;
            const writer = fs.createWriteStream(destinationPath);
            activeDownload.writer = writer;

            activeDownload.request.on('data', (chunk) => {
                downloadedLength += chunk.length;
                const fileProgress = (downloadedLength / totalLength) * 100;
                const overallProgress = ((i / totalFiles) * 100) + (fileProgress / totalFiles);

                win.webContents.send('download-progress', {
                    overallProgress: overallProgress,
                    fileName: path.basename(file.path),
                    downloadedBytes: downloadedLength,
                    totalBytes: totalLength,
                });
            });
            
            activeDownload.request.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                activeDownload.request.on('end', resolve);
            });
        }

        const versionFilePath = path.join(installPath, 'version.json');
        fs.writeFileSync(versionFilePath, JSON.stringify({ version: latestVersion }, null, 2));

        win.webContents.send('install-complete', { gameId, version: latestVersion });

    } catch (error) {
        if (error.code !== 'ERR_STREAM_DESTROYED') { // Ignore error from cancellation
            console.error(`Download/Update failed for ${gameId}:`, error);
            win.webContents.send('install-error', { gameId, message: 'Download failed.' });
        }
    } finally {
        activeDownload = { request: null, writer: null, isPaused: false, filePath: null };
    }
});
