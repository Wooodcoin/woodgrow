const FIREBASE_BASE_URL = "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app";

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, serviceKey, initData } = req.body;
    if (!userId || !serviceKey || !initData) return res.status(400).json({ error: 'Missing parameters' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const FB_SECRET = process.env.FIREBASE_SECRET;

    if (!BOT_TOKEN || !FB_SECRET) {
        return res.status(500).json({ error: 'Server configuration missing' });
    }

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
        const now = Date.now(); // Поточний час у мілісекундах
        const cooldownTime = 120 * 1000; // 120 секунд у мілісекундах

        // 2. Серверна перевірка тайм-ауту (Захист від ботів та накрутки)
        const lastClickRes = await fetch(`${FIREBASE_BASE_URL}/users/${userId}/last_clicks/${serviceKey}.json?auth=${FB_SECRET}`);
        const lastClickTime = await lastClickRes.json();

        if (lastClickTime && (now - lastClickTime < cooldownTime)) {
            const timeLeft = Math.ceil((cooldownTime - (now - lastClickTime)) / 1000);
            return res.status(429).json({ error: `Зачекайте ще ${timeLeft} сек перед наступним кліком!` });
        }

        // 3. Оновлюємо час останнього кліку
        await fetch(`${FIREBASE_BASE_URL}/users/${userId}/last_clicks/${serviceKey}.json?auth=${FB_SECRET}`, {
            method: 'PUT',
            body: JSON.stringify(now)
        });

        // 4. Отримання даних користувача та нарахування балансу
        const userRes = await fetch(`${FIREBASE_BASE_URL}/users/${userId}.json?auth=${FB_SECRET}`);
        const user = await userRes.json();
        let currentBalance = 0;
        let referredBy = null;

        if (user) {
            currentBalance = parseFloat(user.balance) || 0;
            referredBy = user.referred_by || null;
        }

        const newBalance = currentBalance + reward;
        await fetch(`${FIREBASE_BASE_URL}/users/${userId}/balance.json?auth=${FB_SECRET}`, { 
            method: 'PUT', 
            body: JSON.stringify(newBalance) 
        });

        // Реферальний бонус (+10% USDT)
        if (referredBy && reward > 0) {
            const refRes = await fetch(`${FIREBASE_BASE_URL}/users/${referredBy}.json?auth=${FB_SECRET}`);
            const referrerData = await refRes.json();
            if (referrerData) {
                let refBonus = reward * 0.10;
                let newRefBalance = (parseFloat(referrerData.balance) || 0) + refBonus;
                let newRefBonusTotal = (parseFloat(referrerData.ref_bonus) || 0) + refBonus;
                await fetch(`${FIREBASE_BASE_URL}/users/${referredBy}/balance.json?auth=${FB_SECRET}`, { method: 'PUT', body: JSON.stringify(newRefBalance) });
                await fetch(`${FIREBASE_BASE_URL}/users/${referrerBy}/ref_bonus.json?auth=${FB_SECRET}`, { method: 'PUT', body: JSON.stringify(newRefBonusTotal) });
            }
        }

        return res.status(200).json({ success: true, newBalance: newBalance });
    } catch (e) {
        return res.status(500).json({ error: 'Database error' });
    }
}
