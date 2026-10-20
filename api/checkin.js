import admin from 'firebase-admin';
import crypto from 'crypto';

// Ініціалізуємо Firebase Admin SDK
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

// Таблиця нагород за кожен день чекіну (від 1 до 7)
const STREAK_REWARDS = {
    1: 0.0001,
    2: 0.0001,
    3: 0.0002,
    4: 0.0002,
    5: 0.0003,
    6: 0.0004,
    7: 0.0005
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { userId, initData } = req.body;
    if (!userId || !initData) return res.status(400).json({ error: 'Missing parameters' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing (BOT_TOKEN)' });

    // 1. Валідація Telegram InitData
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
            
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        if (calculatedHash !== hash) {
            return res.status(403).json({ error: 'Auth failed' });
        }
    } catch (err) {
        console.error('Telegram validation error:', err);
        return res.status(500).json({ error: 'Telegram validation error: ' + err.message });
    }

    try {
        const todayStr = new Date().toISOString().split('T')[0]; // Поточна дата (РРРР-ММ-ДД)

        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        let user = userSnapshot.val();

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        let lastStreakDate = user.last_streak_date || '';
        let currentStreakDay = user.streak_day || 1;

        // Перевірка на пропуск дня
        if (lastStreakDate) {
            const lastDate = new Date(lastStreakDate);
            const currentDate = new Date(todayStr);
            const diffTime = currentDate - lastDate;
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

            // Якщо юзер пропустив більше 1 дня — скидаємо стрічку на 1
            if (diffDays > 1) {
                currentStreakDay = 1;
            }
        }

        // Перевірка, чи не забрав уже сьогодні
        if (lastStreakDate === todayStr) {
            return res.status(400).json({ error: 'Already claimed today' });
        }

        // Визначаємо винагороду для поточного дня
        const rewardAmount = STREAK_REWARDS[currentStreakDay] || 0.0001;
        const currentBalance = parseFloat(user.balance) || 0.0000;
        const newBalance = currentBalance + rewardAmount;

        // Розраховуємо наступний день стрічки (якщо це був 7-й день, повертаємось на 1)
        const nextStreakDay = currentStreakDay >= 7 ? 1 : currentStreakDay + 1;

        // Оновлюємо дані в базі
        await userRef.update({
            balance: newBalance,
            streak_day: nextStreakDay,
            last_streak_date: todayStr
        });

        return res.status(200).json({
            success: true,
            newBalance: newBalance,
            nextStreakDay: nextStreakDay,
            rewardAmount: rewardAmount
        });

    } catch (e) {
        console.error("Database error in checkin:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
