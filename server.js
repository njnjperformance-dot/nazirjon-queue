const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Отдаем HTML-файлы прямо из папки проекта
app.use(express.static(__dirname));

// ... дальше ваш остальной код server.js ...

// ⚠️ Данные вашего аккаунта Green API (https://green-api.com)
// Данные подключения Green API
const GREEN_INSTANCE_ID = '720122704980';
const GREEN_API_TOKEN = '9feb851977034a5b8f6f863b110881b8fdb04a9df28e40278a';

// Единая база данных очереди в памяти сервера
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] }
};

// ==================== 1. МАРШРУТЫ ДЛЯ КЛИЕНТАИ ДИСПЛЕЯ ====================

// Получить текущее состояние очереди (для отображения на сайте и ТВ)
app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// Регистрация нового клиента через NFC
app.post('/api/register', async (req, res) => {
    const { name, service, brand, carNum, phone } = req.body;

    if (!service || !queueData.list[service]) {
        return res.status(400).json({ success: false, error: 'Неверно указана услуга' });
    }

    // Расчет порядкового номера в очереди
    const pos = queueData.list[service].length + 1 + queueData.pending[service];
    const newClient = { id: Date.now(), pos, name, brand, carNum, phone };

    // Сохраняем в общую очередь
    queueData.list[service].push(newClient);

    // Фоновая отправка правил в WhatsApp клиенту
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const chatId = `${cleanPhone}@c.us`;
    const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';

    const messageText =
        `Здравствуйте, ${name}!

Вы успешно встали в очередь №${pos} на [${serviceName}] (Авто: ${brand}, Госномер: ${carNum}).

⚠️ *ПРАВИЛА И ОГРАНИЧЕНИЯ:*
1. 🚫 *НЕ паркуйте машину у ворот и дверей соседей!*
2. 🚪 *НЕ стучите в двери!* Мастер сам выйдет к вам, когда подойдет ваша очередь.

Сейчас откроется чат с мастером для уточнения деталей. Пожалуйста, ожидайте!`;
        

    try {
        const url = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}/sendMessage/${GREEN_API_TOKEN}`;
        await axios.post(url, { chatId, message: rulesText });
        console.log(`[WhatsApp] Правила успешно отправлены клиенту: ${name} (${cleanPhone})`);
    } catch (error) {
        console.error('[WhatsApp Ошибка]:', error.message);
    }

    res.json({ success: true, pos, client: newClient });
});

// ==================== 2. МАРШРУТЫ ДЛЯ АДМИНКИ ====================

// Добавить вчерашнюю машину (+1 в начало)
app.post('/api/admin/add-yesterday', (req, res) => {
    const { service } = req.body;
    if (queueData.pending[service] !== undefined) {
        queueData.pending[service]++;
        // Пересчитываем позиции остальных
        recalculatePositions(service);
        res.json({ success: true, queueData });
    } else {
        res.status(400).json({ success: false });
    }
});

// Удалить клиента из очереди
app.post('/api/admin/remove', (req, res) => {
    const { service, id } = req.body;
    if (queueData.list[service]) {
        queueData.list[service] = queueData.list[service].filter(item => item.id !== id);
        recalculatePositions(service);
        res.json({ success: true, queueData });
    } else {
        res.status(400).json({ success: false });
    }
});

// Полный сброс очереди на день
app.post('/api/admin/clear', (req, res) => {
    queueData = {
        pending: { injector: 0, ecu: 0 },
        list: { injector: [], ecu: [] }
    };
    res.json({ success: true, queueData });
});

// Функция пересчета номеров позиций после удалений или добавлений
function recalculatePositions(service) {
    const baseOffset = queueData.pending[service];
    queueData.list[service].forEach((item, index) => {
        item.pos = index + 1 + baseOffset;
    });
}

// Запуск сервера
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`🚀 Сервер автоотправки и очереди запущен на порту ${PORT}`);
    console.log(`===========================================`);
});
// Добавить вчерашнюю машину (+1 в начало)
app.post('/api/admin/add-yesterday', (req, res) => {
    const { service } = req.body;
    if (queueData.pending[service] !== undefined) {
        queueData.pending[service]++;
        // Пересчитываем позиции клиентов
        recalculatePositions(service);
        console.log(`[Админ] Добавлена вчерашняя машина в ${service}`);
        res.json({ success: true, queueData });
    } else {
        res.status(400).json({ success: false, error: 'Неверная услуга' });
    }
});