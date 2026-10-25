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

// Список можливих елементів комбо
const COMBO_ITEMS = ['seed', 'branch', 'bush', 'tree', 'drop', 'spot'];

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
        
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
            
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
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

        // 2. Генерація або отримання системного щоденного комбо на сьогодні
        const dailyComboRef = db.ref(`system_combo/${todayStr}`);
        const comboSnapshot = await dailyComboRef.once('value');
        let currentDailyCombo = comboSnapshot.val();

        if (!currentDailyCombo) {
            let shuffled = [...COMBO_ITEMS].sort(() => 0.5 - Math.random());
            currentDailyCombo = shuffled.slice(0, 3);
            await dailyComboRef.set(currentDailyCombo);
        }

        // 3. Отримання даних користувача
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        let user = userSnapshot.val();

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
                game_points: 0, // Бали WGC
                game_attempts: 10, // 10 безкоштовних спроб у Flappy
                snake_attempts: 5, // 5 безкоштовних спроб у Змійці
                last_game_date: todayStr,
                referred_by: referrerId, 
                ref_bonus: 0.0000,
                last_ad_date: todayStr,
                streak_day: 1,
                last_streak_date: '',
                last_combo_date: '',
                viewCounts: { service1: 0, service2: 0, support: 0 }
            };
            await userRef.set(user);

            await db.ref('system_stats/global/total_users').set(admin.database.ServerValue.increment(1));

            if (referrerId) {
                await db.ref(`referrals/${referrerId}/${userId}`).set(true);
            }
        }

        // 4. Перевірка оновлення спроб ігор при наступному дні
        let gameAttempts = user.game_attempts !== undefined ? user.game_attempts : 10;
        let snakeAttempts = user.snake_attempts !== undefined ? user.snake_attempts : 5;
        let lastGameDate = user.last_game_date || '';

        if (lastGameDate !== todayStr) {
            gameAttempts = 10; 
            snakeAttempts = 5; 
            await userRef.update({
                game_attempts: 10,
                snake_attempts: 5,
                last_game_date: todayStr
            });
        }

        // 5. Обробка логіки зміни дня для лічильників реклами
        let viewCounts = user.viewCounts || { service1: 0, service2: 0, support: 0 };
        let lastAdDate = user.last_ad_date || '';

        if (lastAdDate !== todayStr) {
            viewCounts = { service1: 0, service2: 0, support: 0 };
        }

        // 6. Перевірка статусу щоденного чекіну
        const lastStreakDate = user.last_streak_date || '';
        let currentStreakDay = user.streak_day || 1;

        if (lastStreakDate) {
            const lastDate = new Date(lastStreakDate);
            const currentDate = new Date(todayStr);
            const diffTime = currentDate - lastDate;
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays > 1) {
                currentStreakDay = 1;
            }
        }

        const streakClaimedToday = (lastStreakDate === todayStr);

        // 7. Перевірка статусу щоденного комбо
        const lastComboDate = user.last_combo_date || '';
        const comboTriedToday = (lastComboDate === todayStr);

        // 8. Підрахунок кількості рефералів
        const referralsRef = db.ref(`referrals/${userId}`);
        const referralsSnapshot = await referralsRef.once('value');
        let totalReferrals = 0;
        
        if (referralsSnapshot.exists()) {
            totalReferrals = referralsSnapshot.numChildren();
        }

        const userRole = user.role || 'user';

        let adminDailyCombo = null;
        if (userRole === 'admin' || userId === "6043278492") {
            adminDailyCombo = currentDailyCombo;
        }

        // Повертаємо ПОВНИЙ набір даних на фронтенд (включно зі snake_attempts)
        return res.status(200).json({
            success: true,
            role: userRole, 
            balance: parseFloat(user.balance) || 0.0000,
            game_points: parseInt(user.game_points) || 0,
            game_attempts: parseInt(gameAttempts) || 10,
            snake_attempts: parseInt(snakeAttempts) || 5,
            ref_bonus: parseFloat(user.ref_bonus) || 0.0000,
            ref_count: totalReferrals,
            viewCounts: viewCounts,
            streak_day: currentStreakDay,
            streak_claimed_today: streakClaimedToday,
            combo_tried_today: comboTriedToday,
            admin_combo: adminDailyCombo
        });

    } catch (e) {
        console.error("Database error in user fetch:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
