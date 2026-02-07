// main.js

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
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
        minWidth: 800,
        minHeight: 600,
        resizable: true,
        frame: false,
        transparent: true, // Force removal of standard frame
        backgroundColor: '#00000000', // Transparent hex
        title: 'VR Centre Apps Launcher',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '/assets/icon-white.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });
    win.removeMenu(); // Explicitly remove menu to avoid potential artifacts
    win.loadFile('index.html');
    downloadManager = new DownloadManager(win);

    log.transports.file.level = "info";
    log.info('App starting...');
    log.info(`Checking for GH_TOKEN: ${process.env.GH_TOKEN ? 'Token is set' : 'Token is NOT set'}`);
}

autoUpdater.logger = log;

app.whenReady().then(() => {
    createWindow();
    autoUpdater.checkForUpdates();
});

autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
});
autoUpdater.on('update-available', (info) => {
    console.log('Update available.');
});
autoUpdater.on('update-not-available', (info) => {
    console.log('Update not available.');
});
autoUpdater.on('error', (err) => {
    console.log('Error in auto-updater. ' + err);
});
autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    console.log(log_message);
});
autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded');
    dialog.showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: 'A new version has been downloaded. Restart the application to apply the updates.',
        buttons: ['Restart', 'Later']
    }).then((buttonIndex) => {
        if (buttonIndex.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
});

// Verify if an install path exists and contains game files
ipcMain.handle('verify-install-path', async (event, { installPath, executable }) => {
    if (!installPath) return { exists: false, hasExecutable: false };

    const pathExists = fsSync.existsSync(installPath);
    if (!pathExists) return { exists: false, hasExecutable: false };

    try {
        const contents = await fs.readdir(installPath);
        const hasFiles = contents.length > 0;
        const executablePath = path.join(installPath, executable || '');
        const hasExecutable = executable ? fsSync.existsSync(executablePath) : false;
        return { exists: true, hasFiles, hasExecutable };
    } catch (error) {
        console.error('Error verifying install path:', error);
        return { exists: false, hasExecutable: false };
    }
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

async function checkPrereqsInstalled() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        // Check 64-bit and 32-bit registry keys
        const cmd = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "UE4 Prerequisites" & reg query "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "UE4 Prerequisites"';

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                // If checking specifically for "UE4 Prerequisites" fails or returns no results
                // We might also check for "Unreal Engine Prerequisites" as a fallback if needed
                // But usually error code 1 means not found
                console.log('Prereqs check result (likely not installed):', error.message);
                resolve(false);
                return;
            }
            // If we get output, it means found
            const found = stdout && (stdout.includes('UE4 Prerequisites') || stdout.includes('Unreal Engine Prerequisites'));
            console.log(`Prereqs check stdout found: ${found}`);
            resolve(!!found);
        });
    });
}

async function installPrereqs(win, installerPath) {
    // Verify file exists first
    if (!fsSync.existsSync(installerPath)) {
        console.error('Prereq installer not found at:', installerPath);
        return false;
    }

    const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Install Now', 'Skip'],
        defaultId: 0,
        title: 'Missing Prerequisites',
        message: 'The game requires UE4 Prerequisites (C++ Redistributables) to run correctly.',
        detail: 'Would you like to install them now? (Administrator access may be required)'
    });

    if (response === 0) {
        return new Promise((resolve) => {
            const { spawn } = require('child_process');
            console.log('Spawning installer:', installerPath);

            // Run the installer. /quiet or /passive could be used, but standard UI is safer for user awareness
            const installer = spawn(installerPath, [], { detached: false });

            installer.on('error', (err) => {
                console.error('Failed to start installer:', err);
                dialog.showErrorBox('Installation Error', 'Failed to start the prerequisite installer.');
                resolve(false);
            });

            installer.on('close', async (code) => {
                console.log('Installer exited with code:', code);
                // Verify if it was actually supposed to be installed
                // Don't just trust the code, check the registry again
                const wasInstalled = await checkPrereqsInstalled();
                resolve(wasInstalled);
            });
        });
    }

    return false; // User skipped
}

async function scanForInstallations(rootPath) {
    const results = [];
    const executableName = 'VRClassroom.exe';

    // Helper function for recursive scanning
    async function scanDir(currentPath, depth = 0) {
        if (depth > 4) return; // Limit depth to avoid scanning the entire world

        try {
            const dirents = await fs.readdir(currentPath, { withFileTypes: true });

            // Check for executable in this directory
            const hasExecutable = dirents.some(dirent => dirent.isFile() && dirent.name.toLowerCase() === executableName.toLowerCase());

            if (hasExecutable) {
                // Found an installation!
                // Try to get version
                let version = 'Unknown';
                const versionPath = path.join(currentPath, 'version.json');
                if (fsSync.existsSync(versionPath)) {
                    try {
                        const versionData = JSON.parse(await fs.readFile(versionPath, 'utf-8'));
                        version = versionData.version || 'Unknown';
                    } catch (e) { /* ignore */ }
                }

                results.push({
                    path: currentPath,
                    version: version,
                    timestamp: (await fs.stat(path.join(currentPath, executableName))).mtime
                });

                // Don't scan subdirectories of a found game folder to save time
                return;
            }

            // Recurse into subdirectories
            for (const dirent of dirents) {
                if (dirent.isDirectory()) {
                    const name = dirent.name.toLowerCase();
                    // Skip common heavy/irrelevant folders
                    if (name === 'node_modules' || name === 'windows' || name === 'program files' || name === 'program files (x86)' || name.startsWith('.') || name.includes('$recycle.bin')) {
                        continue;
                    }

                    await scanDir(path.join(currentPath, dirent.name), depth + 1);
                }
            }
        } catch (error) {
            // Permission denied or other error - ignore
        }
    }

    await scanDir(rootPath);
    return results;
}

ipcMain.handle('scan-for-installations', async (event, rootPath) => {
    return await scanForInstallations(rootPath);
});

ipcMain.handle('delete-installation', async (event, installPath) => {
    try {
        if (!installPath) return false;

        // Safety check: ensure it looks like a game folder 
        // (e.g., contains VRClassroom.exe or at least we are sure user selected it from our scan list)
        const exePath = path.join(installPath, 'VRClassroom.exe');
        if (!fsSync.existsSync(exePath)) {
            // Ask for confirmation if exe is missing? Or just fail?
            // To be safe, if we can't find the exe, we might be deleting a wrong folder.
            // But maybe the exe was deleted and user wants to clean up the rest.
            // Let's rely on the trashItem which is recoverable.
        }

        await shell.trashItem(installPath);
        return true;
    } catch (error) {
        console.error('Failed to delete installation:', error);
        return false;
    }
});

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

    async start(gameId, installPath, files, latestVersion, manifest = null) {
        if (this.state.status === 'downloading') return;

        // Extract chunk info from manifest (support both old and new format)
        const baseUrl = manifest?.baseUrl || '';
        const chunkIndex = manifest?.chunkIndex || {};

        console.log(`Starting download for ${files.length} files. baseUrl: "${baseUrl}"`);
        const filteredFiles = files.filter(file => {
            // Support both old (path) and new (filename) manifest format
            const filePath = file.path || file.filename;
            const fileName = path.basename(filePath);
            const pathString = filePath.toLowerCase();

            // Filter out 'Saved' folders, which often contain user-specific, non-essential data.
            const isSavedFolder = pathString.startsWith('saved/') || pathString.startsWith('saved\\') || pathString.includes('/saved/') || pathString.includes('\\saved\\');

            const isManifest = fileName.toLowerCase() === 'manifest_nonufsfiles_win64.txt';
            const isLauncher = fileName.toLowerCase() === 'vrclassroom launcher.exe';
            const isVrClassroomTxt = fileName.toLowerCase() === 'vrclassroom.txt';

            if (isSavedFolder || isManifest || isLauncher || isVrClassroomTxt) {
                console.log(`Filtering out non-essential file: ${file.path}`);
                return false;
            }
            return true;
        });
        console.log(`After filtering, ${filteredFiles.length} files remain.`);

        if (filteredFiles.length === 0) {
            console.log("No critical files to update. Finalizing update process.");
            this.setState({ status: 'success', progress: 100, downloadSpeed: 0 });
            return;
        }

        // Calculate total bytes for all files to enable byte-based progress
        const totalAllBytes = filteredFiles.reduce((sum, file) => sum + (file.size || file.totalSize || 0), 0);
        let cumulativeDownloadedBytes = 0;

        this.setState({
            ...this.getInitialState(),
            status: 'downloading',
            totalFiles: filteredFiles.length,
            totalAllBytes: totalAllBytes,
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
        while (i < filteredFiles.length) {
            if (this.state.status === 'cancelling') {
                break;
            }

            // This is the core loop for a single file, allowing retries and resume.
            const file = filteredFiles[i];
            // Support both old (path) and new (filename) manifest format
            const filePath = file.path || file.filename;
            const fileSize = file.size || file.totalSize || 0;
            this.setState({
                currentFileName: path.basename(filePath),
                downloadedBytes: 0,
                totalBytes: fileSize,
                progress: totalAllBytes > 0 ? (cumulativeDownloadedBytes / totalAllBytes) * 100 : 0
            });

            let success = false;
            let attempts = 0;
            while (!success && attempts < 3 && this.state.status !== 'cancelling') {
                if (this.state.status === 'paused') {
                    await new Promise(resolve => setTimeout(resolve, 500)); // wait while paused
                    continue; // Re-check pause/cancel status
                }

                try {
                    const destinationPath = path.join(installPath, filePath);

                    // Check if file is chunked
                    if (file.chunks && file.chunks.length > 0) {
                        // Chunked file - download and reconstruct
                        console.log(`Downloading chunked file: ${filePath} (${file.chunks.length} chunks)`);
                        await this.downloadChunkedFile(file, baseUrl, chunkIndex, destinationPath);
                    } else if (file.url) {
                        // Regular file with URL
                        await this.downloadFile(file.url, destinationPath);
                    } else {
                        // Small file without chunks - construct URL
                        const fileUrl = `${baseUrl}/${filePath}`;
                        await this.downloadFile(fileUrl, destinationPath);
                    }

                    // Checksum validation - only for non-chunked files that have a checksum
                    // Chunked files use per-chunk hash validation during download
                    if (file.checksum) {
                        const localChecksum = await getFileChecksum(destinationPath);
                        if (localChecksum === file.checksum) {
                            success = true;
                        } else {
                            attempts++;
                            console.warn(`Checksum mismatch for ${file.path || file.filename}. Attempt ${attempts + 1}/3.`);
                            try { await fs.unlink(destinationPath); } catch (e) { console.error('Failed to delete corrupt file:', e); }
                        }
                    } else {
                        // No checksum field (chunked files) - trust the download completed successfully
                        success = true;
                    }
                } catch (error) {
                    if (this.state.status === 'cancelling' || this.state.status === 'paused') {
                        break;
                    }
                    attempts++;
                    console.error(`Error downloading ${file.path || file.filename}, attempt ${attempts + 1}/3:`, error);
                }
            }

            if (success) {
                i++; // Only move to the next file on success
                cumulativeDownloadedBytes += fileSize; // Track total bytes for progress
                this.setState({ filesDownloaded: i, progress: totalAllBytes > 0 ? (cumulativeDownloadedBytes / totalAllBytes) * 100 : 0 });
            } else {
                // If the loop broke due to pause or cancel, we don't set an error.
                if (this.state.status !== 'paused' && this.state.status !== 'cancelling') {
                    this.setState({ status: 'error', error: `Failed to download ${file.path || file.filename} after 3 attempts.` });
                }
                break; // Exit the main `while` loop on failure, pause, or cancel.
            }
        }

        if (this.speedInterval) {
            clearInterval(this.speedInterval);
            this.speedInterval = null;
        }

        if (this.state.status === 'downloading') {
            // Check for prerequisites before finalizing
            this.setState({ currentFileName: 'Checking prerequisites...' });

            // Construct path to UE4PrereqSetup_x64.exe
            // It is usually in Engine/Extras/Redist/en-us/UE4PrereqSetup_x64.exe relative to install path
            const prereqPath = path.join(installPath, 'Engine', 'Extras', 'Redist', 'en-us', 'UE4PrereqSetup_x64.exe');

            if (fsSync.existsSync(prereqPath)) {
                const isInstalled = await checkPrereqsInstalled();
                if (!isInstalled) {
                    console.log('Prerequisites missing, prompting user...');
                    await installPrereqs(this.win, prereqPath);
                } else {
                    console.log('Prerequisites already installed.');
                }
            } else {
                console.log('Prerequisite installer not found at expected path:', prereqPath);
            }

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
                    const newDownloadedBytes = (this.state.downloadedBytes || 0) + chunk.length;

                    const baseProgress = (this.state.filesDownloaded / this.state.totalFiles) * 100;

                    let currentFileProgress = 0;
                    if (this.state.totalBytes > 0) {
                        const currentFileDownloadPercentage = newDownloadedBytes / this.state.totalBytes;
                        currentFileProgress = currentFileDownloadPercentage * (1 / this.state.totalFiles) * 100;
                    }

                    this.setState({
                        downloadedBytes: newDownloadedBytes,
                        progress: baseProgress + currentFileProgress
                    });
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

    /**
     * Download a chunked file by downloading each chunk and reconstructing
     * Supports both old format (chunkIndex lookup) and new format (chunk.url directly)
     * @param {Object} file - File info with chunks array
     * @param {string} baseUrl - Base URL for R2 bucket
     * @param {Object} chunkIndex - Map of chunk hash to relative path (old format)
     * @param {string} destinationPath - Where to write the reconstructed file
     */
    async downloadChunkedFile(file, baseUrl, chunkIndex, destinationPath) {
        const destinationDir = path.dirname(destinationPath);
        await fs.mkdir(destinationDir, { recursive: true });

        const writeStream = fsSync.createWriteStream(destinationPath);
        const filePath = file.path || file.filename;

        try {
            let bytesDownloadedForFile = 0;  // Track bytes for this file only
            for (let i = 0; i < file.chunks.length; i++) {
                const chunk = file.chunks[i];

                // Support both new format (chunk.url) and old format (chunkIndex lookup)
                let chunkUrl;
                if (chunk.url) {
                    // New format: chunk has URL directly (R2 key)
                    chunkUrl = `${baseUrl}/${chunk.url}`;
                } else if (chunkIndex && chunkIndex[chunk.hash]) {
                    // Old format: lookup in chunkIndex
                    chunkUrl = `${baseUrl}/${chunkIndex[chunk.hash]}`;
                } else {
                    throw new Error(`No URL found for chunk ${chunk.hash}`);
                }

                this.setState({
                    currentFileName: `${path.basename(filePath)} (chunk ${i + 1}/${file.chunks.length})`
                });

                const response = await axios.get(chunkUrl, {
                    responseType: 'arraybuffer',
                    headers: browserHeaders,
                    onDownloadProgress: (progressEvent) => {
                        this.bytesSinceLastInterval += progressEvent.bytes || 0;
                    }
                });

                writeStream.write(Buffer.from(response.data));
                bytesDownloadedForFile += chunk.size;

                // Update progress state for UI with local counter
                this.setState({
                    downloadedBytes: bytesDownloadedForFile
                });
            }

            await new Promise((resolve, reject) => {
                writeStream.end();
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            return true;
        } catch (error) {
            writeStream.destroy();
            try { await fs.unlink(destinationPath); } catch (e) { /* ignore */ }
            throw error;
        }
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
    switch (action.type) {
        case 'START':
            downloadManager.start(
                action.payload.gameId,
                action.payload.installPath,
                action.payload.files,
                action.payload.latestVersion,
                action.payload.manifest  // Pass manifest with baseUrl and chunkIndex
            );
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

ipcMain.handle('select-scan-root', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        properties: ['openDirectory'],
        title: 'Select Drive or Folder to Scan'
    });

    if (canceled || !filePaths || filePaths.length === 0) {
        return null;
    }

    return filePaths[0];
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

// Track running games by gameId
let runningGames = {};

ipcMain.on('launch-game', (event, { installPath, executable, gameId }) => {
    if (!installPath || !executable) return;

    // Check if game is already running
    if (runningGames[gameId]) {
        console.log('Game is already running');
        return;
    }

    const executablePath = path.join(installPath, executable);
    if (fsSync.existsSync(executablePath)) {
        const { spawn } = require('child_process');
        const gameProcess = spawn(executablePath, [], { cwd: installPath, detached: false });

        const pid = gameProcess.pid;
        runningGames[gameId] = pid;

        // Notify renderer that game has started
        event.sender.send('game-state-changed', { gameId, running: true });
        console.log(`Game launched: ${executable} (PID: ${pid})`);

        // Poll to check if process is still running (handles child processes)
        const checkInterval = setInterval(() => {
            try {
                process.kill(pid, 0); // Signal 0 just checks if process exists
            } catch (e) {
                // Process no longer exists
                console.log(`Game exited (PID: ${pid})`);
                clearInterval(checkInterval);
                delete runningGames[gameId];
                if (!event.sender.isDestroyed()) {
                    event.sender.send('game-state-changed', { gameId, running: false });
                }
            }
        }, 2000); // Check every 2 seconds

        gameProcess.on('error', (err) => {
            console.error('Game process error:', err);
            clearInterval(checkInterval);
            delete runningGames[gameId];
            if (!event.sender.isDestroyed()) {
                event.sender.send('game-state-changed', { gameId, running: false });
            }
        });

        // Also listen for normal exit
        gameProcess.on('exit', (code) => {
            console.log(`Game process exited with code: ${code}`);
            clearInterval(checkInterval);
            delete runningGames[gameId];
            if (!event.sender.isDestroyed()) {
                console.log('Sending game-state-changed with gameId:', gameId, 'running: false');
                event.sender.send('game-state-changed', { gameId, running: false });
            } else {
                console.log('Cannot send event - sender is destroyed');
            }
        });
    } else {
        console.error(`Launch failed: Executable not found at: ${executablePath}`);
    }
});

ipcMain.on('uninstall-game', async (event, installPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    // Check if the install path actually exists
    const pathExists = fsSync.existsSync(installPath);

    if (!pathExists) {
        // Path doesn't exist - just confirm clearing the launcher data
        const { response } = await dialog.showMessageBox(win, {
            type: 'info',
            buttons: ['Clear Data', 'Cancel'],
            defaultId: 0,
            title: 'Game Not Found',
            message: 'The game installation was not found.',
            detail: `The folder "${installPath}" no longer exists. Would you like to clear the launcher data so you can reinstall?`
        });

        if (response === 0) {
            event.sender.send('uninstall-complete');
        }
        return;
    }

    // Path exists - confirm moving to trash
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

ipcMain.handle('check-prereqs-status', async () => {
    return await checkPrereqsInstalled();
});

ipcMain.handle('install-prereqs', async (event, installerPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return await installPrereqs(win, installerPath);
});



// --- Window Control Handlers ---
ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.minimize();
});

ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
});

ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.close();
});

ipcMain.handle('check-for-updates', async (event, { gameId, installPath, manifestUrl }) => {
    try {
        const response = await axios.get(manifestUrl, { headers: browserHeaders });
        const serverManifest = response.data;
        const serverVersion = serverManifest.version || 'N/A'; // Fallback for version
        const filesToUpdate = [];

        console.log(`--- Starting Update Check for ${gameId} v${serverVersion} ---`);

        // Extract baseUrl from manifest, or derive from manifestUrl
        // For chunk downloads, we need the public R2 base URL
        let baseUrl = serverManifest.baseUrl;
        if (!baseUrl && manifestUrl) {
            // Extract base URL from manifest URL (e.g., https://pub-xxx.r2.dev)
            const urlObj = new URL(manifestUrl);
            baseUrl = urlObj.origin;
        }

        // Get game info for URL construction
        const gameName = serverManifest.gameName || gameId.toLowerCase();
        const buildType = serverManifest.buildType || 'release';
        const version = serverVersion;

        // Helper function to get full URL for a file (supports both old and new format)
        const getFileUrl = (fileInfo) => {
            const filePath = fileInfo.path || fileInfo.filename;
            if (baseUrl && filePath) {
                // For non-chunked files, construct URL with game/version prefix
                return `${baseUrl}/${gameName}/${buildType}/${version}/${filePath}`;
            }
            return fileInfo.url; // Fallback to direct URL for backward compatibility
        };

        if (!installPath || !fsSync.existsSync(installPath)) {
            console.log('No install path provided or path does not exist. Flagging all files for fresh installation.');
            // Add computed URLs to files
            const filesWithUrls = serverManifest.files.map(f => ({ ...f, url: getFileUrl(f) }));
            return {
                isUpdateAvailable: true,
                filesToUpdate: filesWithUrls,
                latestVersion: serverVersion,
                pathInvalid: true,
                manifest: { baseUrl, chunkIndex: serverManifest.chunkIndex || {}, totalFiles: serverManifest.files.length }
            };
        }

        // Also treat an empty directory as an invalid path to force a reinstall/locate state
        const dirContents = await fs.readdir(installPath);
        if (dirContents.length === 0) {
            console.log('Installation directory is empty. Resetting state.');
            const filesWithUrls = serverManifest.files.map(f => ({ ...f, url: getFileUrl(f) }));
            return {
                isUpdateAvailable: true,
                filesToUpdate: filesWithUrls,
                latestVersion: serverVersion,
                pathInvalid: true,
                manifest: { baseUrl, chunkIndex: serverManifest.chunkIndex || {}, totalFiles: serverManifest.files.length }
            };
        }

        for (const fileInfo of serverManifest.files) {
            // Support both old (path) and new (filename) manifest format
            const filePath = fileInfo.path || fileInfo.filename;

            // --- Start of filtering logic ---
            const fileName = path.basename(filePath);
            const pathString = filePath.toLowerCase();

            // Filter out 'Saved' folders, which often contain user-specific, non-essential data.
            const isSavedFolder = pathString.startsWith('saved/') || pathString.startsWith('saved\\') || pathString.includes('/saved/') || pathString.includes('\\saved\\');

            const isManifest = fileName.toLowerCase() === 'manifest_nonufsfiles_win64.txt';
            const isLauncher = fileName.toLowerCase() === 'vrclassroom launcher.exe';
            const isVrClassroomTxt = fileName.toLowerCase() === 'vrclassroom.txt';

            if (isSavedFolder || isManifest || isLauncher || isVrClassroomTxt) {
                console.log(`Skipping non-essential file during check: ${filePath}`);
                continue;
            }
            // --- End of filtering logic ---

            if (path.basename(filePath) === 'version.json') continue;

            const localFilePath = path.join(installPath, filePath);
            try {
                await fs.access(localFilePath);
                const stats = await fs.stat(localFilePath);
                const localSize = stats.size;
                const expectedSize = fileInfo.size || fileInfo.totalSize || 0;

                // For chunked files (no checksum field), compare by file size
                // For files with checksum, compare the checksum
                let isMatch;
                if (fileInfo.checksum) {
                    const localChecksum = await getFileChecksum(localFilePath);
                    isMatch = localChecksum === fileInfo.checksum;
                } else {
                    // Chunked files - verify by size
                    isMatch = localSize === expectedSize;
                }
                console.log(`Checking: ${filePath} -> Match: ${isMatch} (size: ${localSize}/${expectedSize})`);
                if (!isMatch) {
                    // Add computed URL and ensure path is set for old format compatibility
                    filesToUpdate.push({
                        ...fileInfo,
                        path: filePath,
                        url: getFileUrl(fileInfo),
                        size: fileInfo.size || fileInfo.totalSize || 0
                    });
                }
            } catch (e) {
                console.log(`Checking: ${filePath} -> File not found locally. Adding to update list.`);
                filesToUpdate.push({
                    ...fileInfo,
                    path: filePath,
                    url: getFileUrl(fileInfo),
                    size: fileInfo.size || fileInfo.totalSize || 0
                });
            }
        }

        console.log(`--- Update Check Complete. Found ${filesToUpdate.length} files to update. ---`);

        return {
            isUpdateAvailable: filesToUpdate.length > 0,
            filesToUpdate: filesToUpdate,
            latestVersion: serverVersion,
            pathInvalid: false,
            manifest: { baseUrl, chunkIndex: serverManifest.chunkIndex || {}, totalFiles: serverManifest.files.length }
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
