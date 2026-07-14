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

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { userId, initData } = req.body;
    if (!userId || !initData) return res.status(400).json({ error: 'Missing parameters' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing (BOT_TOKEN)' });

    // 1. Валідація Telegram InitData через стандартний crypto Node.js
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        // Сортуємо параметри в алфавітному порядку
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
            
        // Обчислюємо секретний ключ на основі токена бота
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        // Обчислюємо фінальний хеш рядка даних
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        if (calculatedHash !== hash) {
            console.error(`Auth failed for user ${userId}. Calculated: ${calculatedHash}, received: ${hash}`);
            return res.status(403).json({ error: 'Auth failed' });
        }
    } catch (err) {
        console.error('Telegram validation error:', err);
        return res.status(500).json({ error: 'Telegram validation error: ' + err.message });
    }

    try {
        const todayStr = new Date().toISOString().split('T')[0]; // Поточна дата (РРРР-ММ-ДД)

        // 2. Отримання даних користувача
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        let user = userSnapshot.val();

        // Якщо користувача немає в базі, створюємо його
        if (!user) {
            let referrerId = null;
            const urlParams = new URLSearchParams(initData);
            const startParam = urlParams.get('start_param');
            if (startParam && startParam.trim() !== userId) {
                referrerId = startParam.trim();
            }

            user = { 
                id: userId, 
                role: 'user', 
                balance: 0.0000, 
                referred_by: referrerId, 
                ref_bonus: 0.0000,
                last_ad_date: todayStr,
                super_bonus_date: '',
                viewCounts: { service1: 0, service2: 0, service3: 0, service4: 0, support: 0 }
            };
            await userRef.set(user);

            await db.ref('system_stats/global/total_users').set(admin.database.ServerValue.increment(1));

            if (referrerId) {
                await db.ref(`referrals/${referrerId}/${userId}`).set(true);
            }
        }

        // 3. Обробка логіки зміни дня для лічильників реклами
        let viewCounts = user.viewCounts || { service1: 0, service2: 0, service3: 0, service4: 0, support: 0 };
        let lastAdDate = user.last_ad_date || '';

        if (lastAdDate !== todayStr) {
            viewCounts = { service1: 0, service2: 0, service3: 0, service4: 0, support: 0 };
        }

        const superBonusDate = user.super_bonus_date || '';
        const superBonusClaimedToday = (superBonusDate === todayStr);

        // 4. Підрахунок кількості рефералів
        const referralsRef = db.ref(`referrals/${userId}`);
        const referralsSnapshot = await referralsRef.once('value');
        let totalReferrals = 0;
        
        if (referralsSnapshot.exists()) {
            totalReferrals = referralsSnapshot.numChildren();
        }

        // Визначаємо роль користувача з бази даних
        const userRole = user.role || 'user';

        // Повертаємо ПОВНИЙ набір даних на фронтенд
        return res.status(200).json({
            success: true,
            role: userRole, 
            balance: parseFloat(user.balance) || 0.0000,
            ref_bonus: parseFloat(user.ref_bonus) || 0.0000,
            ref_count: totalReferrals,
            viewCounts: viewCounts,
            super_bonus_claimed_today: superBonusClaimedToday
        });

    } catch (e) {
        console.error("Database error in user fetch:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
