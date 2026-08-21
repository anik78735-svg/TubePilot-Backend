const axios = require('axios');
// CASHFREE_ENV: 'TEST' (sandbox) or 'PROD'/'PRODUCTION' (live). Defaults to
// TEST so a missing/misconfigured env var never accidentally goes live.
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'TEST').toUpperCase();
const IS_PROD = CASHFREE_ENV === 'PROD' || CASHFREE_ENV === 'PRODUCTION';
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
// Cashfree PG REST API version — pin this so Cashfree changing their
// default doesn't silently alter the response shape underneath us.
const CASHFREE_API_VERSION = '2023-08-01';
const BASE_URL = IS_PROD
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';
const isConfigured = !!(CASHFREE_APP_ID && CASHFREE_SECRET_KEY);
if (!isConfigured) {
  console.warn('⚠️  CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set — diamond purchases are disabled.');
} else {
  console.log(`ℹ️  Cashfree configured — environment: ${IS_PROD ? 'PROD' : 'TEST'} (${BASE_URL})`);
}
const cashfreeHeaders = () => ({
  'x-client-id': CASHFREE_APP_ID,
  'x-client-secret': CASHFREE_SECRET_KEY,
  'x-api-version': CASHFREE_API_VERSION,
  'Content-Type': 'application/json'
});
const notConfiguredError = () => {
  const err = new Error('Payments are not configured. Please contact support.');
  err.code = 'CASHFREE_NOT_CONFIGURED';
  return err;
};
// Creates a Cashfree order and returns the paymentSessionId the Flutter app
// needs to open the Cashfree Drop-in checkout SDK.
const createCashfreeOrder = async ({ orderId, amount, customerId, customerPhone, customerEmail, customerName }) => {
  if (!isConfigured) throw notConfiguredError();
  const res = await axios.post(
    `${BASE_URL}/orders`,
    {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: customerId,
        // Cashfree requires a phone number on every order — fall back to a
        // placeholder if the user hasn't set one (email/phone auth users
        // may not have a phone on file).
        customer_phone: customerPhone && customerPhone.trim() ? customerPhone : '9999999999',
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        ...(customerName ? { customer_name: customerName } : {})
      },
      order_meta: {
        // Required field for Cashfree's API even though the mobile SDK
        // checkout flow doesn't actually redirect the user through a
        // browser — {order_id} is substituted by Cashfree automatically.
        return_url: `https://tubepilot.app/payment-status?order_id={order_id}`
      }
    },
    { headers: cashfreeHeaders() }
  );
  return {
    orderId: res.data.order_id,
    paymentSessionId: res.data.payment_session_id,
    cfOrderId: res.data.cf_order_id
  };
};
// Fetches the CURRENT status of an order directly from Cashfree's server —
// this is the single source of truth. order_status is one of:
// 'ACTIVE' (created, not yet paid), 'PAID', 'EXPIRED', 'TERMINATED'.
// Callers must NEVER credit diamonds based on a client-reported SDK
// callback alone — always re-check via this function first.
const getCashfreeOrderStatus = async (orderId) => {
  if (!isConfigured) throw notConfiguredError();
  const res = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: cashfreeHeaders() });
  return res.data;
};
module.exports = { createCashfreeOrder, getCashfreeOrderStatus, isConfigured, CASHFREE_ENV };
