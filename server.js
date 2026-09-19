require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const generatePayload = require('promptpay-qr');
const walletStore = require('./wallet-store');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(__dirname));

const promptpayID = process.env.PROMPTPAY_ID;
const adminToken = process.env.ADMIN_TOKEN || '';
const webhookSecret = process.env.WEBHOOK_SECRET || '';
const lineChannelId = process.env.LINE_CHANNEL_ID || '';
const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const tmweasyApiUrl = process.env.TMWEASY_API_URL || 'http://tmwallet.thaighost.net/api_pph.php';
const tmweasyUsername = process.env.TMWEASY_USERNAME || '';
const tmweasyPassword = process.env.TMWEASY_PASSWORD || '';
const tmweasyConId = process.env.TMWEASY_CON_ID || '';
const tmweasyApiKey = process.env.TMWEASY_API_KEY || '';
const tmweasyPromptPayId = process.env.TMWEASY_PROMPTPAY_ID || promptpayID || '';
const tmweasyPromptPayType = process.env.TMWEASY_PROMPTPAY_TYPE || '01';

function unavailable(res, message) {
    return res.status(503).json({ success: false, message });
}

function requireAdmin(req, res, next) {
    if (!adminToken) return unavailable(res, 'ยังไม่ได้ตั้งค่า ADMIN_TOKEN');
    if (req.get('x-admin-token') !== adminToken) return res.status(401).json({ success: false, message: 'ไม่มีสิทธิ์ผู้ดูแลระบบ' });
    next();
}

async function verifyLiffIdToken(idToken) {
    if (!lineChannelId) throw new Error('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ID');
    if (!idToken) throw new Error('ไม่พบ LIFF idToken');
    const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: lineChannelId })
    });
    const result = await response.json();
    if (!response.ok || !result.sub) throw new Error('LIFF token ไม่ถูกต้องหรือหมดอายุ');
    return result;
}

async function notifyLineUser(lineUserId, text) {
    if (!lineUserId || !lineChannelAccessToken) return;
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${lineChannelAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] })
    });
    if (!response.ok) console.error('LINE notification failed:', await response.text());
}

app.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok' });
});

app.post('/api/auth/register', async (req, res) => {
    const { phone, password, bank, accountNo, name } = req.body;
    if (!phone || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเบอร์โทรศัพท์และรหัสผ่าน' });
    }

    try {
        const user = walletStore.registerUser({ phone, password, bank, accountNo, name });
        return res.status(201).json({ success: true, message: 'สมัครสมาชิกสำเร็จ', user });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message || 'เกิดข้อผิดพลาดในการสมัครสมาชิก' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเบอร์โทรศัพท์และรหัสผ่าน' });
    }

    try {
        const result = walletStore.loginUser({ phone, password });
        return res.json({ success: true, user: result.user, balance: result.wallet });
    } catch (error) {
        return res.status(401).json({ success: false, message: error.message || 'เข้าสู่ระบบไม่สำเร็จ' });
    }
});

app.post('/api/payment/generate-qr', (req, res) => {
    const { phone, amount, promptpayId } = req.body;
    const recipient = String(promptpayId || promptpayID || '').replace(/\D/g, '');
    if (!recipient) {
        return unavailable(res, 'ยังไม่ได้ตั้งค่า PROMPTPAY_ID ของผู้ให้บริการ');
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });
    }

    try {
        const qrPayload = generatePayload(recipient, { amount: numericAmount });
        res.json({ success: true, qrPayload, phone });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ไม่สามารถสร้าง QR Code ได้' });
    }
});

app.get('/api/user/balance', async (req, res) => {
    if (!req.query.phone) return res.status(400).json({ success: false, message: 'ต้องระบุเบอร์โทรศัพท์' });
    const balance = walletStore.getBalance(req.query.phone);
    res.json({ success: true, balance });
});

app.post('/api/payment/deposit', async (req, res) => {
    return res.status(410).json({
        success: false,
        message: 'ระบบจะเพิ่มเครดิตหลัง provider ตรวจสอบ webhook เท่านั้น'
    });
});

app.post('/api/payment/withdraw', async (req, res) => {
    const { phone, lineUserId, amount, bank, accountNo } = req.body;
    if ((!phone && !lineUserId) || !amount || !bank || !accountNo) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลถอนเงินให้ครบถ้วน' });
    }

    try {
        const withdrawal = walletStore.requestWithdrawal({ phone, lineUserId, amount, bank, accountNo });
        await notifyLineUser(lineUserId, `รับคำขอถอนเงิน ฿${Number(amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} แล้ว รอผู้ดูแลอนุมัติ`);
        res.status(202).json({ success: true, message: 'ส่งคำขอถอนเงิน รอผู้ดูแลอนุมัติ', withdrawal });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/user/history', async (req, res) => {
    res.json({ success: true, transactions: walletStore.getHistory(req.query.phone) });
});

app.post('/api/payment/webhook/deposit', (req, res) => {
    if (!webhookSecret) return unavailable(res, 'ยังไม่ได้ตั้งค่า WEBHOOK_SECRET');
    if (req.get('x-webhook-secret') !== webhookSecret) return res.status(401).json({ success: false, message: 'webhook ไม่ถูกต้อง' });
    const { phone, lineUserId, amount, providerTransactionId } = req.body;
    if ((!phone && !lineUserId) || !amount || !providerTransactionId) return res.status(400).json({ success: false, message: 'ข้อมูล webhook ไม่ครบถ้วน' });
    try {
        const user = phone ? walletStore.getUser(phone) : walletStore.getUserByLineId(lineUserId);
        const result = walletStore.credit({ phone, lineUserId, amount, source: 'provider_webhook', reference: providerTransactionId, actor: 'provider', metadata: req.body });
        notifyLineUser(user?.lineUserId, `ฝากเงินสำเร็จ ฿${Number(amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} เครดิตเข้าบัญชีแล้ว`);
        res.json({ success: true, duplicate: result.duplicate, balance: result.balance });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/wallets/credit', requireAdmin, (req, res) => {
    const { phone, amount, reason, reference } = req.body;
    if (!phone || !amount || !reason || !reference) return res.status(400).json({ success: false, message: 'ต้องระบุเบอร์ จำนวน เหตุผล และเลขอ้างอิง' });
    try {
        const result = walletStore.credit({ phone, amount, source: 'admin_manual', reference, actor: 'admin', metadata: { reason } });
        res.json({ success: true, duplicate: result.duplicate, balance: result.balance });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json({ success: true, users: walletStore.getUsers() });
});

app.get('/api/admin/users/:phone', requireAdmin, (req, res) => {
    const user = walletStore.getUser(req.params.phone);
    if (!user) return res.status(404).json({ success: false, message: 'ไม่พบบัญชีลูกค้า' });
    const balance = walletStore.getBalance(req.params.phone);
    res.json({ success: true, user, balance });
});

app.get('/api/admin/withdrawals/pending', requireAdmin, (req, res) => {
    res.json({ success: true, withdrawals: walletStore.getPendingWithdrawals() });
});

app.post('/api/admin/withdrawals/:id/review', requireAdmin, (req, res) => {
    const { decision } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ success: false, message: 'decision ต้องเป็น approved หรือ rejected' });
    try {
        const withdrawal = walletStore.reviewWithdrawal({ id: req.params.id, decision, reviewer: 'admin' });
        notifyLineUser(withdrawal.lineUserId, decision === 'approved'
            ? `อนุมัติถอนเงิน ฿${Number(withdrawal.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} แล้ว`
            : `ปฏิเสธคำขอถอนเงิน ฿${Number(withdrawal.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} และคืนเครดิตแล้ว`);
        res.json({ success: true, withdrawal });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
    res.json({ success: true, summary: walletStore.getSummary() });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

app.post('/api/auth/line/liff', async (req, res) => {
    try {
        const profile = await verifyLiffIdToken(req.body.idToken);
        const result = walletStore.loginLineUser({
            lineUserId: profile.sub,
            name: profile.name,
            pictureUrl: profile.picture
        });
        if (result.created) await notifyLineUser(profile.sub, 'สมัครสมาชิกสำเร็จ ยินดีต้อนรับเข้าสู่ระบบ');
        return res.json({ success: true, created: result.created, user: result.user, balance: result.wallet });
    } catch (error) {
        return res.status(401).json({ success: false, message: error.message || 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ' });
    }
});

async function createTmweasyPayment({ amount, reference, ip }) {
    if (!tmweasyUsername || !tmweasyPassword || !tmweasyConId || !tmweasyPromptPayId) {
        throw new Error('ยังไม่ได้ตั้งค่า TMWEASY credentials หรือ PromptPay ID');
    }
    const createParams = new URLSearchParams({
        username: tmweasyUsername,
        password: tmweasyPassword,
        con_id: tmweasyConId,
        amount: String(Math.round(Number(amount))),
        ref1: reference,
        ip: ip || '0.0.0.0',
        method: 'create_pay'
    });
    const createResponse = await fetch(`${tmweasyApiUrl}?${createParams}`);
    const created = await createResponse.json();
    if (!createResponse.ok || Number(created.status) !== 1 || !created.id_pay) {
        throw new Error(created.msg || 'TMWEASY สร้างรายการชำระไม่สำเร็จ');
    }

    const detailParams = new URLSearchParams({
        username: tmweasyUsername,
        password: tmweasyPassword,
        con_id: tmweasyConId,
        id_pay: String(created.id_pay),
        type: tmweasyPromptPayType,
        promptpay_id: tmweasyPromptPayId,
        method: 'detail_pay'
    });
    const detailResponse = await fetch(`${tmweasyApiUrl}?${detailParams}`);
    const detail = await detailResponse.json();
    if (!detailResponse.ok || Number(detail.status) !== 1) {
        throw new Error(detail.msg || 'TMWEASY อ่าน QR ไม่สำเร็จ');
    }
    return { ...detail, id_pay: created.id_pay };
}

app.post('/api/payment/tmweasy/create', async (req, res) => {
    return res.status(410).json({ success: false, message: 'ระบบฝากเงินปิดชั่วคราว' });
    /*
    const { phone, lineUserId, amount } = req.body;
    const numericAmount = Number(amount);
    if ((!phone && !lineUserId) || !Number.isInteger(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: 'ข้อมูลสร้างรายการชำระไม่ถูกต้อง' });
    }
    try {
        const payment = await createTmweasyPayment({ amount: numericAmount, reference: lineUserId || phone, ip: req.ip });
        res.json({ success: true, payment });
    } catch (error) {
        res.status(502).json({ success: false, message: error.message });
    }
    */
});

app.post('/api/payment/webhook/tmweasy', (req, res) => {
    return res.status(410).json({ status: 0, success: false, message: 'ระบบฝากเงินปิดชั่วคราว' });
    /*
    if (!tmweasyApiKey) return unavailable(res, 'ยังไม่ได้ตั้งค่า TMWEASY_API_KEY');
    const { data, signature } = req.body;
    if (!data || !signature) return res.status(400).json({ success: false, message: 'ข้อมูล TMWEASY webhook ไม่ครบถ้วน' });
    try {
        const dataJson = typeof data === 'string' ? data : JSON.stringify(data);
        const expected = crypto.createHash('md5').update(`${dataJson}:${tmweasyApiKey}`).digest('hex');
        if (signature.toLowerCase() !== expected.toLowerCase()) {
            return res.status(401).json({ success: false, message: 'ลายเซ็น TMWEASY ไม่ถูกต้อง' });
        }
        const payment = typeof data === 'string' ? JSON.parse(data) : data;
        const reference = String(payment.ref1 || '');
        const isLineUser = reference.startsWith('U');
        const user = isLineUser ? walletStore.getUserByLineId(reference) : walletStore.getUser(reference);
        if (!user) {
            return res.status(404).json({ status: 0, success: false, message: 'ไม่พบบัญชีสมาชิกจาก ref1' });
        }
        const result = walletStore.credit({
            phone: isLineUser ? null : reference,
            lineUserId: isLineUser ? reference : null,
            amount: payment.amount,
            source: 'tmweasy_webhook',
            reference: `tmweasy:${payment.id_pay}`,
            actor: 'provider',
            metadata: payment
        });
        notifyLineUser(user?.lineUserId, `ฝากเงินสำเร็จ ฿${Number(payment.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} เครดิตเข้าบัญชีแล้ว`);
        return res.json({ status: 1, success: true, duplicate: result.duplicate, balance: result.balance });
    } catch (error) {
        return res.status(400).json({ status: 0, success: false, message: error.message });
    }
    */
});