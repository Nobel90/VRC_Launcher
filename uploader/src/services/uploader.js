// uploader.js - R2 Upload Service

const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class UploaderService {
    constructor(config) {
        this.config = config;
        this.client = new S3Client({
            region: 'auto',
            endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
        });
        this.bucketName = config.bucketName;
    }

    /**
     * Test connection to R2
     */
    async testConnection() {
        try {
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Upload a Buffer directly to R2 with retry logic
     */
    async uploadBuffer(buffer, key, contentType = 'application/octet-stream', maxRetries = 3) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const command = new PutObjectCommand({
                    Bucket: this.bucketName,
                    Key: key,
                    Body: buffer,
                    ContentType: contentType,
                });

                await this.client.send(command);
                return { success: true, key };
            } catch (error) {
                lastError = error;
                console.log(`Upload attempt ${attempt}/${maxRetries} failed for ${key}: ${error.message}`);

                if (attempt < maxRetries) {
                    // Exponential backoff: 2s, 4s, 8s
                    const delay = Math.pow(2, attempt) * 1000;
                    console.log(`Retrying in ${delay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    /**
     * Upload a file from disk to R2
     */
    async uploadFile(filePath, key, progressCallback) {
        const content = await fs.readFile(filePath);
        return this.uploadBuffer(content, key);
    }

    /**
     * Upload string content to R2
     */
    async uploadContent(content, key, contentType = 'application/json') {
        return this.uploadBuffer(Buffer.from(content), key, contentType);
    }
}

module.exports = { UploaderService };
