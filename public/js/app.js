document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();

    // DOM Elements
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const selectBtn = document.getElementById('select-btn');
    const expireSelect = document.getElementById('expire-select');

    const uploadStep = document.getElementById('upload-step');
    const progressStep = document.getElementById('progress-step');
    const successStep = document.getElementById('success-step');

    const progressCounter = document.getElementById('progress-counter');
    const progressFileName = document.getElementById('progress-file-name');
    const progressFileSize = document.getElementById('progress-file-size');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressPercent = document.getElementById('progress-percent');
    const progressSpeed = document.getElementById('progress-speed');
    const cancelBtn = document.getElementById('cancel-btn');

    const expireNotice = document.getElementById('expire-notice');
    const resultsList = document.getElementById('results-list');
    const qrSection = document.getElementById('qr-section');
    const copyAllBtn = document.getElementById('copy-all-btn');
    const resetBtn = document.getElementById('reset-btn');
    const qrCanvas = document.getElementById('qr-code');

    // Maximum file size: 100 MB (in bytes)
    const MAX_FILE_SIZE = 100 * 1024 * 1024;

    // Upload queue state
    let uploadQueue = [];        // validated files awaiting upload
    let uploadIndex = 0;         // index of currently uploading file
    let results = [];            // completed uploads: {name, size, directUrl, previewUrl}
    let currentXHR = null;
    let uploadStartTime = 0;
    let cancelled = false;

    /* ==========================================================================
       TOAST NOTIFICATIONS
       ========================================================================== */
    function showToast(message, type = 'error') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const iconName = type === 'success' ? 'check-circle' : 'alert-circle';
        toast.innerHTML = `<i data-lucide="${iconName}"></i><span>${escapeHtml(message)}</span>`;
        container.appendChild(toast);
        lucide.createIcons();
        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 200);
        }, 4000);
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ==========================================================================
       DRAG AND DROP HANDLERS
       ========================================================================== */
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        }, false);
    });

    // Drop handler
    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFilesSelection(files);
        }
    });

    // File Input selection handler
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFilesSelection(e.target.files);
        }
    });

    // Select Button trigger
    selectBtn.addEventListener('click', () => {
        fileInput.click();
    });

    /* ==========================================================================
       FILE VALIDATION AND UPLOAD LIFE CYCLE
       ========================================================================== */
    function handleFilesSelection(fileList) {
        const files = Array.from(fileList);
        if (files.length === 0) return;

        // Validate each file: reject empty and oversize files, keep the rest.
        const valid = [];
        for (const file of files) {
            if (file.size === 0) {
                showToast(`"${file.name}" boş bir dosya, yüklenemez.`, 'error');
                continue;
            }
            if (file.size > MAX_FILE_SIZE) {
                showToast(`"${file.name}" 100 MB sınırını aşıyor.`, 'error');
                continue;
            }
            valid.push(file);
        }

        fileInput.value = '';
        if (valid.length === 0) return;

        // Start a fresh batch
        uploadQueue = valid;
        uploadIndex = 0;
        results = [];
        cancelled = false;

        const expireSeconds = expireSelect.value;
        const expireLabel = expireSelect.options[expireSelect.selectedIndex].text;

        startNextUpload(expireSeconds, expireLabel);
    }

    function startNextUpload(expireSeconds, expireLabel) {
        if (cancelled) return;
        if (uploadIndex >= uploadQueue.length) {
            // All done
            handleBatchComplete(expireLabel);
            return;
        }

        const file = uploadQueue[uploadIndex];

        // Step transition on first file
        if (uploadIndex === 0) {
            switchStep(uploadStep, progressStep);
        }

        // Counter (e.g. "2 / 5 dosya")
        progressCounter.innerHTML = uploadQueue.length > 1
            ? `<strong>${uploadIndex + 1}</strong> / ${uploadQueue.length} dosya yükleniyor`
            : '';

        // Update preview details
        progressFileName.textContent = file.name;
        progressFileSize.textContent = formatBytes(file.size);
        progressBarFill.style.width = '0%';
        progressPercent.textContent = '0%';
        progressSpeed.textContent = 'Bağlantı kuruluyor...';

        // Prepare File Data
        const formData = new FormData();
        formData.append('file', file);
        if (expireSeconds) {
            formData.append('expire', expireSeconds);
        }

        // Initialize XHR for progress tracking
        currentXHR = new XMLHttpRequest();
        uploadStartTime = Date.now();

        // Track Upload Progress
        currentXHR.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = Math.round((e.loaded / e.total) * 100);
                progressBarFill.style.width = percentComplete + '%';
                progressPercent.textContent = percentComplete + '%';

                const timeElapsed = (Date.now() - uploadStartTime) / 1000;
                if (timeElapsed > 0.1) {
                    const bytesPerSecond = e.loaded / timeElapsed;
                    const speedText = formatBytes(bytesPerSecond) + '/s';
                    const remainingBytes = e.total - e.loaded;
                    const remainingSeconds = Math.round(remainingBytes / bytesPerSecond);
                    let etaText = '';
                    if (percentComplete < 100) {
                        etaText = remainingSeconds > 0 ? ` (${remainingSeconds}sn kaldı)` : ' (Hesaplanıyor...)';
                    }
                    progressSpeed.textContent = speedText + etaText;
                }
            }
        });

        const fileRef = file;
        currentXHR.onload = function() {
            if (currentXHR.status >= 200 && currentXHR.status < 300) {
                try {
                    const response = JSON.parse(currentXHR.responseText);
                    if (response.status === 'success' && response.data && response.data.directUrl) {
                        results.push({
                            name: fileRef.name,
                            size: fileRef.size,
                            directUrl: response.data.directUrl,
                            previewUrl: response.data.previewUrl
                        });
                        uploadIndex++;
                        currentXHR = null;
                        startNextUpload(expireSeconds, expireLabel);
                    } else {
                        const message = response.message || 'Sunucudan geçersiz yanıt alındı.';
                        handleUploadError(message, fileRef);
                    }
                } catch (e) {
                    handleUploadError('Sunucu yanıtı çözümlenemedi.', fileRef);
                }
            } else {
                let message = `Sunucu hatası: ${currentXHR.status}`;
                try {
                    const parsed = JSON.parse(currentXHR.responseText);
                    if (parsed.message) message = parsed.message;
                } catch (_) {}
                handleUploadError(message, fileRef);
            }
        };

        currentXHR.onerror = function() {
            handleUploadError('Ağ bağlantı hatası oluştu.', fileRef);
        };

        currentXHR.onabort = function() {
            console.log('Upload aborted by user');
        };

        // Open and send to local server (encrypts file server-side)
        currentXHR.open('POST', '/api/upload');
        currentXHR.send(formData);
    }

    // A single file failed: notify, skip it, continue with the rest.
    function handleUploadError(errorMessage, file) {
        showToast(`"${file.name}" yüklenemedi: ${errorMessage}`, 'error');
        uploadIndex++;
        currentXHR = null;
        // Continue batch if not cancelled
        if (!cancelled) {
            const expireSeconds = expireSelect.value;
            const expireLabel = expireSelect.options[expireSelect.selectedIndex].text;
            // small delay so the toast is readable before next file flips the UI
            setTimeout(() => startNextUpload(expireSeconds, expireLabel), 300);
        }
    }

    function handleBatchComplete(expireLabel) {
        if (results.length === 0) {
            // everything failed
            resetApp();
            return;
        }
        renderResults(expireLabel);
        switchStep(progressStep, successStep);
    }

    /* ==========================================================================
       SUCCESS RENDERING (per-file cards)
       ========================================================================== */
    function renderResults(expireLabel) {
        // Expire notice
        expireNotice.innerHTML = `
            <i class="clock-icon" data-lucide="clock" style="width: 14px; height: 14px; display: inline; vertical-align: middle; margin-right: 4px;"></i>
            Dosyalarınız <strong>${escapeHtml(expireLabel)}</strong> süresince şifreli şekilde saklanacaktır.
        `;

        // Build a card per uploaded file
        resultsList.innerHTML = '';
        results.forEach((r, i) => {
            const card = document.createElement('div');
            card.className = 'result-card';
            card.innerHTML = `
                <div class="result-card-header">
                    <i data-lucide="file"></i>
                    <span class="result-card-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
                    <span class="result-card-size">${formatBytes(r.size)}</span>
                </div>
                <div class="link-group">
                    <label class="field-label">
                        <i data-lucide="download"></i> Doğrudan İndirme <span class="badge-direct">En Hızlı</span>
                    </label>
                    <div class="input-copy-group">
                        <input type="text" readonly value="${escapeHtml(r.directUrl)}" />
                        <button class="btn btn-copy" data-copy="${escapeHtml(r.directUrl)}">
                            <i data-lucide="copy" class="btn-copy-icon"></i> Kopyala
                        </button>
                    </div>
                </div>
                <div class="link-group">
                    <label class="field-label">
                        <i data-lucide="eye"></i> Önizleme Sayfası
                    </label>
                    <div class="input-copy-group">
                        <input type="text" readonly value="${escapeHtml(r.previewUrl)}" />
                        <button class="btn btn-copy" data-copy="${escapeHtml(r.previewUrl)}">
                            <i data-lucide="copy" class="btn-copy-icon"></i> Kopyala
                        </button>
                    </div>
                </div>
            `;
            resultsList.appendChild(card);
        });

        // QR only makes sense for a single file
        if (results.length === 1) {
            qrSection.style.display = '';
            document.querySelector('.results-layout').classList.remove('no-qr');
            generateQRCode(results[0].directUrl);
        } else {
            qrSection.style.display = 'none';
            document.querySelector('.results-layout').classList.add('no-qr');
        }

        // "Copy all" only useful with multiple files
        copyAllBtn.style.display = results.length > 1 ? '' : 'none';

        lucide.createIcons();
        bindCopyButtons();
    }

    /* ==========================================================================
       COPY TO CLIPBOARD
       ========================================================================== */
    function copyText(text) {
        // navigator.clipboard requires a secure context (HTTPS/localhost).
        // Fall back to execCommand for LAN/HTTP deployments.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        try {
            const ok = document.execCommand('copy');
            return ok ? Promise.resolve() : Promise.reject(new Error('execCommand failed'));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function showCopiedUI(button) {
        const originalHTML = button.innerHTML;
        button.classList.add('copied');
        button.innerHTML = '<i data-lucide="check" class="btn-copy-icon"></i> Kopyalandı!';
        lucide.createIcons();
        setTimeout(() => {
            button.classList.remove('copied');
            button.innerHTML = originalHTML;
            lucide.createIcons();
        }, 2000);
    }

    // Select the text of an input element as a visual fallback when copy fails.
    function selectInputText(input) {
        input.select();
        input.setSelectionRange(0, 99999);
    }

    function bindCopyButtons() {
        document.querySelectorAll('.btn-copy').forEach(button => {
            button.addEventListener('click', () => {
                const text = button.getAttribute('data-copy');
                if (!text) return;
                const input = button.parentElement.querySelector('input');
                if (input) selectInputText(input);

                copyText(text)
                    .then(() => showCopiedUI(button))
                    .catch(() => showToast('Kopyalama başarısız oldu. Linki elle seçip kopyalayın.', 'error'));
            });
        });
    }

    // "Copy all" — copies every direct + preview link, one per line.
    copyAllBtn.addEventListener('click', () => {
        const lines = results.map(r => `${r.name}\n${r.directUrl}\n${r.previewUrl}`).join('\n\n');
        copyText(lines)
            .then(() => {
                showCopiedUI(copyAllBtn);
                showToast('Tüm linkler panoya kopyalandı.', 'success');
            })
            .catch(() => showToast('Kopyalama başarısız oldu.', 'error'));
    });

    /* ==========================================================================
       CANCEL & RESET
       ========================================================================== */
    cancelBtn.addEventListener('click', () => {
        cancelled = true;
        if (currentXHR) {
            currentXHR.abort();
            currentXHR = null;
        }
        showToast('Yükleme iptal edildi.', 'error');
        resetApp();
    });

    resetBtn.addEventListener('click', resetApp);

    function resetApp() {
        cancelled = true;
        if (currentXHR) {
            currentXHR.abort();
            currentXHR = null;
        }
        // Clear state
        uploadQueue = [];
        uploadIndex = 0;
        results = [];
        fileInput.value = '';
        resultsList.innerHTML = '';
        progressCounter.innerHTML = '';
        progressBarFill.style.width = '0%';
        progressPercent.textContent = '0%';
        progressSpeed.textContent = '';

        // Reset steps (single clean transition back to upload step)
        switchStep(progressStep, uploadStep);
        switchStep(successStep, uploadStep);
    }

    // Handle smooth step toggles
    function switchStep(fromStep, toStep) {
        fromStep.classList.remove('active');
        setTimeout(() => {
            fromStep.style.display = 'none';
            toStep.style.display = 'block';
            // Force redraw for CSS transition
            toStep.offsetHeight;
            toStep.classList.add('active');
        }, 150);
    }

    /* ==========================================================================
       QR CODE GENERATOR
       ========================================================================== */
    function generateQRCode(text) {
        const qr = new QRious({
            element: qrCanvas,
            value: text,
            size: 280, // High-res canvas scale (CSS scales it to 140px)
            background: '#ffffff',
            foreground: '#070a13', // Matches brand color background for contrast
            level: 'H' // High error correction
        });
    }

    /* ==========================================================================
       HELPER FUNCTIONS
       ========================================================================== */
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
});