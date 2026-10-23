import admin from 'firebase-admin';
import crypto from 'crypto';

// Ініціалізуємо Firebase Admin SDK (як і в інших файлах)
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
    
    const { userId, pointsEarned, initData } = req.body;
    if (!userId || pointsEarned === undefined || !initData) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

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
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        
        if (!userSnapshot.exists()) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = userSnapshot.val();
        let currentGamePoints = userData.game_points || 0;
        
        // Захист від неадекватних великих накруток за один запит
        const parsedPoints = parseInt(pointsEarned, 10);
        if (isNaN(parsedPoints) || parsedPoints <= 0 || parsedPoints > 500) {
            return res.status(400).json({ error: 'Invalid score value' });
        }

        // Додаємо нові бали до поточних у базі
        currentGamePoints += parsedPoints;

        // Зберігаємо оновлені бали у Firebase
        await userRef.update({
            game_points: currentGamePoints
        });

        return res.status(200).json({
            success: true,
            totalGamePoints: currentGamePoints
        });

    } catch (e) {
        console.error("Database error in game-score:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
