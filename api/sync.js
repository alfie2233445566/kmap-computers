import { createClient } from '@vercel/kv';

export default async function handler(request, response) {
  const allowedKeys = ['kmap_products', 'kmap_users', 'kmap_orders', 'kmap_logs', 'kmap_promos', 'kmap_hire_purchase'];

  // Dynamically resolve URL and write TOKEN (ignoring READ_ONLY tokens)
  const url = process.env.KV_REST_API_URL 
    || process.env.KMAP_KV_KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL 
    || process.env.STORAGE_REST_API_URL
    || Object.entries(process.env).find(([k]) => !k.includes('READ_ONLY') && (k.endsWith('_REST_API_URL') || k.endsWith('_URL')))?.[1];

  const token = process.env.KV_REST_API_TOKEN 
    || process.env.KMAP_KV_KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN 
    || process.env.STORAGE_REST_API_TOKEN
    || Object.entries(process.env).find(([k]) => !k.includes('READ_ONLY') && (k.endsWith('_REST_API_TOKEN') || (k.endsWith('_TOKEN') && !k.includes('READ_ONLY'))))?.[1];

  // Check if Vercel KV or Upstash Redis is configured in environment
  if (!url || !token) {
    return response.status(503).json({
      error: 'Upstash Redis / Vercel KV not connected. In your Vercel Dashboard, go to Storage -> Upstash and connect it to this project.',
      configured: false
    });
  }

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const kv = createClient({ url, token });

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

