// uploadManager.js
// Upload orchestration with pause/resume

const fs = require('fs').promises;
const path = require('path');
const { R2Uploader } = require('./r2Uploader');
const { detectDelta } = require('./deltaDetector');
const { getAllChunks } = require('./manifestUtils');

/**
 * Upload Manager with pause/resume capability
 */
class UploadManager {
    constructor(r2Config) {
        this.uploader = new R2Uploader(r2Config);
        this.isPaused = false;
        this.isCancelled = false;
        this.pauseResolve = null;
    }

    /**
     * Pause the upload
     */
    pause() {
        this.isPaused = true;
    }

    /**
     * Resume the upload
     */
    resume() {
        this.isPaused = false;
        if (this.pauseResolve) {
            this.pauseResolve();
            this.pauseResolve = null;
        }
    }

    /**
     * Cancel the upload
     */
    cancel() {
        this.isCancelled = true;
        this.resume(); // Unblock if paused
    }

    /**
     * Wait if paused
     */
    async waitIfPaused() {
        if (this.isPaused) {
            await new Promise(resolve => {
                this.pauseResolve = resolve;
            });
        }
        if (this.isCancelled) {
            throw new Error('Upload cancelled');
        }
    }

    /**
     * Upload chunks and manifest
     */
    async upload(options, onProgress = null) {
        const {
            manifestPath,
            oldManifestPath = null,
            chunksDir,
            gameName,
            version,
            buildType = 'release',
            mode = 'delta' // 'delta' or 'full'
        } = options;

        // Reset state
        this.isPaused = false;
        this.isCancelled = false;

        // Read manifest
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestData);

        let chunksToUpload = [];

        if (mode === 'delta' && oldManifestPath) {
            // Delta upload
            if (onProgress) onProgress({ percentage: 0, message: 'Detecting changes...' });

            const oldManifestData = await fs.readFile(oldManifestPath, 'utf-8');
            const delta = detectDelta(oldManifestData, manifestData);

            chunksToUpload = delta.chunksToUploadDetails;

            if (onProgress) {
                onProgress({
                    percentage: 5,
                    message: `Delta: ${chunksToUpload.length} chunks to upload (${delta.stats.savingsPercent} saved)`
                });
            }
        } else {
            // Full upload
            if (onProgress) onProgress({ percentage: 0, message: 'Preparing full upload...' });

            chunksToUpload = getAllChunks(manifest);

            if (onProgress) {
                onProgress({ percentage: 5, message: `Full upload: ${chunksToUpload.length} chunks` });
            }
        }

        // Upload chunks
        const totalChunks = chunksToUpload.length;
        let uploadedChunks = 0;
        let skippedChunks = 0;
        let failedChunks = 0;

        for (let i = 0; i < chunksToUpload.length; i++) {
            await this.waitIfPaused();

            const chunk = chunksToUpload[i];
            const hashPrefix = chunk.hash.substring(0, 2);
            const chunkPath = path.join(chunksDir, hashPrefix, chunk.hash);

            try {
                // Verify chunk exists
                await fs.access(chunkPath);

                const result = await this.uploader.uploadChunk(
                    chunk.hash,
                    chunkPath,
                    gameName,
                    version,
                    buildType,
                    (progress) => {
                        if (progress.skipped) skippedChunks++;
                    }
                );

                if (!result.skipped) uploadedChunks++;

                if (onProgress) {
                    const percentage = 5 + ((i + 1) / totalChunks) * 80;
                    const pauseStatus = this.isPaused ? ' (Paused)' : '';
                    onProgress({
                        percentage,
                        message: `Uploading: ${i + 1}/${totalChunks} (${uploadedChunks} new, ${skippedChunks} exists)${pauseStatus}`,
                        currentChunk: i + 1,
                        totalChunks
                    });
                }
            } catch (error) {
                console.error(`Failed to upload chunk ${chunk.hash}:`, error.message);
                failedChunks++;

                if (onProgress) {
                    onProgress({
                        percentage: 5 + ((i + 1) / totalChunks) * 80,
                        message: `Error: ${chunk.hash.substring(0, 8)}... - ${error.message}`,
                        error: true
                    });
                }
            }
        }

        // Upload manifest
        if (onProgress) onProgress({ percentage: 90, message: 'Uploading manifest...' });

        await this.uploader.uploadManifest(manifest, gameName, version, buildType, onProgress);

        // Upload version file
        if (onProgress) onProgress({ percentage: 95, message: 'Uploading version file...' });

        const versionPath = path.join(path.dirname(manifestPath), 'version.json');
        try {
            await fs.access(versionPath);
            const versionKey = `${gameName}/${buildType}/${version}/version.json`;
            await this.uploader.uploadFile(versionPath, versionKey);
        } catch {
            // version.json doesn't exist, skip
        }

        if (onProgress) onProgress({ percentage: 100, message: 'Upload complete!' });

        return {
            success: true,
            stats: {
                totalChunks,
                uploadedChunks,
                skippedChunks,
                failedChunks
            }
        };
    }
}

module.exports = { UploadManager };
