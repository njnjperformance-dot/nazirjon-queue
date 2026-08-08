const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Хранилище очереди (хранится непрерывно)
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] },
    completed: { injector: [], ecu: [] }
};

// Перерасчет позиций в очереди
function recalculatePositions(service) {
    const offset = queueData.pending[service] || 0;
    queueData.list[service].forEach((item, index) => {
        item.pos = offset + index + 1;
    });
}

// 1. Получить данные очереди
app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// 2. Регистрация нового клиента (он встаёт в конец существующей цепи)
app.post('/api/register', (req, res) => {
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
        carNum,
        phone,
        pos,
        dateAdded: new Date().toLocaleDateString('ru-RU') // Запоминаем дату записи
    };

    queueData.list[service].push(newClient);
    res.json({ success: true, pos, queueData });
});

// 3. Добавление вчерашней / приоритетной машины вручную
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

// 4. Перенос ВЧЕРАШНЕЙ/ПРИОРИТЕТНОЙ машины в ГОТОВЫЕ
app.post('/api/admin/complete-yesterday', (req, res) => {
    const { service, price } = req.body;

    if (queueData.pending[service] > 0) {
        queueData.pending[service] -= 1;
        recalculatePositions(service);

        const formattedPrice = price ? `${price} ₸` : 'Уточняйте у мастера';
        const completedCar = {
            id: 'yesterday_' + Date.now(),
            brand: 'Приоритетный ремонт (Долгоиграющий)',
            carNum: 'ПРИОРИТЕТ',
            price: formattedPrice,
            completedTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        queueData.completed[service].push(completedCar);
        return res.json({ success: true, queueData });
    }

    res.status(400).json({ error: 'Нет приоритетных машин' });
});

// 5. Перенос ОБЫЧНОЙ машины в ГОТОВЫЕ (только когда мастер закончил!)
app.post('/api/admin/complete', (req, res) => {
    const { service, id, price } = req.body;

    if (queueData.list[service]) {
        const index = queueData.list[service].findIndex(item => item.id === id || String(item.pos) === String(id));

        if (index !== -1) {
            const [completedCar] = queueData.list[service].splice(index, 1);
            completedCar.completedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            completedCar.price = price ? `${price} ₸` : 'Уточняйте у мастера';

            queueData.completed[service].push(completedCar);
            recalculatePositions(service);

            return res.json({ success: true, queueData });
        }
    }

    res.status(400).json({ error: 'Машина не найдена' });
});

// 6. Удаление из списка готовых (после выдачи клиенту)
app.post('/api/admin/remove-completed', (req, res) => {
    const { service, carNum } = req.body;
    if (queueData.completed[service]) {
        queueData.completed[service] = queueData.completed[service].filter(item => item.carNum !== carNum);
        return res.json({ success: true, queueData });
    }
    res.status(400).json({ error: 'Ошибка удаления' });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});