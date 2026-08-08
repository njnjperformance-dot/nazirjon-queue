const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// НАСТРОЙКИ GREEN API
// ==========================================
const GREEN_ID_INSTANCE = '720122704980';
const GREEN_API_TOKEN = '9feb851977034a5b8f6f863b110881b8fdb04a9df28e40278a';

// Хранилище очереди
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] },
    completed: { injector: [], ecu: [] }
};

// Функция приведения номера к международному формату Green API (7XXXXXXXXXX@c.us)
function formatPhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = phone.toString().replace(/\D/g, ''); // Удаляем все кроме цифр

    if (cleaned.length === 11 && cleaned.startsWith('8')) {
        cleaned = '7' + cleaned.slice(1);
    }

    return `${cleaned}@c.us`;
}

// Отправка сообщений через Green API (через ваш хост 7201.api.green-api.com)
async function sendWhatsAppNotification(phone, message) {
    if (!phone) {
        console.log('[Green API] Ошибка: телефон не указан');
        return;
    }

    const chatId = formatPhoneNumber(phone);
    const url = `https://7201.api.green-api.com/waInstance${GREEN_ID_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, message })
        });

        const data = await response.json();
        console.log(`[Green API] Сообщение успешно отправлено на ${chatId}:`, data);
    } catch (error) {
        console.error('[Green API Error] Ошибка отправки:', error.message);
    }
}

// Перерасчет позиций активной очереди
function recalculatePositions(service) {
    const offset = queueData.pending[service] || 0;
    queueData.list[service].forEach((item, index) => {
        item.pos = offset + index + 1;
    });
}

// ==========================================
// API МАРШРУТЫ
// ==========================================

// 1. Получить состояние очереди
app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// 2. Регистрация нового клиента с NFC (index.html) + ОТПРАВКА ПРЕДУПРЕЖДЕНИЯ
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

    // 📩 Отправка приветственного сообщения с предупреждением
    const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';
    const welcomeMsg =
        `Здравствуйте, ${name}! 👋

Вы успешно зарегистрировались в живой очереди **Nazirjon ECU**!

🚗 Автомобиль: **${brand}** (${carNum.toUpperCase()})
🛠 Услуга: [${serviceName}]
🔢 Ваша позиция в очереди: **№${pos}**

⚠️ **ВАЖНЫЕ ПРАВИЛА И ПРЕДУПРЕЖДЕНИЯ:**
1. Пожалуйста, паркуйте автомобиль строго вдоль линии, не перекрывая въезд другим машинам.
2. Оставьте ключи мастеру или будьте на связи по телефону.
3. Точное время ремонта и стоимость рассчитываются после проведения первичной диагностики.
4. О готовности авто вы получите автоматическое уведомление в этот чат.

Благодарим за обращение! 🚘✨`;

    await sendWhatsAppNotification(phone, welcomeMsg);

    res.json({ success: true, pos, queueData });
});

// 3. Админ: Добавить длительный / вчерашний ремонт вручную
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

// 4. Админ: Готово к выдаче для ОБЫЧНОЙ машины (+ отправка WhatsApp с ценой)
app.post('/api/admin/complete', async (req, res) => {
    const { service, id, price } = req.body;

    if (queueData.list[service]) {
        const index = queueData.list[service].findIndex(item => item.id === id || String(item.pos) === String(id));

        if (index !== -1) {
            const [completedCar] = queueData.list[service].splice(index, 1);
            completedCar.completedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            completedCar.price = price ? `${price} ₸` : 'Уточняйте у мастера';

            queueData.completed[service].push(completedCar);
            recalculatePositions(service);

            // 📩 Сообщение о готовности с ценой
            const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';
            const readyMsg =
                `Здравствуйте, ${completedCar.name}! 👋

✅ *Ваш автомобиль готов к выдаче!*
🚗 **${completedCar.brand}** (${completedCar.carNum})
🛠 Услуга: [${serviceName}]
💰 **К оплате:** ${completedCar.price}

Вы можете приехать и забрать ваш автомобиль. Ждем вас! 🚘✨`;

            await sendWhatsAppNotification(completedCar.phone, readyMsg);

            return res.json({ success: true, queueData });
        }
    }

    res.status(400).json({ error: 'Машина не найдена' });
});

// 5. Админ: Готово к выдаче для ДЛИТЕЛЬНОЙ / ВЧЕРАШНЕЙ машины
app.post('/api/admin/complete-yesterday', (req, res) => {
    const { service, price } = req.body;

    if (queueData.pending[service] > 0) {
        queueData.pending[service] -= 1;
        recalculatePositions(service);

        const formattedPrice = price ? `${price} ₸` : 'Уточняйте у мастера';
        const completedCar = {
            id: 'yesterday_' + Date.now(),
            brand: 'Длительный / Вчерашний ремонт',
            carNum: 'ПРИОРИТЕТ',
            price: formattedPrice,
            completedTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        queueData.completed[service].push(completedCar);
        return res.json({ success: true, queueData });
    }

    res.status(400).json({ error: 'Нет длительных машин' });
});

// 6. Админ: Удалить из списка готовых (после выдачи ключей)
app.post('/api/admin/remove-completed', (req, res) => {
    const { service, carNum } = req.body;
    if (queueData.completed[service]) {
        queueData.completed[service] = queueData.completed[service].filter(item => item.carNum !== carNum);
        return res.json({ success: true, queueData });
    }
    res.status(400).json({ error: 'Ошибка удаления' });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер Nazirjon ECU запущен на порту ${PORT}`);
});