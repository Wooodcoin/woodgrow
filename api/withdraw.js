const FIREBASE_BASE_URL = "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app";

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, initData } = req.body;
    if (!userId || !initData) return res.status(400).json({ error: 'Missing parameters' });

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
        return res.status(500).json({ error: 'Validation error' });
    }

    // 2. Перевірка балансу та безпечне обнулення
    try {
        const userRes = await fetch(`${FIREBASE_BASE_URL}/users/${userId}.json?auth=${FB_SECRET}`);
        const user = await userRes.json();
        if (!user || (parseFloat(user.balance) || 0) <= 0) {
            return res.status(400).json({ error: 'Недостатньо коштів або користувача не знайдено' });
        }

        const currentBalance = parseFloat(user.balance);

        // Безпечно обнуляємо баланс у Firebase за допомогою адмін-доступу
        await fetch(`${FIREBASE_BASE_URL}/users/${userId}/balance.json?auth=${FB_SECRET}`, { 
            method: 'PUT', 
            body: JSON.stringify(0) 
        });

        return res.status(200).json({ success: true, withdrawnAmount: currentBalance });
    } catch (e) {
        return res.status(500).json({ error: 'Database error' });
    }
}
