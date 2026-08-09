const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');
const User = require('../models/User');
const Video = require('../models/Video');
const Transaction = require('../models/Transaction');
const PaymentSettings = require('../models/PaymentSettings');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { uploadBufferToCloudinary, deleteManyFromCloudinary, account1 } = require('../utils/cloudinary');

const router = express.Router();
router.use(protect, adminOnly);

// @route GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [totalUsers, activeUsers, connectedChannels, pendingPayments, approvedPayments, rejectedPayments, uploadQueue] =
      await Promise.all([
        User.countDocuments({ role: 'user' }),
        User.countDocuments({ role: 'user', isActive: true }),
        User.countDocuments({ role: 'user', youtubeChannel: { $ne: null } }),
        Transaction.countDocuments({ type: 'diamond_purchase', status: 'pending' }),
        Transaction.countDocuments({ type: 'diamond_purchase', status: 'approved' }),
        Transaction.countDocuments({ type: 'diamond_purchase', status: 'rejected' }),
        Video.countDocuments({ status: { $in: ['queued', 'scheduled', 'uploading_storage', 'processing'] } })
      ]);

    const revenueAgg = await Transaction.aggregate([
      { $match: { type: 'diamond_purchase', status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amountINR' } } }
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        connectedChannels,
        pendingPayments,
        approvedPayments,
        rejectedPayments,
        revenue: revenueAgg[0]?.total || 0,
        uploadQueue
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/admin/payments?status=pending
router.get('/payments', async (req, res) => {
  const filter = { type: 'diamond_purchase' };
  if (req.query.status) filter.status = req.query.status;
  const transactions = await Transaction.find(filter).populate('user', 'userId name email').sort({ createdAt: -1 });
  res.json({ success: true, transactions });
});

// @route PATCH /api/admin/payments/:id/approve
router.patch('/payments/:id/approve', async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });
    if (transaction.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Transaction already ${transaction.status}` });
    }

    const user = await User.findById(transaction.user);
    user.diamondBalance += transaction.diamondPackage;
    await user.save();

    transaction.status = 'approved';
    transaction.reviewedBy = req.user._id;
    transaction.reviewedAt = new Date();
    transaction.adminNote = req.body.note || '';
    await transaction.save();

    await Notification.create({
      user: user._id,
      type: 'payment_approved',
      title: 'Payment Approved 🎉',
      message: `Your payment of ₹${transaction.amountINR} was approved. ${transaction.diamondPackage} diamonds added to your wallet.`
    });
    await sendPushToUser(user, {
      title: 'Payment approved 💎',
      body: `${transaction.diamondPackage} diamonds added to your wallet.`,
      data: { type: 'payment_approved' }
    });

    res.json({ success: true, message: 'Payment approved and diamonds credited', transaction });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route PATCH /api/admin/payments/:id/reject
router.patch('/payments/:id/reject', async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });
    if (transaction.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Transaction already ${transaction.status}` });
    }

    transaction.status = 'rejected';
    transaction.reviewedBy = req.user._id;
    transaction.reviewedAt = new Date();
    transaction.adminNote = req.body.note || 'Payment could not be verified';
    await transaction.save();

    await Notification.create({
      user: transaction.user,
      type: 'payment_rejected',
      title: 'Payment Rejected',
      message: `Your payment request of ₹${transaction.amountINR} was rejected. Reason: ${transaction.adminNote}`
    });
    const rejectedUser = await User.findById(transaction.user);
    if (rejectedUser) {
      await sendPushToUser(rejectedUser, {
        title: 'Payment rejected',
        body: transaction.adminNote,
        data: { type: 'payment_rejected' }
      });
    }

    res.json({ success: true, message: 'Payment rejected', transaction });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/admin/payment-settings
router.get('/payment-settings', async (req, res) => {
  const settings = (await PaymentSettings.findOne()) || {};
  res.json({ success: true, settings });
});

// @route PUT /api/admin/payment-settings
router.put('/payment-settings', upload.single('qrImage'), async (req, res) => {
  try {
    let settings = await PaymentSettings.findOne();
    if (!settings) settings = new PaymentSettings();

    if (req.body.upiId) settings.upiId = req.body.upiId;
    if (req.body.accountName) settings.accountName = req.body.accountName;
    if (req.body.merchantName) settings.merchantName = req.body.merchantName;

    if (req.file) {
      const result = await uploadBufferToCloudinary(account1, req.file.buffer, {
        resource_type: 'image',
        folder: 'tubepilot/qr_codes',
        public_id: `qr_${Date.now()}`
      });
      settings.qrImageUrl = result.secure_url;
    }

    settings.updatedBy = req.user._id;
    await settings.save();

    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/admin/users?search=text
router.get('/users', async (req, res) => {
  const filter = { role: 'user' };
  const search = (req.query.search || '').trim();
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ username: regex }, { email: regex }, { name: regex }, { userId: regex }];
  }
  const users = await User.find(filter).select('-password -refreshTokens').sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, users });
});

// @route PATCH /api/admin/users/:id/force-logout
// Clears every saved refresh token for this user — their app will be forced
// back to the login screen the next time their short-lived access token expires.
// This does NOT delete any data. Their account, diamonds, videos, and
// connections are untouched — they just have to log back in.
router.patch('/users/:id/force-logout', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  user.refreshTokens = [];
  await user.save();
  res.json({ success: true, message: `${user.username || user.email} has been logged out on all devices` });
});

// @route PATCH /api/admin/users/:id/toggle-active
// Suspends or reactivates a user account.
router.patch('/users/:id/toggle-active', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  user.isActive = !user.isActive;
  if (!user.isActive) user.refreshTokens = []; // also force-logout when suspending
  await user.save();
  res.json({ success: true, message: `${user.username || user.email} is now ${user.isActive ? 'active' : 'suspended'}`, isActive: user.isActive });
});

// @route DELETE /api/admin/users/:id
// PERMANENTLY deletes a user account and everything tied to it:
//   1. Every video file the user ever uploaded, deleted from BOTH Cloudinary
//      accounts (whichever account each file actually lives on).
//   2. Their Google Drive connection is disconnected (connectedDrive
//      cleared). We do NOT delete files from their own Drive — we only ever
//      had drive.readonly access, so we have no permission to touch their
//      Drive storage, and shouldn't even if we could. It's their Drive, not
//      ours.
//   3. The Video, Transaction, and Notification documents themselves.
//   4. The User document.
// This is irreversible — there is no soft-delete / recovery here. If they
// sign up again with the same email/phone/Google account, they get a
// completely fresh account: new userId, new referralCode, diamondBalance
// back to 0, freeUploadsRemaining back to the default — because none of
// that old data exists anymore.
//
// IMPORTANT: Cloudinary deletion assumes each Video doc stores the fields
// used below (cloudinaryPublicId, cloudinaryAccount — 'cloudinary_1' or
// 'cloudinary_2'). If your Video schema uses different field names, update
// the `.map()` below to match — otherwise this will silently delete 0
// Cloudinary files while still deleting the Video docs, leaving orphaned
// files in Cloudinary with no DB record pointing to them (worse than
// before, since you lose the reference needed to clean them up later).
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Cannot delete an admin account from here' });
    }

    const label = user.username || user.email || user.userId;

    // 1. Delete every Cloudinary file this user ever uploaded, BEFORE the
    // Video docs (which hold the publicId/account pointers) are removed.
    const videos = await Video.find({ userId: user._id }, 'cloudinaryPublicId cloudinaryAccount');
    const cloudinaryEntries = videos
      .filter((v) => v.cloudinaryPublicId)
      .map((v) => ({ publicId: v.cloudinaryPublicId, cloudinaryAccount: v.cloudinaryAccount }));

    let cloudinaryResult = { attempted: 0, deleted: 0, failed: [] };
    if (cloudinaryEntries.length) {
      cloudinaryResult = await deleteManyFromCloudinary(cloudinaryEntries);
    }

    // 2. Disconnect Google Drive (does not touch the user's own Drive files —
    // see note above the route).
    user.connectedDrive = null;

    // 3 & 4. Wipe DB records, then the user doc itself.
    await Promise.all([
      Video.deleteMany({ userId: user._id }),
      Transaction.deleteMany({ user: user._id }),
      Notification.deleteMany({ user: user._id })
    ]);

    await User.findByIdAndDelete(user._id);

    const storageNote = cloudinaryResult.failed.length
      ? ` (${cloudinaryResult.failed.length} of ${cloudinaryResult.attempted} Cloudinary file(s) failed to delete — check server logs)`
      : '';

    res.json({
      success: true,
      message: `${label}'s account and all associated data has been permanently deleted${storageNote}`,
      cloudinaryCleanup: cloudinaryResult
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
