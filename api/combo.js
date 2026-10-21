import admin from 'firebase-admin';
import crypto from 'crypto';

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
const COMBO_REWARD = 0.0002;
const ADMIN_ID = "6043278492"; // Твій адмін-ID

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, selectedCombo, initData } = req.body;
    if (!userId || !selectedCombo || !Array.isArray(selectedCombo) || selectedCombo.length !== 3 || !initData) {
        return res.status(400).json({ error: 'Missing or invalid parameters' });
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
        return res.status(500).json({ error: 'Telegram validation error' });
    }

    try {
        const todayStr = new Date().toISOString().split('T')[0];

        // 2. Отримуємо правильне комбо на сьогодні з бази
        const dailyComboRef = db.ref(`system_combo/${todayStr}`);
        const comboSnapshot = await dailyComboRef.once('value');
        const correctCombo = comboSnapshot.val();

        if (!correctCombo) {
            return res.status(400).json({ error: 'Combo not generated for today' });
        }

        // 3. Отримуємо дані користувача
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const user = userSnapshot.val();

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const isAdmin = (String(userId) === ADMIN_ID || user.role === 'admin');

        // Якщо це звичайний юзер і він вже пробував сьогодні — блокуємо
        if (!isAdmin && user.last_combo_date === todayStr) {
            return res.status(400).json({ error: 'Combo already tried today' });
        }

        // 4. Перевіряємо правильність комбінації
        let isCorrect = true;
        for (let i = 0; i < 3; i++) {
            if (selectedCombo[i] !== correctCombo[i]) {
                isCorrect = false;
                break;
            }
        }

        let newBalance = parseFloat(user.balance) || 0.0000;
        
        // Для адміна НЕ оновлюємо last_combo_date, щоб він міг тестувати необмежено
        let updates = {};
        if (!isAdmin) {
            updates.last_combo_date = todayStr;
        }

        if (isCorrect) {
            newBalance += COMBO_REWARD;
            updates.balance = newBalance;
        }

        if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
        }

        return res.status(200).json({
            success: true,
            isCorrect: isCorrect,
            reward: isCorrect ? COMBO_REWARD : 0,
            newBalance: newBalance
        });

    } catch (err) {
        console.error("Error processing combo:", err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
