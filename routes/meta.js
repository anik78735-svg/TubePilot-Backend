const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages
} = require('../utils/meta');
const User = require('../models/User');

const router = express.Router();

const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

router.get('/oauth/url', protect, (req, res) => {
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });
  res.json({ success: true, url: getFacebookOAuthUrl(state) });
});

router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state } = req.query;
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    console.log(`▶️ [Meta OAuth Callback] Starting for user ${user._id}`);

    const shortLivedToken = await exchangeCodeForToken(code);
    const longLivedToken = await getLongLivedUserToken(shortLivedToken);
    const pages = await getUserPages(longLivedToken);

    if (!pages.length) {
      throw new Error('No Facebook Pages found on this account. You need a Facebook Page to publish Reels.');
    }

    if (pages.length === 1) {
      console.log(`ℹ️ [Meta OAuth Callback] Exactly 1 page found, auto-connecting: ${pages[0].name}`);
      await connectPageToUser(user, pages[0]);
    } else {
      console.log(`ℹ️ [Meta OAuth Callback] ${pages.length} pages found, awaiting user selection`);
      user.set('metaPendingPages', pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })));
      await user.save();
    }

    console.log(`✅ [Meta OAuth Callback] Done. connectedFacebook=${!!user.connectedFacebook}`);

    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?meta_connected=1&multiple_pages=${pages.length > 1 ? '1' : '0'}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=1`);
    }
  } catch (err) {
    console.error(`❌ [Meta OAuth Callback] Failed:`, err.message);
    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
});

const connectPageToUser = async (user, page) => {
  user.connectedFacebook = {
    pageId: page.id,
    pageName: page.name,
    pageAccessToken: page.access_token,
    connectedAt: new Date()
  };

  user.set('metaPendingPages', undefined);
  await user.save();
};

router.get('/pages', protect, async (req, res) => {
  const pending = req.user.get('metaPendingPages') || [];
  res.json({ success: true, pages: pending.map((p) => ({ id: p.id, name: p.name })) });
});

router.patch('/select-page', protect, async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    const chosen = pending.find((p) => p.id === req.body.pageId);
    if (!chosen) return res.status(400).json({ success: false, message: 'Page not found in your pending list' });

    await connectPageToUser(req.user, chosen);
    res.json({
      success: true,
      facebook: { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/facebook/disconnect', protect, async (req, res) => {
  req.user.connectedFacebook = null;
  await req.user.save();
  res.json({ success: true, message: 'Facebook disconnected' });
});

router.get('/status', protect, async (req, res) => {
  res.json({
    success: true,
    facebook: req.user.connectedFacebook
      ? { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName, connectedAt: req.user.connectedFacebook.connectedAt }
      : null
  });
});

module.exports = router;
