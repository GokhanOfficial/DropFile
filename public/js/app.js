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

    const progressFileName = document.getElementById('progress-file-name');
    const progressFileSize = document.getElementById('progress-file-size');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressPercent = document.getElementById('progress-percent');
    const progressSpeed = document.getElementById('progress-speed');
    const cancelBtn = document.getElementById('cancel-btn');

    const expireNotice = document.getElementById('expire-notice');
    const directLinkInput = document.getElementById('direct-link-input');
    const pageLinkInput = document.getElementById('page-link-input');
    const resetBtn = document.getElementById('reset-btn');
    const qrCanvas = document.getElementById('qr-code');

    // State Variables
    let currentXHR = null;
    let uploadStartTime = 0;

    // Maximum file size: 100 MB (in bytes)
    const MAX_FILE_SIZE = 100 * 1024 * 1024;

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
            handleFileSelection(files[0]);
        }
    });

    // File Input selection handler
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileSelection(e.target.files[0]);
        }
    });

    // Select Button trigger
    selectBtn.addEventListener('click', () => {
        fileInput.click();
    });

    /* ==========================================================================
       FILE VALIDATION AND UPLOAD LIFE CYCLE
       ========================================================================== */
    function handleFileSelection(file) {
        if (!file) return;

        // Size check
        if (file.size > MAX_FILE_SIZE) {
            alert('Hata: Dosya boyutu 100 MB\'tan büyük olamaz.');
            fileInput.value = '';
            return;
        }

        // Expiration value (seconds)
        const expireSeconds = expireSelect.value;
        const expireLabel = expireSelect.options[expireSelect.selectedIndex].text;

        startUpload(file, expireSeconds, expireLabel);
    }

    function startUpload(file, expireSeconds, expireLabel) {
        // Step transition: Upload -> Progress
        switchStep(uploadStep, progressStep);

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

                // Update Progress bar
                progressBarFill.style.width = percentComplete + '%';
                progressPercent.textContent = percentComplete + '%';

                // Speed calculation
                const timeElapsed = (Date.now() - uploadStartTime) / 1000; // in seconds
                if (timeElapsed > 0.1) {
                    const bytesPerSecond = e.loaded / timeElapsed;
                    const speedText = formatBytes(bytesPerSecond) + '/s';

                    // Estimated time remaining (ETA)
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

        // Request Completed
        currentXHR.onload = function() {
            if (currentXHR.status >= 200 && currentXHR.status < 300) {
                try {
                    const response = JSON.parse(currentXHR.responseText);
                    if (response.status === 'success' && response.data && response.data.directUrl) {
                        handleUploadSuccess(response.data, file, expireLabel);
                    } else {
                        const message = response.message || 'Sunucudan geçersiz yanıt alındı.';
                        handleUploadError(message);
                    }
                } catch (e) {
                    handleUploadError('Sunucu yanıtı çözümlenemedi.');
                }
            } else {
                let message = `Sunucu hatası: ${currentXHR.status}`;
                try {
                    const parsed = JSON.parse(currentXHR.responseText);
                    if (parsed.message) message = parsed.message;
                } catch (_) {}
                handleUploadError(message);
            }
        };

        // Network/Cors Error
        currentXHR.onerror = function() {
            handleUploadError('Ağ bağlantı hatası oluştu.');
        };

        // Request aborted
        currentXHR.onabort = function() {
            console.log('Upload aborted by user');
        };

        // Open and send to local server (encrypts file server-side)
        currentXHR.open('POST', '/api/upload');
        currentXHR.send(formData);
    }

    // Cancel upload handler
    cancelBtn.addEventListener('click', () => {
        if (currentXHR) {
            currentXHR.abort();
            currentXHR = null;
            resetApp();
        }
    });

    /* ==========================================================================
       SUCCESS & ERROR UTILITIES
       ========================================================================== */
    function handleUploadSuccess(responseData, file, expireLabel) {
        const directUrl = responseData.directUrl || responseData.url;
        const pageUrl = responseData.previewUrl || responseData.url;

        // Populate fields
        directLinkInput.value = directUrl;
        pageLinkInput.value = pageUrl;

        // Update notice banner
        expireNotice.innerHTML = `\n            <i class="clock-icon" data-lucide="clock" style="width: 14px; height: 14px; display: inline; vertical-align: middle; margin-right: 4px;"></i>\n            Dosyanız <strong>${expireLabel}</strong> süresince şifreli şekilde saklanacaktır.\n        `;
        lucide.createIcons(); // Re-render icon in notice banner

        // Generate QR Code targeting the local download URL
        generateQRCode(directUrl);

        // Step transition: Progress -> Success
        switchStep(progressStep, successStep);
        currentXHR = null;
    }

    function handleUploadError(errorMessage) {
        alert(`Yükleme Başarısız: ${errorMessage}`);
        resetApp();
    }

    // Reset button click
    resetBtn.addEventListener('click', resetApp);

    function resetApp() {
        // Clear input values
        fileInput.value = '';
        directLinkInput.value = '';
        pageLinkInput.value = '';

        // Reset steps
        switchStep(progressStep, uploadStep);
        switchStep(successStep, uploadStep);

        currentXHR = null;
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
       COPY TO CLIPBOARD FUNCTIONS
       ========================================================================== */
    document.querySelectorAll('.btn-copy').forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-target');
            const inputElement = document.getElementById(targetId);
            if (!inputElement) return;

            inputElement.select();
            inputElement.setSelectionRange(0, 99999); // For mobile devices

            navigator.clipboard.writeText(inputElement.value).then(() => {
                // Copy success UI states
                button.classList.add('copied');
                const originalHTML = button.innerHTML;
                button.innerHTML = '<i data-lucide="check" class="btn-copy-icon"></i> Kopyalandı!';
                lucide.createIcons();

                setTimeout(() => {
                    button.classList.remove('copied');
                    button.innerHTML = originalHTML;
                    lucide.createIcons();
                }, 2000);
            }).catch(err => {
                console.error('Kopyalama başarısız: ', err);
            });
        });
    });

    /* ==========================================================================
       QR CODE GENERATOR
       ========================================================================== */
    function generateQRCode(text) {
        // Render QR Code using QRious
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
