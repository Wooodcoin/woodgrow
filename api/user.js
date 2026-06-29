import admin from 'firebase-admin';

// Ініціалізуємо Firebase Admin SDK
if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        // Декодуємо Base64 ключ, якщо він зашифрований (починається на "ewog")
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
    // Дозволяємо тільки POST запити
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { userId, initData } = req.body;
    
    // Якщо клієнт не надіслав параметри, повертаємо 400
    if (!userId || !initData) return res.status(400).json({ error: 'Missing parameters' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    // 1. Валідація Telegram InitData (захист від злому)
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

    try {
        // 2. Отримання даних користувача (Гілка "users")
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        let user = userSnapshot.val();

        // Якщо користувача немає в базі, створюємо його автоматично
        if (!user) {
            let referrerId = null;
            const urlParams = new URLSearchParams(initData);
            const startParam = urlParams.get('start_param');
            if (startParam && startParam.trim() !== userId) {
                referrerId = startParam.trim();
            }

            user = { id: userId, balance: 0.0000, referred_by: referrerId, ref_bonus: 0.0000 };
            await userRef.set(user);

            // ЛІЧИЛЬНИК: Безпечно додаємо +1 до загальної статистики на сервері
            await db.ref('system_stats/global/total_users').set(admin.database.ServerValue.increment(1));

            if (referrerId) {
                await db.ref(`referrals/${referrerId}/${userId}`).set(true);
            }
        }

        // 3. Підрахунок кількості рефералів з гілки "referrals"
        const referralsRef = db.ref(`referrals/${userId}`);
        const referralsSnapshot = await referralsRef.once('value');
        let totalReferrals = 0;
        
        if (referralsSnapshot.exists()) {
            totalReferrals = referralsSnapshot.numChildren();
        }

        // Повертаємо дані на фронтенд (без total_users, як у Варіанті 1)
        return res.status(200).json({
            success: true,
            balance: parseFloat(user.balance) || 0.0000,
            ref_bonus: parseFloat(user.ref_bonus) || 0.0000,
            ref_count: totalReferrals
        });

    } catch (e) {
        console.error("Database error in user fetch:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
