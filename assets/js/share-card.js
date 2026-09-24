// Shareable result card for quizzes and labs.
// Draws a square PNG ("9/10 on <title>") on a canvas so readers can post the image natively
// on LinkedIn and put the link in the first comment. Pure helpers are exported for node tests.
(function () {
    const SIZE = 1200;
    const PADDING = 96;
    const COLORS = {
        background: '#111827',
        primary: '#1D9E75',
        accent: '#A7F3D0',
        muted: '#9CA3AF',
        track: '#1F2937',
        text: '#FFFFFF'
    };
    const FONT_DISPLAY = '"DM Sans", sans-serif';
    const FONT_MONO = '"JetBrains Mono", monospace';

    function postText(result) {
        return `I scored ${result.score}/${result.total} on ${result.title} at CodeWithKyryl.\n\n`
            + 'Think you can beat it? Link in the comments 👇';
    }

    function fileName(result) {
        const slug = String(result.slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `codewithkyryl-${slug}-${result.score}-of-${result.total}.png`;
    }

    function displayUrl(url) {
        return String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
    }

    // Greedy word wrap. `measure` returns the pixel width of a string, so the same code wraps
    // canvas text in the browser and fixed-width text in tests.
    function wrapLines(text, maxWidth, measure, maxLines) {
        const lines = [];
        let line = '';

        String(text).split(/\s+/).filter(Boolean).forEach(function (word) {
            const candidate = line ? `${line} ${word}` : word;
            if (measure(candidate) <= maxWidth) {
                line = candidate;
                return;
            }
            if (line) lines.push(line);
            line = word;
            while (measure(line) > maxWidth && line.length > 1) {
                const fit = fitPrefix(line, maxWidth, measure);
                lines.push(fit);
                line = line.slice(fit.length);
            }
        });
        if (line) lines.push(line);

        if (lines.length <= maxLines) return lines;
        const kept = lines.slice(0, maxLines);
        kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]} ${lines[maxLines]}`, maxWidth, measure);
        return kept;
    }

    function fitPrefix(text, maxWidth, measure) {
        let end = text.length;
        while (end > 1 && measure(text.slice(0, end)) > maxWidth) end -= 1;
        return text.slice(0, end);
    }

    function ellipsize(text, maxWidth, measure) {
        let value = text;
        while (value.length > 0 && measure(`${value}…`) > maxWidth) value = value.slice(0, -1);
        return `${value.trimEnd()}…`;
    }

    async function loadFonts() {
        if (!document.fonts || !document.fonts.load) return;
        try {
            await Promise.all([
                document.fonts.load(`700 160px ${FONT_DISPLAY}`),
                document.fonts.load(`400 36px ${FONT_DISPLAY}`),
                document.fonts.load(`700 44px ${FONT_MONO}`),
                document.fonts.load(`500 30px ${FONT_MONO}`)
            ]);
        } catch (error) {
            // Fallback fonts still produce a readable card.
        }
    }

    // result: { slug, title, label, score, total, verdict, url }
    async function renderBlob(result) {
        await loadFonts();
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        drawBackground(ctx);
        drawHeader(ctx, result);
        drawScore(ctx, result);
        drawText(ctx, result);

        return new Promise(function (resolve) {
            canvas.toBlob(resolve, 'image/png');
        });
    }

    function drawBackground(ctx) {
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, SIZE, SIZE);
        const glow = ctx.createRadialGradient(SIZE * 0.85, SIZE * 0.1, 0, SIZE * 0.85, SIZE * 0.1, SIZE * 0.7);
        glow.addColorStop(0, 'rgba(29, 158, 117, 0.35)');
        glow.addColorStop(1, 'rgba(29, 158, 117, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.fillStyle = COLORS.primary;
        ctx.fillRect(0, SIZE - 16, SIZE, 16);
    }

    function drawHeader(ctx, result) {
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.primary;
        ctx.font = `700 44px ${FONT_MONO}`;
        ctx.fillText('</> CodeWithKyryl', PADDING, 150);

        if (!result.label) return;
        const label = String(result.label).toUpperCase();
        ctx.font = `500 26px ${FONT_MONO}`;
        const width = ctx.measureText(label).width + 48;
        const x = SIZE - PADDING - width;
        ctx.fillStyle = 'rgba(29, 158, 117, 0.18)';
        roundRect(ctx, x, 106, width, 60, 30);
        ctx.fill();
        ctx.fillStyle = COLORS.accent;
        ctx.fillText(label, x + 24, 146);
    }

    function drawScore(ctx, result) {
        const centerX = SIZE / 2;
        const centerY = 500;
        const radius = 200;
        const ratio = result.total > 0 ? Math.max(0, Math.min(1, result.score / result.total)) : 0;

        ctx.lineWidth = 30;
        ctx.lineCap = 'round';
        ctx.strokeStyle = COLORS.track;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();
        if (ratio > 0) {
            ctx.strokeStyle = COLORS.primary;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
            ctx.stroke();
        }

        const score = String(result.score);
        const total = `/${result.total}`;
        ctx.font = `700 160px ${FONT_DISPLAY}`;
        const scoreWidth = ctx.measureText(score).width;
        ctx.font = `700 64px ${FONT_DISPLAY}`;
        const totalWidth = ctx.measureText(total).width;
        const startX = centerX - (scoreWidth + totalWidth) / 2;

        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.text;
        ctx.font = `700 160px ${FONT_DISPLAY}`;
        ctx.fillText(score, startX, centerY + 56);
        ctx.fillStyle = COLORS.muted;
        ctx.font = `700 64px ${FONT_DISPLAY}`;
        ctx.fillText(total, startX + scoreWidth, centerY + 56);
    }

    function drawText(ctx, result) {
        const maxWidth = SIZE - PADDING * 2;
        ctx.textAlign = 'center';

        ctx.fillStyle = COLORS.text;
        ctx.font = `700 60px ${FONT_DISPLAY}`;
        const titleLines = wrapLines(result.title, maxWidth, function (text) {
            return ctx.measureText(text).width;
        }, 2);
        let y = 815;
        titleLines.forEach(function (line) {
            ctx.fillText(line, SIZE / 2, y);
            y += 72;
        });

        if (result.verdict) {
            ctx.fillStyle = COLORS.muted;
            ctx.font = `400 34px ${FONT_DISPLAY}`;
            wrapLines(result.verdict, maxWidth, function (text) {
                return ctx.measureText(text).width;
            }, 2).forEach(function (line) {
                ctx.fillText(line, SIZE / 2, y + 10);
                y += 46;
            });
        }

        ctx.fillStyle = COLORS.accent;
        ctx.font = `500 30px ${FONT_MONO}`;
        ctx.fillText(`Your turn → ${displayUrl(result.url)}`, SIZE / 2, SIZE - 80);
    }

    function roundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + width, y, x + width, y + height, radius);
        ctx.arcTo(x + width, y + height, x, y + height, radius);
        ctx.arcTo(x, y + height, x, y, radius);
        ctx.arcTo(x, y, x + width, y, radius);
        ctx.closePath();
    }

    // Renders the share panel into `container`. options.track(eventName, properties) is optional.
    function mount(container, result, options) {
        const track = (options && options.track) || function () {};
        const properties = { slug: result.slug, score: result.score, total: result.total };
        let blob = null;
        let previewUrl = null;

        container.innerHTML = `<div class="share-card">
                <img class="share-card-preview" alt="" width="160" height="160" hidden>
                <div class="share-card-body">
                    <strong class="share-card-title"><i class="fab fa-linkedin"></i> Share your result</strong>
                    <p class="share-card-hint">Post the image, then drop the link in the first comment.</p>
                    <div class="share-card-actions">
                        <button type="button" class="btn-primary" data-share="native" hidden><i class="fas fa-share-nodes"></i> Share image</button>
                        <button type="button" class="btn-secondary" data-share="download" disabled><i class="fas fa-download"></i> Download image</button>
                        <button type="button" class="btn-secondary" data-share="text"><i class="fas fa-pen"></i> Copy post text</button>
                        <button type="button" class="btn-secondary" data-share="link"><i class="fas fa-link"></i> Copy link</button>
                    </div>
                    <span class="share-card-status" aria-live="polite"></span>
                </div>
            </div>`;

        const preview = container.querySelector('.share-card-preview');
        const status = container.querySelector('.share-card-status');
        const nativeButton = container.querySelector('[data-share="native"]');
        const downloadButton = container.querySelector('[data-share="download"]');

        renderBlob(result).then(function (rendered) {
            if (!rendered) {
                downloadButton.hidden = true;
                return;
            }
            blob = rendered;
            previewUrl = URL.createObjectURL(blob);
            preview.src = previewUrl;
            preview.alt = `Result card: ${result.score}/${result.total} on ${result.title}`;
            preview.hidden = false;
            downloadButton.disabled = false;
            if (navigator.canShare && navigator.canShare({ files: [imageFile()] })) nativeButton.hidden = false;
        }).catch(function () {
            downloadButton.hidden = true;
        });

        container.addEventListener('click', function (event) {
            const button = event.target.closest('[data-share]');
            if (!button) return;
            const action = button.dataset.share;
            if (action === 'download') download();
            if (action === 'native') shareNative();
            if (action === 'text') copy(postText(result), 'Post text copied — paste it on LinkedIn with the image.');
            if (action === 'link') copy(result.url, 'Link copied — paste it as the first comment.');
            track('practice_shared', Object.assign({ method: action }, properties));
        });

        function imageFile() {
            return new File([blob], fileName(result), { type: 'image/png' });
        }

        function download() {
            if (!previewUrl) return;
            const link = document.createElement('a');
            link.href = previewUrl;
            link.download = fileName(result);
            document.body.appendChild(link);
            link.click();
            link.remove();
            status.textContent = 'Image downloaded.';
        }

        async function shareNative() {
            try {
                await navigator.share({ files: [imageFile()], text: postText(result) });
                status.textContent = 'Shared.';
            } catch (error) {
                if (error && error.name === 'AbortError') return;
                status.textContent = 'Sharing failed — download the image instead.';
            }
        }

        async function copy(text, message) {
            try {
                await navigator.clipboard.writeText(text);
                status.textContent = message;
            } catch (error) {
                status.textContent = `Copy failed. ${text}`;
            }
        }
    }

    const ShareCard = { postText, fileName, displayUrl, wrapLines, renderBlob, mount };
    if (typeof module === 'object' && module.exports) module.exports = ShareCard;
    else window.ShareCard = ShareCard;
}());
