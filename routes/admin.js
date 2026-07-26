const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');
const User = require('../models/User');
const Video = require('../models/Video');
const Transaction = require('../models/Transaction');
const PaymentSettings = require('../models/PaymentSettings');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { uploadBufferToCloudinary, account1 } = require('../utils/cloudinary');

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

module.exports = router;
