const { exec } = require('child_process');

console.log('Checking for UE4 Prerequisites...');

function checkPrereqsInstalled() {
    return new Promise((resolve) => {
        // Check 64-bit and 32-bit registry keys
        // We use the exact same command as in main.js
        const cmd = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "UE4 Prerequisites" & reg query "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "UE4 Prerequisites"';

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                // error code 1 usually means not found in reg query
                console.log('Registry query command finished with error (expected if not found):', error.message);
            }

            console.log('--- Output ---');
            console.log(stdout);
            console.log('--------------');

            const found = stdout && (stdout.includes('UE4 Prerequisites') || stdout.includes('Unreal Engine Prerequisites'));
            resolve(!!found);
        });
    });
}

checkPrereqsInstalled().then(isInstalled => {
    if (isInstalled) {
        console.log('\n✅ RESULT: UE4 Prerequisites detected!');
    } else {
        console.log('\n❌ RESULT: UE4 Prerequisites NOT detected.');
    }
});
