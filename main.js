// main.js

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises; // Use promises-based fs
const fsSync = require('fs'); // Use sync for specific cases if needed
const crypto = require('crypto');
const axios = require('axios');
const { session } = require('electron');

let downloadManager = null;

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
    downloadManager = new DownloadManager(win);
}

app.whenReady().then(createWindow);

ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
});

async function getFileChecksum(filePath) {
    try {
        const extension = path.extname(filePath).toLowerCase();
        if (textFileExtensions.includes(extension)) {
            const textData = await fs.readFile(filePath, 'utf-8');
            const normalizedText = textData.trim().replace(/\r\n/g, '\n');
            return crypto.createHash('sha256').update(normalizedText).digest('hex');
        } else {
            const hash = crypto.createHash('sha256');
            const stream = fsSync.createReadStream(filePath); // fs.promises doesn't have createReadStream
            for await (const chunk of stream) {
                hash.update(chunk);
            }
            return hash.digest('hex');
        }
    } catch (error) {
        console.error(`Checksum error for ${filePath}:`, error);
        return null; // Return null on error
    }
}

async function getLocalVersion(installPath) {
    const versionFilePath = path.join(installPath, 'version.json');
    try {
        await fs.access(versionFilePath); // Check if file exists
        const data = await fs.readFile(versionFilePath, 'utf-8');
        return JSON.parse(data).version || '0.0.0';
    } catch (error) {
        // This is not a critical error, just means no version file found
        return '0.0.0';
    }
}

class DownloadManager {
    constructor(win) {
        this.win = win;
        this.state = this.getInitialState();
        this.request = null;
        this.writer = null;
        this.speedInterval = null;
        this.bytesSinceLastInterval = 0;
    }

    getInitialState() {
        return {
            status: 'idle', // idle, downloading, paused, success, error, cancelling
            progress: 0,
            totalFiles: 0,
            filesDownloaded: 0,
            totalBytes: 0,
            downloadedBytes: 0,
            currentFileName: '',
            downloadSpeed: 0, // Bytes per second
            error: null,
        };
    }

    setState(newState) {
        this.state = { ...this.state, ...newState };
        console.log('Download state updated:', this.state.status);
        this.win.webContents.send('download-state-update', this.state);
    }

    async start(gameId, installPath, files, latestVersion) {
        if (this.state.status === 'downloading') return;

        this.setState({
            ...this.getInitialState(),
            status: 'downloading',
            totalFiles: files.length,
        });
        
        this.bytesSinceLastInterval = 0;
        if (this.speedInterval) clearInterval(this.speedInterval);

        this.speedInterval = setInterval(() => {
            if (this.state.status === 'downloading') {
                // Speed is in bytes per second, so we multiply by 4 as interval is 250ms
                this.setState({ downloadSpeed: this.bytesSinceLastInterval * 4 });
                this.bytesSinceLastInterval = 0;
            } else {
                this.setState({ downloadSpeed: 0 });
            }
        }, 250);

        let i = 0;
        while (i < files.length) {
            if (this.state.status === 'cancelling') {
                break;
            }

            // This is the core loop for a single file, allowing retries and resume.
            const file = files[i];
            this.setState({ 
                currentFileName: path.basename(file.path), 
                downloadedBytes: 0, 
                totalBytes: file.size || 0,
                progress: ((i) / this.state.totalFiles) * 100 // Progress before this file starts
            });

            let success = false;
            let attempts = 0;
            while (!success && attempts < 3 && this.state.status !== 'cancelling') {
                if (this.state.status === 'paused') {
                    await new Promise(resolve => setTimeout(resolve, 500)); // wait while paused
                    continue; // Re-check pause/cancel status
                }

                try {
                    const destinationPath = path.join(installPath, file.path);
                    await this.downloadFile(file.url, destinationPath);
                    
                    const localChecksum = await getFileChecksum(destinationPath);
                    if (localChecksum === file.checksum) {
                        success = true;
                    } else {
                        attempts++;
                        console.warn(`Checksum mismatch for ${file.path}. Attempt ${attempts + 1}/3.`);
                        try { await fs.unlink(destinationPath); } catch (e) { console.error('Failed to delete corrupt file:', e); }
                    }
                } catch (error) {
                    if (this.state.status === 'cancelling' || this.state.status === 'paused') {
                        break; 
                    }
                    attempts++;
                    console.error(`Error downloading ${file.path}, attempt ${attempts + 1}/3:`, error);
                }
            }

            if (success) {
                i++; // Only move to the next file on success
                this.setState({ filesDownloaded: i });
            } else {
                // If the loop broke due to pause or cancel, we don't set an error.
                if (this.state.status !== 'paused' && this.state.status !== 'cancelling') {
                    this.setState({ status: 'error', error: `Failed to download ${file.path} after 3 attempts.` });
                }
                break; // Exit the main `while` loop on failure, pause, or cancel.
            }
        }

        if (this.speedInterval) {
            clearInterval(this.speedInterval);
            this.speedInterval = null;
        }

        if (this.state.status === 'downloading') {
            const versionFilePath = path.join(installPath, 'version.json');
            await fs.writeFile(versionFilePath, JSON.stringify({ version: latestVersion }, null, 2));
            this.setState({ status: 'success', progress: 100, downloadSpeed: 0 });
        } else if (this.state.status === 'cancelling') {
            this.setState(this.getInitialState());
        }
    }

    async downloadFile(url, destinationPath) {
        return new Promise(async (resolve, reject) => {
            try {
                const destinationDir = path.dirname(destinationPath);
                await fs.mkdir(destinationDir, { recursive: true });

                const response = await axios.get(url, { responseType: 'stream', headers: browserHeaders });
                this.request = response.data;
                this.writer = fsSync.createWriteStream(destinationPath);
                this.writer.on('error', (err) => { /* Handle appropriately */ });
                this.request.pipe(this.writer);

                this.request.on('data', (chunk) => {
                    this.bytesSinceLastInterval += chunk.length;
                    this.setState({ downloadedBytes: (this.state.downloadedBytes || 0) + chunk.length });
                });

                this.writer.on('finish', () => resolve());
                this.writer.on('error', (err) => {
                    this.cleanUpRequestAndWriter();
                    if (this.state.status !== 'cancelling' && this.state.status !== 'paused') {
                        reject(err);
                    } else {
                        resolve(); // Resolve without error on pause/cancel
                    }
                });
                this.request.on('error', (err) => {
                    this.cleanUpRequestAndWriter();
                    if (this.state.status !== 'cancelling' && this.state.status !== 'paused') {
                        reject(err);
                    } else {
                        resolve(); // Resolve without error on pause/cancel
                    }
                });

            } catch (error) {
                reject(error);
            }
        });
    }
    
    cleanUpRequestAndWriter() {
        this.request = null;
        this.writer = null;
    }

    pause() {
        if (this.state.status !== 'downloading') return;
        this.setState({ status: 'paused' });
        if (this.request) {
            this.request.destroy();
        }
        if (this.writer) {
            // Closing the writer might be asynchronous
            const writerPath = this.writer.path;
            this.writer.close(() => {
                // Once closed, delete the partial file
                fs.unlink(writerPath).catch(err => console.error(`Failed to delete partial file on pause: ${writerPath}`, err));
            });
        }
        this.cleanUpRequestAndWriter();
    }

    resume() {
        if (this.state.status !== 'paused') return;
        this.setState({ status: 'downloading' });
    }

    cancel() {
        if (this.state.status !== 'downloading' && this.state.status !== 'paused') return;
        this.setState({ status: 'cancelling' });
        if (this.request) {
            this.request.destroy();
        }
        if (this.writer) {
            const writerPath = this.writer.path;
            this.writer.close(() => {
                fs.unlink(writerPath).catch(err => console.error(`Failed to delete partial file on cancel: ${writerPath}`, err));
            });
        }
        this.cleanUpRequestAndWriter();
    }
}

// --- IPC Handlers ---

ipcMain.on('handle-download-action', (event, action) => {
    if (!downloadManager) return;
    switch(action.type) {
        case 'START':
            downloadManager.start(action.payload.gameId, action.payload.installPath, action.payload.files, action.payload.latestVersion);
            break;
        case 'PAUSE':
            downloadManager.pause();
            break;
        case 'RESUME':
            downloadManager.resume();
            break;
        case 'CANCEL':
            downloadManager.cancel();
            break;
    }
});

ipcMain.on('open-install-folder', (event, installPath) => {
    if (installPath && fsSync.existsSync(installPath)) {
        shell.openPath(installPath);
    }
});

ipcMain.handle('get-local-version', async (event, installPath) => {
    return await getLocalVersion(installPath);
});

ipcMain.handle('get-app-path', () => {
    return app.getAppPath();
});

ipcMain.handle('load-game-data', async () => {
    try {
        await fs.access(dataPath);
        const data = await fs.readFile(dataPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // If file doesn't exist or is invalid, return empty object
        return {};
    }
});

ipcMain.on('save-game-data', async (event, data) => {
    try {
        await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving game data:', error);
    }
});

ipcMain.handle('select-install-dir', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        properties: ['openDirectory'],
        title: 'Select Installation Directory'
    });

    if (canceled || !filePaths || filePaths.length === 0) {
        return null;
    }

    let selectedPath = filePaths[0];
    
    // Enforce installation in a "VRClassroom" folder
    if (path.basename(selectedPath).toLowerCase() !== 'vrclassroom') {
        selectedPath = path.join(selectedPath, 'VRClassroom');
    }

    // The handler now returns the potentially modified path
    return selectedPath;
});

ipcMain.handle('verify-install-path', async (event, { gameId, manifestUrl }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select Game Folder'
    });
    if (canceled) return { isValid: false, error: "Selection cancelled." };

    const selectedPath = filePaths[0];

    try {
        const response = await axios.get(manifestUrl, { headers: browserHeaders });
        const serverManifest = response.data;
        
        // A simple verification: check for the presence of a few key files.
        // A full checksum can be done during the update check later.
        // Here, we'll just check if all files listed in the manifest exist.
        for (const fileInfo of serverManifest.files) {
            const filePath = path.join(selectedPath, fileInfo.path);
            await fs.access(filePath); // Throws if file does not exist
        }
        
        const localVersion = await getLocalVersion(selectedPath);

        return { isValid: true, path: selectedPath, localVersion };
    } catch (error) {
        console.error(`Verification failed for ${selectedPath}:`, error);
        return { isValid: false, path: selectedPath, error: 'The selected folder does not contain a valid installation.' };
    }
});

ipcMain.handle('move-install-path', async (event, currentPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select New Installation Directory'
    });
    if (canceled || !filePaths || filePaths.length === 0) return null;

    const newParentDir = filePaths[0];
    const newPath = path.join(newParentDir, path.basename(currentPath));

    const normalizedCurrentPath = path.normalize(currentPath);
    const normalizedNewPath = path.normalize(newPath);

    if (normalizedNewPath.toLowerCase() === normalizedCurrentPath.toLowerCase()) {
        dialog.showErrorBox('Invalid Path', 'The new installation path cannot be the same as the current one.');
        return null;
    }

    // Prevent moving a directory into itself
    if (normalizedNewPath.toLowerCase().startsWith(normalizedCurrentPath.toLowerCase() + path.sep)) {
        dialog.showErrorBox('Invalid Path', 'You cannot move the game into a subfolder of its current location.');
        return null;
    }

    try {
        await fs.access(newPath);
        dialog.showErrorBox('Move Error', `The destination folder "${newPath}" already exists. Please choose a different location or remove the existing folder.`);
        return null;
    } catch (e) {
        // Folder doesn't exist, which is what we want. Continue.
    }

    try {
        // Using fs.cp for robust copy
        await fs.cp(currentPath, newPath, {
            recursive: true,
            force: false, // Don't overwrite
            errorOnExist: true,
        });

        // After successful copy, remove the old directory
        await shell.trashItem(currentPath);

        return newPath;
    } catch (error) {
        console.error(`Failed to move installation from ${currentPath} to ${newPath}:`, error);
        dialog.showErrorBox('Move Failed', `Could not move the game files. Please ensure you have the correct permissions and the destination drive has enough space. The original files have not been changed.`);
        // Attempt to clean up partially copied new directory if move fails
        try { await fs.rm(newPath, { recursive: true, force: true }); } catch (cleanupError) { console.error('Failed to cleanup failed move directory:', cleanupError); }
        return null;
    }
});

ipcMain.on('launch-game', (event, { installPath, executable }) => {
    if (!installPath || !executable) return;
    const executablePath = path.join(installPath, executable);
    if (fsSync.existsSync(executablePath)) {
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

ipcMain.handle('get-file-size', async (event, url) => {
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            headers: browserHeaders
        });

        const size = response.headers['content-length'];

        // IMPORTANT: Destroy the stream to prevent downloading the file body
        response.data.destroy();

        if (size) {
            return parseInt(size, 10);
        }
        return 0;
    } catch (error) {
        console.error(`Could not get file size for ${url}:`, error.message);
        return 0;
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

        if (!installPath || !fsSync.existsSync(installPath)) {
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
            try {
                await fs.access(localFilePath);
                const localChecksum = await getFileChecksum(localFilePath);
                const isMatch = localChecksum === fileInfo.checksum;
                console.log(`Checking: ${fileInfo.path} -> Match: ${isMatch}`);
                if (!isMatch) {
                    filesToUpdate.push(fileInfo);
                }
            } catch (e) {
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
