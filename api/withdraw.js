import admin from 'firebase-admin';

// Ініціалізуємо Firebase Admin SDK, якщо він ще не ініціалізований
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
    
    const { userId, initData, walletAddress } = req.body;
    
    // Перевіряємо наявність усіх необхідних параметрів (тепер передаємо і гаманець)
    if (!userId || !initData || !walletAddress) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    // 1. Валідація Telegram InitData (Захист від підміни даних)
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
        // 2. Отримуємо поточні дані користувача з гілки "users"
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const user = userSnapshot.val();

        if (!user) return res.status(444).json({ error: 'User not found' });

        const currentBalance = parseFloat(user.balance) || 0;

        // Перевірка на мінімальну суму виведення (5 USDT)
        if (currentBalance < 5.0) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // 3. ОБНУЛЯЄМО БАЛАНС КОРИСТУВАЧА В БАЗІ (Захист від повторних кліків)
        await userRef.update({
            balance: 0.0000
        });

        // 4. АВТОМАТИЧНО СТВОРЮЄМО ЗАПИС ЗАЯВКИ В ГІЛЦІ "withdraw_requests"
        const newRequestRef = db.ref('withdraw_requests').push(); // Генеруємо унікальний ID заявки
        
        const timestamp = new Date().toISOString(); // Фіксуємо точний час створення (UTC)

        await newRequestRef.set({
            requestId: newRequestRef.key,
            userId: userId,
            username: user.username || "Невказано",
            amount: currentBalance.toFixed(4),
            wallet: walletAddress,
            status: "pending", // статус за замовчуванням
            createdAt: timestamp
        });

        // Повертаємо успішну відповідь на фронтенд
        return res.status(200).json({
            success: true,
            message: 'Withdrawal request created successfully'
        });

    } catch (e) {
        console.error("Database error during withdrawal:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
