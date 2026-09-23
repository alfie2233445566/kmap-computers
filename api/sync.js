import { kv } from '@vercel/kv';

export default async function handler(request, response) {
  const allowedKeys = ['kmap_products', 'kmap_users', 'kmap_orders', 'kmap_logs', 'kmap_promos', 'kmap_hire_purchase'];

  // Check if Vercel KV is configured in environment
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return response.status(503).json({
      error: 'Vercel KV not connected. In your Vercel Dashboard, go to Storage -> Create/Connect KV Database.',
      configured: false
    });
  }

  try {
    if (request.method === 'GET') {
      const data = {};
      for (const key of allowedKeys) {
        const value = await kv.get(key);
        data[key] = value || null;
      }
      return response.status(200).json(data);
    } else if (request.method === 'POST') {
      const body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
      const { updates } = body;
      if (!updates || typeof updates !== 'object') {
        return response.status(400).json({ error: 'Invalid payload' });
      }

      for (const [key, value] of Object.entries(updates)) {
        if (allowedKeys.includes(key)) {
          await kv.set(key, value);
        }
      }
      return response.status(200).json({ success: true });
    } else {
      return response.status(405).json({ error: 'Method Not Allowed' });
    }
  } catch (error) {
    console.error('KV Error:', error);
    return response.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}

