const admin = require('firebase-admin');

function classifyVerifyTokenError(err) {
  const code = err?.code || null;
  if (!code) return { code: null, kind: 'unknown' };

  if (code === 'auth/id-token-expired') return { code, kind: 'expired' };
  if (code === 'auth/id-token-revoked') return { code, kind: 'revoked' };
  if (code === 'auth/argument-error') return { code, kind: 'invalid' };
  if (code === 'auth/invalid-id-token') return { code, kind: 'invalid' };
  if (code === 'auth/invalid-credential') return { code, kind: 'misconfig' };

  return { code, kind: 'unknown' };
}

function logAuthFailure(req, err) {
  const classification = classifyVerifyTokenError(err);
  const level = classification.kind === 'misconfig' ? 'error' : 'warn';

  req.logEvent(
    level,
    classification.kind === 'misconfig'
      ? 'auth.firebase_verification_unavailable'
      : 'auth.token_verification_failed',
    {
      method: req.method,
      path: req.path,
      kind: classification.kind,
      code: classification.code,
    }
  );
}

// verifyToken middleware
// - Requires Authorization: Bearer <Firebase ID token>
// - Attaches req.user with uid, role, and restaurantId (if present in custom claims)

module.exports = async function verifyToken(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = header.replace('Bearer ', '').trim();

    const decoded = await admin.auth().verifyIdToken(token, true);

    // Attach identity + claims context.
    // Firebase custom claims may not appear as top-level fields on `decoded`.
    // Preserve `decoded` so downstream guards can extract roles/scopes reliably.
    const claims = decoded.customClaims || decoded.claims || decoded || {};

    const rawRole = decoded.role || claims.role || null;

    // Normalize role to DB enum values (role_type)
    // Supported canonical roles: Manager, Employee, Customer
    // Transitional safety: treat legacy "staff" as Employee.
    let normalizedRole = null;
    if (rawRole) {
      const r = String(rawRole).trim().toLowerCase();
      else if (r === 'employee') normalizedRole = 'Employee';
      else if (r === 'manager') normalizedRole = 'Manager';
      else if (r === 'customer') normalizedRole = 'Customer';
      else if (r === 'staff') normalizedRole = 'Employee';
    }

    // Phase 17 — Customer flows may not carry explicit custom role claims.
    // Default authenticated unknown-role users to Customer so dine-customer
    // can proceed through runtime restaurant selection and checkout.
    if (!normalizedRole) {
      normalizedRole = 'Customer';
    }

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,

      // Claim-derived values only. These are NOT authoritative for authorization.
      // resolveActor must load the authoritative role and restaurant scope from the database.
      claimedRole: normalizedRole,
      claimedRestaurantId:
        decoded.restaurantId || claims.restaurantId || null,

      // Preserve full decoded token for other extractors
      decoded,
      claims,
    };

    return next();
  } catch (err) {
    const classification = classifyVerifyTokenError(err);

    logAuthFailure(req, err);

    if (classification.kind === 'misconfig') {
      return res.status(503).json({
        error: 'Authentication service unavailable',
      });
    }

    return res.status(401).json({
      error: 'Invalid or expired token',
    });
  }
};