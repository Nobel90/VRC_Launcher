// r2Uploader.js
// R2 upload client with deduplication checking

const { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs').promises;
const path = require('path');

/**
 * R2 Uploader with deduplication
 */
class R2Uploader {
    constructor(config) {
        this.config = {
            bucket: config.bucketName || config.bucket,
            endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            region: 'auto'
        };

        this.client = new S3Client({
            region: this.config.region,
            endpoint: this.config.endpoint,
            forcePathStyle: true,
            credentials: {
                accessKeyId: this.config.accessKeyId,
                secretAccessKey: this.config.secretAccessKey
            }
        });
    }

    /**
     * Test R2 connection
     */
    async testConnection() {
        try {
            const listCommand = new ListObjectsV2Command({
                Bucket: this.config.bucket,
                MaxKeys: 1
            });
            await this.client.send(listCommand);
            return { success: true, message: `Connected to bucket "${this.config.bucket}"` };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                httpStatusCode: error.$metadata?.httpStatusCode
            };
        }
    }

    /**
     * Check if object exists in R2
     */
    async objectExists(key) {
        try {
            const command = new HeadObjectCommand({
                Bucket: this.config.bucket,
                Key: key
            });
            await this.client.send(command);
            return true;
        } catch (error) {
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Upload buffer to R2 with retry logic
     */
    async uploadBuffer(buffer, key, contentType = 'application/octet-stream', maxRetries = 3) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const command = new PutObjectCommand({
                    Bucket: this.config.bucket,
                    Key: key,
                    Body: buffer,
                    ContentType: contentType
                });

                await this.client.send(command);
                return { success: true, key, size: buffer.length };
            } catch (error) {
                lastError = error;
                console.log(`Upload attempt ${attempt}/${maxRetries} failed for ${key}: ${error.message}`);

                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    /**
     * Upload file from disk to R2
     */
    async uploadFile(localPath, key, onProgress = null) {
        const fileData = await fs.readFile(localPath);
        const result = await this.uploadBuffer(fileData, key);

        if (onProgress) {
            onProgress({ key, size: fileData.length, uploaded: true });
        }

        return result;
    }

    /**
     * Upload chunk with deduplication check
     * Key structure: {gameName}/{buildType}/{version}/chunks/{hashPrefix}/{hash}
     */
    async uploadChunk(chunkHash, chunkPath, gameName, version, buildType = 'release', onProgress = null) {
        const hashPrefix = chunkHash.substring(0, 2);
        const r2Key = `${gameName}/${buildType}/${version}/chunks/${hashPrefix}/${chunkHash}`;

        // Check if chunk already exists (deduplication)
        const exists = await this.objectExists(r2Key);
        if (exists) {
            if (onProgress) {
                onProgress({
                    key: r2Key,
                    skipped: true,
                    message: `Chunk ${chunkHash.substring(0, 8)}... already exists`,
                    chunkHash,
                    reason: 'already_exists'
                });
            }
            return { success: true, key: r2Key, skipped: true, reason: 'already_exists', chunkHash };
        }

        return await this.uploadFile(chunkPath, r2Key, onProgress);
    }

    /**
     * Upload chunk from buffer with deduplication
     */
    async uploadChunkBuffer(chunkHash, chunkData, gameName, version, buildType = 'release', onProgress = null) {
        const hashPrefix = chunkHash.substring(0, 2);
        const r2Key = `${gameName}/${buildType}/${version}/chunks/${hashPrefix}/${chunkHash}`;

        // Check if chunk already exists
        const exists = await this.objectExists(r2Key);
        if (exists) {
            if (onProgress) {
                onProgress({
                    key: r2Key,
                    skipped: true,
                    chunkHash,
                    reason: 'already_exists'
                });
            }
            return { success: true, key: r2Key, skipped: true, reason: 'already_exists' };
        }

        return await this.uploadBuffer(chunkData, r2Key);
    }

    /**
     * Upload manifest to R2
     * Uploads both version-specific and latest manifest
     */
    async uploadManifest(manifestData, gameName, version, buildType = 'release', onProgress = null) {
        const manifestJson = typeof manifestData === 'string' ? manifestData : JSON.stringify(manifestData, null, 2);
        const manifestBuffer = Buffer.from(manifestJson, 'utf-8');

        // Update chunk URLs in manifest
        let manifest = typeof manifestData === 'string' ? JSON.parse(manifestData) : manifestData;
        manifest.files.forEach(file => {
            file.chunks.forEach(chunk => {
                const hashPrefix = chunk.hash.substring(0, 2);
                chunk.url = `${gameName}/${buildType}/${version}/chunks/${hashPrefix}/${chunk.hash}`;
            });
        });

        const updatedManifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');

        // Upload version-specific manifest
        const versionKey = `${gameName}/${buildType}/${version}/manifest.json`;
        await this.uploadBuffer(updatedManifestBuffer, versionKey, 'application/json');

        // Upload as latest manifest
        const latestKey = `${gameName}/${buildType}/${gameName.toLowerCase()}_manifest.json`;
        await this.uploadBuffer(updatedManifestBuffer, latestKey, 'application/json');

        if (onProgress) {
            onProgress({ message: 'Manifest uploaded', versionKey, latestKey });
        }

        return { success: true, versionKey, latestKey };
    }

    /**
     * Get manifest from R2
     */
    async getManifest(gameName, version, buildType = 'release') {
        const key = version
            ? `${gameName}/${buildType}/${version}/manifest.json`
            : `${gameName}/${buildType}/${gameName.toLowerCase()}_manifest.json`;

        try {
            const command = new GetObjectCommand({
                Bucket: this.config.bucket,
                Key: key
            });

            const response = await this.client.send(command);
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(chunk);
            }

            return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch (error) {
            if (error.$metadata?.httpStatusCode === 404) {
                return null;
            }
            throw error;
        }
    }

    /**
     * List all versions for a game
     */
    async listVersions(gameName, buildType = 'release') {
        const versions = new Set();

        try {
            const listCommand = new ListObjectsV2Command({
                Bucket: this.config.bucket,
                Prefix: `${gameName}/${buildType}/`,
                Delimiter: '/'
            });

            const response = await this.client.send(listCommand);

            if (response.CommonPrefixes) {
                for (const prefix of response.CommonPrefixes) {
                    const match = prefix.Prefix.match(new RegExp(`${gameName}/${buildType}/([^/]+)/`));
                    if (match && match[1] && !match[1].includes('manifest')) {
                        versions.add(match[1]);
                    }
                }
            }

            // Sort versions descending
            return Array.from(versions).sort((a, b) => {
                const aParts = a.split('.').map(Number);
                const bParts = b.split('.').map(Number);
                for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                    if ((bParts[i] || 0) !== (aParts[i] || 0)) {
                        return (bParts[i] || 0) - (aParts[i] || 0);
                    }
                }
                return 0;
            });
        } catch (error) {
            console.error('Error listing versions:', error);
            return [];
        }
    }

    /**
     * Promote a version as latest
     */
    async promoteVersion(gameName, version, buildType = 'release', onProgress = null) {
        if (onProgress) onProgress({ percentage: 0, message: 'Fetching manifest...' });

        const manifest = await this.getManifest(gameName, version, buildType);
        if (!manifest) {
            throw new Error(`Manifest not found for version ${version}`);
        }

        if (onProgress) onProgress({ percentage: 50, message: 'Uploading as latest...' });

        // Upload as latest manifest
        const latestKey = `${gameName}/${buildType}/${gameName.toLowerCase()}_manifest.json`;
        await this.uploadBuffer(
            Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
            latestKey,
            'application/json'
        );

        if (onProgress) onProgress({ percentage: 100, message: `Version ${version} promoted as latest` });

        return { success: true, version, latestKey };
    }
}

module.exports = { R2Uploader };
