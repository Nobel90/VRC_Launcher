# VRC Launcher & Uploader - Project Documentation

## 1. Project Overview
The **VRC Launcher** is a specialized application designed to manage, update, and launch high-fidelity VR/Unreal Engine applications for VR Centre. It provides a seamless user experience for downloading large game files, ensuring clients always have the latest version, and managing local installations.

Accompanying it is the **VRC Uploader**, an internal tool used by administrators to prepare game builds, chunk large files for efficient storage, and upload updates to the cloud (Cloudflare R2).

## 2. Architecture

### 2.1 Launcher (Client Application)
Built with **Electron**, the Launcher runs on user machines (Windows).
*   **Main Process (`main.js`)**: Handles core logic, file system operations, process management (launching games), and download coordination.
*   **Renderer Process (`renderer.js`)**: Manages the UI, communicates with the main process via `preload.js` bridge, and displays real-time progress.
*   **Tech Stack**: Electron, HTML/CSS (Tailwind-like utility classes), Vanilla JS.

### 2.2 Uploader (Admin Tool)
Typically runs as a separate tool or development script, but integrated into the project structure.
*   **Core Logic (`uploader/src/services/`)**:
    *   **Chunking**: Uses **FastCDC** to split large files (PAKs) into content-defined chunks. This maximizes deduplication efficiency between updates.
    *   **Storage**: Uploads to **Cloudflare R2** (S3-compatible).
    *   **Delta Detection**: Only uploads chunks that do not already exist on the server.
*   **Tech Stack**: Node.js, FastCDC, AWS SDK (for R2).

### 2.3 Storage (Backend)
*   **Cloudflare R2**: Stores game files, chunks, and manifests.
*   **GitHub Releases**: Stores the Launcher's own updates (self-update mechanism via `latest.yml`).

## 3. Key Features

### 3.1 Efficient Update System (Chunk-Based)
Instead of downloading the entire game for every small update, the system uses **Content-Defined Chunking**:
1.  **Manifest Comparison**: Launcher compares local file chunks vs. server manifest.
2.  **Delta Download**: Only changed or missing chunks are downloaded.
3.  **File Reconstruction**: Chunks are reassembled into valid game files.

### 3.2 Robust Download Manager
*   **Resumable Downloads**: Can pause/resume or recover from network failures.
*   **Real-Time Metrics**: Displays accurate download speed (MB/s) and time remaining.
*   **Byte-Level Progress**: Progress bars reflect actual data transfer, not just file counts.

### 3.3 Active Game Detection
*   **PID Tracking**: The Launcher tracks the Process ID of the launched game.
*   **UI Integration**: The "Launch" button changes to **"APP RUNNING..."** and disables itself while the game is active.
*   **Auto-Reset**: Detects when the game exits (even if it wasn't launched by the launcher, if PID is known) and re-enables the UI.

### 3.4 Security & Integrity
*   **Code Signing**: All releases are digitally signed with a **Sectigo EV Certificate** (VR Centre Pty Ltd).
*   **Integrity Checks**: Verifies file sizes and checksums post-install to ensure data corruption hasn't occurred.

## 4. Developer Guide

### 4.1 Prerequisites
*   **Node.js** (v18+)
*   **Git**
*   **SafeNet Authentication Client** (for Code Signing if building release)

### 4.2 Setup
```bash
# Clone repository
git clone https://github.com/Nobel90/VRC_Launcher.git
cd VRC_Launcher

# Install dependencies
npm install

# Install Uploader dependencies
cd uploader
npm install
```

### 4.3 Running Locally
```bash
# Start the Launcher in Dev Mode
npm start
```

### 4.4 Build & Release
To create a production installer (`.exe`):

1.  **Version Bump**: Update `version` in `package.json`.
2.  **Code Signing**: Ensure your SafeNet USB token is plugged in.
3.  **Build Command**:
    *   **PowerShell**:
        ```powershell
        $env:CSC_NAME="VR Centre Pty Ltd"; npm run dist
        ```
    *   **Git Bash**:
        ```bash
        export CSC_NAME="VR Centre Pty Ltd" && npm run dist
        ```
    *   *Note: `forceCodeSigning` is enabled in `package.json`, so the build will fail if signing fails.*

4.  **Artifacts**: Check `dist/` for:
    *   `VRC-Launcher-Setup-X.Y.Z.exe` (Signed Installer)
    *   `latest.yml` (Required for auto-update)

### 4.5 Publishing an Update
1.  Go to **GitHub Releases**.
2.  Draft a new release (tag matched to `package.json`).
3.  Upload the signed `.exe` and `latest.yml`.
4.  Publish. Existing clients will detect the update on next launch.

## 5. Configuration Files

*   **`package.json`**:
    *   `build.publish`: Configures GitHub repo for auto-updates.
    *   `build.win`: NSIS target, Icon settings, `forceCodeSigning`.
*   **`vrclassroom_manifest.json`**: The server-side manifest defining the current game version and file structure.
*   **`version.json`**: Simple version pointer.

## 6. Common Issues & Debugging

*   **"App is not signed"**: Check USB token, SafeNet client, and that `CSC_NAME` matches the certificate Subject exactly. Use `DEBUG=electron-builder` for detailed logs.
*   **0 B/s Download**: Usually means the speed interval calculation logic is flawed (fixed in v1.0.4).
*   **Update Loop**: Check `latest.yml` on GitHub matches the installed version.
