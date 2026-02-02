// chunker.js - FastCDC Chunking Service

const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const path = require('path');

/**
 * ChunkerService - Creates content-defined chunks and writes to output folder
 */

// Gear hash table for rolling hash
const GEAR = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    GEAR[i] = (Math.random() * 0xFFFFFFFF) >>> 0;
}

class ChunkerService {
    constructor() {
        this.settings = {
            minSize: 10485760,   // 10 MB
            avgSize: 20971520,   // 20 MB  
            maxSize: 31457280    // 30 MB
        };
    }

    setSettings(settings) {
        this.settings = { ...this.settings, ...settings };
        console.log('[Chunker] Settings:', this.settings);
    }

    formatSize(bytes) {
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
        return bytes + ' B';
    }

    calculateChecksum(buffer) {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    /**
     * Process a single file and write chunks to output folder
     * Returns file info with chunk references
     */
    async processFileToFolder(filePath, outputDir, relativePath) {
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;
        const content = await fs.readFile(filePath);
        const fileChecksum = this.calculateChecksum(content);

        console.log(`[Chunker] Processing: ${relativePath} (${this.formatSize(fileSize)})`);

        // Small files - copy directly, no chunking
        if (fileSize < this.settings.minSize) {
            console.log(`[Chunker]   -> Small file, copying directly`);
            const destPath = path.join(outputDir, relativePath);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, content);

            return {
                path: relativePath,
                size: fileSize,
                checksum: fileChecksum,
                chunks: null  // null = download whole file
            };
        }

        // Large files - apply FastCDC chunking
        console.log(`[Chunker]   -> Large file, applying FastCDC...`);

        const { minSize, avgSize, maxSize } = this.settings;
        const maskBits = Math.floor(Math.log2(avgSize));
        const mask = (1 << maskBits) - 1;

        const chunkInfos = [];
        let pos = 0;

        // Create chunks directory
        const chunksDir = path.join(outputDir, 'chunks');
        await fs.mkdir(chunksDir, { recursive: true });

        while (pos < fileSize) {
            const remaining = fileSize - pos;

            // Last piece
            if (remaining <= minSize) {
                const chunkData = content.subarray(pos, fileSize);
                const chunkHash = this.calculateChecksum(chunkData).substring(0, 16);

                // Write chunk file
                const chunkPath = path.join(chunksDir, `${chunkHash}.chunk`);
                await fs.writeFile(chunkPath, chunkData);

                chunkInfos.push({
                    hash: chunkHash,
                    size: remaining,
                    offset: pos
                });
                break;
            }

            // Find boundary using FastCDC
            let hash = 0;
            let cutPoint = Math.min(pos + maxSize, fileSize);

            // Skip first minSize bytes
            for (let i = pos; i < pos + minSize && i < fileSize; i++) {
                hash = ((hash << 1) + GEAR[content[i]]) >>> 0;
            }

            // Look for natural boundary
            const searchEnd = Math.min(pos + maxSize, fileSize);
            for (let i = pos + minSize; i < searchEnd; i++) {
                hash = ((hash << 1) + GEAR[content[i]]) >>> 0;
                if ((hash & mask) === 0) {
                    cutPoint = i + 1;
                    break;
                }
            }

            const chunkData = content.subarray(pos, cutPoint);
            const chunkHash = this.calculateChecksum(chunkData).substring(0, 16);

            // Write chunk file (skip if already exists - deduplication)
            const chunkPath = path.join(chunksDir, `${chunkHash}.chunk`);
            try {
                await fs.access(chunkPath);
                console.log(`[Chunker]     Chunk ${chunkHash} already exists`);
            } catch {
                await fs.writeFile(chunkPath, chunkData);
            }

            chunkInfos.push({
                hash: chunkHash,
                size: cutPoint - pos,
                offset: pos
            });

            pos = cutPoint;
        }

        console.log(`[Chunker]   -> Created ${chunkInfos.length} chunks`);

        return {
            path: relativePath,
            size: fileSize,
            checksum: fileChecksum,
            chunks: chunkInfos
        };
    }

    async getAllFiles(dirPath, basePath = dirPath) {
        const files = [];
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                files.push(...await this.getAllFiles(fullPath, basePath));
            } else {
                files.push({
                    fullPath,
                    relativePath: path.relative(basePath, fullPath).replace(/\\/g, '/')
                });
            }
        }

        return files;
    }
}

module.exports = { ChunkerService };
