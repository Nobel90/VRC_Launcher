// packagePrep.js
// Package preparation - chunk files and generate manifest

const fs = require('fs').promises;
const path = require('path');
const { ChunkManager } = require('./chunkManager');
const { createChunkManifest } = require('./manifestUtils');

/**
 * Filter out non-essential files
 */
function shouldIncludeFile(relativePath, filters = {}) {
    const fileName = path.basename(relativePath);
    const pathString = relativePath.toLowerCase();
    const fileExt = path.extname(fileName).toLowerCase();

    // Exclude Saved folders
    if (filters.excludeSaved !== false) {
        if (pathString.includes('saved/') || pathString.includes('saved\\')) {
            return false;
        }
    }

    // Exclude .pdb files
    if (filters.excludePdb !== false && fileExt === '.pdb') {
        return false;
    }

    // Exclude system files
    const isManifest = fileName.toLowerCase().startsWith('manifest_') && fileName.endsWith('.txt');
    const isVersionJson = fileName.toLowerCase() === 'version.json';
    const isLauncher = fileName.toLowerCase().includes('launcher.exe');

    return !(isManifest || isVersionJson || isLauncher);
}

/**
 * Recursively get all files from directory
 */
async function getAllFiles(dir) {
    const files = [];

    async function walkDir(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(dir, fullPath);

            if (entry.isDirectory()) {
                await walkDir(fullPath);
            } else {
                files.push({ fullPath, relativePath });
            }
        }
    }

    await walkDir(dir);
    return files;
}

/**
 * Generate chunk-based manifest from source directory
 */
async function generateManifest(options, onProgress = null) {
    const {
        sourceDir,
        outputDir,
        gameName,
        version,
        buildType = 'release',
        chunkSizes = {
            min: 5 * 1024 * 1024,   // 5MB
            avg: 10 * 1024 * 1024,  // 10MB
            max: 20 * 1024 * 1024   // 20MB
        },
        filters = {}
    } = options;

    // Validate
    if (!sourceDir || !outputDir || !version || !gameName) {
        throw new Error('Missing required options: sourceDir, outputDir, gameName, version');
    }

    // Check source exists
    await fs.access(sourceDir);

    // Create output directories
    await fs.mkdir(outputDir, { recursive: true });
    const chunksDir = path.join(outputDir, 'chunks');
    await fs.mkdir(chunksDir, { recursive: true });

    // Initialize chunk manager
    const chunkManager = new ChunkManager({
        chunkCacheDir: chunksDir,
        fastCDCOptions: {
            minSize: chunkSizes.min,
            avgSize: chunkSizes.avg,
            maxSize: chunkSizes.max
        }
    });
    await chunkManager.initialize();

    // Get all files
    if (onProgress) onProgress({ percentage: 0, message: 'Scanning files...' });

    const allFiles = await getAllFiles(sourceDir);
    const filesToProcess = allFiles.filter(({ relativePath }) =>
        shouldIncludeFile(relativePath, filters)
    );

    if (filesToProcess.length === 0) {
        throw new Error('No files found to process');
    }

    if (onProgress) {
        onProgress({ percentage: 5, message: `Found ${filesToProcess.length} files` });
    }

    // Process files
    const processedFiles = [];
    let totalChunks = 0;
    let totalSize = 0;
    const uniqueChunks = new Set();

    for (let i = 0; i < filesToProcess.length; i++) {
        const { fullPath, relativePath } = filesToProcess[i];

        try {
            const stats = await fs.stat(fullPath);
            const fileSize = stats.size;

            if (onProgress) {
                const percentage = 5 + ((i / filesToProcess.length) * 85);
                const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
                onProgress({
                    percentage,
                    message: `Processing ${relativePath} (${sizeMB} MB)`,
                    currentFile: i + 1,
                    totalFiles: filesToProcess.length
                });
            }

            // Chunk the file
            const chunks = await chunkManager.fastCDC.chunkFile(fullPath);

            // Store chunks and build file entry
            const fileChunks = [];

            for (const chunk of chunks) {
                // Store chunk (deduplication)
                if (!uniqueChunks.has(chunk.hash)) {
                    await chunkManager.storeChunk(chunk.hash, chunk.data);
                    uniqueChunks.add(chunk.hash);
                }

                fileChunks.push({
                    hash: chunk.hash,
                    size: chunk.size,
                    offset: chunk.offset
                });
            }

            processedFiles.push({
                filename: relativePath.replace(/\\/g, '/'),
                totalSize: fileSize,
                chunks: fileChunks
            });

            totalChunks += chunks.length;
            totalSize += fileSize;

        } catch (error) {
            console.error(`Error processing ${relativePath}:`, error);
        }
    }

    // Create manifest
    if (onProgress) onProgress({ percentage: 90, message: 'Creating manifest...' });

    const manifest = createChunkManifest(version, gameName, buildType, processedFiles);

    // Save manifest
    const manifestFilename = `manifest_${buildType}_${version}.json`;
    const manifestPath = path.join(outputDir, manifestFilename);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Save version file
    const versionPath = path.join(outputDir, 'version.json');
    await fs.writeFile(versionPath, JSON.stringify({ version }, null, 2), 'utf-8');

    if (onProgress) onProgress({ percentage: 100, message: 'Complete!' });

    return {
        success: true,
        manifestPath,
        versionPath,
        chunksDir,
        stats: {
            filesProcessed: processedFiles.length,
            totalChunks,
            uniqueChunks: uniqueChunks.size,
            totalSize,
            deduplicationRatio: totalChunks > 0
                ? ((uniqueChunks.size / totalChunks) * 100).toFixed(1) + '%'
                : '100%'
        }
    };
}

module.exports = { generateManifest, shouldIncludeFile, getAllFiles };
