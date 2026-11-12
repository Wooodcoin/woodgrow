// api/get-tasks.js

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
        // 1. Витягуємо список виконаних завдань саме ЦЬОГО користувача
        let completedTaskIds = [];
        if (userId) {
            const completedSnapshot = await db.ref(`users/${userId}/completed_tasks`).once('value');
            if (completedSnapshot.exists()) {
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

        // 3. Фільтруємо завдання (і реакції, і реферали)
        for (const key in allTasks) {
            const task = allTasks[key];
            const taskId = task.id || key;
            
            // Перевірка: чи є ID цього завдання в списку вже виконаних юзером
            const isAlreadyCompleted = completedTaskIds.includes(taskId);
            if (isAlreadyCompleted) continue;

            // Логіка для РЕФЕРАЛЬНИХ завдань (type === 'referral')
            if (task.type === 'referral') {
                const currentCount = parseInt(task.current_count || 0);
                const targetCount = parseInt(task.target_count || 5);

                if (currentCount < targetCount) {
                    // Перевіряємо також, чи користувач вже не надсилав звіт (pending/approved)
                    const subRef = db.ref(`task_submissions/${taskId}`);
                    const subSnap = await subRef.orderByChild('userId').equalTo(userId).once('value');
                    
                    let hasPendingOrApproved = false;
                    if (subSnap.exists()) {
                        subSnap.forEach(child => {
                            const sub = child.val();
                            if (sub.status === 'pending' || sub.status === 'approved') {
                                hasPendingOrApproved = true;
                            }
                        });
                    }

                    if (!hasPendingOrApproved) {
                        activeTasks.push({
                            id: taskId,
                            link: task.link,
                            reward: 0.002, // Фіксована нагорода за реферала
                            type: 'referral'
                        });
                    }
                }
            } 
            // Логіка для стандартних завдань (реакції / перегляди)
            else {
                if (
                    task.status === 'active' && 
                    parseInt(task.current_views || 0) < parseInt(task.required_views || 26)
                ) {
                    activeTasks.push({
                        id: taskId,
                        link: task.link,
                        reward: task.reward || 0.0005,
                        type: 'reaction'
                    });
                }
            }
        }

        // Повертаємо об'єднаний список активних завдань
        return res.status(200).json({ success: true, tasks: activeTasks });

    } catch (error) {
        console.error("Error fetching tasks:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
