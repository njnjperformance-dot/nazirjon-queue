const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

// Начальная структура данных
let queueData = {
    pending: { injector: 0, ecu: 0 },
    list: { injector: [], ecu: [] },
    completed: { injector: [], ecu: [] },
    dailyReport: {
        totalEarned: 0,
        workEarned: 0,
        partsEarned: 0,
        history: [],
        archive: [] // Хранение закрытых смен прошлых дней
    }
};

// Загрузка данных из файла
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            queueData = { ...queueData, ...fileData };
            if (!queueData.dailyReport.archive) {
                queueData.dailyReport.archive = [];
            }
        } catch (e) {
            console.error('Ошибка чтения data.json:', e);
        }
    }
}

// Сохранение данных в файл
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

    // Обнуляем кассу за день
    rep.totalEarned = 0;
    rep.workEarned = 0;
    rep.partsEarned = 0;
    rep.history = [];

    saveData();
}

// 🌙 Автоматический сброс смены в полночь (00:00) по часовому поясу Казахстана (UTC+5)
// На серверах Render (UTC) 00:00 UTC+5 соответствуют 19:00 UTC
cron.schedule('0 19 * * *', () => {
    console.log('🌙 [CRON] Автоматическое закрытие смены в полночь...');
    closeShiftInternal();
});

// --- API МАРШРУТЫ ---

// Получить данные очереди и отчёта
app.get('/api/queue', (req, res) => {
    res.json(queueData);
});

// Запись клиента через сайт
app.post('/api/register', (req, res) => {
    const { service, name, brand, carNum, phone } = req.body;
    if (!service || !name || !brand || !carNum || !phone) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const targetList = queueData.list[service];
    const isExist = targetList.some(item => item.carNum.toLowerCase() === carNum.toLowerCase());

    if (isExist) {
        return res.status(400).json({ error: 'Автомобиль с таким гос. номером уже есть в очереди!' });
    }

    const newPos = targetList.length + 1;
    const newItem = {
        id: Date.now().toString(),
        pos: newPos,
        name,
        brand,
        carNum,
        phone,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    targetList.push(newItem);
    saveData();

    res.json({ success: true, pos: newPos, item: newItem });
});

// Изменение кол-ва ожидания у ворот (Админ)
app.post('/api/admin/pending', (req, res) => {
    const { service, action } = req.body;
    if (action === 'inc') queueData.pending[service]++;
    if (action === 'dec' && queueData.pending[service] > 0) queueData.pending[service]--;
    saveData();
    res.json({ success: true, pending: queueData.pending });
});

// Перевод авто из ожидания в активную очередь (Админ)
app.post('/api/admin/add-from-pending', (req, res) => {
    const { service } = req.body;
    if (queueData.pending[service] > 0) {
        queueData.pending[service]--;
        const newPos = queueData.list[service].length + 1;
        queueData.list[service].push({
            id: Date.now().toString(),
            pos: newPos,
            brand: 'Авто у ворот',
            carNum: 'БЕЗ НОМЕРА',
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        });
        saveData();
    }
    res.json({ success: true, queueData });
});

// Перемещение позиции в очереди (Админ)
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

    // Пересчёт номеров позиций
    list.forEach((item, i) => item.pos = i + 1);
    saveData();
    res.json({ success: true, queueData });
});

// Расчёт и перевод в готовые (Админ)
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

    // Пересчёт позиций в оставшейся очереди
    list.forEach((it, i) => it.pos = i + 1);

    // Добавление в готовые
    queueData.completed[service].unshift(item);

    // Фиксация в кассовом отчёте
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

// Удаление из очереди / готовых (Админ)
app.post('/api/admin/delete', (req, res) => {
    const { service, index, type } = req.body; // type: 'list' или 'completed'
    if (type === 'list') {
        queueData.list[service].splice(index, 1);
        queueData.list[service].forEach((it, i) => it.pos = i + 1);
    } else if (type === 'completed') {
        queueData.completed[service].splice(index, 1);
    }
    saveData();
    res.json({ success: true, queueData });
});

// Полная очистка очереди / готовых (Админ)
app.post('/api/admin/clear-all', (req, res) => {
    const { type } = req.body; // 'queue' или 'completed'
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

// Ручное закрытие смены (Админ)
app.post('/api/admin/close-shift', (req, res) => {
    closeShiftInternal();
    res.json({ success: true, queueData });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));