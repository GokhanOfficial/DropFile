const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');

const PORT = parseInt(process.env.PORT, 10) || 9392;
const TMPFILES_UPLOAD_HOST = 'tmpfiles.org';
const TMPFILES_UPLOAD_PATH = '/api/v1/upload';
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
const ID_LENGTH = 12;    // bytes -> ~16 url-safe base64 chars

function generateId() {
    return crypto.randomBytes(ID_LENGTH).toString('base64url');
}

function getMetadataPath(id) {
    return path.join(DATA_DIR, `${id}.json`);
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
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
        return { record: null, expired: false };
    }
    try {
        const payload = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        const expired = Date.now() > payload.expiresAt;
        // Note: expired records are NOT deleted here; the background TTL
        // cleanup task below handles removal. Returning expired state lets
        // endpoints show a dedicated "expired" message instead of a 404.
        return {
            record: {
                ...payload,
                key: Buffer.from(payload.key, 'base64'),
                iv: Buffer.from(payload.iv, 'base64')
            },
            expired
        };
    } catch (err) {
        console.error(`Failed to load metadata for ${id}:`, err);
        return { record: null, expired: false };
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

function serveStaticFile(filePath, res, req) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                renderNotFoundPage(res, {
                    title: 'Sayfa Bulunamadı',
                    message: 'Aradığınız sayfa mevcut değil veya taşınmış olabilir.',
                    iconName: 'compass',
                    reasons: null
                });
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain', ...setSecurityHeaders('text/plain') });
                res.end(`Server Error: ${err.code}`);
            }
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        // Inject Open Graph / Twitter metadata placeholders for the homepage
        // so social shares resolve to absolute URLs (crawlers don't run JS).
        if (filePath.endsWith('index.html') && req) {
            const protocol = req.headers['x-forwarded-proto'] || 'http';
            const host = req.headers.host || `localhost:${PORT}`;
            const base = `${protocol}://${host}`;
            data = Buffer.from(data.toString('utf-8')
                .replace(/\{\{OG_URL\}\}/g, base + '/')
                .replace(/\{\{OG_IMAGE\}\}/g, base + '/preview.png'));
        }

        res.writeHead(200, {
            'Content-Type': contentType,
            ...setSecurityHeaders(contentType)
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

    const busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_FILE_SIZE },
        defParamCharset: 'utf8' // decode multipart field values (incl. filename) as UTF-8
    });

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

function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve({ statusCode: res.statusCode, headers: res.headers, buffer });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
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

    return httpsRequest({
        hostname: TMPFILES_UPLOAD_HOST,
        path: TMPFILES_UPLOAD_PATH,
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
        }
    }, body).then(response => {
        const text = response.buffer.toString('utf-8');
        return { response: { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode }, text };
    });
}

function downloadFromTmpfiles(url) {
    const parsed = new URL(url);
    return httpsRequest({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET'
    }, null).then(response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Tmpfiles download failed: ${response.statusCode}`);
        }
        return response.buffer;
    });
}

function jsonResponse(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...setSecurityHeaders('application/json')
    });
    res.end(JSON.stringify(data));
}

// Centralized security headers. CSP is only attached to HTML responses
// (inline scripts/styles in the app require 'unsafe-inline').
function setSecurityHeaders(contentType) {
    const headers = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    if (contentType && contentType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data:",
            "connect-src 'self'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ');
    }
    return headers;
}

// Reusable branded "not found" / "expired" page. Defaults to the
// file-not-found variant; pass opts to render the expired or generic-404
// variant. Avoids duplicating the HTML across the /f/:id and static 404 paths.
function renderNotFoundPage(res, opts = {}) {
    const {
        statusCode = 404,
        title = 'Dosya Bulunamadı',
        message = 'Dosya süresi dolmuş veya silinmiş olabilir.',
        iconName = 'file-x-2',
        reasons = [
            { icon: 'clock', text: 'Seçilen saklama süresi dolmuş olabilir' },
            { icon: 'trash-2', text: 'Dosya kalıcı olarak silinmiş olabilir' },
            { icon: 'link-2-off', text: 'Link hatalı veya eksik olabilir' }
        ]
    } = opts;

    const reasonsHtml = Array.isArray(reasons) && reasons.length
        ? `<ul class="not-found-reasons">${reasons.map(r => `
            <li>
                <i data-lucide="${r.icon}"></i>
                <span>${r.text}</span>
            </li>`).join('')}
        </ul>`
        : '';

    res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        ...setSecurityHeaders('text/html')
    });
    res.end(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title} | DropFile</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
            <script src="https://unpkg.com/lucide@1.21.0" crossorigin="anonymous"></script>
            <link rel="stylesheet" href="/css/style.css">
        </head>
        <body>
            <div class="bg-glow bg-glow-1"></div>
            <div class="bg-glow bg-glow-2"></div>
            <main class="app-container">
                <header class="app-header">
                    <a href="/" class="logo" aria-label="DropFile ana sayfa">
                        <i data-lucide="cloud-lightning" class="logo-icon"></i>
                        <span class="logo-text">DropFile</span>
                    </a>
                    <p class="tagline">Geçici ve şifreli dosya paylaşım servisi</p>
                </header>

                <section class="card not-found-card">
                    <div class="not-found-icon-circle">
                        <i data-lucide="${iconName}" class="not-found-icon"></i>
                    </div>
                    <h1 class="not-found-title">${title}</h1>
                    <p class="not-found-message">${message}</p>

                    ${reasonsHtml}

                    <a href="/" class="btn btn-primary btn-home">
                        <i data-lucide="home"></i> Ana Sayfaya Dön
                    </a>

                    <p class="security-note">
                        <i data-lucide="shield-check" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 4px;"></i>
                        Güvenliğiniz için dosyalar belirli süre sonunda otomatik olarak silinir.
                    </p>
                </section>

                <footer class="app-footer">
                    <p>&copy; 2026 DropFile. Tüm hakları saklıdır.</p>
                    <p class="footer-note">Dosyalar saklama süresi sonunda sistemden kalıcı olarak silinir.</p>
                </footer>
            </main>
            <script>lucide.createIcons();</script>
        </body>
        </html>
    `);
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
                                message: 'Dosya yüklenemedi: ' + text
                            });
                            return;
                        }
                        let parsed;
                        try {
                            parsed = JSON.parse(text);
                        } catch (e) {
                            jsonResponse(res, 502, {
                                status: 'error',
                                message: 'Sunucudan geçersiz yanıt alındı'
                            });
                            return;
                        }

                        if (!parsed.data || !parsed.data.url) {
                            jsonResponse(res, 502, {
                                status: 'error',
                                message: 'Sunucu yanıtı eksik'
                            });
                            return;
                        }

                        const remoteUrl = parsed.data.url;
                        const remoteDirectUrl = remoteUrl.replace(
                            'https://tmpfiles.org/',
                            'https://tmpfiles.org/dl/'
                        );

                        const now = Date.now();
                        const record = {
                            key: encrypted.key,
                            iv: encrypted.iv,
                            originalName: fileInfo.originalName,
                            mimeType: fileInfo.mimeType,
                            remoteUrl: remoteDirectUrl,
                            size: fileInfo.buffer.length,
                            createdAt: now,
                            expiresAt: now + ttlSeconds * 1000
                        };
                        saveFileRecord(id, record);

                        const protocol = req.headers['x-forwarded-proto'] || 'http';
                        const host = req.headers.host || `localhost:${PORT}`;
                        const directUrl = `${protocol}://${host}/d/${id}`;
                        const previewUrl = `${protocol}://${host}/f/${id}`;

                        jsonResponse(res, 200, {
                            status: 'success',
                            data: {
                                id,
                                directUrl,
                                previewUrl,
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

    // Short download endpoint /d/:id (also keep /api/download/:id for backwards compatibility)
    const shortDownloadMatch = urlPath.match(/^\/d\/([A-Za-z0-9_-]+)$/);
    const apiDownloadMatch = urlPath.match(/^\/api\/download\/([A-Za-z0-9_-]+)$/);
    if ((shortDownloadMatch || apiDownloadMatch) && req.method === 'GET') {
        const id = (shortDownloadMatch || apiDownloadMatch)[1];
        const { record, expired } = loadFileRecord(id);
        if (expired) {
            jsonResponse(res, 404, {
                status: 'error',
                message: 'Bu dosyanın süresi dolmuş'
            });
            return;
        }
        if (!record) {
            jsonResponse(res, 404, {
                status: 'error',
                message: 'File not found or expired'
            });
            return;
        }

        downloadFromTmpfiles(record.remoteUrl)
            .then(encryptedBuffer => {
                try {
                    const decrypted = decryptBuffer(encryptedBuffer, record.key, record.iv);
                    // Strip CRLF to prevent header injection; RFC 5987 filename*
                    // carries UTF-8 names safely for modern browsers.
                    const safeName = (record.originalName || 'file').replace(/[\r\n]+/g, ' ').trim();
                    const encodedName = encodeURIComponent(safeName);
                    res.writeHead(200, {
                        'Content-Type': record.mimeType || 'application/octet-stream',
                        'Content-Length': decrypted.length,
                        'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
                        ...setSecurityHeaders(record.mimeType)
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

    // Preview page endpoint /f/:id
    const previewMatch = urlPath.match(/^\/f\/([A-Za-z0-9_-]+)$/);
    if (previewMatch && req.method === 'GET') {
        const id = previewMatch[1];
        const { record, expired } = loadFileRecord(id);
        if (expired) {
            renderNotFoundPage(res, {
                title: 'Süresi Dolmuş',
                message: 'Bu dosyanın saklama süresi dolduğu için artık erişilemez.',
                iconName: 'timer-off',
                reasons: [
                    { icon: 'clock', text: 'Seçilen saklama süresi dolmuş' },
                    { icon: 'trash-2', text: 'Dosya yakında kalıcı olarak silinecek' }
                ]
            });
            return;
        }
        if (!record) {
            renderNotFoundPage(res);
            return;
        }

        const remainingMs = record.expiresAt - Date.now();
        const remainingText = `~${Math.ceil(remainingMs / (1000 * 60 * 60))} saat`;

        const downloadLink = `/d/${id}`;
        const safeName = record.originalName
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            ...setSecurityHeaders('text/html')
        });
        res.end(`
            <!DOCTYPE html>
            <html lang="tr">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${safeName} | DropFile</title>
                <link rel="preconnect" href="https://fonts.googleapis.com">
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
                <script src="https://unpkg.com/lucide@1.21.0" crossorigin="anonymous"></script>
                <link rel="stylesheet" href="/css/style.css">
            </head>
            <body>
                <div class="bg-glow bg-glow-1"></div>
                <div class="bg-glow bg-glow-2"></div>
                <main class="app-container">
                    <header class="app-header">
                        <a href="/" class="logo" aria-label="DropFile ana sayfa">
                            <i data-lucide="cloud-lightning" class="logo-icon"></i>
                            <span class="logo-text">DropFile</span>
                        </a>
                        <p class="tagline">Geçici ve şifreli dosya paylaşım servisi</p>
                    </header>

                    <section class="card preview-card">
                        <div class="preview-icon-circle">
                            <i data-lucide="file-lock-2" class="preview-icon"></i>
                        </div>
                        <h1 class="preview-filename">${safeName}</h1>

                        <div class="preview-meta">
                            <div class="meta-item">
                                <i data-lucide="hard-drive"></i>
                                <span>${formatBytes(record.size)}</span>
                            </div>
                            <div class="meta-item">
                                <i data-lucide="file-type"></i>
                                <span>${record.mimeType}</span>
                            </div>
                            <div class="meta-item">
                                <i data-lucide="clock"></i>
                                <span>${remainingText} içinde silinecek</span>
                            </div>
                        </div>

                        <a href="${downloadLink}" class="btn btn-primary btn-download">
                            <i data-lucide="download"></i> Dosyayı İndir
                        </a>

                        <p class="security-note">
                            <i data-lucide="lock" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 4px;"></i>
                            Dosya uçtan uca şifreli olarak tutulur; indirme sırasında güvenli şekilde çözülür.
                        </p>
                    </section>

                    <footer class="app-footer">
                        <p>&copy; 2026 DropFile. Tüm hakları saklıdır.</p>
                        <p class="footer-note">Dosyalar saklama süresi sonunda sistemden kalıcı olarak silinir.</p>
                    </footer>
                </main>
                <script>lucide.createIcons();</script>
            </body>
            </html>
        `);
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

    serveStaticFile(filePath, res, req);
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
