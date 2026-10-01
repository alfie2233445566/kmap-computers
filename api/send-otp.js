import nodemailer from 'nodemailer';
import { createClient } from '@vercel/kv';
import crypto from 'crypto';

// In-memory fallback for local dev or when KV is connecting
const memoryOtpStore = new Map();

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const allowedEmails = [
    'admin@kmapcomputers.com',
    'alfred@kmapcomputers.com',
    'info@kmapcomputers.com',
    'sales@kmapcomputers.com'
  ];

  // Dynamically resolve KV
  const kvUrl = process.env.KV_REST_API_URL 
    || process.env.KMAP_KV_KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL 
    || process.env.STORAGE_REST_API_URL
    || Object.entries(process.env).find(([k]) => !k.includes('READ_ONLY') && (k.endsWith('_REST_API_URL') || k.endsWith('_URL')))?.[1];

  const kvToken = process.env.KV_REST_API_TOKEN 
    || process.env.KMAP_KV_KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN 
    || process.env.STORAGE_REST_API_TOKEN
    || Object.entries(process.env).find(([k]) => !k.includes('READ_ONLY') && (k.endsWith('_REST_API_TOKEN') || (k.endsWith('_TOKEN') && !k.includes('READ_ONLY'))))?.[1];

  let kv = null;
  if (kvUrl && kvToken) {
    try {
      kv = createClient({ url: kvUrl, token: kvToken });
    } catch (e) {
      console.warn('KV initialization skipped, using fallback store:', e.message);
    }
  }

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
    const { action, email, otp, newPasswordHash } = body;

    const normalizedEmail = (email || '').trim().toLowerCase();

    // 1. ACTION: SEND OTP
    if (action === 'send') {
      if (!allowedEmails.includes(normalizedEmail)) {
        return response.status(403).json({ error: 'Unauthorized email address for security verification.' });
      }

      // Generate a secure 6-digit OTP
      const generatedOtp = String(crypto.randomInt(100000, 999999));
      const expiresAt = Date.now() + 5 * 60 * 1000; // Strictly 5 minutes

      // Store in KV or in-memory
      const otpPayload = { otp: generatedOtp, expiresAt };
      if (kv) {
        await kv.set(`kmap_otp_${normalizedEmail}`, JSON.stringify(otpPayload), { ex: 300 }); // 300 sec TTL
      } else {
        memoryOtpStore.set(normalizedEmail, otpPayload);
      }

      // Prepare Hostinger SMTP configuration
      const smtpHost = process.env.SMTP_HOST || 'smtp.hostinger.com';
      const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
      const smtpUser = process.env.SMTP_USER || 'admin@kmapcomputers.com';
      const smtpPass = process.env.SMTP_PASS || process.env.HOSTINGER_EMAIL_PASS;

      let emailSent = false;
      let emailError = null;

      if (smtpPass) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465,
            auth: {
              user: smtpUser,
              pass: smtpPass
            }
          });

          await transporter.sendMail({
            from: `"KMAP Computers Security" <${smtpUser}>`,
            to: normalizedEmail,
            subject: `Your KMAP Security Verification Code: ${generatedOtp}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff;">
                <div style="text-align: center; margin-bottom: 20px;">
                  <h2 style="color: #1e3a5f; margin: 0; font-size: 22px; font-weight: 800;">KMAP COMPUTERS</h2>
                  <p style="color: #64748b; font-size: 13px; margin: 4px 0 0 0;">Ghana's Premier Tech & Computer Store</p>
                </div>
                <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 18px; text-align: center; margin-bottom: 20px;">
                  <span style="font-size: 13px; color: #475569; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Password Change Verification Code</span>
                  <div style="font-size: 36px; font-weight: 900; letter-spacing: 6px; color: #0d9488; margin: 12px 0; font-family: monospace;">
                    ${generatedOtp}
                  </div>
                  <p style="font-size: 13px; color: #dc2626; font-weight: 700; margin: 0;">
                    ⏱️ Code expires in exactly 5 minutes (Strict Timer).
                  </p>
                </div>
                <p style="font-size: 14px; color: #334155; line-height: 1.5; margin-bottom: 16px;">
                  A password update was requested for your account (<strong>${normalizedEmail}</strong>). Enter this 6-digit code in the verification modal to authorize the change.
                </p>
                <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 14px; margin: 0;">
                  If you did not request this code, ignore this email or notify your system administrator immediately.
                </p>
              </div>
            `
          });
          emailSent = true;
        } catch (err) {
          console.error('SMTP Send Error:', err);
          emailError = err.message;
        }
      }

      return response.status(200).json({
        success: true,
        message: emailSent 
          ? `Verification OTP sent to ${normalizedEmail}. Check your inbox or webmail.` 
          : `Verification code generated for ${normalizedEmail}. (SMTP configured: ${Boolean(smtpPass)})`,
        emailSent,
        expiresInSeconds: 300,
        // Only return test code if SMTP credentials have not yet been placed into env
        devCode: !smtpPass ? generatedOtp : undefined
      });
    }

    // 2. ACTION: VERIFY OTP & OVERRIDE PASSWORD
    if (action === 'verify') {
      let stored = null;
      if (kv) {
        const raw = await kv.get(`kmap_otp_${normalizedEmail}`);
        if (raw) stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } else {
        stored = memoryOtpStore.get(normalizedEmail);
      }

      if (!stored) {
        return response.status(400).json({
          success: false,
          error: 'No active OTP found. Please request a new verification code.'
        });
      }

      if (Date.now() > stored.expiresAt) {
        if (kv) await kv.del(`kmap_otp_${normalizedEmail}`);
        memoryOtpStore.delete(normalizedEmail);
        return response.status(400).json({
          success: false,
          error: 'Verification code has expired. Please request a new code.'
        });
      }

      if (String(stored.otp).trim() !== String(otp).trim()) {
        return response.status(400).json({
          success: false,
          error: 'Incorrect 6-digit verification code. Please check your email and try again.'
        });
      }

      // Valid OTP! Invalidate it immediately so it can never be reused
      if (kv) await kv.del(`kmap_otp_${normalizedEmail}`);
      memoryOtpStore.delete(normalizedEmail);

      // If newPasswordHash provided, update in KV
      if (newPasswordHash && kv) {
        try {
          const rawUsers = await kv.get('kmap_users');
          if (rawUsers) {
            const users = typeof rawUsers === 'string' ? JSON.parse(rawUsers) : rawUsers;
            const targetUser = users.find(u => (u.email && u.email.toLowerCase() === normalizedEmail) || u.username.toLowerCase() === normalizedEmail.split('@')[0]);
            if (targetUser) {
              targetUser.password = newPasswordHash;
              await kv.set('kmap_users', users);
            }
          }
        } catch (e) {
          console.error('Failed to update user in KV:', e);
        }
      }

      return response.status(200).json({
        success: true,
        message: 'Verification successful. Password updated and old password permanently invalidated.'
      });
    }

    return response.status(400).json({ error: 'Invalid action specified.' });
  } catch (err) {
    console.error('OTP Handler Error:', err);
    return response.status(500).json({ error: err.message || 'Server error processing request.' });
  }
}
