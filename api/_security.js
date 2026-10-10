import crypto from 'crypto';
import { createClient } from '@vercel/kv';

// Secure Server Secret for HMAC Session Token Generation
export const AUTH_SECRET = process.env.AUTH_SECRET 
  || process.env.KV_REST_API_TOKEN 
  || process.env.UPSTASH_REDIS_REST_TOKEN 
  || 'kmap_super_secret_session_signer_key_2026_ghana_tech_enterprise';

// Production Root System Accounts (Seeded safely on server, NEVER exposed to client)
export const DEFAULT_USERS = [
  { id: 'USR-001', username: 'admin', email: 'admin@kmapcomputers.com', role: 'superadmin', name: 'Kwaku Aduse-poku', password: '120a46268023a0eee2ac955c6ddcb939bec5c756db98bffc391e7d741d952292' },
  { id: 'USR-002', username: 'alfred', email: 'alfred@kmapcomputers.com', role: 'superadmin', name: 'Alfred', password: 'd456fd28999ab6ba5d59467f81220aae1adcbd841b6b4e6595688fd961dfa145', hiddenFromStaffList: true },
  { id: 'USR-003', username: 'info', email: 'info@kmapcomputers.com', role: 'admin', name: 'Felix', password: 'd4d6b2cece42e0df40d9fdc25b0901101cf88a9423ed0a4f7e0cd8fa2d5b2c0f' },
  { id: 'USR-004', username: 'sales', email: 'sales@kmapcomputers.com', role: 'admin', name: 'Victor Aduse-poku', password: '77d57cc3989d096d65e9d89f168d6e70971a482c7be707bb34c1511325882bb7' }
];

export function getKvClient() {
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

  if (!url || !token) return null;
  return createClient({ url, token });
}

export function hashPassword(plainPassword) {
  if (!plainPassword) return '';
  if (/^[a-f0-9]{64}$/i.test(plainPassword)) return plainPassword.toLowerCase();
  return crypto.createHash('sha256').update('kmap_salt_2026_' + plainPassword).digest('hex');
}

export function verifyPassword(plainOrHash, storedHash) {
  if (!plainOrHash || !storedHash) return false;
  const target = String(storedHash).trim().toLowerCase();
  const input = String(plainOrHash).trim();

  // 1. Direct match (if input is already hashed or exact)
  if (input.toLowerCase() === target) return true;

  // 2. Salted sha256
  const saltedHash = crypto.createHash('sha256').update('kmap_salt_2026_' + input).digest('hex');
  if (saltedHash === target) return true;

  // 3. Unsalted sha256 fallback
  const plainHash = crypto.createHash('sha256').update(input).digest('hex');
  if (plainHash === target) return true;

  return false;
}

export function sanitizeUser(u) {
  if (!u) return null;
  const { password, ...safe } = u;
  return safe;
}

// Generates a tamper-proof cryptographically signed session token:
// Format: base64url(payload) + '.' + base64url(hmacSignature)
export function createSessionToken(user) {
  const payload = {
    id: user.id || user.username,
    username: user.username,
    role: user.role || 'client',
    email: user.email || '',
    name: user.name || user.username,
    exp: Date.now() + 14 * 24 * 60 * 60 * 1000 // 14-day validity
  };
  const bodyB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(bodyB64).digest('base64url');
  return `${bodyB64}.${signature}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [bodyB64, signature] = token.split('.');
  if (!bodyB64 || !signature) return null;
  
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(bodyB64).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);

  // Constant-time comparison to prevent timing attacks
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) return null; // Expired
    return payload;
  } catch (e) {
    return null;
  }
}

export function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) return null;
  const parts = String(authHeader).split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1].trim();
  }
  return String(authHeader).trim();
}
