const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

// Mock implementation of the scan function for testing node logic
async function scanForInstallations(rootPath) {
    console.log(`Scanning root: ${rootPath}`);
    const results = [];
    const executableName = 'VRClassroom.exe';

    async function scanDir(currentPath, depth = 0) {
        if (depth > 4) return;

        try {
            const dirents = await fs.readdir(currentPath, { withFileTypes: true });

            const hasExecutable = dirents.some(dirent => dirent.isFile() && dirent.name.toLowerCase() === executableName.toLowerCase());

            if (hasExecutable) {
                console.log(`Found installation at: ${currentPath}`);
                let version = 'Unknown';
                const versionPath = path.join(currentPath, 'version.json');
                if (fsSync.existsSync(versionPath)) {
                    try {
                        const versionData = JSON.parse(await fs.readFile(versionPath, 'utf-8'));
                        version = versionData.version || 'Unknown';
                    } catch (e) { }
                }

                results.push({
                    path: currentPath,
                    version: version
                });
                return;
            }

            for (const dirent of dirents) {
                if (dirent.isDirectory()) {
                    const name = dirent.name.toLowerCase();
                    if (name === 'node_modules' || name === 'windows' || name === 'program files' || name === 'program files (x86)' || name.startsWith('.')) {
                        continue;
                    }
                    await scanDir(path.join(currentPath, dirent.name), depth + 1);
                }
            }
        } catch (error) {
            // ignore
        }
    }

    await scanDir(rootPath);
    return results;
}

// Setup a test environment
async function runTest() {
    const testDir = path.join(__dirname, 'test_scan_env');
    const install1 = path.join(testDir, 'Install_1.0.0');
    const install2 = path.join(testDir, 'Subfolder', 'Install_1.0.1');
    const emptyDir = path.join(testDir, 'Empty');

    // Clean up previous runs
    if (fsSync.existsSync(testDir)) {
        fsSync.rmSync(testDir, { recursive: true, force: true });
    }

    // Create directories
    await fs.mkdir(install1, { recursive: true });
    await fs.mkdir(install2, { recursive: true });
    await fs.mkdir(emptyDir, { recursive: true });

    // Create dummy EXE
    await fs.writeFile(path.join(install1, 'VRClassroom.exe'), 'dummy content');
    await fs.writeFile(path.join(install1, 'version.json'), JSON.stringify({ version: '1.0.0' }));

    await fs.writeFile(path.join(install2, 'VRClassroom.exe'), 'dummy content');
    // install2 has no version.json to test Unknown

    console.log('Test environment created at:', testDir);

    // Run Scan
    const results = await scanForInstallations(testDir);

    console.log('\nResults:', JSON.stringify(results, null, 2));

    // Cleanup
    fsSync.rmSync(testDir, { recursive: true, force: true });
    console.log('\nTest environment cleaned up.');
}

runTest();
