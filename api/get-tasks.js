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
    // Дозволяємо лише GET запити для отримання даних
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // 1. Беремо всі завдання з гілки "tasks"
        const snapshot = await db.ref('tasks').once('value');
        if (!snapshot.exists()) {
            return res.status(200).json({ success: true, tasks: [] });
        }

        const allTasks = snapshot.val();
        const activeTasks = [];

        // 2. Фільтруємо завдання: залишаємо лише активні та з лімітом переглядів
        for (const key in allTasks) {
            const task = allTasks[key];
            
            if (
                task.status === 'active' && 
                parseInt(task.current_views || 0) < parseInt(task.required_views || 26)
            ) {
                // Віддаємо на фронтенд тільки безпечні дані, без ID творця
                activeTasks.push({
                    id: task.id,
                    link: task.link,
                    reward: task.reward || 0.0005
                });
            }
        }

        // Повертаємо масив активних завдань
        return res.status(200).json({ success: true, tasks: activeTasks });

    } catch (error) {
        console.error("Error fetching tasks:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
