import admin from 'firebase-admin';

if (!admin.apps.length) {
    const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
    const decryptedKey = rawKey.startsWith('ewog') ? Buffer.from(rawKey, 'base64').toString('utf-8') : rawKey;
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(decryptedKey)),
        databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
    });
}

const db = admin.database();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BATCH_SIZE = 20; // Кількість повідомлень за один запуск

export default async function handler(req, res) {
    // Безпека: перевіряємо секретний заголовок (налаштуємо його в Vercel пізніше)
    if (req.headers.get('x-vercel-cron-secret') !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskRef = db.ref('broadcast_tasks/active_task');
    const taskSnapshot = await taskRef.once('value');
    const task = taskSnapshot.val();

    if (!task || task.status === 'completed') {
        return res.status(200).json({ message: 'No active tasks' });
    }

    // Отримуємо пачку користувачів
    let query = db.ref('users').orderByKey();
    if (task.last_processed_user_id) {
        query = query.startAfter(task.last_processed_user_id);
    }
    
    const usersSnapshot = await query.limitToFirst(BATCH_SIZE).once('value');
    const users = usersSnapshot.val();

    if (!users) {
        await taskRef.update({ status: 'completed' });
        return res.status(200).json({ message: 'Broadcast completed' });
    }

    // Відправляємо повідомлення
    let lastId = task.last_processed_user_id;
    for (const userId in users) {
        try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: userId, text: task.text })
            });
        } catch (e) {
            console.error(`Failed to send to ${userId}:`, e);
        }
        lastId = userId;
    }

    // Оновлюємо стан завдання
    await taskRef.update({ last_processed_user_id: lastId });

    return res.status(200).json({ message: `Batch processed up to ${lastId}` });
}
