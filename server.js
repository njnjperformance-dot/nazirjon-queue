const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Отдаем файлы из корневой папки проекта
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data.json');

// Структура данных
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] },
    completed: { injector: [], ecu: [] },
    dailyReport: {
        totalEarned: 0,
        workEarned: 0,
        partsEarned: 0,
        history: [],
        archive: []
    }
};

// Загрузка данных из файла data.json
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            queueData = { ...queueData, ...fileData };
            if (!queueData.dailyReport.archive) queueData.dailyReport.archive = [];
            if (!queueData.completed) queueData.completed = { injector: [], ecu: [] };
            if (!queueData.list) queueData.list = { injector: [], ecu: [] };
        } catch (e) {
            console.error('Ошибка чтения data.json:', e);
        }
    }
}

// Сохранение данных в файл data.json
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(queueData, null, 2), 'utf8');
    } catch (e) {
        console.error('Ошибка сохранения data.json:', e);
    }
}

loadData();

// Внутренняя функция закрытия смены
function closeShiftInternal() {
    const rep = queueData.dailyReport;
    if (rep.totalEarned > 0 || (rep.history && rep.history.length > 0)) {
        const todayStr = new Date().toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        rep.archive.unshift({
            date: todayStr,
            total: rep.totalEarned,
            work: rep.workEarned,
            parts: rep.partsEarned,
            count: rep.history.length
        });
    }

    rep.totalEarned = 0;
    rep.workEarned = 0;
    rep.partsEarned = 0;
    rep.history = [];

    saveData();
}

// Сброс смены в полночь (00:00 UTC+5)
cron.schedule('0 19 * * *', () => {
    console.log('🌙 [CRON] Автоматическое закрытие смены...');
    closeShiftInternal();
});

// --- API МАРШРУТЫ ---

// 1. Получить данные очереди
app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// 2. Регистрация клиента с формы
app.post('/api/register', (req, res) => {
    const { service, name, brand, carNum, phone } = req.body;
    if (!service || !name || !brand || !carNum || !phone) {
        return res.status(400).json({ error: 'Заполните все поля!' });
    }

    if (!queueData.list[service]) {
        queueData.list[service] = [];
    }

    const targetList = queueData.list[service];
    const cleanCar = carNum.toString().toUpperCase().replace(/\s+/g, '');
    const cleanPhone = phone.toString().replace(/\D/g, '');

    // Проверка дубликатов по всем активным очередям
    const allActive = [...(queueData.list.injector || []), ...(queueData.list.ecu || [])];
    const isExist = allActive.some(item => {
        const itemCar = item.carNum.toString().toUpperCase().replace(/\s+/g, '');
        const itemPhone = item.phone ? item.phone.toString().replace(/\D/g, '') : '';
        return itemCar === cleanCar || (cleanPhone && itemPhone === cleanPhone);
    });

    if (isExist) {
        return res.status(400).json({ error: 'Вы или ваш автомобиль уже состоите в очереди!' });
    }

    const offset = queueData.pending[service] || 0;
    const newPos = offset + targetList.length + 1;
    const newItem = {
        id: Date.now().toString(),
        pos: newPos,
        name,
        brand,
        carNum: carNum.toUpperCase(),
        phone,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    targetList.push(newItem);
    saveData();

    res.json({ success: true, pos: newPos, item: newItem });
});

// 3. Админ: Счетчик ожидающих у ворот
app.post('/api/admin/pending', (req, res) => {
    const { service, action } = req.body;
    if (action === 'inc') queueData.pending[service]++;
    if (action === 'dec' && queueData.pending[service] > 0) queueData.pending[service]--;
    saveData();
    res.json({ success: true, pending: queueData.pending });
});

// 4. Админ: Добавить из ожидания
app.post('/api/admin/add-from-pending', (req, res) => {
    const { service } = req.body;
    if (queueData.pending[service] > 0) {
        queueData.pending[service]--;
        const offset = queueData.pending[service] || 0;
        const newPos = offset + queueData.list[service].length + 1;
        queueData.list[service].push({
            id: Date.now().toString(),
            pos: newPos,
            name: 'Вчерашний / Долгий',
            brand: 'Авто у ворот',
            carNum: 'ПРИОРИТЕТ',
            phone: '',
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        });
        saveData();
    }
    res.json({ success: true, queueData });
});

// 5. Админ: Перемещение позиции (вверх/вниз)
app.post('/api/admin/move', (req, res) => {
    const { service, index, direction } = req.body;
    const list = queueData.list[service];

    if (direction === 'up' && index > 0) {
        const temp = list[index];
        list[index] = list[index - 1];
        list[index - 1] = temp;
    } else if (direction === 'down' && index < list.length - 1) {
        const temp = list[index];
        list[index] = list[index + 1];
        list[index + 1] = temp;
    }

    const offset = queueData.pending[service] || 0;
    list.forEach((item, i) => item.pos = offset + i + 1);
    saveData();
    res.json({ success: true, queueData });
});

// 6. Админ: Расчёт и перевод в готовые
app.post('/api/admin/complete', (req, res) => {
    const { service, index, workAmount, partsAmount } = req.body;
    const list = queueData.list[service];

    if (index < 0 || index >= list.length) {
        return res.status(400).json({ error: 'Автомобиль не найден' });
    }

    const work = Number(workAmount) || 0;
    const parts = Number(partsAmount) || 0;
    const total = work + parts;

    const [item] = list.splice(index, 1);

    const offset = queueData.pending[service] || 0;
    list.forEach((it, i) => it.pos = offset + i + 1);

    if (!queueData.completed[service]) queueData.completed[service] = [];
    queueData.completed[service].unshift(item);

    const rep = queueData.dailyReport;
    rep.totalEarned += total;
    rep.workEarned += work;
    rep.partsEarned += parts;
    rep.history.push({
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        brand: item.brand,
        carNum: item.carNum,
        work,
        parts,
        total
    });

    saveData();
    res.json({ success: true, queueData });
});

// 7. Админ: Удаление записи
app.post('/api/admin/delete', (req, res) => {
    const { service, index, type } = req.body;
    if (type === 'list' && queueData.list[service]) {
        queueData.list[service].splice(index, 1);
        const offset = queueData.pending[service] || 0;
        queueData.list[service].forEach((it, i) => it.pos = offset + i + 1);
    } else if (type === 'completed' && queueData.completed[service]) {
        queueData.completed[service].splice(index, 1);
    }
    saveData();
    res.json({ success: true, queueData });
});

// 8. Админ: Очистить готовые
app.post('/api/admin/clear-all', (req, res) => {
    const { type } = req.body;
    if (type === 'queue') {
        queueData.list.injector = [];
        queueData.list.ecu = [];
        queueData.pending.injector = 0;
        queueData.pending.ecu = 0;
    } else if (type === 'completed') {
        queueData.completed.injector = [];
        queueData.completed.ecu = [];
    }
    saveData();
    res.json({ success: true, queueData });
});

// 9. Админ: Закрыть смену вручную
app.post('/api/admin/close-shift', (req, res) => {
    closeShiftInternal();
    res.json({ success: true, queueData });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));