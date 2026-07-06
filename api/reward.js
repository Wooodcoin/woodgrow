import admin from 'firebase-admin';

// Ініціалізуємо Firebase Admin SDK, якщо він ще не ініціалізований
if (!admin.apps.length) {
    try {
        const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        if (!base64Key) {
            console.error('КРИТИЧНА ПОМИЛКА: Змінна FIREBASE_SERVICE_ACCOUNT порожня у Vercel!');
        } else {
            const decodedJson = Buffer.from(base64Key, 'base64').toString('utf-8');
            const serviceAccount = JSON.parse(decodedJson);
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
            });
        }
    } catch (error) {
        console.error('Firebase admin initialization error:', error);
    }
}

const db = admin.database();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, serviceKey, initData } = req.body;
    if (!userId || !serviceKey || !initData) return res.status(400).json({ error: 'Missing parameters' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    // 1. Валідація Telegram InitData
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries()).map(([k, v]) => `${k}=${v}`).sort().join('\n');
        const encoder = new TextEncoder();
        const secretKeyMaterial = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const secretKeyBuffer = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(BOT_TOKEN));
        const checkKeyMaterial = await crypto.subtle.importKey("raw", secretKeyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signatureBuffer = await crypto.subtle.sign("HMAC", checkKeyMaterial, encoder.encode(dataCheckString));
        const calculatedHash = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (calculatedHash !== hash) return res.status(403).json({ error: 'Auth failed' });
    } catch (err) {
        return res.status(500).json({ error: 'Telegram validation error' });
    }

    // Нагороди в USDT
    const configRewards = { service1: 0.0004, service2: 0.0002, service3: 0.0002, service4: 0.0004, support: 0.0000 };
    const reward = configRewards[serviceKey];
    if (reward === undefined) return res.status(400).json({ error: 'Invalid service' });

    try {
        const now = Date.now();
        const cooldownTime = 120 * 1000; // 120 секунд
        const todayStr = new Date().toISOString().split('T')[0]; // Поточна дата (РРРР-ММ-ДД)

        // 2. Отримання даних користувача
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const user = userSnapshot.val();

        if (!user) return res.status(404).json({ error: 'User not found' });

        let currentBalance = parseFloat(user.balance) || 0;
        let referredBy = user.referred_by || null;
        let viewCounts = user.viewCounts || { service1: 0, service2: 0, service3: 0, service4: 0, support: 0 };
        let lastAdDate = user.last_ad_date || '';

        // Якщо настав новий календарний день — повністю скидаємо лічильники
        if (lastAdDate !== todayStr) {
            viewCounts = { service1: 0, service2: 0, service3: 0, service4: 0, support: 0 };
            lastAdDate = todayStr;
            // Видаляємо вчорашні кулдауни, щоб не блокувати перші кліки нового дня
            await db.ref(`users/${userId}/last_clicks`).remove();
        } else {
            // Перевірка таймауту ТІЛЬКИ якщо день той самий
            const lastClickRef = db.ref(`users/${userId}/last_clicks/${serviceKey}`);
            const lastClickSnapshot = await lastClickRef.once('value');
            const lastClickTime = lastClickSnapshot.val();

            if (lastClickTime && (now - lastClickTime < cooldownTime)) {
                const timeLeft = Math.ceil((cooldownTime - (now - lastClickTime)) / 1000);
                return res.status(429).json({ error: `Зачекайте ще ${timeLeft} сек!` });
            }
        }

        let currentViews = parseInt(viewCounts[serviceKey]) || 0;

        // Якщо ліміт 20 вже досягнуто — повертаємо актуальні лічильники і не нараховуємо баланс
        if (serviceKey !== 'support' && currentViews >= 20) {
            return res.status(200).json({ success: true, newBalance: currentBalance, viewCounts: viewCounts, message: 'Limit already reached' });
        }

        // 3. Оновлюємо час останнього кліку
        await db.ref(`users/${userId}/last_clicks/${serviceKey}`).set(now);

        const newBalance = currentBalance + reward;
        const newViews = currentViews + 1;
        
        viewCounts[serviceKey] = newViews;
        
        const updates = { 
            balance: newBalance,
            last_ad_date: todayStr, 
            viewCounts: viewCounts
        };
        
        await userRef.update(updates);

        // 4. Реферальний бонус (+10% USDT)
        if (referredBy && reward > 0) {
            const referrerRef = db.ref(`users/${referredBy}`);
            const referrerSnapshot = await referrerRef.once('value');
            const referrerData = referrerSnapshot.val();

            if (referrerData) {
                let refBonus = reward * 0.10;
                let newRefBalance = (parseFloat(referrerData.balance) || 0) + refBonus;
                let newRefBonusTotal = (parseFloat(referrerData.ref_bonus) || 0) + refBonus;
                
                await referrerRef.update({
                    balance: newRefBalance,
                    ref_bonus: newRefBonusTotal
                });
            }
        }

        // Повертаємо оновлений баланс і синхронізовані лічильники
        return res.status(200).json({ success: true, newBalance: newBalance, viewCounts: viewCounts });
    } catch (e) {
        console.error("Database error:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
