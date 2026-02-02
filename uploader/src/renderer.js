// renderer.js - VRC Uploader UI Logic

let currentManifest = null;
let uploadState = 'idle'; // idle, uploading, paused

// =====================
// TAB NAVIGATION
// =====================

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
    });
});

// Upload mode toggle
document.getElementById('upload-mode').addEventListener('change', (e) => {
    document.getElementById('delta-options').style.display =
        e.target.value === 'delta' ? 'block' : 'none';
});

// =====================
// FOLDER SELECTION
// =====================

async function selectSourceFolder() {
    const path = await window.electronAPI.selectFolder('Select Game Source Folder');
    if (path) {
        document.getElementById('source-folder').value = path;
        const scan = await window.electronAPI.scanFolder(path);
        if (!scan.error) {
            log(`Found ${scan.totalFiles} files (${formatBytes(scan.totalSize)})`);
        }
    }
}

async function selectOutputFolder() {
    const path = await window.electronAPI.selectFolder('Select Output Folder');
    if (path) document.getElementById('output-folder').value = path;
}

async function selectManifest() {
    // For now just use folder selection, manifest is manifest_*.json inside
    const path = await window.electronAPI.selectFolder('Select Build Folder');
    if (path) {
        document.getElementById('manifest-path').value = path;
        // Try to load manifest info
        const manifest = await window.electronAPI.loadManifest(path + '/manifest_release_' + document.getElementById('version').value + '.json');
        if (manifest && !manifest.error) {
            currentManifest = manifest;
        }
    }
}

async function selectOldManifest() {
    const path = await window.electronAPI.selectFolder('Select Previous Build Folder');
    if (path) {
        document.getElementById('old-manifest-path').value = path;
        await checkDelta();
    }
}

// =====================
// BUILD (GENERATE MANIFEST)
// =====================

async function generateBuild() {
    const gameName = document.getElementById('game-name').value.trim();
    const version = document.getElementById('version').value.trim();
    const buildType = document.getElementById('build-type').value;
    const sourceDir = document.getElementById('source-folder').value;
    const outputDir = document.getElementById('output-folder').value;

    if (!gameName || !version || !sourceDir || !outputDir) {
        alert('Please fill in all fields');
        return;
    }

    // Get chunk settings
    const chunkSettings = await window.electronAPI.getChunkSettings();

    // Show progress
    document.getElementById('build-progress').style.display = 'block';
    document.getElementById('build-stats').style.display = 'none';
    document.getElementById('btn-generate').disabled = true;

    const result = await window.electronAPI.generateManifest({
        sourceDir,
        outputDir,
        gameName,
        version,
        buildType,
        chunkSizes: {
            min: chunkSettings.minSize,
            avg: chunkSettings.avgSize,
            max: chunkSettings.maxSize
        }
    });

    document.getElementById('btn-generate').disabled = false;

    if (result.error) {
        alert('Error: ' + result.error);
        document.getElementById('build-progress').style.display = 'none';
    } else {
        // Show stats
        document.getElementById('build-stats').style.display = 'grid';
        document.getElementById('stat-files').textContent = result.stats.filesProcessed;
        document.getElementById('stat-chunks').textContent = result.stats.uniqueChunks;
        document.getElementById('stat-dedup').textContent = result.stats.deduplicationRatio;

        // Auto-fill upload path
        document.getElementById('manifest-path').value = result.manifestPath.replace(/\/manifest_.*\.json$/, '');

        log(`Build complete! Manifest: ${result.manifestPath}`, 'success');
    }
}

// Listen for build progress
window.electronAPI.onGenerateProgress((data) => {
    document.getElementById('build-progress-fill').style.width = data.percentage + '%';
    document.getElementById('build-progress-text').textContent = data.message;
});

// =====================
// UPLOAD
// =====================

async function startUpload() {
    const manifestFolder = document.getElementById('manifest-path').value;
    const mode = document.getElementById('upload-mode').value;
    const gameName = document.getElementById('game-name').value.trim();
    const version = document.getElementById('version').value.trim();
    const buildType = document.getElementById('build-type').value;

    if (!manifestFolder || !gameName || !version) {
        alert('Please fill in all fields and select manifest folder');
        return;
    }

    const manifestPath = `${manifestFolder}/manifest_${buildType}_${version}.json`;
    const chunksDir = `${manifestFolder}/chunks`;

    let oldManifestPath = null;
    if (mode === 'delta') {
        const oldFolder = document.getElementById('old-manifest-path').value;
        if (oldFolder) {
            // Try to find previous manifest
            oldManifestPath = `${oldFolder}/manifest_${buildType}_${version}.json`;
        }
    }

    // Show progress and controls
    document.getElementById('upload-progress').style.display = 'block';
    document.getElementById('upload-stats').style.display = 'none';
    document.getElementById('btn-upload').style.display = 'none';
    document.getElementById('btn-pause').style.display = 'inline-block';
    document.getElementById('btn-cancel').style.display = 'inline-block';
    document.getElementById('btn-pause').textContent = 'Pause';

    uploadState = 'uploading';

    const result = await window.electronAPI.uploadToR2({
        manifestPath,
        oldManifestPath,
        chunksDir,
        gameName,
        version,
        buildType,
        mode
    });

    uploadState = 'idle';

    // Reset UI
    document.getElementById('btn-upload').style.display = 'inline-block';
    document.getElementById('btn-pause').style.display = 'none';
    document.getElementById('btn-cancel').style.display = 'none';

    if (result.error) {
        alert('Upload error: ' + result.error);
    } else {
        // Show stats
        document.getElementById('upload-stats').style.display = 'grid';
        document.getElementById('stat-uploaded').textContent = result.stats.uploadedChunks;
        document.getElementById('stat-skipped').textContent = result.stats.skippedChunks;
        document.getElementById('stat-failed').textContent = result.stats.failedChunks;

        log(`Upload complete! ${result.stats.uploadedChunks} uploaded, ${result.stats.skippedChunks} skipped`, 'success');
    }
}

function pauseUpload() {
    if (uploadState === 'uploading') {
        window.electronAPI.pauseUpload();
        uploadState = 'paused';
        document.getElementById('btn-pause').textContent = 'Resume';
    } else if (uploadState === 'paused') {
        window.electronAPI.resumeUpload();
        uploadState = 'uploading';
        document.getElementById('btn-pause').textContent = 'Pause';
    }
}

function cancelUpload() {
    window.electronAPI.cancelUpload();
    uploadState = 'idle';
    document.getElementById('btn-upload').style.display = 'inline-block';
    document.getElementById('btn-pause').style.display = 'none';
    document.getElementById('btn-cancel').style.display = 'none';
}

// Listen for upload progress
window.electronAPI.onUploadProgress((data) => {
    document.getElementById('upload-progress-fill').style.width = data.percentage + '%';
    document.getElementById('upload-progress-text').textContent = data.message;
});

// =====================
// DELTA DETECTION
// =====================

async function checkDelta() {
    const newFolder = document.getElementById('manifest-path').value;
    const oldFolder = document.getElementById('old-manifest-path').value;
    const version = document.getElementById('version').value.trim();
    const buildType = document.getElementById('build-type').value;

    if (!newFolder || !oldFolder || !version) return;

    const newPath = `${newFolder}/manifest_${buildType}_${version}.json`;
    const oldPath = `${oldFolder}/manifest_${buildType}_${version}.json`;

    const delta = await window.electronAPI.detectDelta({ oldManifestPath: oldPath, newManifestPath: newPath });

    if (!delta.error) {
        document.getElementById('delta-stats').style.display = 'block';
        document.getElementById('delta-info').innerHTML = `
            <strong>Delta Analysis:</strong><br>
            • ${delta.stats.chunksToUpload} chunks to upload (${delta.stats.totalNewChunksSizeHuman})<br>
            • ${delta.stats.chunksReused} chunks reused<br>
            • Savings: ${delta.stats.savingsHuman} (${delta.stats.savingsPercent})
        `;
    }
}

// =====================
// SETTINGS
// =====================

async function loadSettings() {
    // R2 Config
    const r2Config = await window.electronAPI.loadR2Config();
    document.getElementById('r2-account-id').value = r2Config.accountId || '';
    document.getElementById('r2-bucket').value = r2Config.bucketName || 'vrcentre';
    document.getElementById('r2-access-key').value = r2Config.accessKeyId || '';
    document.getElementById('r2-secret-key').value = r2Config.secretAccessKey || '';

    // Chunk settings
    const chunkSettings = await window.electronAPI.getChunkSettings();
    document.getElementById('chunk-min').value = Math.round(chunkSettings.minSize / 1024 / 1024);
    document.getElementById('chunk-avg').value = Math.round(chunkSettings.avgSize / 1024 / 1024);
    document.getElementById('chunk-max').value = Math.round(chunkSettings.maxSize / 1024 / 1024);
}

async function saveR2Config() {
    const config = {
        accountId: document.getElementById('r2-account-id').value,
        bucketName: document.getElementById('r2-bucket').value,
        accessKeyId: document.getElementById('r2-access-key').value,
        secretAccessKey: document.getElementById('r2-secret-key').value
    };

    const result = await window.electronAPI.saveR2Config(config);
    if (result.success) {
        log('R2 configuration saved', 'success');
    } else {
        log('Failed to save config: ' + result.error, 'error');
    }
}

async function testR2Connection() {
    const config = {
        accountId: document.getElementById('r2-account-id').value,
        bucketName: document.getElementById('r2-bucket').value,
        accessKeyId: document.getElementById('r2-access-key').value,
        secretAccessKey: document.getElementById('r2-secret-key').value
    };

    const status = document.getElementById('connection-status');
    status.innerHTML = '<span class="status-badge status-working">Testing...</span>';

    const result = await window.electronAPI.testR2Connection(config);

    if (result.success) {
        status.innerHTML = '<span class="status-badge status-success">✓ Connected</span>';
    } else {
        status.innerHTML = `<span class="status-badge status-error">✗ ${result.message}</span>`;
    }
}

async function saveChunkSettings() {
    const settings = {
        minSize: parseInt(document.getElementById('chunk-min').value) * 1024 * 1024,
        avgSize: parseInt(document.getElementById('chunk-avg').value) * 1024 * 1024,
        maxSize: parseInt(document.getElementById('chunk-max').value) * 1024 * 1024
    };

    const result = await window.electronAPI.saveChunkSettings(settings);
    if (result.success) {
        log('Chunk settings saved', 'success');
    }
}

// =====================
// UTILS
// =====================

function formatBytes(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
}

function log(message, type = 'info') {
    console.log(`[${type}] ${message}`);
}

// Initialize
loadSettings();
