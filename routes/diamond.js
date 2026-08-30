const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const router = express.Router();

// Helper to sanitize phone for Cashfree requirements
const formatPhoneNumber = (phoneStr) => {
  if (!phoneStr) return '9999999999';
  const cleaned = phoneStr.replace(/\D/g, '');
  if (cleaned.length >= 10) {
    return cleaned.slice(-10);
  }
  return '9999999999';
};

// @route   POST /api/diamonds/create-order
// @desc    Creates Cashfree Payment Order for Diamond Purchase
router.post('/create-order', protect, async (req, res) => {
  try {
    const { diamondPackage } = req.body; // Package options: 10, 50, 100, 200

    const validPackages = [10, 50, 100, 200];
    const pkgAmount = Number(diamondPackage);

    if (!validPackages.includes(pkgAmount)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid diamond package selection. Choose 10, 50, 100, or 200.'
      });
    }

    const orderId = `ORDER_${Date.now()}_${req.user._id.toString().slice(-4)}`;
    const amountINR = pkgAmount; // 1 Diamond = ₹1 Rate

    const isProduction = process.env.CASHFREE_ENV === 'PRODUCTION';
    const cashfreeBaseUrl = isProduction
      ? 'https://api.cashfree.com/pg/orders'
      : 'https://sandbox.cashfree.com/pg/orders';

    const customerPhone = formatPhoneNumber(req.user.phone);
    const customerEmail = (req.user.email && req.user.email.includes('@')) 
      ? req.user.email 
      : `user_${req.user._id}@tubepilot.app`;

    const requestBody = {
      order_id: orderId,
      order_amount: amountINR,
      order_currency: 'INR',
      customer_details: {
        customer_id: req.user._id.toString(),
        customer_email: customerEmail,
        customer_phone: customerPhone,
        customer_name: req.user.name || 'TubePilot User'
      },
      order_meta: {
        return_url: `https://test.cashfree.com/pgapp/subsc/dev/return?order_id=${orderId}`
      }
    };

    const response = await axios.post(cashfreeBaseUrl, requestBody, {
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      }
    });

    const { payment_session_id } = response.data;

    // Create pending transaction entry
    const transaction = await Transaction.create({
      user: req.user._id,
      userDisplayId: `TP${Math.floor(100000 + Math.random() * 900000)}`,
      type: 'diamond_purchase',
      diamondPackage: pkgAmount,
      amountINR: amountINR,
      paymentMethod: 'cashfree',
      cashfreeOrderId: orderId,
      paymentSessionId: payment_session_id,
      status: 'pending'
    });

    res.status(200).json({
      success: true,
      paymentSessionId: payment_session_id,
      orderId: orderId,
      environment: isProduction ? 'PRODUCTION' : 'SANDBOX',
      transactionId: transaction._id
    });

  } catch (err) {
    console.error('❌ [Cashfree Order Error]:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'Failed to initialize Cashfree payment order.'
    });
  }
});

// @route   POST /api/diamonds/verify-payment
// @desc    Verifies payment with Cashfree after SDK callback & credits diamonds
router.post('/verify-payment', protect, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required.' });
    }

    const transaction = await Transaction.findOne({ cashfreeOrderId: orderId, user: req.user._id });

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction record not found.' });
    }

    if (transaction.status === 'approved' || transaction.status === 'completed') {
      const updatedUser = await User.findById(req.user._id);
      return res.json({
        success: true,
        message: 'Payment already processed.',
        diamondBalance: updatedUser.diamondBalance
      });
    }

    const isProduction = process.env.CASHFREE_ENV === 'PRODUCTION';
    const verifyUrl = isProduction
      ? `https://api.cashfree.com/pg/orders/${orderId}`
      : `https://sandbox.cashfree.com/pg/orders/${orderId}`;

    const response = await axios.get(verifyUrl, {
      headers: {
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      }
    });

    const orderData = response.data;

    if (orderData.order_status === 'PAID') {
      transaction.status = 'approved';
      transaction.reviewedAt = new Date();
      await transaction.save();

      // Add purchased diamonds to user account
      const user = await User.findById(req.user._id);
      user.diamondBalance += transaction.diamondPackage;
      await user.save();

      return res.json({
        success: true,
        message: 'Payment verified successfully! Diamonds added.',
        diamondBalance: user.diamondBalance
      });
    } else {
      transaction.status = 'rejected';
      await transaction.save();

      return res.status(400).json({
        success: false,
        message: `Payment status is ${orderData.order_status}.`
      });
    }

  } catch (err) {
    console.error('❌ [Verify Payment Error]:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'Payment verification failed.'
    });
  }
});

module.exports = router;
