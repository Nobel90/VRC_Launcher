// generate-manifest.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const gameRoot = './'; // Run this script from your game's root directory
const manifestVersion = '1.1.0.8'; // Change this for each new version
const baseUrl = `https://vrcentre.com.au/launcher_files/vrclassroom/${manifestVersion}`;

// --- Create a version file ---
const versionData = { version: manifestVersion };
fs.writeFileSync(path.join(gameRoot, 'version.json'), JSON.stringify(versionData, null, 2));
console.log('version.json created successfully!');

const textFileExtensions = ['.txt', '.ini', '.json'];

// --- ROBUST CHECKSUM FUNCTION ---
function getFileChecksum(filePath) {
    return new Promise((resolve, reject) => {
        const extension = path.extname(filePath).toLowerCase();

        if (textFileExtensions.includes(extension)) {
            fs.readFile(filePath, 'utf-8', (err, textData) => {
                if (err) return reject(err);
                // Trim BOM and normalize line endings for text files
                const normalizedText = textData.trim().replace(/\r\n/g, '\n');
                const hash = crypto.createHash('sha256').update(normalizedText).digest('hex');
                resolve(hash);
            });
        } else {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        }
    });
}

function getFilesRecursively(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let fileList = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // --- MORE ROBUST EXCLUSION ---
        // This will exclude any directory named 'Saved' anywhere in the tree.
        if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== 'saved') {
                fileList = fileList.concat(getFilesRecursively(fullPath));
            }
        } else if (entry.isFile()) {
            if (entry.name !== 'generate-manifest.js' && entry.name !== 'vrclassroom_manifest.json' && entry.name !== 'manifest.json') {
                 fileList.push(fullPath);
            }
        }
    }
    return fileList;
}

// --- ASYNC MAIN FUNCTION ---
async function createManifest() {
    const allFiles = getFilesRecursively(gameRoot);
    const manifestFiles = [];

    for (const filePath of allFiles) {
        const relativePath = path.relative(gameRoot, filePath).replace(/\\/g, '/');
        // Exclude the version file from the manifest itself
        if (relativePath === 'version.json') continue;

        const checksum = await getFileChecksum(filePath);
        manifestFiles.push({
            path: relativePath,
            checksum: checksum,
            url: `${baseUrl}/${relativePath}`
        });
    }

    const manifest = {
        version: manifestVersion,
        files: manifestFiles
    };

    fs.writeFileSync('vrclassroom_manifest.json', JSON.stringify(manifest, null, 2));
    console.log(`vrclassroom_manifest.json for version ${manifestVersion} created successfully!`);
}

createManifest().catch(console.error);