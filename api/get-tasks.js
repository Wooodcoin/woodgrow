import admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') ? Buffer.from(rawKey, 'base64').toString('utf-8') : rawKey;
        const serviceAccount = JSON.parse(decryptedKey);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
        });
    } catch (error) {
        console.error('Firebase init error:', error);
    }
}

const db = admin.database();

export default async function handler(req, res) {
    // Дозволяємо лише GET запити
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Отримуємо ID користувача з query-параметрів (запиту)
    const { userId } = req.query;

    try {
        // 1. Спочатку витягуємо список виконаних завдань саме ЦЬОГО користувача
        let completedTaskIds = [];
        if (userId) {
            const completedSnapshot = await db.ref(`users/${userId}/completed_tasks`).once('value');
            if (completedSnapshot.exists()) {
                // Отримуємо ключі (ID завдань), де значення є true
                completedTaskIds = Object.keys(completedSnapshot.val());
            }
        }

        // 2. Беремо всі глобальні завдання з гілки "tasks"
        const snapshot = await db.ref('tasks').once('value');
        if (!snapshot.exists()) {
            return res.status(200).json({ success: true, tasks: [] });
        }

        const allTasks = snapshot.val();
        const activeTasks = [];

        // 3. Фільтруємо завдання за твоїми правилами + додаємо перевірку на виконання
        for (const key in allTasks) {
            const task = allTasks[key];
            
            // ПЕРЕВІРКА: чи є ID цього завдання в списку вже виконаних юзером
            const isAlreadyCompleted = completedTaskIds.includes(task.id);

            if (
                task.status === 'active' && 
                !isAlreadyCompleted && // <--- НОВА УМОВА: Пропускаємо, якщо вже виконано
                parseInt(task.current_views || 0) < parseInt(task.required_views || 26)
            ) {
                // Віддаємо на фронтенд тільки безпечні дані
                activeTasks.push({
                    id: task.id,
                    link: task.link,
                    reward: task.reward || 0.0005
                });
            }
        }

        // Повертаємо масив тільки тих активних завдань, які юзер ще НЕ робив
        return res.status(200).json({ success: true, tasks: activeTasks });

    } catch (error) {
        console.error("Error fetching tasks:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
