// test_download_urls.js
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const manifestPath = path.join(__dirname, 'vrclassroom_manifest.json');

async function checkUrl(fileInfo) {
    try {
        const response = await axios.head(fileInfo.url);
        if (response.status >= 200 && response.status < 300) {
            console.log(`[  OK  ] ${fileInfo.path}`);
            return true;
        } else {
            console.error(`[ FAILED ] ${fileInfo.path} (Status: ${response.status})`);
            return false;
        }
    } catch (error) {
        console.error(`[ ERROR ] ${fileInfo.path} (Error: ${error.message})`);
        return false;
    }
}

async function runTest() {
    console.log(`--- Starting URL Accessibility Test ---`);
    console.log(`Reading manifest from: ${manifestPath}\n`);

    try {
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestData);

        if (!manifest.files || manifest.files.length === 0) {
            console.error('Manifest file is empty or does not contain a "files" array.');
            return;
        }

        const results = await Promise.all(manifest.files.map(checkUrl));
        
        const successful = results.filter(r => r).length;
        const failed = results.length - successful;

        console.log(`\n--- Test Complete ---`);
        console.log(`Total Files Checked: ${results.length}`);
        console.log(`Successful: ${successful}`);
        console.log(`Failed: ${failed}`);

        if (failed > 0) {
            console.log('\nSome URLs were not accessible. Please check the errors above.');
        } else {
            console.log('\nAll URLs are accessible!');
        }

    } catch (error) {
        console.error(`Failed to read or parse the manifest file: ${error.message}`);
    }
}

runTest();
