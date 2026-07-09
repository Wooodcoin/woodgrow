import admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!base64Key) {
            console.error('КРИТИЧНА ПОМИЛКА: Змінна FIREBASE_SERVICE_ACCOUNT порожня!');
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
    
    const { userId, taskId, initData } = req.body;
    if (!userId || !taskId || !initData) return res.status(400).json({ error: 'Missing parameters' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    // 1. Валідація Telegram InitData (Захист від зламу)
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
        // 2. Перевірка, чи існує таке завдання взагалі
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnapshot = await taskRef.once('value');
        if (!taskSnapshot.exists()) return res.status(404).json({ error: 'Task not found' });
        
        const taskData = taskSnapshot.val();

        // Перевірка лімітів завдання замовника
        if (taskData.status !== 'active' || parseInt(taskData.current_views || 0) >= parseInt(taskData.required_views || 26)) {
            return res.status(410).json({ error: 'Task is no longer active or limit reached' });
        }

        // 3. Перевірка користувача та чи не виконував він це завдання раніше
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        if (!userSnapshot.exists()) return db.status(404).json({ error: 'User not found' });

        const userData = userSnapshot.val();
        
        // Перевіряємо гілку completed_tasks всередині профілю користувача
        const isAlreadyDone = await db.ref(`users/${userId}/completed_tasks/${taskId}`).once('value');
        if (isAlreadyDone.exists()) {
            return res.status(409).json({ error: 'Task already completed' });
        }

        // 4. Процес нарахування нагороди
        const reward = parseFloat(taskData.reward) || 0.0005;
        const currentBalance = parseFloat(userData.balance) || 0;
        const newBalance = currentBalance + reward;
        const referredBy = userData.referred_by || null;

        // Оновлюємо дані користувача: новий баланс + додаємо ID завдання у виконані
        await userRef.update({ balance: newBalance });
        await db.ref(`users/${userId}/completed_tasks/${taskId}`).set(true);

        // 5. Оновлюємо лічильник переглядів самого завдання для замовника
        const newViews = (parseInt(taskData.current_views) || 0) + 1;
        await taskRef.update({ current_views: newViews });

        // 6. Реферальний бонус (+10% USDT запросившому)
        if (referredBy) {
            const referrerRef = db.ref(`users/${referredBy}`);
            const referrerSnapshot = await referrerRef.once('value');
            if (referrerSnapshot.exists()) {
                const referrerData = referrerSnapshot.val();
                const refBonus = reward * 0.10;
                const newRefBalance = (parseFloat(referrerData.balance) || 0) + refBonus;
                const newRefBonusTotal = (parseFloat(referrerData.ref_bonus) || 0) + refBonus;
                
                await referrerRef.update({
                    balance: newRefBalance,
                    ref_bonus: newRefBonusTotal
                });
            }
        }

        // Повертаємо новий баланс на фронтенд
        return res.status(200).json({ success: true, newBalance: newBalance });

    } catch (e) {
        console.error("Database error in claim-task:", e);
        return res.status(500).json({ error: 'Database transaction error' });
    }
}
