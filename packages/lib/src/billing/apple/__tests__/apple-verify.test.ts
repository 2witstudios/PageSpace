import { describe, it, expect } from 'vitest';
import { X509Certificate, createHash } from 'crypto';
import { AppleVerificationError, appleVerifierConfigFromEnv, createAppleVerifier, type AppleVerifierConfig } from '../apple-verify';
import { APPLE_ROOT_CA_G3_SHA256, appleRootCertificates } from '../apple-root-certs';
import { TEST_ROOT_DER, signAppleJws } from './sign-jws';

const BUNDLE = 'ai.pagespace.ios';
const APP_APPLE_ID = 6_700_000_001;
const NOW = Date.now();

const config = (overrides: Partial<AppleVerifierConfig> = {}): AppleVerifierConfig => ({
  bundleId: BUNDLE,
  appAppleId: APP_APPLE_ID,
  allowSandbox: true,
  enableOnlineChecks: false,
  rootCertificates: [TEST_ROOT_DER],
  ...overrides,
});

const transaction = (overrides: Record<string, unknown> = {}) => ({
  transactionId: '2000000000000001',
  originalTransactionId: '2000000000000001',
  bundleId: BUNDLE,
  productId: 'ai.pagespace.ios.credits.100',
  purchaseDate: NOW - 1000,
  originalPurchaseDate: NOW - 1000,
  quantity: 1,
  type: 'Consumable',
  inAppOwnershipType: 'PURCHASED',
  signedDate: NOW,
  environment: 'Sandbox',
  transactionReason: 'PURCHASE',
  storefront: 'USA',
  storefrontId: '143441',
  price: 11_990,
  currency: 'USD',
  appAccountToken: '6f1c0b9e-3c43-4b8f-9d7f-0b1a2c3d4e5f',
  ...overrides,
});

describe('the embedded Apple root', () => {
  it('is exactly Apple Root CA - G3, pinned by fingerprint', () => {
    const [der] = appleRootCertificates();
    expect(createHash('sha256').update(der).digest('hex').toUpperCase()).toBe(APPLE_ROOT_CA_G3_SHA256);
    const cert = new X509Certificate(der);
    expect(cert.subject).toContain('CN=Apple Root CA - G3');
    expect(cert.ca).toBe(true);
  });
});

describe('appleVerifierConfigFromEnv', () => {
  it('defaults to the PageSpace bundle, Sandbox allowed (App Review), online checks on', () => {
    const c = appleVerifierConfigFromEnv({});
    expect(c).toMatchObject({ bundleId: BUNDLE, appAppleId: undefined, allowSandbox: true, enableOnlineChecks: true });
    expect(c.rootCertificates).toHaveLength(1);
  });

  it('reads the numeric App Apple ID and ignores a non-numeric one', () => {
    expect(appleVerifierConfigFromEnv({ APPLE_IAP_APP_APPLE_ID: '6700000001' }).appAppleId).toBe(6_700_000_001);
    expect(appleVerifierConfigFromEnv({ APPLE_IAP_APP_APPLE_ID: 'abc' }).appAppleId).toBeUndefined();
  });

  it('lets an operator turn Sandbox funding off', () => {
    expect(appleVerifierConfigFromEnv({ APPLE_IAP_ALLOW_SANDBOX: 'false' }).allowSandbox).toBe(false);
    expect(appleVerifierConfigFromEnv({ APPLE_IAP_ALLOW_SANDBOX: '0' }).allowSandbox).toBe(false);
    expect(appleVerifierConfigFromEnv({ APPLE_IAP_ALLOW_SANDBOX: 'true' }).allowSandbox).toBe(true);
  });
});

describe('verifyTransaction', () => {
  it('verifies and decodes a correctly signed Sandbox transaction', async () => {
    const decoded = await createAppleVerifier(config()).verifyTransaction(signAppleJws(transaction()));
    expect(decoded).toMatchObject({ transactionId: '2000000000000001', productId: 'ai.pagespace.ios.credits.100', environment: 'Sandbox' });
  });

  it('verifies a Production transaction when the App Apple ID is configured', async () => {
    const decoded = await createAppleVerifier(config()).verifyTransaction(signAppleJws(transaction({ environment: 'Production' })));
    expect(decoded.environment).toBe('Production');
  });

  it('refuses Production verification until the App Apple ID is configured', async () => {
    await expect(createAppleVerifier(config({ appAppleId: undefined })).verifyTransaction(signAppleJws(transaction({ environment: 'Production' }))))
      .rejects.toMatchObject({ failure: 'not_configured' });
  });

  it('refuses a payload whose signature does not match (tampered body)', async () => {
    const jws = signAppleJws(transaction());
    const [h, , s] = jws.split('.');
    const forged = Buffer.from(JSON.stringify(transaction({ productId: 'ai.pagespace.ios.credits.500' }))).toString('base64url');
    await expect(createAppleVerifier(config()).verifyTransaction(`${h}.${forged}.${s}`)).rejects.toMatchObject({ failure: 'invalid_signature' });
  });

  it('refuses a chain that does not lead to a trusted root (the real Apple root does not sign our test chain)', async () => {
    await expect(createAppleVerifier(config({ rootCertificates: appleRootCertificates() })).verifyTransaction(signAppleJws(transaction())))
      .rejects.toMatchObject({ failure: 'invalid_signature' });
  });

  it('refuses a chain of the wrong length', async () => {
    await expect(createAppleVerifier(config()).verifyTransaction(signAppleJws(transaction(), { x5c: [] }))).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it('refuses a transaction for another app', async () => {
    await expect(createAppleVerifier(config()).verifyTransaction(signAppleJws(transaction({ bundleId: 'com.other.app' }))))
      .rejects.toMatchObject({ failure: 'invalid_signature' });
  });

  it('refuses an Xcode or LocalTesting payload outright (the library would skip its signature check)', async () => {
    for (const environment of ['Xcode', 'LocalTesting']) {
      await expect(createAppleVerifier(config()).verifyTransaction(signAppleJws(transaction({ environment }))))
        .rejects.toMatchObject({ failure: 'malformed' });
    }
  });

  it('refuses something that is not a JWS', async () => {
    await expect(createAppleVerifier(config()).verifyTransaction('not-a-jws')).rejects.toMatchObject({ failure: 'malformed' });
    await expect(createAppleVerifier(config()).verifyTransaction('a.b.c')).rejects.toMatchObject({ failure: 'malformed' });
  });
});

describe('verifyNotification', () => {
  const renewal = (overrides: Record<string, unknown> = {}) => ({
    originalTransactionId: '2000000000000009',
    autoRenewProductId: 'ai.pagespace.ios.pro.monthly',
    productId: 'ai.pagespace.ios.pro.monthly',
    autoRenewStatus: 1,
    signedDate: NOW,
    environment: 'Sandbox',
    recentSubscriptionStartDate: NOW - 1000,
    renewalDate: NOW + 1000,
    ...overrides,
  });

  const notification = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    notificationType: 'DID_RENEW',
    notificationUUID: '11111111-2222-4333-8444-555555555555',
    version: '2.0',
    signedDate: NOW,
    data: { environment: 'Sandbox', bundleId: BUNDLE, appAppleId: APP_APPLE_ID, bundleVersion: '42', status: 1, ...data },
    ...overrides,
  });

  it('verifies the envelope and the signed transaction and renewal inside it', async () => {
    const signedTransactionInfo = signAppleJws(transaction({ productId: 'ai.pagespace.ios.pro.monthly', type: 'Auto-Renewable Subscription', expiresDate: NOW + 30 * 86_400_000 }));
    const signedRenewalInfo = signAppleJws(renewal({ autoRenewStatus: 0, gracePeriodExpiresDate: NOW + 5000 }));
    const verified = await createAppleVerifier(config()).verifyNotification(signAppleJws(notification({ signedTransactionInfo, signedRenewalInfo })));
    expect(verified).toMatchObject({
      notificationUUID: '11111111-2222-4333-8444-555555555555',
      type: 'DID_RENEW',
      subtype: null,
      status: 1,
      transaction: { productId: 'ai.pagespace.ios.pro.monthly' },
      renewal: { autoRenew: false, gracePeriodExpiresMs: NOW + 5000 },
    });
  });

  it('decodes a TEST notification that carries no transaction', async () => {
    const verified = await createAppleVerifier(config()).verifyNotification(signAppleJws(notification({ status: undefined }, { notificationType: 'TEST' })));
    expect(verified).toMatchObject({ type: 'TEST', transaction: null, renewal: null, status: null });
  });

  it('refuses a notification for another app', async () => {
    await expect(createAppleVerifier(config()).verifyNotification(signAppleJws(notification({ bundleId: 'com.other.app' }))))
      .rejects.toMatchObject({ failure: 'invalid_signature' });
  });

  it('refuses a forged inner transaction even inside a valid envelope', async () => {
    const good = signAppleJws(transaction());
    const [h, , s] = good.split('.');
    const forgedInner = `${h}.${Buffer.from(JSON.stringify(transaction({ productId: 'ai.pagespace.ios.credits.500' }))).toString('base64url')}.${s}`;
    await expect(createAppleVerifier(config()).verifyNotification(signAppleJws(notification({ signedTransactionInfo: forgedInner }))))
      .rejects.toMatchObject({ failure: 'invalid_signature' });
  });
});
