import { 
  getKvClient, 
  DEFAULT_USERS, 
  verifyPassword, 
  hashPassword, 
  sanitizeUser, 
  createSessionToken, 
  verifySessionToken, 
  extractBearerToken 
} from './_security.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const kv = getKvClient();

  // Helper to load current user list from KV or server defaults
  const loadUsers = async () => {
    if (!kv) return DEFAULT_USERS;
    try {
      const stored = await kv.get('kmap_users');
      if (stored) {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.error('Failed reading users from KV:', e);
    }
    return DEFAULT_USERS;
  };

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
    const action = body.action || (request.method === 'GET' ? 'verify' : null);

    // 1. ACTION: VERIFY SESSION TOKEN
    if (action === 'verify') {
      const token = extractBearerToken(request) || body.token;
      if (!token) {
        return response.status(401).json({ success: false, error: 'No token provided' });
      }

      const session = verifySessionToken(token);
      if (!session) {
        return response.status(401).json({ success: false, error: 'Invalid or expired session token' });
      }

      // Verify user still exists in database
      const users = await loadUsers();
      const currentUser = users.find(u => u.username.toLowerCase() === session.username.toLowerCase());
      if (!currentUser) {
        return response.status(401).json({ success: false, error: 'User no longer exists' });
      }

      return response.status(200).json({
        success: true,
        user: sanitizeUser(currentUser)
      });
    }

    // 2. ACTION: SECURE SERVER-SIDE LOGIN
    if (action === 'login') {
      const { username, password } = body;
      if (!username || !password) {
        return response.status(400).json({ success: false, error: 'Username and password are required' });
      }

      const users = await loadUsers();
      const inputLower = String(username).trim().toLowerCase();

      const user = users.find(u => {
        const uName = (u.username || '').toLowerCase();
        const uEmail = (u.email || '').toLowerCase();
        const emailPrefix = uEmail.includes('@') ? uEmail.split('@')[0] : '';
        return uName === inputLower || uEmail === inputLower || emailPrefix === inputLower;
      });

      if (!user) {
        return response.status(401).json({ success: false, error: 'Invalid credentials. User not found.' });
      }

      const isValidPass = verifyPassword(password, user.password);
      if (!isValidPass) {
        return response.status(401).json({ success: false, error: 'Invalid password. Check your details or reset via OTP.' });
      }

      // If user had an un-salted hash or plaintext, upgrade it automatically on the server
      const standardSaltedHash = hashPassword(password);
      if (user.password !== standardSaltedHash && kv) {
        try {
          user.password = standardSaltedHash;
          await kv.set('kmap_users', users);
        } catch (e) { }
      }

      const token = createSessionToken(user);
      return response.status(200).json({
        success: true,
        token,
        user: sanitizeUser(user)
      });
    }

    // 3. ACTION: CLIENT SIGNUP
    if (action === 'signup') {
      const { name, username, password } = body;
      const cleanUsername = String(username || '').trim();
      const cleanName = String(name || '').trim();
      const cleanPass = String(password || '').trim();

      if (!cleanUsername || !cleanPass) {
        return response.status(400).json({ success: false, error: 'Phone number/username and password are required.' });
      }

      const users = await loadUsers();
      const exists = users.some(u => (u.username || '').toLowerCase() === cleanUsername.toLowerCase());
      if (exists) {
        return response.status(400).json({ success: false, error: 'Phone number/username is already registered.' });
      }

      const saltedHash = hashPassword(cleanPass);
      const newUser = {
        id: 'USR-' + Date.now().toString(36).toUpperCase(),
        username: cleanUsername,
        name: cleanName || cleanUsername,
        phone: cleanUsername,
        role: 'client',
        password: saltedHash
      };

      users.push(newUser);
      if (kv) {
        await kv.set('kmap_users', users);
      }

      const token = createSessionToken(newUser);
      return response.status(200).json({
        success: true,
        token,
        user: sanitizeUser(newUser)
      });
    }

    return response.status(400).json({ success: false, error: 'Invalid action specified' });

  } catch (err) {
    console.error('Auth Handler Error:', err);
    return response.status(500).json({ success: false, error: err.message || 'Server error' });
  }
}
