// manifestUtils.js
// Utilities for handling chunk-based manifests

/**
 * Detect manifest type
 */
function detectManifestType(manifest) {
    if (manifest.manifestType === 'chunk-based') {
        return 'chunk-based';
    }

    if (manifest.files && manifest.files.length > 0) {
        const firstFile = manifest.files[0];
        if (firstFile.chunks && Array.isArray(firstFile.chunks)) {
            return 'chunk-based';
        }
    }

    return 'file-based';
}

/**
 * Validate chunk-based manifest structure
 */
function validateChunkManifest(manifest, requireUrls = false) {
    if (!manifest.version) {
        throw new Error('Manifest missing version');
    }

    if (!manifest.files || !Array.isArray(manifest.files)) {
        throw new Error('Manifest missing files array');
    }

    for (const file of manifest.files) {
        if (!file.filename) {
            throw new Error('File missing filename');
        }

        if (!file.chunks || !Array.isArray(file.chunks)) {
            throw new Error(`File ${file.filename} missing chunks array`);
        }

        for (const chunk of file.chunks) {
            if (!chunk.hash) {
                throw new Error(`Chunk missing hash in file ${file.filename}`);
            }
            if (typeof chunk.size !== 'number') {
                throw new Error(`Chunk missing size in file ${file.filename}`);
            }
            if (typeof chunk.offset !== 'number') {
                throw new Error(`Chunk missing offset in file ${file.filename}`);
            }
            if (requireUrls && !chunk.url) {
                throw new Error(`Chunk missing url in file ${file.filename}`);
            }
        }
    }

    return true;
}

/**
 * Get all chunks from manifest
 */
function getAllChunks(manifest) {
    const chunks = [];

    for (const file of manifest.files) {
        for (const chunk of file.chunks) {
            chunks.push({
                ...chunk,
                file: file.filename
            });
        }
    }

    return chunks;
}

/**
 * Get unique chunks (for deduplication stats)
 */
function getUniqueChunks(manifest) {
    const seen = new Set();
    const unique = [];

    for (const file of manifest.files) {
        for (const chunk of file.chunks) {
            if (!seen.has(chunk.hash)) {
                seen.add(chunk.hash);
                unique.push(chunk);
            }
        }
    }

    return unique;
}

/**
 * Calculate total download size
 */
function calculateDownloadSize(chunks) {
    return chunks.reduce((sum, chunk) => sum + chunk.size, 0);
}

/**
 * Create a chunk-based manifest
 */
function createChunkManifest(version, gameName, buildType, files) {
    return {
        version,
        gameName,
        buildType,
        manifestType: 'chunk-based',
        generatedAt: new Date().toISOString(),
        files: files.map(file => ({
            filename: file.filename,
            totalSize: file.totalSize || file.chunks.reduce((sum, chunk) => sum + chunk.size, 0),
            chunks: file.chunks.map(chunk => ({
                hash: chunk.hash,
                size: chunk.size,
                offset: chunk.offset
                // url added during upload
            }))
        }))
    };
}

/**
 * Format bytes to human-readable
 */
function formatBytes(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
}

module.exports = {
    detectManifestType,
    validateChunkManifest,
    getAllChunks,
    getUniqueChunks,
    calculateDownloadSize,
    createChunkManifest,
    formatBytes
};
