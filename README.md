# WhatsApp Now Playing (foobar2000 + Spotify / Last.fm)

Автоматическая трансляция текущего трека из **foobar2000** и **Spotify** (через Last.fm) в статус «О себе» (About) в WhatsApp Web.

## Возможности
- **Мгновенный захват из foobar2000:** считывает играющий трек напрямую с ПК через плагин Beefweb.
- **Поддержка Spotify через Last.fm:** если foobar2000 закрыт или на паузе, подтягивает текущий трек *Now Playing* из Spotify через Last.fm API (с поддержкой локального HTTP-прокси).
- **Умная навигация:** динамически находит поле ввода и кнопку сохранения в WhatsApp Web, подстраиваясь под изменение высоты окна.
- **Режим обучения:** позволяет за 5 кликов переобучить координаты под любое разрешение экрана или язык интерфейса.

## Требования
- **Node.js** версии 18 или выше
- **foobar2000** с установленным плагином [Beefweb Remote Control](https://www.foobar2000.org/components/view/foo_beefweb) (по умолчанию работает на порту `8880`)
- Аккаунт и бесплатный [API-ключ Last.fm](https://www.last.fm/api/account/create) (опционально, если нужен трекинг с других устройств)

## Установка и запуск

1. Клонируйте репозиторий и установите зависимости:
```bash
git clone https://github.com/yumshanova/wa-foobar2000.git
cd wa-foobar2000
npm install
```

2. Скопируйте файл конфигурации и впишите свои данные:
```bash
copy config.example.js config.js
```

3. Запустите скрипт и отсканируйте QR-код в WhatsApp:
```bash
node index.js
```

## Синхронизация со смартфона (Android)

Официальное мобильное приложение Spotify не отправляет статус Now Playing в Last.fm в реальном времени. 
Чтобы треки с телефона попадали в статус WhatsApp, установите на смартфон [Pano Scrobbler](https://github.com/kawaiiDango/pano-scrobbler) и включите в нём перехват уведомлений музыкальных плееров.
