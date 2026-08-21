const express = require('express');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { createCashfreeOrder, getCashfreeOrderStatus } = require('../utils/cashfree');

const router = express.Router();

// Fixed packages: 1 Diamond = ₹1, only these 4 sizes are sold
const DIAMOND_PACKAGES = [10, 50, 100, 200];

// @route GET /api/diamonds/packages
router.get('/packages', protect, (req, res) => {
  const packages = DIAMOND_PACKAGES.map((d) => ({ diamonds: d, priceINR: d }));
  res.json({ success: true, packages, currentBalance: req.user.diamondBalance });
});

// @route POST /api/diamonds/create-order  { diamondPackage }
// Creates a pending Transaction + a matching Cashfree order. Returns
// paymentSessionId, which the Flutter app passes straight into the
// Cashfree Drop-in checkout SDK to open the in-app payment screen.
router.post('/create-order', protect, async (req, res) => {
  try {
    const diamondPackage = Number(req.body.diamondPackage);
    if (!DIAMOND_PACKAGES.includes(diamondPackage)) {
      return res.status(400).json({ success: false, message: 'Invalid diamond package. Choose 10, 50, 100 or 200.' });
    }

    // Cashfree requires a unique order_id per attempt — include the
    // timestamp so retrying (e.g. after a cancelled checkout) always works.
    const orderId = `TP${req.user.userId}_${Date.now()}`;

    const transaction = await Transaction.create({
      user: req.user._id,
      userDisplayId: req.user.userId,
      type: 'diamond_purchase',
      diamondPackage,
      amountINR: diamondPackage, // 1 diamond = ₹1
      status: 'pending',
      paymentMethod: 'cashfree',
      cashfreeOrderId: orderId
    });

    const order = await createCashfreeOrder({
      orderId,
      amount: diamondPackage,
      customerId: req.user.userId,
      customerPhone: req.user.phone,
      customerEmail: req.user.email,
      customerName: req.user.name
    });

    transaction.paymentSessionId = order.paymentSessionId;
    await transaction.save();

    console.log(`💳 [Cashfree] Order created — user ${req.user._id}, orderId=${orderId}, amount=₹${diamondPackage}`);

    res.status(201).json({
      success: true,
      orderId: order.orderId,
      paymentSessionId: order.paymentSessionId,
      transactionId: transaction._id
    });
  } catch (err) {
    if (err.code === 'CASHFREE_NOT_CONFIGURED') {
      return res.status(503).json({ success: false, message: err.message, code: err.code });
    }
    console.error('❌ [Cashfree] create-order failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not start payment. Please try again.' });
  }
});

// @route POST /api/diamonds/verify-payment  { orderId }
// Called by the app immediately after the Cashfree checkout screen closes —
// on BOTH the SDK's success callback and its error/cancel callback, since a
// failure callback can sometimes fire even when the payment actually went
// through on Cashfree's side. This NEVER trusts the SDK's client-side
// result: it always re-fetches the order status directly from Cashfree's
// server and only credits diamonds if Cashfree itself reports
// order_status === 'PAID'. Idempotent — safe to call more than once; an
// already-'approved' transaction is a no-op.
router.post('/verify-payment', protect, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (transaction.status === 'approved') {
      return res.json({ success: true, status: 'approved', message: 'Payment already confirmed', transaction });
    }

    const cfOrder = await getCashfreeOrderStatus(orderId);
    console.log(`💳 [Cashfree] Verify — order ${orderId}: status=${cfOrder.order_status}`);

    if (cfOrder.order_status === 'PAID') {
      const user = req.user;
      user.diamondBalance += transaction.diamondPackage;
      await user.save();

      transaction.status = 'approved';
      transaction.reviewedAt = new Date();
      transaction.adminNote = 'Auto-approved via Cashfree';
      await transaction.save();

      await Notification.create({
        user: user._id,
        type: 'payment_approved',
        title: 'Payment Successful 🎉',
        message: `₹${transaction.amountINR} paid — ${transaction.diamondPackage} diamonds added to your wallet.`
      });
      await sendPushToUser(user, {
        title: 'Payment successful 💎',
        body: `${transaction.diamondPackage} diamonds added to your wallet.`,
        data: { type: 'payment_approved' }
      });

      console.log(`✅ [Cashfree] Order ${orderId}: PAID — credited ${transaction.diamondPackage} diamonds to user ${user._id}`);
      return res.json({ success: true, status: 'approved', message: 'Payment confirmed, diamonds credited', transaction });
    }

    if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(cfOrder.order_status)) {
      transaction.status = 'rejected';
      transaction.adminNote = `Cashfree order status: ${cfOrder.order_status}`;
      await transaction.save();
      return res.json({ success: true, status: 'rejected', message: 'Payment was not completed', transaction });
    }

    // 'ACTIVE' or anything else not-yet-final — payment still in progress.
    return res.json({ success: true, status: 'pending', message: 'Payment not completed yet', transaction });
  } catch (err) {
    console.error('❌ [Cashfree] verify-payment failed:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not verify payment. Please check My Requests or contact support.' });
  }
});

// @route POST /api/diamonds/webhook  (Cashfree server-to-server webhook)
// Backup confirmation path for when the app is closed/killed before it can
// call verify-payment itself — configure this URL in the Cashfree
// dashboard under Developers -> Webhooks. No auth middleware (Cashfree
// can't send a user JWT); instead of trusting the webhook body's
// amount/status directly, this re-fetches the order from Cashfree's API
// using the order_id in the payload — same server-side-source-of-truth
// pattern as verify-payment above. Always responds 200 so Cashfree doesn't
// retry-storm on a transient error on our end.
router.post('/webhook', async (req, res) => {
  try {
    const orderId = req.body?.data?.order?.order_id;
    if (!orderId) return res.status(200).json({ success: true });

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId });
    if (!transaction || transaction.status === 'approved') {
      return res.status(200).json({ success: true });
    }

    const cfOrder = await getCashfreeOrderStatus(orderId);
    console.log(`💳 [Cashfree Webhook] Order ${orderId}: status=${cfOrder.order_status}`);

    if (cfOrder.order_status === 'PAID') {
      const user = await User.findById(transaction.user);
      if (user) {
        user.diamondBalance += transaction.diamondPackage;
        await user.save();

        transaction.status = 'approved';
        transaction.reviewedAt = new Date();
        transaction.adminNote = 'Auto-approved via Cashfree webhook';
        await transaction.save();

        await Notification.create({
          user: user._id,
          type: 'payment_approved',
          title: 'Payment Successful 🎉',
          message: `₹${transaction.amountINR} paid — ${transaction.diamondPackage} diamonds added to your wallet.`
        });
        await sendPushToUser(user, {
          title: 'Payment successful 💎',
          body: `${transaction.diamondPackage} diamonds added to your wallet.`,
          data: { type: 'payment_approved' }
        });

        console.log(`✅ [Cashfree Webhook] Order ${orderId}: PAID — credited ${transaction.diamondPackage} diamonds to user ${user._id}`);
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ [Cashfree Webhook] error:', err.response?.data || err.message);
    res.status(200).json({ success: true });
  }
});

// @route GET /api/diamonds/my-requests
router.get('/my-requests', protect, async (req, res) => {
  const transactions = await Transaction.find({ user: req.user._id, type: 'diamond_purchase' }).sort({ createdAt: -1 });
  res.json({ success: true, transactions });
});

module.exports = router;
