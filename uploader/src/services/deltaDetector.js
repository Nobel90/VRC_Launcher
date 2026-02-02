// deltaDetector.js
// Detect changes between manifests for delta uploads

const { getAllChunks, getUniqueChunks, calculateDownloadSize, formatBytes } = require('./manifestUtils');

/**
 * Compare two manifests and detect delta
 */
function detectDelta(oldManifestData, newManifestData) {
    const oldManifest = typeof oldManifestData === 'string' ? JSON.parse(oldManifestData) : oldManifestData;
    const newManifest = typeof newManifestData === 'string' ? JSON.parse(newManifestData) : newManifestData;

    // Build lookup maps
    const oldFiles = new Map(oldManifest.files.map(f => [f.filename, f]));
    const newFiles = new Map(newManifest.files.map(f => [f.filename, f]));

    const oldChunkHashes = new Set();
    for (const file of oldManifest.files) {
        for (const chunk of file.chunks) {
            oldChunkHashes.add(chunk.hash);
        }
    }

    // Categorize files
    const newFilesList = [];
    const changedFiles = [];
    const unchangedFiles = [];
    const deletedFiles = [];

    // Check new manifest files
    for (const [filename, newFile] of newFiles) {
        const oldFile = oldFiles.get(filename);

        if (!oldFile) {
            // New file
            newFilesList.push(newFile);
        } else {
            // Check if file changed by comparing chunks
            const oldChunks = new Set(oldFile.chunks.map(c => c.hash));
            const newChunks = newFile.chunks.map(c => c.hash);

            const hasChanges = newChunks.some(hash => !oldChunks.has(hash)) ||
                newFile.chunks.length !== oldFile.chunks.length;

            if (hasChanges) {
                changedFiles.push(newFile);
            } else {
                unchangedFiles.push(newFile);
            }
        }
    }

    // Check for deleted files
    for (const [filename, oldFile] of oldFiles) {
        if (!newFiles.has(filename)) {
            deletedFiles.push(oldFile);
        }
    }

    // Find chunks to upload (new chunks not in old manifest)
    const chunksToUpload = [];
    const chunksToUploadSet = new Set();

    for (const file of [...newFilesList, ...changedFiles]) {
        for (const chunk of file.chunks) {
            if (!oldChunkHashes.has(chunk.hash) && !chunksToUploadSet.has(chunk.hash)) {
                chunksToUploadSet.add(chunk.hash);
                chunksToUpload.push({
                    ...chunk,
                    file: file.filename
                });
            }
        }
    }

    // Calculate sizes
    const totalNewChunksSize = calculateDownloadSize(chunksToUpload);
    const totalOldSize = calculateDownloadSize(getAllChunks(oldManifest));
    const totalNewSize = calculateDownloadSize(getAllChunks(newManifest));

    return {
        oldVersion: oldManifest.version,
        newVersion: newManifest.version,

        newFiles: newFilesList,
        changedFiles,
        unchangedFiles,
        deletedFiles,

        chunksToUploadDetails: chunksToUpload,

        stats: {
            newFilesCount: newFilesList.length,
            changedFilesCount: changedFiles.length,
            unchangedFilesCount: unchangedFiles.length,
            deletedFilesCount: deletedFiles.length,

            totalChunksInNew: getUniqueChunks(newManifest).length,
            chunksToUpload: chunksToUpload.length,
            chunksReused: getUniqueChunks(newManifest).length - chunksToUpload.length,

            totalNewChunksSize,
            totalNewChunksSizeHuman: formatBytes(totalNewChunksSize),
            totalNewSize,
            totalNewSizeHuman: formatBytes(totalNewSize),

            savings: totalNewSize - totalNewChunksSize,
            savingsHuman: formatBytes(totalNewSize - totalNewChunksSize),
            savingsPercent: totalNewSize > 0
                ? ((1 - totalNewChunksSize / totalNewSize) * 100).toFixed(1) + '%'
                : '0%'
        }
    };
}

/**
 * Quick check if delta upload is worthwhile
 */
function shouldUseDelta(oldManifest, newManifest) {
    if (!oldManifest || !newManifest) return false;

    const delta = detectDelta(oldManifest, newManifest);

    // Use delta if we can save more than 10% of upload
    const savingsRatio = delta.stats.savings / delta.stats.totalNewSize;
    return savingsRatio > 0.1;
}

module.exports = { detectDelta, shouldUseDelta };
