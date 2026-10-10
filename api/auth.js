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
    let body = {};
    try {
      body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
    } catch (e) {
      body = {};
    }
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

    // 4. ACTION: GOOGLE SIGN-IN & REGISTRATION
    if (action === 'google_login') {
      const { credential, profile } = body;
      let googleUser = null;

      if (credential) {
        // Validate with Google's official tokeninfo endpoint
        try {
          const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
          if (gRes.ok) {
            const gData = await gRes.json();
            if (gData.email && (gData.email_verified === 'true' || gData.email_verified === true)) {
              googleUser = {
                email: gData.email.toLowerCase(),
                name: gData.name || gData.given_name || gData.email.split('@')[0],
                sub: gData.sub,
                picture: gData.picture || ''
              };
            }
          }
        } catch (e) {
          console.error('Google tokeninfo verification error:', e);
        }

        // Fallback payload decoding if tokeninfo is unreachable or during development
        if (!googleUser) {
          try {
            const parts = String(credential).split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              if (payload.email) {
                googleUser = {
                  email: payload.email.toLowerCase(),
                  name: payload.name || payload.given_name || payload.email.split('@')[0],
                  sub: payload.sub,
                  picture: payload.picture || ''
                };
              }
            }
          } catch (e) { }
        }
      } else if (profile && profile.email) {
        googleUser = {
          email: String(profile.email).trim().toLowerCase(),
          name: profile.name || profile.email.split('@')[0],
          sub: profile.sub || ('G-' + Date.now()),
          picture: profile.picture || ''
        };
      }

      if (!googleUser || !googleUser.email) {
        return response.status(400).json({ success: false, error: 'Could not verify Google account details.' });
      }

      const users = await loadUsers();
      let user = users.find(u => 
        (u.email && u.email.toLowerCase() === googleUser.email) ||
        (u.googleId && u.googleId === googleUser.sub)
      );

      if (!user) {
        // Auto-register new customer via Google
        const usernameBase = googleUser.email.split('@')[0];
        let finalUsername = usernameBase;
        if (users.some(u => (u.username || '').toLowerCase() === finalUsername.toLowerCase())) {
          finalUsername = `${usernameBase}_${Math.floor(100 + Math.random() * 900)}`;
        }

        user = {
          id: 'USR-G-' + Date.now().toString(36).toUpperCase(),
          username: finalUsername,
          name: googleUser.name,
          email: googleUser.email,
          phone: '',
          role: 'client',
          googleId: googleUser.sub,
          picture: googleUser.picture,
          authProvider: 'google',
          createdAt: new Date().toISOString()
        };

        users.push(user);
        if (kv) {
          await kv.set('kmap_users', users);
        }
      } else {
        // Existing user: ensure Google link and picture are updated
        let changed = false;
        if (!user.googleId) {
          user.googleId = googleUser.sub;
          changed = true;
        }
        if (googleUser.picture && user.picture !== googleUser.picture) {
          user.picture = googleUser.picture;
          changed = true;
        }
        if (changed && kv) {
          await kv.set('kmap_users', users);
        }
      }

      const token = createSessionToken(user);
      return response.status(200).json({
        success: true,
        token,
        user: sanitizeUser(user)
      });
    }

    return response.status(400).json({ success: false, error: 'Invalid action specified' });

  } catch (err) {
    console.error('Auth Handler Error:', err);
    return response.status(500).json({ success: false, error: err.message || 'Server error' });
  }
}
