const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// НАСТРОЙКИ GREEN API
const GREEN_ID_INSTANCE = '720122704980';
const GREEN_API_TOKEN = '9feb851977034a5b8f6f863b110881b8fdb04a9df28e40278a';

// Хранилище
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] },
    completed: { injector: [], ecu: [] },
    dailyReport: {
        totalEarned: 0,
        workEarned: 0,
        partsEarned: 0,
        history: []
    }
};

function formatPhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = phone.toString().replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('8')) {
        cleaned = '7' + cleaned.slice(1);
    }
    return `${cleaned}@c.us`;
}

async function sendWhatsAppNotification(phone, message) {
    if (!phone) return;
    const chatId = formatPhoneNumber(phone);
    const url = `https://7201.api.green-api.com/waInstance${GREEN_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`;

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, message })
        });
    } catch (error) {
        console.error('[Green API Error]', error.message);
    }
}

function recalculatePositions(service) {
    const offset = queueData.pending[service] || 0;
    queueData.list[service].forEach((item, index) => {
        item.pos = offset + index + 1;
    });
}

// ==========================================
// API
// ==========================================

app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// Регистрация клиента
app.post('/api/register', async (req, res) => {
    const { name, service, brand, carNum, phone } = req.body;

    if (!name || !service || !brand || !carNum || !phone) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const offset = queueData.pending[service] || 0;
    const pos = offset + queueData.list[service].length + 1;

    const newClient = {
        id: Date.now().toString(),
        name,
        brand,
        carNum: carNum.toUpperCase(),
        phone,
        pos,
        dateAdded: new Date().toLocaleDateString('ru-RU')
    };

    queueData.list[service].push(newClient);

    const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';
    const welcomeMsg =
        `Здравствуйте, ${name}! 👋

Вы успешно записаны в живую очередь **Nazirjon Performance**!

🚗 Автомобиль: **${brand}** (${carNum.toUpperCase()})
🛠 Услуга: [${serviceName}]
🔢 Ваша позиция: **№${pos}**

⚠️ **ВАЖНО:**
1. Приём авто строго в **08:50 – 09:00**.
2. Водитель должен находиться возле машины.

О готовности сообщим в этот чат. 🚘✨`;

    await sendWhatsAppNotification(phone, welcomeMsg);
    res.json({ success: true, pos, queueData });
});

// Добавить вчерашнюю машину (счетчик)
app.post('/api/admin/add-yesterday', (req, res) => {
    const { service } = req.body;
    if (queueData.pending[service] !== undefined) {
        queueData.pending[service] += 1;
        recalculatePositions(service);
        res.json({ success: true, queueData });
    } else {
        res.status(400).json({ error: 'Неверная услуга' });
    }
});

// Завершение работы
app.post('/api/admin/complete', async (req, res) => {
    const { service, id, workPrice, partsPrice } = req.body;

    const work = parseInt(workPrice) || 0;
    const parts = parseInt(partsPrice) || 0;
    const totalPrice = work + parts;

    if (queueData.list[service]) {
        const index = queueData.list[service].findIndex(item => item.id === id || String(item.pos) === String(id));

        if (index !== -1) {
            const [completedCar] = queueData.list[service].splice(index, 1);
            completedCar.completedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            completedCar.workPrice = work;
            completedCar.partsPrice = parts;
            completedCar.totalPrice = totalPrice;

            queueData.completed[service].push(completedCar);
            recalculatePositions(service);

            // Сохранение в отчет админки
            queueData.dailyReport.totalEarned += totalPrice;
            queueData.dailyReport.workEarned += work;
            queueData.dailyReport.partsEarned += parts;
            queueData.dailyReport.history.push({
                time: completedCar.completedTime,
                brand: completedCar.brand,
                carNum: completedCar.carNum,
                service: service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE',
                work,
                parts,
                total: totalPrice
            });

            // 📩 Сообщение клиенту (ТОЛЬКО ОБЩАЯ СУММА)
            const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';
            const readyMsg =
                `Здравствуйте, ${completedCar.name}! 👋

✅ *Ваш автомобиль готов к выдаче!*
🚗 **${completedCar.brand}** (${completedCar.carNum})
🛠 Услуга: [${serviceName}]

💰 **Сумма к оплате:** ${totalPrice.toLocaleString()} ₸

Ждем вас! 🚘✨`;

            await sendWhatsAppNotification(completedCar.phone, readyMsg);
            return res.json({ success: true, queueData });
        }
    }

    res.status(400).json({ error: 'Машина не найдена' });
});

// Завершение вчерашней машины
app.post('/api/admin/complete-yesterday', (req, res) => {
    const { service, workPrice, partsPrice } = req.body;

    const work = parseInt(workPrice) || 0;
    const parts = parseInt(partsPrice) || 0;
    const totalPrice = work + parts;

    if (queueData.pending[service] > 0) {
        queueData.pending[service] -= 1;
        recalculatePositions(service);

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const completedCar = {
            id: 'yesterday_' + Date.now(),
            brand: 'Длительный / Вчерашний ремонт',
            carNum: 'ПРИОРИТЕТ',
            workPrice: work,
            partsPrice: parts,
            totalPrice: totalPrice,
            completedTime: timeStr
        };

        queueData.completed[service].push(completedCar);

        queueData.dailyReport.totalEarned += totalPrice;
        queueData.dailyReport.workEarned += work;
        queueData.dailyReport.partsEarned += parts;
        queueData.dailyReport.history.push({
            time: timeStr,
            brand: 'Длительный ремонт',
            carNum: 'ПРИОРИТЕТ',
            service: service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE',
            work,
            parts,
            total: totalPrice
        });

        return res.json({ success: true, queueData });
    }

    res.status(400).json({ error: 'Нет длительных машин' });
});

app.post('/api/admin/remove-completed', (req, res) => {
    const { service, carNum } = req.body;
    if (queueData.completed[service]) {
        queueData.completed[service] = queueData.completed[service].filter(item => item.carNum !== carNum);
        return res.json({ success: true, queueData });
    }
    res.status(400).json({ error: 'Ошибка удаления' });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер Nazirjon Performance запущен на порту ${PORT}`);
});