const express = require('express');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'luy-ai-secret-2026';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));
const upload = multer({ dest: uploadDir, limits: { fileSize: 5*1024*1024 } });

// ── POSTGRESQL ─────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const db = {
  query: (t,p) => pool.query(t,p),
  one:   async (t,p) => { const r=await pool.query(t,p); return r.rows[0]; },
  all:   async (t,p) => { const r=await pool.query(t,p); return r.rows; },
  run:   (t,p) => pool.query(t,p)
};

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      shop_name TEXT DEFAULT 'ហាងរបស់ខ្ញុំ',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL,
      description TEXT, buy_price NUMERIC DEFAULT 0, sell_price NUMERIC DEFAULT 0,
      stock INTEGER DEFAULT 0, image TEXT, category TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id TEXT, customer_id TEXT DEFAULT '',
      customer_name TEXT DEFAULT 'Walk-in', items JSONB,
      total NUMERIC DEFAULT 0, cost NUMERIC DEFAULT 0, profit NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'pending', note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL,
      phone TEXT DEFAULT '', address TEXT DEFAULT '',
      total_orders INTEGER DEFAULT 0, total_spent NUMERIC DEFAULT 0,
      last_order TIMESTAMPTZ, note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, user_id TEXT, invoice_no TEXT,
      customer_name TEXT, customer_phone TEXT DEFAULT '',
      items JSONB, subtotal NUMERIC DEFAULT 0, discount NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0, status TEXT DEFAULT 'unpaid',
      due_date DATE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, user_id TEXT, category TEXT,
      amount NUMERIC DEFAULT 0, note TEXT DEFAULT '', date DATE DEFAULT CURRENT_DATE
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT, client_name TEXT,
      client_phone TEXT DEFAULT '', title TEXT, description TEXT DEFAULT '',
      price NUMERIC DEFAULT 0, cost NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active', deadline DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;
  `);
  console.log('✅ Database tables ready');
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── AUTH ROUTES ────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, shop_name } = req.body;
  if (!name || !email || !password) return res.json({ error: 'Fill all fields!' });
  try {
    const exists = await db.one('SELECT id FROM users WHERE email=$1', [email]);
    if (exists) return res.json({ error: 'Email already exists!' });
  } catch {}
  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  await db.run(
    'INSERT INTO users (id,name,email,password,shop_name) VALUES ($1,$2,$3,$4,$5)',
    [id, name, email, hash, shop_name||'ហាងរបស់ខ្ញុំ']
  );
  const token = jwt.sign({ id, name, email, shop_name: shop_name||'ហាងរបស់ខ្ញុំ' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id, name, email, shop_name } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.one('SELECT * FROM users WHERE email=$1', [email]);
  if (!user) return res.json({ error: 'Email not found!' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.json({ error: 'Wrong password!' });
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, shop_name: user.shop_name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, shop_name: user.shop_name, plan: user.plan } });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const user = await db.one('SELECT id,name,email,shop_name,plan,created_at FROM users WHERE id=$1', [req.user.id]);
  res.json(user);
});

// ── GEMINI AI ──────────────────────────────────────────────────────────
async function gemini(prompt, imageBase64=null, mimeType='image/jpeg') {
  if (!GEMINI_KEY) return '❌ GEMINI_API_KEY not set';
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
  const parts = [{ text: prompt }];
  if (imageBase64) parts.push({ inlineData: { data: imageBase64, mimeType } });
  const result = await model.generateContent(parts);
  return result.response.text();
}

app.post('/api/ai/generate', auth, upload.single('image'), async (req, res) => {
  try {
    const { type, product_name, price, extra } = req.body;
    let imageBase64 = null;
    if (req.file) { imageBase64 = fs.readFileSync(req.file.path).toString('base64'); fs.unlinkSync(req.file.path); }
    let prompt = '';
    if (type==='caption') {
      prompt = `Khmer social media expert. Create viral Facebook/TikTok content in Khmer for:\nProduct: ${product_name||'ផលិតផល'}\nPrice: ${price||''}\n${extra||''}\n${imageBase64?'Describe from image.':''}\n\nWrite:\n1. 🔥 Caption ខ្មែរ (2-3 lines, emoji)\n2. ✍️ Description (5-7 lines, benefits)\n3. 💬 3 Reply templates\n4. #Hashtags ១០`;
    } else if (type==='ads') {
      prompt = `Khmer Facebook Ads for: ${product_name} - ${price}\n${extra||''}\nWrite: Headline, Ad Copy, Target Audience, Video Script (15-30s)`;
    } else if (type==='reply') {
      prompt = `Professional Khmer customer service. Customer said: "${extra}"\nProduct: ${product_name||''}\nWrite 3 reply options: Quick, Detailed, Sales`;
    } else if (type==='description') {
      prompt = `Product description in Khmer for: ${product_name}\n${extra||''}\nFeatures, Benefits, Usage, Why buy. 150-200 words.`;
    }
    const result = await gemini(prompt, imageBase64);
    res.json({ success: true, result });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ── PRODUCTS ───────────────────────────────────────────────────────────
app.get('/api/products', auth, async (req,res) => {
  res.json(await db.all('SELECT * FROM products WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]));
});
app.post('/api/products', auth, upload.single('image'), async (req,res) => {
  const {name,description,buy_price,sell_price,stock,category}=req.body;
  const id=uuidv4(), image=req.file?`/uploads/${req.file.filename}`:null;
  await db.run('INSERT INTO products (id,user_id,name,description,buy_price,sell_price,stock,image,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id,req.user.id,name,description,+buy_price||0,+sell_price||0,+stock||0,image,category]);
  res.json({success:true,id});
});
app.put('/api/products/:id', auth, async (req,res) => {
  const {name,description,buy_price,sell_price,stock,category}=req.body;
  await db.run('UPDATE products SET name=$1,description=$2,buy_price=$3,sell_price=$4,stock=$5,category=$6 WHERE id=$7 AND user_id=$8',
    [name,description,+buy_price||0,+sell_price||0,+stock||0,category,req.params.id,req.user.id]);
  res.json({success:true});
});
app.delete('/api/products/:id', auth, async (req,res) => {
  await db.run('DELETE FROM products WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
  res.json({success:true});
});

// ── ORDERS ─────────────────────────────────────────────────────────────
app.get('/api/orders', auth, async (req,res) => {
  res.json(await db.all('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]));
});
app.post('/api/orders', auth, async (req,res) => {
  const {customer_name,customer_id,items,note}=req.body;
  const parsed=JSON.parse(items||'[]'); let total=0,cost=0;
  for(const i of parsed){
    total+=i.price*i.qty; cost+=i.buy_price*i.qty;
    await db.run('UPDATE products SET stock=stock-$1 WHERE id=$2 AND user_id=$3',[i.qty,i.id,req.user.id]);
  }
  const id=uuidv4();
  await db.run('INSERT INTO orders (id,user_id,customer_id,customer_name,items,total,cost,profit,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id,req.user.id,customer_id||'',customer_name||'Walk-in',JSON.stringify(parsed),total,cost,total-cost,note||'']);
  if(customer_id) await db.run('UPDATE customers SET total_orders=total_orders+1,total_spent=total_spent+$1,last_order=NOW() WHERE id=$2 AND user_id=$3',[total,customer_id,req.user.id]);
  res.json({success:true,id,total,profit:total-cost});
});
app.put('/api/orders/:id/status', auth, async (req,res) => {
  await db.run('UPDATE orders SET status=$1 WHERE id=$2 AND user_id=$3',[req.body.status,req.params.id,req.user.id]);
  res.json({success:true});
});
app.delete('/api/orders/:id', auth, async (req,res) => {
  await db.run('DELETE FROM orders WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);
  res.json({success:true});
});

// ── CUSTOMERS ──────────────────────────────────────────────────────────
app.get('/api/customers', auth, async (req,res) => {
  res.json(await db.all('SELECT * FROM customers WHERE user_id=$1 ORDER BY total_spent DESC',[req.user.id]));
});
app.post('/api/customers', auth, async (req,res) => {
  const {name,phone,address,note}=req.body; const id=uuidv4();
  await db.run('INSERT INTO customers (id,user_id,name,phone,address,note) VALUES ($1,$2,$3,$4,$5,$6)',[id,req.user.id,name,phone||'',address||'',note||'']);
  res.json({success:true,id});
});
app.post('/api/customers/followup-message', auth, async (req,res) => {
  const {customer_name,last_order}=req.body;
  const result=await gemini(`Friendly Khmer follow-up message to "${customer_name}" (last order: ${last_order}). Warm, personal, encourage rebuy. 2-3 sentences.`);
  res.json({success:true,message:result});
});

// ── INVOICES ───────────────────────────────────────────────────────────
app.get('/api/invoices', auth, async (req,res) => {
  res.json(await db.all('SELECT * FROM invoices WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]));
});
app.post('/api/invoices', auth, async (req,res) => {
  const {customer_name,customer_phone,items,discount,due_date}=req.body;
  const parsed=JSON.parse(items||'[]');
  const subtotal=parsed.reduce((s,i)=>s+i.price*i.qty,0), total=subtotal-(+discount||0);
  const id=uuidv4(), seq=await db.one("SELECT nextval('invoice_seq') as n");
  const invoice_no=`INV-${String(seq.n).padStart(4,'0')}`;
  await db.run('INSERT INTO invoices (id,user_id,invoice_no,customer_name,customer_phone,items,subtotal,discount,total,due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id,req.user.id,invoice_no,customer_name,customer_phone||'',JSON.stringify(parsed),subtotal,+discount||0,total,due_date||null]);
  res.json({success:true,id,invoice_no,total});
});
app.put('/api/invoices/:id/pay', auth, async (req,res) => {
  await db.run("UPDATE invoices SET status='paid' WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);
  res.json({success:true});
});

// ── EXPENSES ───────────────────────────────────────────────────────────
app.get('/api/expenses', auth, async (req,res) => {
  res.json(await db.all('SELECT * FROM expenses WHERE user_id=$1 ORDER BY date DESC',[req.user.id]));
});
app.post('/api/expenses', auth, async (req,res) => {
  const {category,amount,note,date}=req.body; const id=uuidv4();
  await db.run('INSERT INTO expenses (id,user_id,category,amount,note,date) VALUES ($1,$2,$3,$4,$5,$6)',[id,req.user.id,category,+amount||0,note||'',date||null]);
  res.json({success:true});
});

// ── PROJECTS ───────────────────────────────────────────────────────────
app.get('/api/projects', auth, async (req,res) => {
  res.json(await db.all('SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]));
});
app.post('/api/projects', auth, async (req,res) => {
  const {client_name,client_phone,title,description,price,cost,deadline}=req.body; const id=uuidv4();
  await db.run('INSERT INTO projects (id,user_id,client_name,client_phone,title,description,price,cost,deadline) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id,req.user.id,client_name,client_phone||'',title,description||'',+price||0,+cost||0,deadline||null]);
  res.json({success:true,id});
});
app.put('/api/projects/:id/status', auth, async (req,res) => {
  await db.run('UPDATE projects SET status=$1 WHERE id=$2 AND user_id=$3',[req.body.status,req.params.id,req.user.id]);
  res.json({success:true});
});

// ── DASHBOARD ──────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req,res) => {
  const uid=req.user.id, today=new Date().toISOString().slice(0,10), month=new Date().toISOString().slice(0,7);
  const [ts,tp,to,tc,tpr,ls,ui,tds,ms,ro,dp] = await Promise.all([
    db.one("SELECT COALESCE(SUM(total),0) v FROM orders WHERE user_id=$1 AND status!='cancelled'",[uid]),
    db.one("SELECT COALESCE(SUM(profit),0) v FROM orders WHERE user_id=$1 AND status!='cancelled'",[uid]),
    db.one('SELECT COUNT(*) v FROM orders WHERE user_id=$1',[uid]),
    db.one('SELECT COUNT(*) v FROM customers WHERE user_id=$1',[uid]),
    db.one('SELECT COUNT(*) v FROM products WHERE user_id=$1',[uid]),
    db.one('SELECT COUNT(*) v FROM products WHERE user_id=$1 AND stock<=5',[uid]),
    db.one("SELECT COUNT(*) v FROM invoices WHERE user_id=$1 AND status='unpaid'",[uid]),
    db.one('SELECT COALESCE(SUM(total),0) v FROM orders WHERE user_id=$1 AND created_at::date=$2',[uid,today]),
    db.one('SELECT COALESCE(SUM(total),0) v FROM orders WHERE user_id=$1 AND TO_CHAR(created_at,$2)=$3',[uid,'YYYY-MM',month]),
    db.all('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5',[uid]),
    db.all("SELECT created_at::date as date, SUM(total) sales, SUM(profit) profit FROM orders WHERE user_id=$1 AND status!='cancelled' AND created_at>=NOW()-INTERVAL '30 days' GROUP BY created_at::date ORDER BY date",[uid]),
  ]);
  res.json({totalSales:+ts.v,totalProfit:+tp.v,totalOrders:+to.v,totalCustomers:+tc.v,
    totalProducts:+tpr.v,lowStock:+ls.v,unpaidInv:+ui.v,todaySales:+tds.v,monthSales:+ms.v,
    recentOrders:ro,dailyProfit:dp});
});

// ── REPORTS ────────────────────────────────────────────────────────────
app.get('/api/reports', auth, async (req,res) => {
  const uid=req.user.id, {period}=req.query;
  let df='', ef='';
  if(period==='today') { df=`AND created_at::date=CURRENT_DATE`; ef=`AND date=CURRENT_DATE`; }
  if(period==='week')  { df=`AND created_at>=NOW()-INTERVAL '7 days'`; ef=`AND date>=CURRENT_DATE-7`; }
  if(period==='month') { df=`AND TO_CHAR(created_at,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')`; ef=`AND TO_CHAR(date::timestamptz,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')`; }
  const [sa,pr,co,or,ex,ds] = await Promise.all([
    db.one(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE user_id=$1 AND status!='cancelled' ${df}`,[uid]),
    db.one(`SELECT COALESCE(SUM(profit),0) v FROM orders WHERE user_id=$1 AND status!='cancelled' ${df}`,[uid]),
    db.one(`SELECT COALESCE(SUM(cost),0) v FROM orders WHERE user_id=$1 AND status!='cancelled' ${df}`,[uid]),
    db.one(`SELECT COUNT(*) v FROM orders WHERE user_id=$1 ${df}`,[uid]),
    db.one(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE user_id=$1 ${ef}`,[uid]),
    db.all(`SELECT created_at::date date,SUM(total) sales,SUM(profit) profit FROM orders WHERE user_id=$1 AND status!='cancelled' AND created_at>=NOW()-INTERVAL '30 days' GROUP BY created_at::date ORDER BY date`,[uid]),
  ]);
  res.json({sales:+sa.v,profit:+pr.v,cost:+co.v,orders:+or.v,expenses:+ex.v,netProfit:+pr.v-+ex.v,dailySales:ds});
});

app.post('/api/ai/report', auth, async (req,res) => {
  const {sales,profit,orders,expenses,netProfit,period}=req.body;
  const result=await gemini(`Khmer business advisor. Analyze in Khmer:\nPeriod:${period}|Sales:$${sales}|Profit:$${profit}|Expenses:$${expenses}|Net:$${netProfit}|Orders:${orders}\nGive: Analysis+3 Tips+Warnings+Next month goal`);
  res.json({success:true,analysis:result});
});

// ── EXPORT CSV ─────────────────────────────────────────────────────────
app.get('/api/export/orders', auth, async (req,res) => {
  const orders=await db.all('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);
  const csv=['Date,Customer,Total,Profit,Status',...orders.map(o=>`${o.created_at?.toString().slice(0,10)},${o.customer_name},${o.total},${o.profit},${o.status}`)].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment;filename=orders.csv');
  res.send(csv);
});

initDB().then(()=>{
  app.listen(PORT,()=>{
    console.log(`✅ Luy AI on port ${PORT}`);
    console.log(`📦 PostgreSQL: ${process.env.DATABASE_URL?'Connected ✅':'Not set ❌'}`);
  });
}).catch(e=>{console.error('❌ DB init failed:',e.message);process.exit(1);});

// ── ADMIN MIDDLEWARE ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@luyai.com';
    if (user.email !== ADMIN_EMAIL && user.role !== 'admin')
      return res.status(403).json({ error: 'Admin only!' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── ADMIN ROUTES ──────────────────────────────────────────────────────

// All users
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await db.all(`
    SELECT u.id, u.name, u.email, u.shop_name, u.plan, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) as total_orders,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.user_id=u.id AND status!='cancelled') as total_sales,
      (SELECT COUNT(*) FROM products p WHERE p.user_id=u.id) as total_products
    FROM users u ORDER BY u.created_at DESC
  `);
  res.json(users);
});

// Update user plan
app.put('/api/admin/users/:id/plan', adminAuth, async (req, res) => {
  const { plan } = req.body;
  await db.run('UPDATE users SET plan=$1 WHERE id=$2', [plan, req.params.id]);
  res.json({ success: true });
});

// Delete user
app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  await db.run('DELETE FROM orders WHERE user_id=$1', [req.params.id]);
  await db.run('DELETE FROM products WHERE user_id=$1', [req.params.id]);
  await db.run('DELETE FROM customers WHERE user_id=$1', [req.params.id]);
  await db.run('DELETE FROM invoices WHERE user_id=$1', [req.params.id]);
  await db.run('DELETE FROM expenses WHERE user_id=$1', [req.params.id]);
  await db.run('DELETE FROM projects WHERE user_id=$1', [req.params.id]);
  await db.run('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// System stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [users, orders, revenue, products, freeUsers, proUsers] = await Promise.all([
    db.one('SELECT COUNT(*) v FROM users'),
    db.one("SELECT COUNT(*) v FROM orders WHERE status!='cancelled'"),
    db.one("SELECT COALESCE(SUM(total),0) v FROM orders WHERE status!='cancelled'"),
    db.one('SELECT COUNT(*) v FROM products'),
    db.one("SELECT COUNT(*) v FROM users WHERE plan='free'"),
    db.one("SELECT COUNT(*) v FROM users WHERE plan!='free'"),
  ]);
  const daily = await db.all(`
    SELECT created_at::date as date, COUNT(*) as new_users
    FROM users WHERE created_at >= NOW()-INTERVAL '30 days'
    GROUP BY created_at::date ORDER BY date
  `);
  res.json({
    totalUsers: +users.v, totalOrders: +orders.v,
    totalRevenue: +revenue.v, totalProducts: +products.v,
    freeUsers: +freeUsers.v, proUsers: +proUsers.v,
    dailySignups: daily
  });
});

// Check if current user is admin
app.get('/api/admin/check', auth, async (req, res) => {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@luyai.com';
  res.json({ isAdmin: req.user.email === ADMIN_EMAIL });
});
