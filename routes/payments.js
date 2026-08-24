const express = require('express');
const Stripe = require('stripe');
const config = require('../config');

module.exports = (pool, verifyToken) => {
  const router = express.Router();

  const stripeKey = (config.stripe.secretKey || '').trim();

  if (!stripeKey) {
    const error = new Error('Stripe configuration unavailable');
    error.code = 'STRIPE_CONFIGURATION_UNAVAILABLE';
    throw error;
  }

  const stripe = new Stripe(
    stripeKey,
    { apiVersion: '2023-10-16' }
  );

  // MVP1 payment cycle (order-anchored PaymentIntent + idempotency)
  // This router defines POST /intent
  const paymentIntentRouter = require('./payments/payments.intent');
  router.use(paymentIntentRouter);

  // Stripe webhook (source of truth for payment reconciliation)
  const paymentsWebhookRouter = require('./payments/payments.webhook');
  router.use(paymentsWebhookRouter(pool));

  // Deprecated during backend hardening: keep a single payment truth (order-anchored /intent)
  router.post('/payment-sheet', verifyToken, (_req, res) => {
    return res.status(410).json({
      error: 'Deprecated. Use POST /api/payments/intent (order-anchored PaymentIntent).',
    });
  });

  // Deprecated during backend hardening: keep a single payment truth (order-anchored /intent)
  router.post('/checkout-session', verifyToken, (_req, res) => {
    return res.status(410).json({
      error: 'Deprecated. Use POST /api/payments/intent (order-anchored PaymentIntent).',
    });
  });

  return router;
};