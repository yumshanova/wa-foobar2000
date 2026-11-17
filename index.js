const fs = require('fs');
const https = require('https');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { HttpsProxyAgent } = require('https-proxy-agent');

if (!fs.existsSync('./config.js')) {
    console.error('Ошибка: файл config.js не найден! Скопируйте config.example.js в config.js и заполните его.');
    process.exit(1);
}

const config = require('./config');
const RECORD_MODE = process.argv.includes('--record');
const MACRO_FILE = 'macro.json';

const proxyAgent = config.LASTFM_PROXY ? new HttpsProxyAgent(config.LASTFM_PROXY) : undefined;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: RECORD_MODE ? false : Boolean(config.HEADLESS),
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
    if (RECORD_MODE) {
        console.log('РЕЖИМ ОБУЧЕНИЯ: откройте профиль -> "О себе" -> кликните в поле ввода -> сохраните -> вернитесь к чатам.');
        console.log('После этого нажмите Ctrl+C в консоли для сохранения macro.json.');
        await startMacroRecorder();
        return;
    }

    if (!fs.existsSync(MACRO_FILE)) {
        console.error(`Ошибка: файл ${MACRO_FILE} не найден! Запустите скрипт с флагом --record для записи кликов.`);
        process.exit(1);
    }

    console.log('WhatsApp подключен! Отслеживаю foobar2000 и Last.fm...');
    setInterval(checkPlayback, config.POLL_INTERVAL_MS || 1500);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startMacroRecorder() {
    const page = client.pupPage;
    const recorded = [];

    await page.exposeFunction('__recordClick', (x, y, isInput) => {
        recorded.push({ type: 'click', x, y, isInput });
        console.log(`Записан клик: x=${x}, y=${y}${isInput ? ' [Поле ввода]' : ''}`);
    });

    await page.evaluate(() => {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
            window.__recordClick(Math.round(e.clientX), Math.round(e.clientY), Boolean(el));
        }, true);
    });

    process.on('SIGINT', () => {
        fs.writeFileSync(MACRO_FILE, JSON.stringify(recorded, null, 2));
        console.log(`\nСохранено ${recorded.length} действий в ${MACRO_FILE}`);
        process.exit(0);
    });
}

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
    if (!config.BEEFWEB_URL) return null;

    try {
        const res = await fetch(config.BEEFWEB_URL);
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
    if (!config.LASTFM_USER || !config.LASTFM_API_KEY || config.LASTFM_API_KEY === 'YOUR_LASTFM_API_KEY') {
        return null;
    }

    const now = Date.now();
    if (now - lastFmCache.checkedAt < 4000) {
        return lastFmCache.status;
    }

    try {
        const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(config.LASTFM_USER)}&api_key=${config.LASTFM_API_KEY}&format=json&limit=1`;
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
    } catch (err) {
        console.error('Ошибка Last.fm:', err.message);
        lastFmCache.checkedAt = now;
    }

    return lastFmCache.status;
}

async function checkPlayback() {
    const foobarStatus = await getFoobarTrack();
    const currentTrackStatus = foobarStatus || (await getLastFmTrack()) || config.DEFAULT_BIO || 'Доступен';

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
            }, config.DEBOUNCE_MS || 2500);
        }
    } else {
        targetStatus = lastSentStatus;
        clearTimeout(debounceTimer);
    }
}

client.initialize();