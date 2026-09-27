const express = require('express');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Uploads
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));
const upload = multer({ dest: uploadDir, limits: { fileSize: 5*1024*1024 } });

// ── POSTGRESQL CONNECTION ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const db = {
  query: (text, params) => pool.query(text, params),
  one: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows[0];
  },
  all: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows;
  },
  run: (text, params) => pool.query(text, params)
};

// ── INIT TABLES ───────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      buy_price NUMERIC DEFAULT 0,
      sell_price NUMERIC DEFAULT 0,
      stock INTEGER DEFAULT 0,
      image TEXT,
      category TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT DEFAULT '',
      customer_name TEXT DEFAULT 'Walk-in',
      items JSONB,
      total NUMERIC DEFAULT 0,
      cost NUMERIC DEFAULT 0,
      profit NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      total_orders INTEGER DEFAULT 0,
      total_spent NUMERIC DEFAULT 0,
      last_order TIMESTAMPTZ,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_no TEXT UNIQUE,
      customer_name TEXT,
      customer_phone TEXT DEFAULT '',
      items JSONB,
      subtotal NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'unpaid',
      due_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      category TEXT,
      amount NUMERIC DEFAULT 0,
      note TEXT DEFAULT '',
      date DATE DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      client_name TEXT,
      client_phone TEXT DEFAULT '',
      title TEXT,
      description TEXT DEFAULT '',
      price NUMERIC DEFAULT 0,
      cost NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active',
      deadline DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;
  `);
  console.log('✅ Database tables ready');
}

const now = () => new Date().toISOString();

// ── GEMINI AI ─────────────────────────────────────────────────────────
async function gemini(prompt, imageBase64 = null, mimeType = 'image/jpeg') {
  if (!GEMINI_KEY) return '❌ GEMINI_API_KEY not set';
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
  const parts = [{ text: prompt }];
  if (imageBase64) parts.push({ inlineData: { data: imageBase64, mimeType } });
  const result = await model.generateContent(parts);
  return result.response.text();
}

// ── AI ROUTES ────────────────────────────────────────────────────────
app.post('/api/ai/generate', upload.single('image'), async (req, res) => {
  try {
    const { type, product_name, price, extra } = req.body;
    let imageBase64 = null;
    if (req.file) {
      imageBase64 = fs.readFileSync(req.file.path).toString('base64');
      fs.unlinkSync(req.file.path);
    }

    let prompt = '';
    if (type === 'caption') {
      prompt = `You are a Khmer social media expert. Create viral Facebook/TikTok content in Khmer for:
Product: ${product_name || 'ផលិតផល'}
Price: ${price || ''} 
${extra ? 'Info: ' + extra : ''}
${imageBase64 ? 'Describe the product from the image.' : ''}

Write:
1. 🔥 Caption ខ្មែរ (2-3 sentences, engaging, emoji)
2. ✍️ Description ពេញ (5-7 sentences, benefits)
3. 💬 Reply ទូទៅ ៣ (ឆ្លើយ "តម្លៃ?", "មានទេ?", "ល្អទេ?")
4. #Hashtags ១០`;
    } else if (type === 'ads') {
      prompt = `Create Khmer Facebook Ads for: ${product_name} - ${price}
${extra || ''}
Write: Headline, Ad Copy, Target Audience, Video Script (15-30s ខ្មែរ)`;
    } else if (type === 'reply') {
      prompt = `Professional Khmer customer service reply to: "${extra}"
Product: ${product_name || ''}
Write 3 reply options: Quick Reply, Detailed Reply, Sales Reply`;
    } else if (type === 'description') {
      prompt = `Product description in Khmer for: ${product_name}
${extra || ''}
Include: Features, Benefits, Usage, Why buy. 150-200 words.`;
    }

    const result = await gemini(prompt, imageBase64);
    res.json({ success: true, result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const rows = await db.all('SELECT * FROM products ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/products', upload.single('image'), async (req, res) => {
  const { name, description, buy_price, sell_price, stock, category } = req.body;
  const id = uuidv4();
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  await db.run(
    'INSERT INTO products (id,name,description,buy_price,sell_price,stock,image,category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, name, description, +buy_price||0, +sell_price||0, +stock||0, image, category]
  );
  res.json({ success: true, id });
});

app.put('/api/products/:id', async (req, res) => {
  const { name, description, buy_price, sell_price, stock, category } = req.body;
  await db.run(
    'UPDATE products SET name=$1,description=$2,buy_price=$3,sell_price=$4,stock=$5,category=$6 WHERE id=$7',
    [name, description, +buy_price||0, +sell_price||0, +stock||0, category, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/products/:id', async (req, res) => {
  await db.run('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── ORDERS ────────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const rows = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_id, items, note } = req.body;
  const parsedItems = JSON.parse(items || '[]');
  let total = 0, cost = 0;

  for (const item of parsedItems) {
    total += item.price * item.qty;
    cost  += item.buy_price * item.qty;
    await db.run('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.qty, item.id]);
  }

  const profit = total - cost;
  const id = uuidv4();
  await db.run(
    'INSERT INTO orders (id,customer_id,customer_name,items,total,cost,profit,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, customer_id||'', customer_name||'Walk-in', JSON.stringify(parsedItems), total, cost, profit, note||'']
  );

  if (customer_id) {
    await db.run(
      'UPDATE customers SET total_orders=total_orders+1, total_spent=total_spent+$1, last_order=NOW() WHERE id=$2',
      [total, customer_id]
    );
  }
  res.json({ success: true, id, total, profit });
});

app.put('/api/orders/:id/status', async (req, res) => {
  await db.run('UPDATE orders SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/orders/:id', async (req, res) => {
  await db.run('DELETE FROM orders WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── CUSTOMERS ─────────────────────────────────────────────────────────
app.get('/api/customers', async (req, res) => {
  const rows = await db.all('SELECT * FROM customers ORDER BY total_spent DESC');
  res.json(rows);
});

app.post('/api/customers', async (req, res) => {
  const { name, phone, address, note } = req.body;
  const id = uuidv4();
  await db.run(
    'INSERT INTO customers (id,name,phone,address,note) VALUES ($1,$2,$3,$4,$5)',
    [id, name, phone||'', address||'', note||'']
  );
  res.json({ success: true, id });
});

app.put('/api/customers/:id', async (req, res) => {
  const { name, phone, address, note } = req.body;
  await db.run(
    'UPDATE customers SET name=$1,phone=$2,address=$3,note=$4 WHERE id=$5',
    [name, phone, address, note, req.params.id]
  );
  res.json({ success: true });
});

app.post('/api/customers/followup-message', async (req, res) => {
  const { customer_name, last_order, products } = req.body;
  const result = await gemini(
    `Write a friendly Khmer follow-up message to "${customer_name}" who last ordered on ${last_order}. Products: ${products}. Warm, personal, encourage rebuy. 2-3 sentences.`
  );
  res.json({ success: true, message: result });
});

// ── INVOICES ──────────────────────────────────────────────────────────
app.get('/api/invoices', async (req, res) => {
  const rows = await db.all('SELECT * FROM invoices ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/invoices', async (req, res) => {
  const { customer_name, customer_phone, items, discount, due_date } = req.body;
  const parsedItems = JSON.parse(items || '[]');
  const subtotal = parsedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const total = subtotal - (+discount || 0);
  const id = uuidv4();
  // Auto invoice number
  const seqRow = await db.one("SELECT nextval('invoice_seq') as n");
  const invoice_no = `INV-${String(seqRow.n).padStart(4,'0')}`;
  await db.run(
    'INSERT INTO invoices (id,invoice_no,customer_name,customer_phone,items,subtotal,discount,total,due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, invoice_no, customer_name, customer_phone||'', JSON.stringify(parsedItems), subtotal, +discount||0, total, due_date||null]
  );
  res.json({ success: true, id, invoice_no, total });
});

app.put('/api/invoices/:id/pay', async (req, res) => {
  await db.run("UPDATE invoices SET status='paid' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ── EXPENSES ──────────────────────────────────────────────────────────
app.get('/api/expenses', async (req, res) => {
  const rows = await db.all('SELECT * FROM expenses ORDER BY date DESC');
  res.json(rows);
});

app.post('/api/expenses', async (req, res) => {
  const { category, amount, note, date } = req.body;
  const id = uuidv4();
  await db.run(
    'INSERT INTO expenses (id,category,amount,note,date) VALUES ($1,$2,$3,$4,$5)',
    [id, category, +amount||0, note||'', date||null]
  );
  res.json({ success: true });
});

// ── PROJECTS (Freelancer) ─────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  const rows = await db.all('SELECT * FROM projects ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/projects', async (req, res) => {
  const { client_name, client_phone, title, description, price, cost, deadline } = req.body;
  const id = uuidv4();
  await db.run(
    'INSERT INTO projects (id,client_name,client_phone,title,description,price,cost,deadline) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, client_name, client_phone||'', title, description||'', +price||0, +cost||0, deadline||null]
  );
  res.json({ success: true, id });
});

app.put('/api/projects/:id/status', async (req, res) => {
  await db.run('UPDATE projects SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  res.json({ success: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const month = new Date().toISOString().slice(0,7);

  const [totalSales, totalProfit, totalOrders, totalCustomers,
         totalProducts, lowStock, unpaidInv, todaySales, monthSales,
         recentOrders] = await Promise.all([
    db.one("SELECT COALESCE(SUM(total),0) as v FROM orders WHERE status!='cancelled'"),
    db.one("SELECT COALESCE(SUM(profit),0) as v FROM orders WHERE status!='cancelled'"),
    db.one("SELECT COUNT(*) as v FROM orders"),
    db.one("SELECT COUNT(*) as v FROM customers"),
    db.one("SELECT COUNT(*) as v FROM products"),
    db.one("SELECT COUNT(*) as v FROM products WHERE stock<=5"),
    db.one("SELECT COUNT(*) as v FROM invoices WHERE status='unpaid'"),
    db.one(`SELECT COALESCE(SUM(total),0) as v FROM orders WHERE created_at::date=$1`, [today]),
    db.one(`SELECT COALESCE(SUM(total),0) as v FROM orders WHERE TO_CHAR(created_at,'YYYY-MM')=$1`, [month]),
    db.all("SELECT * FROM orders ORDER BY created_at DESC LIMIT 5"),
  ]);

  res.json({
    totalSales: +totalSales.v, totalProfit: +totalProfit.v,
    totalOrders: +totalOrders.v, totalCustomers: +totalCustomers.v,
    totalProducts: +totalProducts.v, lowStock: +lowStock.v,
    unpaidInv: +unpaidInv.v, todaySales: +todaySales.v,
    monthSales: +monthSales.v, recentOrders
  });
});

// ── REPORTS ───────────────────────────────────────────────────────────
app.get('/api/reports', async (req, res) => {
  const { period } = req.query;
  let dateFilter = '';
  if (period==='today') dateFilter = `AND created_at::date=CURRENT_DATE`;
  if (period==='week')  dateFilter = `AND created_at >= NOW()-INTERVAL '7 days'`;
  if (period==='month') dateFilter = `AND TO_CHAR(created_at,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')`;

  const expFilter = dateFilter.replace(/created_at/g,'date::timestamptz');

  const [sales, profit, cost, orders, expenses, dailySales] = await Promise.all([
    db.one(`SELECT COALESCE(SUM(total),0) as v FROM orders WHERE status!='cancelled' ${dateFilter}`),
    db.one(`SELECT COALESCE(SUM(profit),0) as v FROM orders WHERE status!='cancelled' ${dateFilter}`),
    db.one(`SELECT COALESCE(SUM(cost),0) as v FROM orders WHERE status!='cancelled' ${dateFilter}`),
    db.one(`SELECT COUNT(*) as v FROM orders WHERE 1=1 ${dateFilter}`),
    db.one(`SELECT COALESCE(SUM(amount),0) as v FROM expenses WHERE 1=1 ${expFilter}`),
    db.all(`SELECT created_at::date as date, SUM(total) as sales, SUM(profit) as profit
            FROM orders WHERE status!='cancelled' AND created_at>=NOW()-INTERVAL '30 days'
            GROUP BY created_at::date ORDER BY date`),
  ]);

  res.json({
    sales: +sales.v, profit: +profit.v, cost: +cost.v,
    orders: +orders.v, expenses: +expenses.v,
    netProfit: +profit.v - +expenses.v,
    dailySales
  });
});

app.post('/api/ai/report', async (req, res) => {
  const { sales, profit, orders, expenses, netProfit, period } = req.body;
  const result = await gemini(`You are a Khmer business advisor. Analyze in Khmer:
Period: ${period} | Sales: $${sales} | Profit: $${profit} | Expenses: $${expenses} | Net: $${netProfit} | Orders: ${orders}
Give: Analysis (2-3 sentences) + 3 Tips to improve + Warnings + Next month goal`);
  res.json({ success: true, analysis: result });
});

// ── START ─────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Luy AI on port ${PORT}`);
    console.log(`📦 PostgreSQL: ${process.env.DATABASE_URL ? 'Connected ✅' : 'Not set ❌'}`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
