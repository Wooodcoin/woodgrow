import admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') 
            ? Buffer.from(rawKey, 'base64').toString('utf-8') 
            : rawKey;

        const serviceAccount = JSON.parse(decryptedKey);
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
        });
    } catch (error) {
        console.error('Firebase admin initialization error:', error);
    }
}

const db = admin.database();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BATCH_SIZE = 20; // Кількість користувачів за одну хвилину

export default async function handler(req, res) {
    // Безпека: Перевіряємо наш ключ з URL-параметрів (?secret=...)
    const { searchParams } = new URL(req.url, `https://${req.headers.get('host')}`);
    const secret = searchParams.get('secret');

    if (secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const taskRef = db.ref('broadcast_tasks/active_task');
        const taskSnapshot = await taskRef.once('value');
        const task = taskSnapshot.val();

        // Якщо завдання немає або воно вже завершене — нічого не робимо
        if (!task || task.status === 'completed') {
            return res.status(200).json({ message: 'No active tasks' });
        }

        // Беремо користувачів з бази, сортуючи за їхнім ID
        let query = db.ref('users').orderByKey();
        
        // Якщо ми вже когось обробили в минулій пачці, починаємо після цього користувача
        if (task.last_processed_user_id) {
            query = query.startAfter(task.last_processed_user_id);
        }
        
        const usersSnapshot = await query.limitToFirst(BATCH_SIZE).once('value');
        const users = usersSnapshot.val();

        // Якщо нових користувачів немає — розсилку завершено
        if (!users) {
            await taskRef.update({ status: 'completed' });
            return res.status(200).json({ message: 'Broadcast completed. No more users.' });
        }

        let lastId = task.last_processed_user_id;

        // Перебираємо користувачів у пачці та відправляємо повідомлення
        for (const userId in users) {
            try {
                // Відправляємо запит до Telegram API з підтримкою HTML
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        chat_id: userId, 
                        text: task.text,
                        parse_mode: 'HTML' // Дозволяє використовувати <b>, <i>, <a href='...'>
                    })
                });
            } catch (e) {
                console.error(`Failed to send message to user ${userId}:`, e);
            }
            // Фіксуємо ID останнього користувача, якому намагалися відправити
            lastId = userId;
        }

        // Оновлюємо статус у базі, щоб наступна хвилина почалася з нового місця
        await taskRef.update({ 
            last_processed_user_id: lastId,
            status: 'processing'
        });

        return res.status(200).json({ message: `Batch processed successfully up to ID: ${lastId}` });

    } catch (error) {
        console.error("Cron broadcast general error:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
