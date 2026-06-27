// api/reward.js
const FIREBASE_BASE_URL = "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app";
const TELEGRAM_BOT_TOKEN = "8730969626:AAFs9pve4MpcMTVhpfBtz_FN6rXqb9h3Jrg"; 

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, serviceKey, initData } = req.body;
    if (!userId || !serviceKey || !initData) return res.status(400).json({ error: 'Missing parameters' });

    // Валідація Telegram InitData
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries()).map(([k, v]) => `${k}=${v}`).sort().join('\n');
        const encoder = new TextEncoder();
        const secretKeyMaterial = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const secretKeyBuffer = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(TELEGRAM_BOT_TOKEN));
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
        const userRes = await fetch(`${FIREBASE_BASE_URL}/users/${userId}.json`);
        const user = await userRes.json();
        let currentBalance = 0;
        let referredBy = null;

        if (user) {
            currentBalance = parseFloat(user.balance) || 0;
            referredBy = user.referred_by || null;
        }

        const newBalance = currentBalance + reward;
        await fetch(`${FIREBASE_BASE_URL}/users/${userId}/balance.json`, { method: 'PUT', body: JSON.stringify(newBalance) });

        // Реферальний бонус (+10% USDT) на сервері
        if (referredBy && reward > 0) {
            const refRes = await fetch(`${FIREBASE_BASE_URL}/users/${referredBy}.json`);
            const referrerData = await refRes.json();
            if (referrerData) {
                let refBonus = reward * 0.10;
                let newRefBalance = (parseFloat(referrerData.balance) || 0) + refBonus;
                let newRefBonusTotal = (parseFloat(referrerData.ref_bonus) || 0) + refBonus;
                await fetch(`${FIREBASE_BASE_URL}/users/${referrerBy}/balance.json`, { method: 'PUT', body: JSON.stringify(newRefBalance) });
                await fetch(`${FIREBASE_BASE_URL}/users/${referrerBy}/ref_bonus.json`, { method: 'PUT', body: JSON.stringify(newRefBonusTotal) });
            }
        }
        return res.status(200).json({ success: true, newBalance: newBalance });
    } catch (e) {
        return res.status(500).json({ error: 'Database error' });
    }
}
