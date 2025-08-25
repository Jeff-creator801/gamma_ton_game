// server.js — backend для проверки депозитов и очереди выплат
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');

const admin = require('firebase-admin');
const serviceJson = process.env.FIREBASE_SERVICE_JSON;
if(!serviceJson) throw new Error('FIREBASE_SERVICE_JSON env required');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceJson)), databaseURL: process.env.FIREBASE_DBURL || 'https://gammaton-fdbfd-default-rtdb.firebaseio.com' });
const db = admin.database();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static index.html from same folder (so one service serves front + api)
app.use(express.static(__dirname));
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'index.html')));

const OWNER_TON_WALLET = process.env.OWNER_TON_WALLET;
const TONAPI_KEY = process.env.TONAPI_KEY || '';

/**
 * checkDeposit
 * По uid и сумме ищем входящую транзакцию на OWNER_TON_WALLET за последние 30 минут.
 * Если найдена — зачисляем сумму минус комиссия 10% (то есть +0.9*amount) в баланс пользователя.
 */
app.post('/api/checkDeposit', async (req,res) => {
  try {
    const { uid, amount } = req.body;
    if(!uid || !amount) return res.json({ ok:false, error:'bad params' });
    // Используем tonapi.io (если есть ключ) или public endpoint
    const headers = TONAPI_KEY ? { 'Authorization': `Bearer ${TONAPI_KEY}` } : {};
    // запрос транзакций
    const url = `https://tonapi.io/v2/blockchain/getTransactions?account=${OWNER_TON_WALLET}&limit=50`;
    const r = await axios.get(url, { headers, timeout:10000 }).catch(()=>null);
    const txs = r?.data?.transactions || [];
    const nowSec = Math.floor(Date.now()/1000);
    const found = txs.find(t => {
      const v = Number((t?.in_msg?.value || 0)) / 1e9;
      const ts = t.utime || nowSec;
      return (nowSec - ts) < (30*60) && Math.abs(v - amount) < 0.01;
    });
    if(found) {
      const credit = +(amount * 0.9).toFixed(6); // комиссия 10%
      const ref = db.ref('users/'+uid+'/balances/ton');
      const snap = await ref.get();
      const cur = Number(snap.val()||0);
      await ref.set( +( (cur + credit).toFixed(6) ) );
      const userRef = db.ref('users/'+uid);
      const u = (await userRef.get()).val() || {};
      if(!u.firstDepositAt) await userRef.update({ firstDepositAt: Date.now() });
      return res.json({ ok:true, credited: credit });
    }
    return res.json({ ok:false });
  } catch (e) {
    console.error(e);
    return res.json({ ok:false, error:'exception' });
  }
});

/**
 * requestWithdrawal
 * Записываем заявку в очередь. Считаем, что фронт уже списал сумму + комиссию.
 */
app.post('/api/requestWithdrawal', async (req,res) => {
  try {
    const { uid, address, amount } = req.body;
    if(!uid || !address || !amount) return res.json({ ok:false, error:'bad params' });
    const qref = db.ref('withdrawQueue').push();
    await qref.set({ uid, address, amount: Number(amount), status:'queued', createdAt: Date.now() });
    return res.json({ ok:true });
  } catch(e){ console.error(e); return res.json({ ok:false }); }
});

/**
 * Admin process (demo)
 */
app.post('/api/admin/processPayout', async (req,res) => {
  const { secret } = req.body || {};
  if(secret !== process.env.ADMIN_SECRET) return res.status(403).json({ ok:false });
  const qref = db.ref('withdrawQueue');
  const qsnap = await qref.orderByChild('status').equalTo('queued').limitToFirst(10).get();
  const updates = {};
  qsnap.forEach(ch => { updates[ch.key + '/status'] = 'done'; updates[ch.key + '/processedAt'] = Date.now(); });
  if(Object.keys(updates).length) await qref.update(updates);
  res.json({ ok:true, processed: Object.keys(updates).length/2 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
