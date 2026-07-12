import admin from 'firebase-admin';

// Ініціалізуємо Firebase Admin SDK (так само, як у твоєму user.js)
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
const ADMIN_ID = "6043278492"; // Твій зафіксований ID для безпеки

export default async function handler(req, res) {
    // Дозволяємо тільки POST-запити
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const { userId, messageText } = req.body;

    // 1. Перевірка параметрів
    if (!userId || !messageText) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    // 2. Жорстка перевірка на адміна
    if (String(userId) !== ADMIN_ID) {
        return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    try {
        // 3. Записуємо нове завдання в гілку broadcast_tasks
        const taskRef = db.ref('broadcast_tasks/active_task');
        
        await taskRef.set({
            text: messageText,
            last_processed_user_id: "", // Спочатку пустий рядок, щоб почати з першого користувача
            status: "pending",          // Статус: очікує виконання
            created_at: new Date().toISOString()
        });

        return res.status(200).json({
            success: true,
            message: 'Broadcast task successfully created and queued!'
        });

    } catch (e) {
        console.error("Error creating broadcast task:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
