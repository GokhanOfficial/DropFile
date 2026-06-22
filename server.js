const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');
const fetch = require('node-fetch');
const { Readable } = require('stream');

const PORT = 9392;
const TMPFILES_UPLOAD_URL = 'https://tmpfiles.org/api/v1/upload';
const DATA_DIR = path.join(__dirname, 'data');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject'
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// Ensure data directory exists for persistent file metadata store
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// AES-256-GCM encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;   // bytes
const IV_LENGTH = 16;    // bytes
const TAG_LENGTH = 16;   // bytes
const ID_LENGTH = 24;    // bytes

function generateId() {
    return crypto.randomBytes(ID_LENGTH)
        .toString('base64url')
        .slice(0, ID_LENGTH);
}

function getMetadataPath(id) {
    return path.join(DATA_DIR, `${id}.json`);
}

function saveFileRecord(id, record) {
    const payload = {
        ...record,
        key: record.key.toString('base64'),
        iv: record.iv.toString('base64')
    };
    fs.writeFileSync(getMetadataPath(id), JSON.stringify(payload, null, 2));
}

function loadFileRecord(id) {
    const metadataPath = getMetadataPath(id);
    if (!fs.existsSync(metadataPath)) {
        return null;
    }
    try {
        const payload = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        if (Date.now() > payload.expiresAt) {
            deleteFileRecord(id);
            return null;
        }
        return {
            ...payload,
            key: Buffer.from(payload.key, 'base64'),
            iv: Buffer.from(payload.iv, 'base64')
        };
    } catch (err) {
        console.error(`Failed to load metadata for ${id}:`, err);
        return null;
    }
}

function deleteFileRecord(id) {
    try {
        fs.unlinkSync(getMetadataPath(id));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Failed to delete metadata for ${id}:`, err);
        }
    }
}

function encryptBuffer(buffer) {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv (16) + tag (16) + encryptedPayload
    return { encrypted: Buffer.concat([iv, tag, encrypted]), key, iv };
}

function decryptBuffer(encrypted, key, iv) {
    if (encrypted.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error('Invalid encrypted payload');
    }
    const storedIv = encrypted.slice(0, IV_LENGTH);
    const tag = encrypted.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const payload = encrypted.slice(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, storedIv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function getPublicFilePath(urlPath) {
    const publicDir = path.join(__dirname, 'public');
    let safeUrl = urlPath.split('?')[0]; // strip query string
    if (safeUrl === '/') {
        safeUrl = '/index.html';
    }
    const filePath = path.join(publicDir, safeUrl);
    if (!filePath.startsWith(publicDir)) {
        return null;
    }
    return filePath;
}

function serveStaticFile(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Server Error: ${err.code}`);
            }
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        });
        res.end(data);
    });
}

function parseMultipart(req, res, callback) {
    let fileBuffer = Buffer.alloc(0);
    let expireSeconds = '3600';
    let originalName = 'file';
    let mimeType = 'application/octet-stream';
    let fileSize = 0;
    let exceeded = false;

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });

    busboy.on('file', (fieldname, file, info) => {
        originalName = info.filename || originalName;
        mimeType = info.mimeType || mimeType;
        file.on('data', (data) => {
            if (exceeded) return;
            fileSize += data.length;
            if (fileSize > MAX_FILE_SIZE) {
                exceeded = true;
                file.resume();
                return;
            }
            fileBuffer = Buffer.concat([fileBuffer, data]);
        });
    });

    busboy.on('field', (fieldname, value) => {
        if (fieldname === 'expire') {
            expireSeconds = value || expireSeconds;
        }
    });

    busboy.on('error', (err) => {
        callback(err);
    });

    busboy.on('finish', () => {
        if (exceeded || fileSize > MAX_FILE_SIZE) {
            callback(new Error('File too large'));
            return;
        }
        callback(null, { buffer: fileBuffer, expireSeconds, originalName, mimeType });
    });

    req.pipe(busboy);
}

function uploadToTmpfiles(buffer, originalName) {
    const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
    const metadata = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${originalName}.enc"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
        'utf-8'
    );
    const ending = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([metadata, buffer, ending]);

    return fetch(TMPFILES_UPLOAD_URL, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: Readable.from([body])
    }).then(response => response.text().then(text => ({ response, text })));
}

function jsonResponse(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];

    // Upload endpoint
    if (urlPath === '/api/upload' && req.method === 'POST') {
        parseMultipart(req, res, (err, fileInfo) => {
            if (err) {
                jsonResponse(res, 400, { status: 'error', message: err.message });
                return;
            }

            try {
                const encrypted = encryptBuffer(fileInfo.buffer);
                const id = generateId();

                let ttlSeconds = parseInt(fileInfo.expireSeconds, 10);
                if (isNaN(ttlSeconds) || ttlSeconds <= 0) {
                    ttlSeconds = 3600;
                }

                uploadToTmpfiles(encrypted.encrypted, fileInfo.originalName)
                    .then(({ response, text }) => {
                        if (!response.ok) {
                            jsonResponse(res, 502, {
                                status: 'error',
                                message: 'Tmpfiles upload failed: ' + text
                            });
                            return;
                        }
                        let parsed;
                        try {
                            parsed = JSON.parse(text);
                        } catch (e) {
                            jsonResponse(res, 502, {
                                status: 'error',
                                message: 'Invalid response from tmpfiles'
                            });
                            return;
                        }

                        if (!parsed.data || !parsed.data.url) {
                            jsonResponse(res, 502, {
                                status: 'error',
                                message: 'Tmpfiles response missing URL'
                            });
                            return;
                        }

                        const remoteUrl = parsed.data.url;
                        const directUrl = remoteUrl.replace(
                            'https://tmpfiles.org/',
                            'https://tmpfiles.org/dl/'
                        );

                        const now = Date.now();
                        const record = {
                            key: encrypted.key,
                            iv: encrypted.iv,
                            originalName: fileInfo.originalName,
                            mimeType: fileInfo.mimeType,
                            remoteUrl: directUrl,
                            size: fileInfo.buffer.length,
                            createdAt: now,
                            expiresAt: now + ttlSeconds * 1000
                        };
                        saveFileRecord(id, record);

                        const protocol = req.headers['x-forwarded-proto'] || 'http';
                        const host = req.headers.host || `localhost:${PORT}`;
                        const downloadUrl = `${protocol}://${host}/api/download/${id}`;

                        jsonResponse(res, 200, {
                            status: 'success',
                            data: {
                                id,
                                url: downloadUrl,
                                expiresIn: ttlSeconds
                            }
                        });
                    })
                    .catch(err => {
                        console.error('Upload to tmpfiles failed:', err);
                        jsonResponse(res, 502, {
                            status: 'error',
                            message: 'Failed to upload encrypted file'
                        });
                    });
            } catch (err) {
                console.error('Encryption failed:', err);
                jsonResponse(res, 500, {
                    status: 'error',
                    message: 'Encryption failed'
                });
            }
        });
        return;
    }

    // Download endpoint
    const downloadMatch = urlPath.match(/^\/api\/download\/([A-Za-z0-9_-]+)$/);
    if (downloadMatch && req.method === 'GET') {
        const id = downloadMatch[1];
        const record = loadFileRecord(id);
        if (!record) {
            jsonResponse(res, 404, {
                status: 'error',
                message: 'File not found or expired'
            });
            return;
        }

        fetch(record.remoteUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Tmpfiles download failed: ' + response.status);
                }
                return response.buffer();
            })
            .then(encryptedBuffer => {
                try {
                    const decrypted = decryptBuffer(encryptedBuffer, record.key, record.iv);
                    res.writeHead(200, {
                        'Content-Type': record.mimeType || 'application/octet-stream',
                        'Content-Length': decrypted.length,
                        'Content-Disposition': `attachment; filename="${encodeURIComponent(record.originalName)}"`,
                        'X-Content-Type-Options': 'nosniff'
                    });
                    res.end(decrypted);
                } catch (err) {
                    console.error('Decryption failed:', err);
                    jsonResponse(res, 500, {
                        status: 'error',
                        message: 'Failed to decrypt file'
                    });
                }
            })
            .catch(err => {
                console.error('Download from tmpfiles failed:', err);
                jsonResponse(res, 502, {
                    status: 'error',
                    message: 'Failed to fetch encrypted file'
                });
            });
        return;
    }

    // Static files (GET only)
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
    }

    const filePath = getPublicFilePath(req.url);
    if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    serveStaticFile(filePath, res);
});

// Background TTL cleanup every minute: remove expired metadata files
setInterval(() => {
    const now = Date.now();
    try {
        const files = fs.readdirSync(DATA_DIR);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const id = file.slice(0, -5);
            const metadataPath = path.join(DATA_DIR, file);
            try {
                const payload = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                if (now > payload.expiresAt) {
                    fs.unlinkSync(metadataPath);
                }
            } catch (err) {
                console.error('Error during TTL cleanup:', err);
            }
        }
    } catch (err) {
        console.error('Failed to read data directory:', err);
    }
}, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
