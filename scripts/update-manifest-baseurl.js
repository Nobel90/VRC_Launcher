/**
 * Manifest URL Converter Utility
 * 
 * Converts existing manifests with individual file URLs to the new baseUrl format.
 * 
 * Usage:
 *   node scripts/update-manifest-baseurl.js <input-manifest> <base-url> [output-manifest]
 * 
 * Example:
 *   node scripts/update-manifest-baseurl.js vrclassroom_manifest.json "https://bucket.r2.dev/vrcentre/vrclassroom/1.1.0.8"
 */

const fs = require('fs');
const path = require('path');

function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log('Usage: node update-manifest-baseurl.js <input-manifest> <base-url> [output-manifest]');
        console.log('');
        console.log('Arguments:');
        console.log('  input-manifest   Path to the existing manifest JSON file');
        console.log('  base-url         The new base URL for all files');
        console.log('  output-manifest  Optional. Output file path (defaults to overwriting input)');
        console.log('');
        console.log('Example:');
        console.log('  node scripts/update-manifest-baseurl.js vrclassroom_manifest.json "https://bucket.r2.dev/vrcentre/vrclassroom/1.1.0.8"');
        process.exit(1);
    }

    const inputPath = args[0];
    const baseUrl = args[1].replace(/\/$/, ''); // Remove trailing slash if present
    const outputPath = args[2] || inputPath;

    // Read the input manifest
    let manifest;
    try {
        const content = fs.readFileSync(inputPath, 'utf-8');
        manifest = JSON.parse(content);
    } catch (error) {
        console.error(`Error reading manifest: ${error.message}`);
        process.exit(1);
    }

    // Add baseUrl
    manifest.baseUrl = baseUrl;

    // Remove individual URLs from files (optional - keeps them for backward compat)
    // Uncomment the following to strip individual URLs:
    /*
    manifest.files = manifest.files.map(file => {
        const { url, ...rest } = file;
        return rest;
    });
    */

    // For now, just add baseUrl without removing individual URLs
    // This provides maximum backward compatibility

    // Write the output
    try {
        fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
        console.log(`✅ Manifest updated successfully!`);
        console.log(`   Base URL: ${baseUrl}`);
        console.log(`   Files: ${manifest.files.length}`);
        console.log(`   Output: ${outputPath}`);
    } catch (error) {
        console.error(`Error writing manifest: ${error.message}`);
        process.exit(1);
    }
}

main();
