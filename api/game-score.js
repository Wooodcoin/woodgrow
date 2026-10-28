import admin from 'firebase-admin';
import crypto from 'crypto';

// Ініціалізуємо Firebase Admin SDK
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
    
    const { userId, pointsEarned, durationSeconds, gameName, initData, action } = req.body;
    if (!userId || !initData || !gameName) {
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
        
        let currentSnakeAttempts = userData.snake_attempts !== undefined ? userData.snake_attempts : 5;
        let currentGameAttempts = userData.game_attempts !== undefined ? userData.game_attempts : 10;
        let currentTowerAttempts = userData.tower_attempts !== undefined ? userData.tower_attempts : 5;

        // Дія: старт гри (списання спроби на сервері одразу при натисканні Старт)
        if (action === 'start_game') {
            if (gameName === 'snake') {
                if (currentSnakeAttempts <= 0) return res.status(400).json({ error: 'No attempts left' });
                currentSnakeAttempts -= 1;
                await userRef.update({ snake_attempts: currentSnakeAttempts });
            } else if (gameName === 'flappy') {
                if (currentGameAttempts <= 0) return res.status(400).json({ error: 'No attempts left' });
                currentGameAttempts -= 1;
                await userRef.update({ game_attempts: currentGameAttempts });
            } else if (gameName === 'tower_stack') {
                if (currentTowerAttempts <= 0) return res.status(400).json({ error: 'No attempts left' });
                currentTowerAttempts -= 1;
                await userRef.update({ tower_attempts: currentTowerAttempts });
            }

            return res.status(200).json({
                success: true,
                snake_attempts: currentSnakeAttempts,
                game_attempts: currentGameAttempts,
                tower_attempts: currentTowerAttempts
            });
        }

        // Дія: додавання спроб за перегляд реклами (+5 спроб)
        if (action === 'add_attempts') {
            if (gameName === 'snake') {
                currentSnakeAttempts += 5;
                await userRef.update({ snake_attempts: currentSnakeAttempts });
            } else if (gameName === 'flappy') {
                currentGameAttempts += 5;
                await userRef.update({ game_attempts: currentGameAttempts });
            } else if (gameName === 'tower_stack') {
                currentTowerAttempts += 5;
                await userRef.update({ tower_attempts: currentTowerAttempts });
            }

            return res.status(200).json({
                success: true,
                snake_attempts: currentSnakeAttempts,
                game_attempts: currentGameAttempts,
                tower_attempts: currentTowerAttempts
            });
        }

        // Стандартна логіка збереження результатів гри (нарахування очок при закінченні)
        let currentGamePoints = userData.game_points || 0;
        let totalPlayTime = userData.total_play_time_seconds || 0;
        let totalGamesPlayed = userData.total_games_played || 0;
        
        const parsedPoints = parseInt(pointsEarned, 10) || 0;
        if (parsedPoints < 0 || parsedPoints > 500) {
            return res.status(400).json({ error: 'Invalid score value' });
        }

        currentGamePoints += parsedPoints;
        totalGamesPlayed += 1;

        if (durationSeconds && !isNaN(durationSeconds)) {
            totalPlayTime += parseInt(durationSeconds, 10);
        }

        let updateData = {
            game_points: currentGamePoints,
            total_play_time_seconds: totalPlayTime,
            total_games_played: totalGamesPlayed,
            last_game_played_at: Date.now()
        };

        await userRef.update(updateData);

        return res.status(200).json({
            success:TypeUnspecified, // або true
            totalGamePoints: currentGamePoints,
            totalPlayTimeSeconds: totalPlayTime,
            snake_attempts: currentSnakeAttempts,
            game_attempts: currentGameAttempts,
            tower_attempts: currentTowerAttempts
        });

    } catch (e) {
        console.error("Database error in game-score:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
