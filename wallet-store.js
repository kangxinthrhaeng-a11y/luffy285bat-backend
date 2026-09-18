const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'wallet.json');

function emptyState() {
    return { users: {}, wallets: {}, transactions: [], withdrawals: [] };
}

function readState() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(dataFile)) {
        const state = emptyState();
        fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
        return state;
    }
    const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    state.users = state.users || {};
    state.wallets = state.wallets || {};
    state.transactions = state.transactions || [];
    state.withdrawals = state.withdrawals || [];
    return state;
}

function writeState(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = `${dataFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryFile, dataFile);
}

function normalisePhone(phone) {
    return String(phone || '').replace(/\D/g, '');
}

function identityKey({ phone, lineUserId } = {}) {
    if (lineUserId) return `line:${String(lineUserId)}`;
    const normalizedPhone = normalisePhone(phone);
    if (!normalizedPhone) throw new Error('ต้องระบุตัวตนสมาชิก');
    return normalizedPhone;
}

function normaliseAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('จำนวนเงินไม่ถูกต้อง');
    }
    return Math.round(amount * 100) / 100;
}

function ensureWallet(state, identity) {
    const key = typeof identity === 'string' && identity.startsWith('line:')
        ? identity
        : identityKey(typeof identity === 'string' ? { phone: identity } : identity);
    if (!state.wallets[key]) state.wallets[key] = { available: 0, held: 0 };
    return state.wallets[key];
}

function getUserRecord(state, identity) {
    const key = typeof identity === 'string' && identity.startsWith('line:')
        ? identity
        : identityKey(typeof identity === 'string' ? { phone: identity } : identity);
    return state.users[key] || null;
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    if (!storedHash || typeof storedHash !== 'string') return false;
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const computed = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

function sanitizeUser(user) {
    if (!user) return null;
    const publicUser = { ...user };
    delete publicUser.passwordHash;
    return publicUser;
}

function hasReference(state, reference) {
    return Boolean(reference && state.transactions.some(transaction => transaction.reference === reference));
}

function registerUser({ phone, password, bank, accountNo, name }) {
    if (!phone || !password) throw new Error('กรุณากรอกเบอร์โทรศัพท์และรหัสผ่าน');
    const normalizedPhone = normalisePhone(phone);
    if (!normalizedPhone || normalizedPhone.length < 9) throw new Error('เบอร์โทรศัพท์ไม่ถูกต้อง');
    if (String(password).length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');

    const state = readState();
    if (state.users[normalizedPhone]) {
        throw new Error('เบอร์นี้ถูกใช้งานแล้ว');
    }

    const user = {
        phone: normalizedPhone,
        name: name || 'ลูกค้า',
        bank: bank || '',
        accountNo: accountNo || '',
        passwordHash: hashPassword(String(password)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: null
    };

    state.users[normalizedPhone] = user;
    ensureWallet(state, normalizedPhone);
    writeState(state);
    return user;
}

function loginUser({ phone, password }) {
    if (!phone || !password) throw new Error('กรุณากรอกเบอร์โทรศัพท์และรหัสผ่าน');
    const normalizedPhone = normalisePhone(phone);
    const state = readState();
    const user = getUserRecord(state, normalizedPhone);
    if (!user) throw new Error('ไม่พบบัญชีผู้ใช้นี้');
    const valid = verifyPassword(String(password), user.passwordHash);
    if (!valid) throw new Error('รหัสผ่านไม่ถูกต้อง');
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    writeState(state);
    const wallet = ensureWallet(state, normalizedPhone);
    return { user, wallet };
}

function registerLineUser({ lineUserId, name, pictureUrl }) {
    if (!lineUserId) throw new Error('ไม่พบ LINE userId');
    const key = identityKey({ lineUserId });
    const state = readState();
    if (state.users[key]) return { user: state.users[key], created: false, wallet: ensureWallet(state, key) };

    const user = {
        phone: null,
        lineUserId: String(lineUserId),
        name: name || 'สมาชิก LINE',
        pictureUrl: pictureUrl || '',
        bank: '',
        accountNo: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
    };
    state.users[key] = user;
    const wallet = ensureWallet(state, key);
    writeState(state);
    return { user, created: true, wallet };
}

function loginLineUser({ lineUserId, name, pictureUrl }) {
    const key = identityKey({ lineUserId });
    const state = readState();
    const user = getUserRecord(state, key);
    if (!user) return registerLineUser({ lineUserId, name, pictureUrl });
    user.name = name || user.name;
    user.pictureUrl = pictureUrl || user.pictureUrl;
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    const wallet = ensureWallet(state, key);
    writeState(state);
    return { user, created: false, wallet };
}

function getUsers() {
    const state = readState();
    return Object.values(state.users).map(user => ({
        ...sanitizeUser(user),
        balance: ensureWallet(state, user.lineUserId ? `line:${user.lineUserId}` : user.phone)
    }));
}

function getUser(phone) {
    const state = readState();
    const user = getUserRecord(state, phone);
    return user ? sanitizeUser(user) : null;
}

function getUserByLineId(lineUserId) {
    const state = readState();
    const user = getUserRecord(state, { lineUserId });
    return user ? sanitizeUser(user) : null;
}

function credit({ phone, lineUserId, amount, source, reference, actor, metadata = {} }) {
    if (!phone && !lineUserId) throw new Error('ต้องระบุตัวตนสมาชิก');
    const key = identityKey({ phone, lineUserId });
    const numericAmount = normaliseAmount(amount);
    const state = readState();
    if (hasReference(state, reference)) return { duplicate: true, balance: ensureWallet(state, key).available };
    const wallet = ensureWallet(state, key);
    wallet.available = Math.round((wallet.available + numericAmount) * 100) / 100;
    state.transactions.push({
        id: crypto.randomUUID(), phone: phone ? normalisePhone(phone) : null, lineUserId: lineUserId || null, type: 'credit', amount: numericAmount, source,
        reference: reference || null, actor: actor || 'system', metadata, createdAt: new Date().toISOString()
    });
    writeState(state);
    return { duplicate: false, balance: wallet.available };
}

function requestWithdrawal({ phone, lineUserId, amount, bank, accountNo }) {
    if ((!phone && !lineUserId) || !bank || !accountNo) throw new Error('ข้อมูลถอนเงินไม่ครบถ้วน');
    const key = identityKey({ phone, lineUserId });
    const numericAmount = normaliseAmount(amount);
    const state = readState();
    const user = getUserRecord(state, key);
    if (!user) throw new Error('ไม่พบบัญชีผู้ใช้นี้');
    const wallet = ensureWallet(state, key);
    if (wallet.available < numericAmount) throw new Error('ยอดคงเหลือไม่เพียงพอ');
    wallet.available = Math.round((wallet.available - numericAmount) * 100) / 100;
    wallet.held = Math.round((wallet.held + numericAmount) * 100) / 100;
    const withdrawal = {
        id: crypto.randomUUID(), phone: phone ? normalisePhone(phone) : null, lineUserId: lineUserId || null, amount: numericAmount, bank, accountNo,
        status: 'pending', createdAt: new Date().toISOString(), reviewedAt: null, reviewer: null
    };
    state.withdrawals.push(withdrawal);
    state.transactions.push({
        id: crypto.randomUUID(), phone: phone ? normalisePhone(phone) : null, lineUserId: lineUserId || null, type: 'withdrawal_hold', amount: numericAmount,
        reference: withdrawal.id, actor: 'system', metadata: { bank }, createdAt: withdrawal.createdAt
    });
    writeState(state);
    return withdrawal;
}

function reviewWithdrawal({ id, decision, reviewer }) {
    const state = readState();
    const withdrawal = state.withdrawals.find(item => item.id === id);
    if (!withdrawal) throw new Error('ไม่พบคำขอถอนเงิน');
    if (withdrawal.status !== 'pending') throw new Error('รายการนี้ถูกตรวจสอบไปแล้ว');
    const wallet = ensureWallet(state, withdrawal.phone);
    withdrawal.status = decision;
    withdrawal.reviewedAt = new Date().toISOString();
    withdrawal.reviewer = reviewer || 'admin';
    wallet.held = Math.round((wallet.held - withdrawal.amount) * 100) / 100;
    if (decision === 'rejected') {
        wallet.available = Math.round((wallet.available + withdrawal.amount) * 100) / 100;
        state.transactions.push({ id: crypto.randomUUID(), phone: withdrawal.phone, type: 'withdrawal_refund', amount: withdrawal.amount, reference: withdrawal.id, actor: reviewer || 'admin', createdAt: withdrawal.reviewedAt });
    } else {
        state.transactions.push({ id: crypto.randomUUID(), phone: withdrawal.phone, type: 'withdrawal_approved', amount: withdrawal.amount, reference: withdrawal.id, actor: reviewer || 'admin', metadata: { bank: withdrawal.bank, accountNo: withdrawal.accountNo }, createdAt: withdrawal.reviewedAt });
    }
    writeState(state);
    return withdrawal;
}

function getBalance(phone) {
    const state = readState();
    return ensureWallet(state, phone);
}

function getLineBalance(lineUserId) {
    const state = readState();
    return ensureWallet(state, { lineUserId });
}

function getHistory(phone) {
    const normalizedPhone = normalisePhone(phone);
    return readState().transactions.filter(transaction => !normalizedPhone || transaction.phone === normalizedPhone).reverse();
}

function getPendingWithdrawals() {
    return readState().withdrawals.filter(withdrawal => withdrawal.status === 'pending');
}

function getSummary() {
    const state = readState();
    return {
        users: Object.keys(state.users).length,
        pendingWithdrawals: state.withdrawals.filter(withdrawal => withdrawal.status === 'pending').length,
        transactions: state.transactions.length
    };
}

module.exports = {
    registerUser,
    loginUser,
    registerLineUser,
    loginLineUser,
    getUsers,
    getUser,
    getUserByLineId,
    credit,
    requestWithdrawal,
    reviewWithdrawal,
    getBalance,
    getLineBalance,
    getHistory,
    getPendingWithdrawals,
    getSummary
};
