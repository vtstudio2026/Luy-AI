const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'luy-ai-secret-2026';

// PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Multer
const upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static('public'));

// ==================== INIT DATABASE ====================
async function initDB() {
  // Users table — id as TEXT to match existing DB
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user',
      plan VARCHAR(50) DEFAULT 'free',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255),
      price DECIMAL(10,2) DEFAULT 0,
      stock INTEGER DEFAULT 0,
      unit VARCHAR(50) DEFAULT 'pcs',
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      customer_name VARCHAR(255),
      items TEXT DEFAULT '[]',
      total DECIMAL(10,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      invoice_number VARCHAR(50),
      customer_name VARCHAR(255),
      items TEXT DEFAULT '[]',
      total DECIMAL(10,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'unpaid',
      due_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      email VARCHAR(255),
      address TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      category VARCHAR(255),
      amount DECIMAL(10,2) DEFAULT 0,
      description TEXT,
      date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      product_name VARCHAR(255),
      quantity INTEGER DEFAULT 1,
      unit_price DECIMAL(10,2) DEFAULT 0,
      total DECIMAL(10,2) DEFAULT 0,
      customer_name VARCHAR(255),
      date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Safe migrations — add missing columns only
  const migrations = [
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS items TEXT DEFAULT '[]'`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50)`,
    `ALTER TABLE orders   ADD COLUMN IF NOT EXISTS items TEXT DEFAULT '[]'`,
    `ALTER TABLE users    ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'free'`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { /* column exists */ }
  }

  console.log('✅ Database initialized');
}

// ==================== AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ==================== AUTH ROUTES ====================
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const count = await pool.query('SELECT COUNT(*) FROM users');
    const role = parseInt(count.rows[0].count) === 0 ? 'admin' : 'user';
    // Use gen_random_uuid() for TEXT id compatibility
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password, role)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
       RETURNING id, name, email, role, plan`,
      [name, email, hashed, role]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id,name,email,role,plan,created_at FROM users WHERE id=$1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADMIN ROUTES ====================
app.get('/api/admin/users', authenticateToken, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT id,name,email,role,plan,created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { role, plan } = req.body;
    const result = await pool.query(
      'UPDATE users SET role=$1, plan=$2 WHERE id=$3 RETURNING id,name,email,role,plan',
      [role, plan, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', authenticateToken, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PRODUCTS ====================
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', authenticateToken, async (req, res) => {
  try {
    const { name, category, price, stock, unit, description } = req.body;
    const result = await pool.query(
      'INSERT INTO products (user_id,name,category,price,stock,unit,description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, name, category, price || 0, stock || 0, unit || 'pcs', description]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { name, category, price, stock, unit, description } = req.body;
    const result = await pool.query(
      'UPDATE products SET name=$1,category=$2,price=$3,stock=$4,unit=$5,description=$6 WHERE id=$7 AND user_id=$8 RETURNING *',
      [name, category, price, stock, unit, description, req.params.id, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ORDERS ====================
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const orders = result.rows.map(o => ({
      ...o,
      items: typeof o.items === 'string' ? JSON.parse(o.items || '[]') : (o.items || [])
    }));
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { customer_name, items, total, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO orders (user_id,customer_name,items,total,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, customer_name, JSON.stringify(items || []), total || 0, notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE orders SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [status, req.params.id, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== INVOICES ====================
function parseItems(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return raw;
}

app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM invoices WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const invoices = result.rows.map(inv => ({
      ...inv,
      items: parseItems(inv.items)
    }));
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const { customer_name, items, total, due_date, notes } = req.body;
    // Generate invoice number
    const count = await pool.query('SELECT COUNT(*) FROM invoices WHERE user_id=$1', [req.user.id]);
    const invNum = 'INV-' + String(parseInt(count.rows[0].count) + 1).padStart(4, '0');
    const result = await pool.query(
      `INSERT INTO invoices (user_id, invoice_number, customer_name, items, total, due_date, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'unpaid') RETURNING *`,
      [req.user.id, invNum, customer_name, JSON.stringify(items || []), total || 0, due_date || null, notes]
    );
    const inv = result.rows[0];
    res.json({ ...inv, items: parseItems(inv.items) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE invoices SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [status, req.params.id, req.user.id]
    );
    const inv = result.rows[0];
    res.json({ ...inv, items: parseItems(inv.items) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM invoices WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CUSTOMERS ====================
app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM customers WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', authenticateToken, async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO customers (user_id,name,phone,email,address,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, name, phone, email, address, notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM customers WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EXPENSES ====================
app.get('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM expenses WHERE user_id=$1 ORDER BY date DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const { category, amount, description, date } = req.body;
    const result = await pool.query(
      'INSERT INTO expenses (user_id,category,amount,description,date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, category, amount || 0, description, date || new Date().toISOString().split('T')[0]]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/expenses/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SALES ====================
app.get('/api/sales', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sales WHERE user_id=$1 ORDER BY date DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sales', authenticateToken, async (req, res) => {
  try {
    const { product_name, quantity, unit_price, customer_name, date } = req.body;
    const total = (quantity || 1) * (unit_price || 0);
    const result = await pool.query(
      'INSERT INTO sales (user_id,product_name,quantity,unit_price,total,customer_name,date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, product_name, quantity || 1, unit_price || 0, total, customer_name, date || new Date().toISOString().split('T')[0]]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DASHBOARD STATS ====================
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const [products, orders, invoices, customers, sales, expenses] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM products WHERE user_id=$1', [uid]),
      pool.query('SELECT COUNT(*) as count FROM orders WHERE user_id=$1', [uid]),
      pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total FROM invoices WHERE user_id=$1', [uid]),
      pool.query('SELECT COUNT(*) as count FROM customers WHERE user_id=$1', [uid]),
      pool.query('SELECT COALESCE(SUM(total),0) as total FROM sales WHERE user_id=$1', [uid]),
      pool.query('SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE user_id=$1', [uid]),
    ]);
    res.json({
      products: parseInt(products.rows[0].count),
      orders: parseInt(orders.rows[0].count),
      invoices: parseInt(invoices.rows[0].count),
      invoice_total: parseFloat(invoices.rows[0].total),
      customers: parseInt(customers.rows[0].count),
      sales_total: parseFloat(sales.rows[0].total),
      expenses_total: parseFloat(expenses.rows[0].total),
      profit: parseFloat(sales.rows[0].total) - parseFloat(expenses.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== AI SELLER (GEMINI) ====================
app.post('/api/ai/generate', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { type, product_name, description, language } = req.body;
    const lang = language === 'khmer' ? 'ភាសាខ្មែរ' : 'English';

    let prompt = '';
    if (type === 'caption') {
      prompt = `Write a creative Facebook post caption in ${lang} to sell: "${product_name}". ${description ? 'Details: ' + description : ''}. Make it engaging with emojis.`;
    } else if (type === 'description') {
      prompt = `Write a product description in ${lang} for: "${product_name}". ${description ? 'Details: ' + description : ''}. Include key features and benefits.`;
    } else if (type === 'reply') {
      prompt = `Write a friendly customer reply in ${lang} for the message: "${description}". Be polite and helpful.`;
    } else if (type === 'ads') {
      prompt = `Write a Facebook ad copy in ${lang} for: "${product_name}". ${description ? 'Details: ' + description : ''}. Include call-to-action.`;
    } else if (type === 'analysis') {
      prompt = `As a business advisor, analyze this business situation in ${lang}: "${description}". Give practical advice and recommendations.`;
    } else {
      prompt = description || 'Help me with my business.';
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    let result;
    if (req.file) {
      const imageData = fs.readFileSync(req.file.path);
      const base64 = imageData.toString('base64');
      const mime = req.file.mimetype;
      result = await model.generateContent([
        { inlineData: { data: base64, mimeType: mime } },
        prompt
      ]);
      fs.unlinkSync(req.file.path);
    } else {
      result = await model.generateContent(prompt);
    }

    const text = result.response.text();
    res.json({ result: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TEMP PASSWORD RESET (use once, then remove) ====================
app.post('/api/reset-pw', async (req, res) => {
  try {
    const { email, new_password, secret } = req.body;
    if (secret !== 'luyai-reset-2026') return res.status(403).json({ error: 'Wrong secret' });
    const hashed = await bcrypt.hash(new_password, 10);
    const result = await pool.query(
      'UPDATE users SET password=$1 WHERE email=$2 RETURNING id, name, email',
      [hashed, email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Email not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== START ====================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Luy AI running on port ${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
