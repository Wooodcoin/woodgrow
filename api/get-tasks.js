// api/get-tasks.js

import admin from 'firebase-admin';
import Busboy from 'busboy';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') ? Buffer.from(rawKey, 'base64').toString('utf-8') : rawKey;
        const serviceAccount = JSON.parse(decryptedKey);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
        });
    } catch (error) {
        console.error('Firebase init error:', error);
    }
}

const db = admin.database();

// Допоміжна функція для парсингу multipart/form-data через busboy
const parseMultipartForm = (req) => {
    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        const fields = {};
        let fileBuffer = null;
        let fileName = '';
        let fileMimeType = '';

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, info) => {
            const { filename, mimeType } = info;
            fileName = filename;
            fileMimeType = mimeType;
            const chunks = [];

            file.on('data', (chunk) => chunks.push(chunk));
            file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
        });

        busboy.on('finish', () => {
            resolve({ fields, file: fileBuffer ? { buffer: fileBuffer, name: fileName, mimetype: fileMimeType } : null });
        });

        busboy.on('error', (error) => reject(error));

        req.pipe(busboy);
    });
};

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function handler(req, res) {
    // ---------------------------------------------------------
    // ОБРОБКА POST-ЗАПИТУ (Надсилання скріншота через Telegram)
    // ---------------------------------------------------------
    if (req.method === 'POST') {
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

        try {
            const { fields, file } = await parseMultipartForm(req);
            const { userId, initData, taskId } = fields;

            if (!userId || !initData || !taskId) {
                return res.status(400).json({ error: 'Missing parameters' });
            }

            if (!file) {
                return res.status(400).json({ error: 'Screenshot file is required' });
            }

            // Валідація Telegram InitData
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

            const taskRef = db.ref(`tasks/${taskId}`);
            const taskSnap = await taskRef.once('value');
            if (!taskSnap.exists()) return res.status(404).json({ error: 'Task not found' });

            const taskData = taskSnap.val();

            const existingSubmissionsSnap = await db.ref(`task_submissions/${taskId}`).orderByChild('userId').equalTo(userId).once('value');
            if (existingSubmissionsSnap.exists()) {
                return res.status(409).json({ error: 'You have already submitted a report for this task' });
            }

            // Відправляємо скріншот напряму в чат рекламодавцю (creatorId) через Telegram API
            let screenshotUrl = 'Telegram Photo Sent';
            try {
                const formDataTg = new globalThis.FormData();
                formDataTg.append('chat_id', taskData.creatorId);
                formDataTg.append('caption', `📸 Звіт по завданню від користувача ID: ${userId}\nСтатус: На перевірці ⏳`);
                
                const blob = new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' });
                formDataTg.append('photo', blob, file.name || 'screenshot.jpg');

                const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                    method: 'POST',
                    body: formDataTg
                });
                const tgData = await tgRes.json();
                if (tgData.ok && tgData.result && tgData.result.photo) {
                    // Отримуємо file_id найбільшого фото для історії
                    const photos = tgData.result.photo;
                    const bestPhoto = photos[photos.length - 1];
                    screenshotUrl = `tg_file_id:${bestPhoto.file_id}`;
                }
            } catch (tgErr) {
                console.error("Failed to send photo to advertiser telegram:", tgErr);
            }

            // Збереження звіту в базу даних
            const submissionRef = db.ref(`task_submissions/${taskId}`).push();
            const submissionId = submissionRef.key;
            const timestamp = Date.now();

            const submissionData = {
                id: submissionId,
                taskId: taskId,
                userId: userId,
                creatorId: taskData.creatorId,
                screenshotUrl: screenshotUrl,
                status: 'pending',
                submittedAt: timestamp,
                expiresAt: timestamp + (48 * 60 * 60 * 1000)
            };

            await submissionRef.set(submissionData);
            await db.ref(`task_users/${taskData.creatorId}/my_campaigns/${taskId}/submissions/${submissionId}`).set(submissionData);

            return res.status(200).json({
                success: true,
                message: 'Submission sent successfully and is pending review',
                submissionId: submissionId
            });

        } catch (e) {
            console.error("Error submitting task file via Telegram:", e);
            return res.status(500).json({ error: 'Server error during file upload' });
        }
    }

    // ---------------------------------------------------------
    // ОБРОБКА GET-ЗАПИТУ (Отримання списку завдань)
    // ---------------------------------------------------------
    if (req.method === 'GET') {
        const { userId } = req.query;

        try {
            let completedTaskIds = [];
            if (userId) {
                const completedSnapshot = await db.ref(`users/${userId}/completed_tasks`).once('value');
                if (completedSnapshot.exists()) {
                    completedTaskIds = Object.keys(completedSnapshot.val());
                }
            }

            const snapshot = await db.ref('tasks').once('value');
            if (!snapshot.exists()) {
                return res.status(200).json({ success: true, tasks: [] });
            }

            const allTasks = snapshot.val();
            const activeTasks = [];

            for (const key in allTasks) {
                const task = allTasks[key];
                const taskId = task.id || key;
                
                const isAlreadyCompleted = completedTaskIds.includes(taskId);
                if (isAlreadyCompleted) continue;

                if (task.type === 'referral') {
                    const currentCount = parseInt(task.current_count || 0);
                    const targetCount = parseInt(task.target_count || 5);

                    if (currentCount < targetCount) {
                        const subRef = db.ref(`task_submissions/${taskId}`);
                        const subSnap = await subRef.orderByChild('userId').equalTo(userId).once('value');
                        
                        let hasPendingOrApproved = false;
                        if (subSnap.exists()) {
                            subSnap.forEach(child => {
                                const sub = child.val();
                                if (sub.status === 'pending' || sub.status === 'approved') {
                                    hasPendingOrApproved = true;
                                }
                            });
                        }

                        if (!hasPendingOrApproved) {
                            activeTasks.push({
                                id: taskId,
                                link: task.link,
                                reward: 0.002,
                                type: 'referral'
                            });
                        }
                    }
                } else {
                    if (
                        task.status === 'active' && 
                        parseInt(task.current_views || 0) < parseInt(task.required_views || 26)
                    ) {
                        activeTasks.push({
                            id: taskId,
                            link: task.link,
                            reward: task.reward || 0.0005,
                            type: 'reaction'
                        });
                    }
                }
            }

            return res.status(200).json({ success: true, tasks: activeTasks });

        } catch (error) {
            console.error("Error fetching tasks:", error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
