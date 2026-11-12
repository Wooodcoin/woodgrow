// api/get-referral-tasks.js

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
        console.error('Firebase initialization error:', error);
    }
}

const db = admin.database();

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        const tasksRef = db.ref('tasks');
        const tasksSnap = await tasksRef.once('value');

        if (!tasksSnap.exists()) {
            return res.status(200).json({ success: true, tasks: [] });
        }

        const tasksData = tasksSnap.val();
        const availableTasks = [];

        for (const [taskId, task] of Object.entries(tasksData)) {
            // Фільтруємо: тільки реферальні завдання, які ще не досягли ліміту
            if (task.type === 'referral') {
                const currentCount = task.current_count || 0;
                const targetCount = task.target_count || 5; // пакет 5, 10 або 20

                if (currentCount < targetCount) {
                    // Перевіряємо, чи цей користувач вже не виконував або не відправляв звіт по цьому завданню
                    const subRef = db.ref(`task_submissions/${taskId}`);
                    const subSnap = await subRef.orderByChild('userId').equalTo(userId).once('value');

                    let alreadySubmitted = false;
                    if (subSnap.exists()) {
                        // Якщо є сабміт, перевіряємо чи він не був відхилений (якщо відхилений, можливо дати шанс, але поки пропустимо якщо pending/approved)
                        subSnap.forEach(child => {
                            const sub = child.val();
                            if (sub.status === 'pending' || sub.status === 'approved') {
                                alreadySubmitted = true;
                            }
                        });
                    }

                    if (!alreadySubmitted) {
                        availableTasks.push({
                            id: taskId,
                            link: task.link,
                            reward: 0.002, // Фіксована винагорода виконавцю
                            targetCount: targetCount,
                            currentCount: currentCount
                        });
                    }
                }
            }
        }

        return res.status(200).json({
            success: true,
            tasks: availableTasks
        });

    } catch (e) {
        console.error("Error fetching referral tasks:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
