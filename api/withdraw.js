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

/**
 * Екранування спеціальних символів для Telegram MarkdownV2
 */
function escapeMarkdownV2(text) {
    return String(text).replace(/[_*\[\]()~`>#+-=|{}.!]/g, '\\$&');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const { userId, initData, walletAddress } = req.body;
    
    if (!userId || !initData || !walletAddress) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const LOG_CHAT_ID = process.env.TELEGRAM_LOG_CHAT_ID;
    if (!BOT_TOKEN) {
        return res.status(500).json({ error: 'Server configuration missing' });
    }

    // 1. Криптографічна валідація Telegram InitData (HMAC-SHA256)
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
            
        const encoder = new TextEncoder();
        const secretKeyMaterial = await crypto.subtle.importKey(
            "raw", 
            encoder.encode("WebAppData"), 
            { name: "HMAC", hash: "SHA-256" }, 
            false, 
            ["sign"]
        );
        const secretKeyBuffer = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(BOT_TOKEN));
        const checkKeyMaterial = await crypto.subtle.importKey(
            "raw", 
            secretKeyBuffer, 
            { name: "HMAC", hash: "SHA-256" }, 
            false, 
            ["sign"]
        );
        const signatureBuffer = await crypto.subtle.sign("HMAC", checkKeyMaterial, encoder.encode(dataCheckString));
        const calculatedHash = Array.from(new Uint8Array(signatureBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        
        if (calculatedHash !== hash) {
            return res.status(403).json({ error: 'Auth failed' });
        }
    } catch (err) {
        return res.status(500).json({ error: 'Telegram validation error' });
    }

    try {
        const userRef = db.ref(`users/${userId}`);
        let withdrawnAmount = 0;
        let username = "Невказано";

        // 2. АТОМАРНА ТРАНЗАКЦІЯ FIREBASE (Захист від Race Condition та Double Spending)
        const transactionResult = await userRef.transaction((currentUserData) => {
            if (!currentUserData) {
                return currentUserData; // Користувач відсутній
            }

            const currentBalance = parseFloat(currentUserData.balance) || 0;

            // Перевірка мінімального ліміту виплати
            if (currentBalance < 5.0) {
                return; // Скасування транзакції (повертає undefined)
            }

            // Фіксація даних та атомарне обнулення
            withdrawnAmount = currentBalance;
            username = currentUserData.username || "Невказано";

            return {
                ...currentUserData,
                balance: 0.0000,
                last_withdraw_at: new Date().toISOString()
            };
        });

        // Перевірка успішності атомарного фіксування
        if (!transactionResult.committed || !transactionResult.snapshot.exists()) {
            return res.status(400).json({ 
                error: 'Insufficient balance or user not found' 
            });
        }

        const finalAmountStr = withdrawnAmount.toFixed(4);
        const timestamp = new Date().toISOString();
        const newRequestRef = db.ref('withdraw_requests').push();

        // 3. ЗБЕРЕЖЕННЯ ЗАЯВКИ З АВТОМАТИЧНИМ ВІДНОВЛЕННЯМ БАЛАНСУ ПРИ ЗБОЇ
        try {
            await newRequestRef.set({
                requestId: newRequestRef.key,
                userId: String(userId),
                username: username,
                amount: finalAmountStr,
                wallet: walletAddress,
                status: "pending",
                createdAt: timestamp
            });
        } catch (dbError) {
            console.error("Критична помилка запису заявки. Відновлення балансу...", dbError);
            // Відкат балансу користувача у разі збою запису
            await userRef.update({ balance: withdrawnAmount });
            return res.status(500).json({ error: 'Failed to create withdrawal request' });
        }

        // 4. НАДСИЛАННЯ СПОВІЩЕННЯ В TELEGRAM (З бекслеш-екрануванням MarkdownV2)
        if (LOG_CHAT_ID) {
            try {
                const textMessage = `🚨 *НОВА ЗАЯВКА НА ВИВЕДЕННЯ\!\*\n\n` +
                                    `👤 *Юзер:* @${escapeMarkdownV2(username)} \(ID: \`${escapeMarkdownV2(userId)}\`\)\n` +
                                    `💰 *Сума:* \`${escapeMarkdownV2(finalAmountStr)}\` USDT\n` +
                                    `👛 *Гаманець:* \`${escapeMarkdownV2(walletAddress)}\`\n\n` +
                                    `👉 _Скопіюйте гаманець в один клік і зробіть виплату через Tonkeeper\._`;

                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: LOG_CHAT_ID,
                        text: textMessage,
                        parse_mode: 'MarkdownV2'
                    })
                });
            } catch (telegramError) {
                console.error("Помилка відправки логу в Telegram:", telegramError);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Withdrawal request created successfully'
        });

    } catch (e) {
        console.error("Database error during withdrawal:", e);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
