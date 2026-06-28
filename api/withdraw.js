import admin from 'firebase-admin';

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

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { userId, initData, walletAddress } = req.body;
    
    if (!userId || !initData || !walletAddress) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const LOG_CHAT_ID = process.env.TELEGRAM_LOG_CHAT_ID; // Наш новий чат логів
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
        // 2. Отримуємо поточні дані користувача
        const userRef = db.ref(`users/${userId}`);
        const userSnapshot = await userRef.once('value');
        const user = userSnapshot.val();

        if (!user) return res.status(444).json({ error: 'User not found' });

        const currentBalance = parseFloat(user.balance) || 0;

        if (currentBalance < 5.0) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        const finalAmount = currentBalance.toFixed(4);
        const username = user.username || "Невказано";

        // 3. ОБНУЛЯЄМО БАЛАНС
        await userRef.update({ balance: 0.0000 });

        // 4. СТВОРЮЄМО ЗАПИС В БАЗІ "withdraw_requests"
        const newRequestRef = db.ref('withdraw_requests').push();
        const timestamp = new Date().toISOString();

        await newRequestRef.set({
            requestId: newRequestRef.key,
            userId: userId,
            username: username,
            amount: finalAmount,
            wallet: walletAddress,
            status: "pending",
            createdAt: timestamp
        });

        // 5. НАДСИЛАЄМО МИТТЄВЕ СПОВІЩЕННЯ В ТЕЛЕГРАМ ЧАТ
        if (LOG_CHAT_ID) {
            try {
                // Формуємо красивий текст із Markdown-розміткою
                const textMessage = `🚨 *НОВА ЗАЯВКА НА ВИВЕДЕННЯ!*\n\n` +
                                    `👤 *Юзер:* @${username.replace(/_/g, '\\_')} (ID: \`${userId}\`)\n` +
                                    `💰 *Сума:* \`${finalAmount}\` USDT\n` +
                                    `👛 *Гаманець:* \`${walletAddress}\`\n\n` +
                                    `👉 _Скопіюйте гаманець в один клік і зробіть виплату через Tonkeeper._`;

                // Відправляємо запит до Telegram API за допомогою вбудованого fetch
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: LOG_CHAT_ID,
                        text: textMessage,
                        parse_mode: 'Markdown'
                    })
                });
            } catch (telegramError) {
                console.error("Помилка відправки логу в Telegram:", telegramError);
                // Навіть якщо Telegram дав збій, ми не зупиняємо процес, адже в базу все записалося
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Withdrawal request created successfully and log sent'
        });

    } catch (e) {
        console.error("Database error during withdrawal:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
