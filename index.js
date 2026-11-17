const fs = require('fs');
const https = require('https');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { HttpsProxyAgent } = require('https-proxy-agent');

if (!fs.existsSync('./config.js')) {
    console.error('Скопируй config.example.js в config.js и заполни свои данные!');
    process.exit(1);
}

const config = require('./config');
const RECORD_MODE = process.argv.includes('--record'); // Запуск записи через: node index.js --record
const MACRO_FILE = 'macro.json';

const proxyAgent = config.LASTFM_PROXY ? new HttpsProxyAgent(config.LASTFM_PROXY) : undefined;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false,
        defaultViewport: { width: 1280, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900']
    }
});

let lastSentStatus = '';
let targetStatus = '';
let debounceTimer = null;
let isUpdating = false;
let lastFmCache = { status: null, checkedAt: 0 };

client.on('qr', (qr) => {
    console.log('Отсканируйте QR-код в WhatsApp (Настройки -> Связанные устройства):');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    if (!fs.existsSync(MACRO_FILE)) {
        console.error(`Ошибка: файл ${MACRO_FILE} не найден!`);
        process.exit(1);
    }

    console.log('WhatsApp подключен! Отслеживаю foobar2000 и Last.fm...');
    setInterval(checkPlayback, POLL_INTERVAL_MS);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchJsonViaProxy(url, agent) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { agent, timeout: 5000 }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Last.fm timeout'));
        });
    });
}

async function runTrainedMacro(newStatus) {
    const page = client.pupPage;
    const actions = JSON.parse(fs.readFileSync(MACRO_FILE, 'utf8'));

    for (let i = 0; i < actions.length; i++) {
        const act = actions[i];
        if (act.type !== 'click') continue;

        if (act.isInput) {
            const inputBox = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'))
                    .filter(el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 120 && r.left > 350 && r.top > 100 && r.top < 350;
                    });
                if (inputs.length === 0) return null;
                const el = inputs[0];
                el.focus();
                const r = el.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            });

            if (inputBox) {
                await page.mouse.click(inputBox.x, inputBox.y);
            } else {
                await page.mouse.click(act.x, act.y);
            }
            await sleep(300);

            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await sleep(200);

            await page.evaluate((text) => {
                const el = document.activeElement;
                if (!el) return;
                document.execCommand('insertText', false, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }, newStatus);
            await sleep(500);

            const saveBtnCoords = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .map(el => {
                        const r = el.getBoundingClientRect();
                        return {
                            x: r.left + r.width / 2,
                            y: r.top + r.height / 2,
                            w: r.width,
                            h: r.height,
                            hasSvg: Boolean(el.querySelector('svg'))
                        };
                    })
                    .filter(b => b.hasSvg && b.w >= 30 && b.w <= 70 && b.x > 750 && b.x < 920 && b.y > 600 && b.y < 860)
                    .sort((a, b) => b.y - a.y);

                return btns.length > 0 ? { x: btns[0].x, y: btns[0].y } : null;
            });

            if (saveBtnCoords) {
                await page.mouse.click(saveBtnCoords.x, saveBtnCoords.y);
                i++;
            }
            await sleep(800);
        } else {
            await page.mouse.click(act.x, act.y);
            await sleep(700);
        }
    }
}

async function getFoobarTrack() {
    try {
        const res = await fetch(BEEFWEB_URL);
        const data = await res.json();

        if (data.player && data.player.playbackState === 'playing') {
            const cols = data.player.activeItem?.columns || [];
            const artist = cols[0] || '';
            const title = cols[1] || '';
            const track = [artist, title].filter(Boolean).join(' - ');
            if (track) return `🎵 ${track}`.slice(0, 50);
        }
    } catch {
        // foobar2000 закрыт или недоступен
    }
    return null;
}

async function getLastFmTrack() {
    if (!LASTFM_USER || !LASTFM_API_KEY || LASTFM_API_KEY === 'ТВОЙ_API_KEY_ОТ_LASTFM') {
        return null;
    }

    const now = Date.now();
    if (now - lastFmCache.checkedAt < 4000) {
        return lastFmCache.status;
    }

    try {
        const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(LASTFM_USER)}&api_key=${LASTFM_API_KEY}&format=json&limit=1`;
        const data = await fetchJsonViaProxy(url, proxyAgent);
        const latest = data?.recenttracks?.track?.[0];

        if (latest && latest['@attr']?.nowplaying === 'true') {
            const artist = latest.artist?.['#text'] || '';
            const title = latest.name || '';
            const track = [artist, title].filter(Boolean).join(' - ');
            lastFmCache = { status: track ? `🎵 ${track}`.slice(0, 50) : null, checkedAt: now };
        } else {
            lastFmCache = { status: null, checkedAt: now };
        }
    } catch {
        lastFmCache.checkedAt = now;
    }

    return lastFmCache.status;
}

async function checkPlayback() {
    const foobarStatus = await getFoobarTrack();
    const currentTrackStatus = foobarStatus || (await getLastFmTrack()) || DEFAULT_BIO;

    if (currentTrackStatus !== lastSentStatus) {
        if (currentTrackStatus !== targetStatus) {
            targetStatus = currentTrackStatus;
            clearTimeout(debounceTimer);

            debounceTimer = setTimeout(async () => {
                if (targetStatus !== lastSentStatus && !isUpdating) {
                    isUpdating = true;
                    const statusToApply = targetStatus;
                    try {
                        await runTrainedMacro(statusToApply);
                        lastSentStatus = statusToApply;
                        console.log(`Статус обновлен: ${statusToApply}`);
                    } catch (err) {
                        console.error('Ошибка обновления статуса:', err.message);
                    } finally {
                        isUpdating = false;
                    }
                }
            }, DEBOUNCE_MS);
        }
    } else {
        targetStatus = lastSentStatus;
        clearTimeout(debounceTimer);
    }
}

client.initialize();