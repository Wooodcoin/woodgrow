import admin from 'firebase-admin';
import crypto from 'crypto';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey && rawKey.startsWith('ewog') 
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
    if (!userId || !initData) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing (BOT_TOKEN)' });

    // Валідація Telegram InitData
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
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        
        if (!userSnapshot.exists()) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = userSnapshot.val();
        let gamePoints = parseInt(userData.game_points) || 0;
        let currentBalance = parseFloat(userData.balance) || 0;

        const EXCHANGE_RATE_WGC = 10000; // 10,000 WGC
        const EXCHANGE_REWARD_USDT = 0.01; // 0.01 USDT

        if (gamePoints < EXCHANGE_RATE_WGC) {
            return res.status(400).json({ error: 'Not enough WGC points for exchange' });
        }

        // Вираховуємо скільки повних блоків по 10000 можна обміняти
        const exchangeBlocks = Math.floor(gamePoints / EXCHANGE_RATE_WGC);
        const pointsToDeduct = exchangeBlocks * EXCHANGE_RATE_WGC;
        const usdtToAdd = exchangeBlocks * EXCHANGE_REWARD_USDT;

        gamePoints -= pointsToDeduct;
        currentBalance += usdtToAdd;

        // Оновлюємо дані в базі
        await userRef.update({
            game_points: gamePoints,
            balance: parseFloat(currentBalance.toFixed(4))
        });

        return res.status(200).json({
            success: true,
            newBalance: parseFloat(currentBalance.toFixed(4)),
            newGamePoints: gamePoints,
            addedUsdt: usdtToAdd
        });

    } catch (e) {
        console.error("Database error in exchange-game-points:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
