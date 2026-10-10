import { 
  getKvClient, 
  DEFAULT_USERS, 
  sanitizeUser, 
  hashPassword,
  verifySessionToken, 
  extractBearerToken 
} from './_security.js';

export default async function handler(request, response) {
  const publicKeys = ['kmap_products', 'kmap_promos', 'kmap_featured_laptops', 'kmap_catalog_version'];
  const adminKeys = ['kmap_orders', 'kmap_logs', 'kmap_hire_purchase', 'kmap_users'];
  const allAllowedKeys = [...publicKeys, ...adminKeys];

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const kv = getKvClient();
  if (!kv) {
    return response.status(503).json({
      error: 'Upstash Redis / Vercel KV not configured.',
      configured: false
    });
  }

  // Verify Session Token (if provided)
  const token = extractBearerToken(request);
  const session = token ? verifySessionToken(token) : null;
  const isAdmin = session && ['admin', 'superadmin'].includes(session.role);
  const isClient = session && session.role === 'client';

  try {
    // ----------------------------------------------------
    // GET: RBAC-GATED DATA RETRIEVAL
    // ----------------------------------------------------
    if (request.method === 'GET') {
      const data = {};

      // 1. Fetch Public Catalog Keys for Everyone
      for (const key of publicKeys) {
        const val = await kv.get(key);
        data[key] = val || null;
      }

      // 2. Fetch Sensitive Keys Based on Roles
      if (isAdmin) {
        // Admins get complete store data
        for (const key of adminKeys) {
          const val = await kv.get(key);
          if (key === 'kmap_users') {
            const rawUsers = val || DEFAULT_USERS;
            const parsed = typeof rawUsers === 'string' ? JSON.parse(rawUsers) : rawUsers;
            // Always sanitize users so password hashes are NEVER transmitted
            data[key] = Array.isArray(parsed) ? parsed.map(sanitizeUser) : [];
          } else {
            data[key] = val || null;
          }
        }
      } else if (isClient) {
        // Authenticated client gets only their own personal orders
        const rawOrders = await kv.get('kmap_orders');
        const orders = typeof rawOrders === 'string' ? JSON.parse(rawOrders) : (rawOrders || []);
        if (Array.isArray(orders)) {
          data['kmap_orders'] = orders.filter(o => 
            (o.clientPhone && o.clientPhone === session.username) || 
            (o.clientName && o.clientName.toLowerCase() === (session.name || '').toLowerCase())
          );
        } else {
          data['kmap_orders'] = [];
        }
        // Client NEVER gets logs, hire purchase applications of other clients, or staff list
        data['kmap_logs'] = [];
        data['kmap_hire_purchase'] = [];
        data['kmap_users'] = [];
      } else {
        // Public guests get zero sensitive data
        data['kmap_orders'] = [];
        data['kmap_logs'] = [];
        data['kmap_hire_purchase'] = [];
        data['kmap_users'] = [];
      }

      return response.status(200).json(data);
    }

    // ----------------------------------------------------
    // POST: STRICTLY CONTROLLED DATABASE WRITES
    // ----------------------------------------------------
    if (request.method === 'POST') {
      const body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
      const action = body.action;

      // SUB-ACTION 1: Safe Customer Order Placement (No Admin Token Required)
      if (action === 'create_order') {
        const newOrder = body.order;
        if (!newOrder || !newOrder.id || !Array.isArray(newOrder.items)) {
          return response.status(400).json({ error: 'Invalid order structure' });
        }

        // Fetch current orders from KV
        const rawOrders = await kv.get('kmap_orders');
        let currentOrders = typeof rawOrders === 'string' ? JSON.parse(rawOrders) : (rawOrders || []);
        if (!Array.isArray(currentOrders)) currentOrders = [];

        // Prepend new order (prevent duplicate IDs)
        const filtered = currentOrders.filter(o => o.id !== newOrder.id);
        filtered.unshift(newOrder);
        await kv.set('kmap_orders', filtered);

        // Append to logs
        const rawLogs = await kv.get('kmap_logs');
        let logs = typeof rawLogs === 'string' ? JSON.parse(rawLogs) : (rawLogs || []);
        if (Array.isArray(logs)) {
          logs.unshift({
            date: new Date().toISOString(),
            user: session ? session.username : 'Online Guest',
            message: `New Order placed: ${newOrder.id} by ${newOrder.clientName || 'Customer'} (Total: GH₵ ${newOrder.total})`
          });
          await kv.set('kmap_logs', logs.slice(0, 100)); // Keep last 100 logs
        }

        return response.status(200).json({ success: true, orderId: newOrder.id });
      }

      // SUB-ACTION 2: Safe Hire Purchase Application Submission
      if (action === 'create_hp') {
        const newHP = body.hp;
        if (!newHP || !newHP.id) {
          return response.status(400).json({ error: 'Invalid hire-purchase application' });
        }

        const rawHP = await kv.get('kmap_hire_purchase');
        let currentHP = typeof rawHP === 'string' ? JSON.parse(rawHP) : (rawHP || []);
        if (!Array.isArray(currentHP)) currentHP = [];

        const filtered = currentHP.filter(h => h.id !== newHP.id);
        filtered.unshift(newHP);
        await kv.set('kmap_hire_purchase', filtered);

        return response.status(200).json({ success: true, hpId: newHP.id });
      }

      // SUB-ACTION 3: Full Database Updates (REQUIRES VERIFIED ADMIN TOKEN)
      if (!isAdmin) {
        return response.status(401).json({
          error: 'Unauthorized: Administrative Bearer token required to update cloud database.'
        });
      }

      const { updates } = body;
      if (!updates || typeof updates !== 'object') {
        return response.status(400).json({ error: 'Invalid payload' });
      }

      for (const [key, value] of Object.entries(updates)) {
        if (!allAllowedKeys.includes(key)) continue;

        // If updating users, preserve password hashes if incoming objects omit them
        if (key === 'kmap_users' && Array.isArray(value)) {
          const rawExisting = await kv.get('kmap_users');
          const existingUsers = typeof rawExisting === 'string' ? JSON.parse(rawExisting) : (rawExisting || DEFAULT_USERS);
          const userMap = new Map();
          if (Array.isArray(existingUsers)) {
            existingUsers.forEach(u => userMap.set(u.username.toLowerCase(), u));
          }

          const mergedUsers = value.map(incoming => {
            const old = userMap.get((incoming.username || '').toLowerCase());
            let finalPass = incoming.password || (old ? old.password : '');
            if (finalPass && !/^[a-f0-9]{64}$/i.test(finalPass)) {
              finalPass = hashPassword(finalPass);
            }
            return {
              ...incoming,
              password: finalPass
            };
          });

          await kv.set(key, mergedUsers);
        } else {
          await kv.set(key, value);
        }
      }

      return response.status(200).json({ success: true });
    }

    return response.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Sync Handler Error:', err);
    return response.status(500).json({ error: err.message || 'Server error' });
  }
}
