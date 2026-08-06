const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  getInstagramBusinessAccount
} = require('../utils/meta');
const User = require('../models/User');

const router = express.Router();

const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

// @route GET /api/meta/oauth/url?platform=mobile|web
router.get('/oauth/url', protect, (req, res) => {
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });
  res.json({ success: true, url: getFacebookOAuthUrl(state) });
});

// @route GET /api/meta/oauth/callback
// Connects Facebook AND Instagram in one flow: fetches every Page the user
// manages, and for each Page checks if it has a linked Instagram Business
// account. If the user manages exactly one Page, we connect it
// automatically. If they manage multiple Pages, we save the list and the
// app shows a picker (GET /api/meta/pages -> PATCH /api/meta/select-page).
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state } = req.query;
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    const shortLivedToken = await exchangeCodeForToken(code);
    const longLivedToken = await getLongLivedUserToken(shortLivedToken);
    const pages = await getUserPages(longLivedToken);

    if (!pages.length) {
      throw new Error('No Facebook Pages found on this account. You need a Facebook Page to publish Reels.');
    }

    if (pages.length === 1) {
      await connectPageToUser(user, pages[0]);
    } else {
      // Multiple Pages — store the raw list temporarily so the app can show
      // a picker; nothing is connected yet until the user picks one.
      user.set('metaPendingPages', pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })));
      await user.save();
    }

    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?meta_connected=1&multiple_pages=${pages.length > 1 ? '1' : '0'}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=1`);
    }
  } catch (err) {
    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
});

// Shared helper: saves a Page (and its linked Instagram account, if any) onto the user.
const connectPageToUser = async (user, page) => {
  user.connectedFacebook = {
    pageId: page.id,
    pageName: page.name,
    pageAccessToken: page.access_token,
    connectedAt: new Date()
  };

  const igAccount = await getInstagramBusinessAccount(page.id, page.access_token);
  if (igAccount) {
    user.connectedInstagram = {
      igUserId: igAccount.id,
      igUsername: igAccount.username,
      linkedPageId: page.id,
      connectedAt: new Date()
    };
  } else {
    user.connectedInstagram = null;
  }

  user.set('metaPendingPages', undefined);
  await user.save();
};

// @route GET /api/meta/pages — list Pages found during OAuth, for the picker
// (only relevant if the user manages more than one Page).
router.get('/pages', protect, async (req, res) => {
  const pending = req.user.get('metaPendingPages') || [];
  res.json({ success: true, pages: pending.map((p) => ({ id: p.id, name: p.name })) });
});

// @route PATCH /api/meta/select-page  { pageId }
router.patch('/select-page', protect, async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    const chosen = pending.find((p) => p.id === req.body.pageId);
    if (!chosen) return res.status(400).json({ success: false, message: 'Page not found in your pending list' });

    await connectPageToUser(req.user, chosen);
    res.json({
      success: true,
      facebook: { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName },
      instagram: req.user.connectedInstagram
        ? { igUserId: req.user.connectedInstagram.igUserId, igUsername: req.user.connectedInstagram.igUsername }
        : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route DELETE /api/meta/facebook/disconnect
router.delete('/facebook/disconnect', protect, async (req, res) => {
  req.user.connectedFacebook = null;
  req.user.connectedInstagram = null; // Instagram publishing depends on the Page token, so it goes too
  await req.user.save();
  res.json({ success: true, message: 'Facebook (and linked Instagram) disconnected' });
});

// @route GET /api/meta/status
router.get('/status', protect, async (req, res) => {
  res.json({
    success: true,
    facebook: req.user.connectedFacebook
      ? { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName, connectedAt: req.user.connectedFacebook.connectedAt }
      : null,
    instagram: req.user.connectedInstagram
      ? { igUserId: req.user.connectedInstagram.igUserId, igUsername: req.user.connectedInstagram.igUsername, connectedAt: req.user.connectedInstagram.connectedAt }
      : null
  });
});

module.exports = router;
