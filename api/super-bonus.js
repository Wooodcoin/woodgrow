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
    const { userId, initData } = req.body;
    if (!userId || !initData) return res.status(400).json({ error: 'Missing parameters' });

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

    try {
        // Отримуємо дані користувача з Firebase
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const user = userSnapshot.val();

        if (!user) return res.status(404).json({ error: 'User not found' });

        // 2. Перевірка: чи не отримував вже супер-бонус сьогодні
        const todayStr = new Date().toISOString().split('T')[0]; 
        if (user.last_super_bonus_date === todayStr) {
            return res.status(400).json({ error: 'Ви вже отримали свій Супер Бонус сьогодні!' });
        }

        // 3. Перевірка лімітів комерційних сервісів (має бути строго 20/20)
        const clicks = user.viewCounts || {}; 
        const s1 = parseInt(clicks.service1) || 0;
        const s2 = parseInt(clicks.service2) || 0;
        const s3 = parseInt(clicks.service3) || 0;
        const s4 = parseInt(clicks.service4) || 0;

        if (s1 < 20 || s2 < 20 || s3 < 20 || s4 < 20) {
            return res.status(400).json({ error: 'Спочатку виконайте всі 4 завдання до ліміту 20/20!' });
        }

        // 4. Математика зваженого рандому
        const randomRoll = Math.floor(Math.random() * 100) + 1;
        let winAmount = 0.0003;

        if (randomRoll <= 45) {
            winAmount = 0.0003; // 45% шанс
        } else if (randomRoll <= 76) {
            winAmount = 0.0005; // 31% шанс
        } else if (randomRoll <= 90) {
            winAmount = 0.0007; // 14% шанс
        } else if (randomRoll <= 97) {
            winAmount = 0.0009; // 7% шанс
        } else {
            winAmount = 0.0012; // 3% джекпот
        }

        // 5. Нарахування нагороди
        const currentBalance = parseFloat(user.balance) || 0;
        const newBalance = currentBalance + winAmount;

        // Оновлюємо баланс, фіксуємо дату та СКИДАЄМО перегляди для нового дня
        await userRef.update({ 
            balance: newBalance,
            last_super_bonus_date: todayStr,
            viewCounts: {
                service1: 0,
                service2: 0,
                service3: 0,
                service4: 0,
                support: 0
            }
        });

        // 6. Рефералка для Супер Бонусу (+10% від виграшу)
        const referredBy = user.referred_by || null;
        if (referredBy) {
            const referrerRef = db.ref(`users/${referredBy}`);
            const referrerSnapshot = await referrerRef.once('value');
            const referrerData = referrerSnapshot.val();

            if (referrerData) {
                let refBonus = winAmount * 0.10;
                let newRefBalance = (parseFloat(referrerData.balance) || 0) + refBonus;
                let newRefBonusTotal = (parseFloat(referrerData.ref_bonus) || 0) + refBonus;
                
                await referrerRef.update({
                    balance: newRefBalance,
                    ref_bonus: newRefBonusTotal
                });
            }
        }

        // Повертаємо успішну відповідь
        return res.status(200).json({ 
            success: true, 
            winAmount: winAmount, 
            newBalance: newBalance 
        });

    } catch (e) {
        console.error("Super Bonus DB error:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
