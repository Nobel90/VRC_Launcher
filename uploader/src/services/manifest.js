// manifest.js - Manifest Generation Service

/**
 * ManifestService - Generates game manifests for the launcher
 */
class ManifestService {
    constructor() {
        this.version = '1.0.0';
    }

    /**
     * Generate a manifest from processed files
     * 
     * @param {Object} options
     * @param {Array} options.files - Array of file objects with path, checksum, size
     * @param {string} options.version - Game version
     * @param {string} options.channel - 'release' or 'beta'
     * @param {string} options.baseUrl - Base URL for file downloads
     * @returns {Object} Manifest object
     */
    generate({ files, version, channel, baseUrl }) {
        const manifest = {
            version: version,
            channel: channel,
            baseUrl: baseUrl,
            generatedAt: new Date().toISOString(),
            files: files.map(file => ({
                path: file.path,
                checksum: file.checksum,
                size: file.size
            }))
        };

        return manifest;
    }

    /**
     * Parse an existing manifest
     */
    parse(manifestContent) {
        if (typeof manifestContent === 'string') {
            return JSON.parse(manifestContent);
        }
        return manifestContent;
    }

    /**
     * Compare two manifests and find differences
     * Useful for incremental updates
     */
    diff(oldManifest, newManifest) {
        const oldFiles = new Map(oldManifest.files.map(f => [f.path, f]));
        const newFiles = new Map(newManifest.files.map(f => [f.path, f]));

        const added = [];
        const modified = [];
        const removed = [];

        // Find added and modified files
        for (const [path, newFile] of newFiles) {
            const oldFile = oldFiles.get(path);
            if (!oldFile) {
                added.push(newFile);
            } else if (oldFile.checksum !== newFile.checksum) {
                modified.push(newFile);
            }
        }

        // Find removed files
        for (const [path, oldFile] of oldFiles) {
            if (!newFiles.has(path)) {
                removed.push(oldFile);
            }
        }

        return {
            added,
            modified,
            removed,
            totalChanges: added.length + modified.length + removed.length
        };
    }

    /**
     * Validate manifest structure
     */
    validate(manifest) {
        const errors = [];

        if (!manifest.version) {
            errors.push('Missing version field');
        }

        if (!manifest.baseUrl) {
            errors.push('Missing baseUrl field');
        }

        if (!Array.isArray(manifest.files)) {
            errors.push('Files must be an array');
        } else {
            manifest.files.forEach((file, index) => {
                if (!file.path) {
                    errors.push(`File at index ${index} missing path`);
                }
                if (!file.checksum) {
                    errors.push(`File at index ${index} missing checksum`);
                }
            });
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}

module.exports = { ManifestService };
