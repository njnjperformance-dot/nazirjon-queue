const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const priceText = price ? `💰 **Стоимость ремонта:** ${price} ₸\n` : '';

const readyMessage =
    `Здравствуйте, ${completedCar.name}! 👋

✅ *Ваш автомобиль готов к выдаче!*
🚗 **${completedCar.brand}** (${completedCar.carNum})
🛠 Услуга: [${serviceName}]
${priceText}
Вы можете приехать и забрать ваш автомобиль. Ждем вас! 🚘✨`;

const app = express();
app.use(cors());
app.use(express.json());

// Раздача статических HTML-файлов
app.use(express.static(__dirname));

// ⚠️ Данные вашего аккаунта Green API (https://green-api.com)
// Данные подключения Green API
const GREEN_INSTANCE_ID = '720122704980';
const GREEN_API_TOKEN = '9feb851977034a5b8f6f863b110881b8fdb04a9df28e40278a';


// Данные очереди
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] },
    completed: { injector: [], ecu: [] }
};

// Перерасчет позиций
function recalculatePositions(service) {
    queueData.list[service].forEach((item, index) => {
        item.pos = index + 1;
    });
}

// 1. Получение всей очереди
app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// 2. Регистрация нового клиента
app.post('/api/register', async (req, res) => {
    const { name, service, brand, carNum, phone } = req.body;

    if (!name || !service || !brand || !carNum || !phone) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const pos = queueData.list[service].length + 1;
    const newClient = {
        id: Date.now().toString(),
        name,
        brand,
        carNum,
        phone,
        pos
    };

    queueData.list[service].push(newClient);

    // Отправка правил в WhatsApp через Green API
    if (GREEN_INSTANCE && GREEN_TOKEN && GREEN_INSTANCE !== 'YOUR_GREEN_API_INSTANCE') {
        let cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.startsWith('8')) cleanPhone = '7' + cleanPhone.slice(1);

        const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';
        const rulesMessage =
            `Здравствуйте, ${name}!

Вы успешно встали в очередь №${pos} на [${serviceName}] (Авто: ${brand}, Госномер: ${carNum}).

⚠️ *ПРАВИЛА И ОГРАНИЧЕНИЯ:*
1. 🚫 *НЕ паркуйте машину у ворот и дверей соседей!*
2. 🚪 *НЕ стучите в двери!* Мастер сам выйдет к вам, когда подойдет ваша очередь.

Сейчас откроется чат с мастером для уточнения деталей. Пожалуйста, ожидайте!`;

        try {
            await axios.post(`https://api.green-api.com/waInstance${GREEN_INSTANCE}/sendMessage/${GREEN_TOKEN}`, {
                chatId: `${cleanPhone}@c.us`,
                message: rulesMessage
            });
            console.log(`[WhatsApp Rules] Правила отправлены клиенту ${cleanPhone}`);
        } catch (e) {
            console.error('[WhatsApp Rules Error]', e.message);
        }
    }

    res.json({ success: true, pos, queueData });
});

// 3. Админ: Добавление вчерашней машины
app.post('/api/admin/add-yesterday', (req, res) => {
    const { service } = req.body;
    if (queueData.pending[service] !== undefined) {
        queueData.pending[service] += 1;
        res.json({ success: true, queueData });
    } else {
        res.status(400).json({ error: 'Неверная услуга' });
    }
});

// 4. Админ: Перевод в ГОТОВЫЕ с ценой и отправкой сообщения клиенту
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

            // Сообщение в WhatsApp клиенту о готовности и сумме к оплате
            if (completedCar.phone && GREEN_INSTANCE && GREEN_TOKEN && GREEN_INSTANCE !== 'YOUR_GREEN_API_INSTANCE') {
                let cleanPhone = completedCar.phone.replace(/\D/g, '');
                if (cleanPhone.startsWith('8')) cleanPhone = '7' + cleanPhone.slice(1);

                const serviceName = service === 'injector' ? 'INJECTOR PRO' : 'ECU PERFORMANCE';
                const priceText = price ? `💰 **К оплате за ремонт:** ${price} ₸\n` : '';

                const readyMessage =
                    `Здравствуйте, ${completedCar.name}! 👋

✅ *Ваш автомобиль готов!*
🚗 **${completedCar.brand}** (${completedCar.carNum})
🛠 Услуга: [${serviceName}]
${priceText}
Можете приехать и забрать ваш автомобиль. Ждем вас! 🚘✨`;

                try {
                    await axios.post(`https://api.green-api.com/waInstance${GREEN_INSTANCE}/sendMessage/${GREEN_TOKEN}`, {
                        chatId: `${cleanPhone}@c.us`,
                        message: readyMessage
                    });
                    console.log(`[WhatsApp Ready] Уведомление о готовности с ценой отправлено ${cleanPhone}`);
                } catch (e) {
                    console.error('[WhatsApp Ready Error]', e.message);
                }
            }

            return res.json({ success: true, queueData });
        }
    }

    res.status(400).json({ success: false, error: 'Машина не найдена' });
});

// 5. Админ: Удаление готовой машины
app.post('/api/admin/remove-completed', (req, res) => {
    const { service, carNum } = req.body;
    if (queueData.completed[service]) {
        queueData.completed[service] = queueData.completed[service].filter(item => item.carNum !== carNum);
        return res.json({ success: true, queueData });
    }
    res.status(400).json({ success: false, error: 'Ошибка удаления' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});