// chunkManager.js
// Content-Defined Chunking (CDC) using FastCDC algorithm

const crypto = require('crypto');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

/**
 * FastCDC implementation based on the paper:
 * "FastCDC: A Fast and Efficient Content-Defined Chunking Approach for Data Deduplication"
 */
class FastCDC {
    constructor(options = {}) {
        // Default chunk size parameters (in bytes)
        this.minSize = options.minSize || 5 * 1024 * 1024;   // 5MB minimum
        this.avgSize = options.avgSize || 10 * 1024 * 1024;  // 10MB average
        this.maxSize = options.maxSize || 20 * 1024 * 1024;  // 20MB maximum

        // Mask for determining chunk boundaries
        this.mask = this.calculateMask(this.avgSize);

        // Gear hash table (precomputed for performance)
        this.gear = this.generateGearTable();
    }

    /**
     * Calculate mask for chunk boundary detection
     */
    calculateMask(avgSize) {
        const bits = Math.floor(Math.log2(avgSize));
        return (1 << bits) - 1;
    }

    /**
     * Generate Gear hash table (256 random 64-bit integers)
     */
    generateGearTable() {
        const gear = new BigUint64Array(256);
        const multiplier = 0x9e3779b97f4a7c15n;
        for (let i = 0; i < 256; i++) {
            gear[i] = (BigInt(i) * multiplier) & 0xffffffffffffffffn;
        }
        return gear;
    }

    /**
     * Update Gear hash with a new byte
     */
    updateHash(hash, byte) {
        return ((hash << 1n) + this.gear[byte]) & 0xffffffffffffffffn;
    }

    /**
     * Check if current position is a chunk boundary
     */
    isChunkBoundary(hash, position) {
        if (position < this.minSize) return false;
        if (position >= this.maxSize) return true;
        return (hash & BigInt(this.mask)) === 0n;
    }

    /**
     * Chunk a file using FastCDC
     * Returns array of chunk objects: { hash, size, offset, data }
     */
    async chunkFile(filePath) {
        const chunks = [];
        const fileHandle = await fs.open(filePath, 'r');
        const stats = await fileHandle.stat();
        const fileSize = stats.size;

        let offset = 0;
        let hash = 0n;
        let chunkStart = 0;
        const buffer = Buffer.alloc(65536); // 64KB read buffer

        while (offset < fileSize) {
            const bytesToRead = Math.min(buffer.length, fileSize - offset);
            const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);

            for (let i = 0; i < bytesRead; i++) {
                const byte = buffer[i];
                hash = this.updateHash(hash, byte);
                offset++;

                if (this.isChunkBoundary(hash, offset - chunkStart)) {
                    const chunkSize = offset - chunkStart;
                    const chunkData = Buffer.alloc(chunkSize);

                    await fileHandle.read(chunkData, 0, chunkSize, chunkStart);
                    const chunkHash = crypto.createHash('sha256').update(chunkData).digest('hex');

                    chunks.push({
                        hash: chunkHash,
                        size: chunkSize,
                        offset: chunkStart,
                        data: chunkData
                    });

                    chunkStart = offset;
                    hash = 0n;
                }
            }
        }

        // Handle remaining data as final chunk
        if (chunkStart < fileSize) {
            const chunkSize = fileSize - chunkStart;
            const chunkData = Buffer.alloc(chunkSize);
            await fileHandle.read(chunkData, 0, chunkSize, chunkStart);
            const chunkHash = crypto.createHash('sha256').update(chunkData).digest('hex');

            chunks.push({
                hash: chunkHash,
                size: chunkSize,
                offset: chunkStart,
                data: chunkData
            });
        }

        await fileHandle.close();
        return chunks;
    }
}

/**
 * Chunk Manager - Handles chunk storage, retrieval, and file reconstruction
 */
class ChunkManager {
    constructor(options = {}) {
        this.chunkCacheDir = options.chunkCacheDir || path.join(process.cwd(), 'chunks');
        this.fastCDC = new FastCDC(options.fastCDCOptions);
    }

    /**
     * Initialize chunk cache directory
     */
    async initialize() {
        await fs.mkdir(this.chunkCacheDir, { recursive: true });
    }

    /**
     * Get chunk file path from hash (with hash prefix directory)
     */
    getChunkPath(chunkHash) {
        const prefix = chunkHash.substring(0, 2);
        return path.join(this.chunkCacheDir, prefix, chunkHash);
    }

    /**
     * Store a chunk to disk
     */
    async storeChunk(chunkHash, chunkData) {
        const chunkPath = this.getChunkPath(chunkHash);
        const chunkDir = path.dirname(chunkPath);

        await fs.mkdir(chunkDir, { recursive: true });
        await fs.writeFile(chunkPath, chunkData);
        return true;
    }

    /**
     * Check if a chunk exists locally
     */
    async hasChunk(chunkHash) {
        const chunkPath = this.getChunkPath(chunkHash);
        try {
            await fs.access(chunkPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Retrieve a chunk from disk
     */
    async getChunk(chunkHash) {
        const chunkPath = this.getChunkPath(chunkHash);
        try {
            return await fs.readFile(chunkPath);
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    /**
     * Chunk a local file
     */
    async chunkLocalFile(filePath) {
        return await this.fastCDC.chunkFile(filePath);
    }

    /**
     * Reconstruct a file from chunks (optimized batch processing)
     */
    async reconstructFile(chunks, outputPath, onProgress = null) {
        const sortedChunks = [...chunks].sort((a, b) => (a.offset || 0) - (b.offset || 0));
        const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.size, 0);

        const writeStream = fsSync.createWriteStream(outputPath);
        let totalWritten = 0;
        const BATCH_SIZE = 50;

        return new Promise((resolve, reject) => {
            let currentIndex = 0;

            const processBatch = async () => {
                try {
                    while (currentIndex < sortedChunks.length) {
                        const batchEnd = Math.min(currentIndex + BATCH_SIZE, sortedChunks.length);
                        const batch = sortedChunks.slice(currentIndex, batchEnd);

                        const chunkDataPromises = batch.map(async (chunk) => {
                            if (chunk.data) return chunk.data;
                            const data = await this.getChunk(chunk.hash);
                            if (!data) throw new Error(`Missing chunk: ${chunk.hash}`);
                            return data;
                        });

                        const chunkDataArray = await Promise.all(chunkDataPromises);

                        for (const chunkData of chunkDataArray) {
                            if (!writeStream.write(chunkData)) {
                                await new Promise(resolve => writeStream.once('drain', resolve));
                            }
                            totalWritten += chunkData.length;
                        }

                        currentIndex = batchEnd;

                        if (onProgress && (currentIndex % 100 === 0 || currentIndex === sortedChunks.length)) {
                            onProgress({
                                chunksProcessed: currentIndex,
                                totalChunks: sortedChunks.length,
                                bytesWritten: totalWritten,
                                totalBytes: totalSize,
                                progress: (totalWritten / totalSize) * 100
                            });
                        }
                    }

                    writeStream.end();
                } catch (error) {
                    writeStream.destroy();
                    reject(error);
                }
            };

            writeStream.on('finish', () => resolve({
                path: outputPath,
                size: totalWritten,
                chunksUsed: sortedChunks.length
            }));

            writeStream.on('error', reject);
            processBatch();
        });
    }
}

module.exports = { FastCDC, ChunkManager };
