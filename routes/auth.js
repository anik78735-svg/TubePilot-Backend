const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateTokens');
const { generateUserId, generateReferralCode } = require('../utils/idGenerator');
const { protect } = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper: build tokens + set refresh cookie (web) + save refresh token on user doc
// Also RETURNS the refreshToken so mobile (Flutter) clients can store it locally
// and send it back in the request body (they can't rely on httpOnly cookies).
const issueTokens = async (res, user) => {
  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  user.refreshTokens = [...(user.refreshTokens || []).slice(-4), refreshToken];
  await user.save();

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });

  return { accessToken, refreshToken };
};

// @route POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, referredBy } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    const userId = await generateUserId();
    const referralCode = await generateReferralCode(userId);

    // No starter diamond bonus here — diamondBalance defaults to 0 (see
    // models/User.js). Diamonds are only granted when the user applies a
    // valid referral code via POST /api/auth/apply-referral. If they skip
    // entering a referral code, they simply stay at 0 diamonds.
    const user = await User.create({
      userId,
      name: name || '',
      email: email.toLowerCase(),
      password,
      authProvider: 'local',
      referralCode,
      referredBy: referredBy || null,
      freeUploadsRemaining: Number(process.env.FREE_UPLOADS_PER_MONTH || 20)
    });

    const { accessToken, refreshToken } = await issueTokens(res, user);
    res.status(201).json({ success: true, accessToken, refreshToken, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() }).select('+password');
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    const match = await user.comparePassword(password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const { accessToken, refreshToken } = await issueTokens(res, user);
    res.json({ success: true, accessToken, refreshToken, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/auth/google
// body: { idToken } - Google ID token from frontend Google Sign-In button
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'idToken is required' });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    let user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      user = await User.findOne({ email: payload.email });
    }

    if (!user) {
      const userId = await generateUserId();
      const referralCode = await generateReferralCode(userId);
      // Same as local signup — no starter diamond bonus. diamondBalance
      // defaults to 0 (see models/User.js) until a referral code is applied.
      user = await User.create({
        userId,
        name: payload.name,
        email: payload.email,
        avatar: payload.picture,
        googleId: payload.sub,
        authProvider: 'google',
        referralCode,
        freeUploadsRemaining: Number(process.env.FREE_UPLOADS_PER_MONTH || 20)
      });
    } else if (!user.googleId) {
      user.googleId = payload.sub;
      user.authProvider = 'google';
      await user.save();
    }

    const { accessToken, refreshToken } = await issueTokens(res, user);
    res.json({ success: true, accessToken, refreshToken, user: user.toSafeObject(), isNewUser: !user.username });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Google authentication failed', error: err.message });
  }
});

// @route POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    if (!token) return res.status(401).json({ success: false, message: 'No refresh token provided' });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.refreshTokens.includes(token)) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    const accessToken = generateAccessToken(user._id);
    res.json({ success: true, accessToken });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Refresh token expired or invalid' });
  }
});

// @route POST /api/auth/logout
router.post('/logout', protect, async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    req.user.refreshTokens = (req.user.refreshTokens || []).filter((t) => t !== token);
    await req.user.save();
    res.clearCookie('refreshToken');
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    // Always respond success to avoid leaking which emails are registered
    if (!user) return res.json({ success: true, message: 'If that email exists, a reset link has been sent' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    // In production: save hashed token + expiry on user, email the link via SMTP/SendGrid etc.
    // This is left as a real integration point — plug in your email provider here.
    console.log(`Password reset requested for ${user.email}. Token: ${resetToken}`);

    res.json({ success: true, message: 'If that email exists, a reset link has been sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  res.json({ success: true, user: req.user.toSafeObject() });
});

// @route POST /api/auth/setup-username
router.post('/setup-username', protect, async (req, res) => {
  try {
    const { username, language, avatar } = req.body;
    if (!username || username.length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
    }
    const taken = await User.findOne({ username, _id: { $ne: req.user._id } });
    if (taken) return res.status(409).json({ success: false, message: 'Username already taken' });

    req.user.username = username;
    if (language) req.user.language = language;
    if (avatar) req.user.avatar = avatar;
    await req.user.save();

    res.json({ success: true, user: req.user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route POST /api/auth/apply-referral  { referralCode }
// Called once, typically right after signup (e.g. during the "enter referral
// code or skip" onboarding step). Both the new user and the referrer get a
// diamond bonus. Real logic — validates the code belongs to someone else and
// hasn't already been used by this user.
//
// The NEW user only ever receives diamonds through this route — signup
// itself grants 0 diamonds (see models/User.js default + routes/auth.js
// signup/google routes). If the user skips entering a referral code, this
// route is simply never called and they stay at 0 diamonds.
const REFERRAL_SIGNUP_BONUS_DIAMONDS = 10; // what the NEW user gets for entering a valid referral code
const REFERRER_BONUS_DIAMONDS = 5;          // what the referrer gets when their code is used

router.post('/apply-referral', protect, async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ success: false, message: 'referralCode is required' });

    if (req.user.referredBy) {
      return res.status(400).json({ success: false, message: 'You have already used a referral code' });
    }

    const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });
    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }
    if (referrer._id.equals(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't use your own referral code" });
    }

    req.user.referredBy = referrer.userId;
    req.user.diamondBalance += REFERRAL_SIGNUP_BONUS_DIAMONDS;
    await req.user.save();

    referrer.diamondBalance += REFERRER_BONUS_DIAMONDS;
    await referrer.save();

    res.json({
      success: true,
      message: `Referral applied! You received ${REFERRAL_SIGNUP_BONUS_DIAMONDS} bonus diamonds, and your referrer received ${REFERRER_BONUS_DIAMONDS}.`,
      diamondBalance: req.user.diamondBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
